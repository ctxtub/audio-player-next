/**
 * 用户配置相关 Zod Schemas 与默认值。
 *
 * M6-01：领域语义迁移 floatingPlayerEnabled → desktopFloatingPlayerEnabled。
 * - DTO 只暴露 desktopFloatingPlayerEnabled（新产品语义唯一来源）。
 * - Patch 以 desktopFloatingPlayerEnabled 为准；legacy floatingPlayerEnabled
 *   仅在 config compatibility boundary 收敛（旧 Bundle 兼容），不得向 Store/DTO 传播。
 * - 两者同时出现且值不同 → BAD_REQUEST（由 superRefine 抛 ZodError，tRPC 映射为 BAD_REQUEST）。
 *
 * patch：更新时的增量；DTO：返回前端的形状。
 */

import { z } from 'zod';

/** 主题模式枚举校验。 */
export const themeModeSchema = z.enum(['dark', 'light', 'system']);

/**
 * 用户配置增量更新 Schema：全字段可选，约束与 UserConfig 表对齐。
 *
 * M6-01 compatibility boundary：legacy `floatingPlayerEnabled` 仅为兼容别名。
 */
export const userConfigPatchSchema = z
    .object({
        /** 播放时长（分钟），范围 10-120。 */
        playDuration: z.number().int().min(10).max(120).optional(),
        /** TTS 音色 ID，空串=系统默认。 */
        voiceId: z.string().max(64).optional(),
        /** 播放速率，范围 0.25-4.0。 */
        speed: z.number().min(0.25).max(4.0).optional(),
        /** 是否在宽屏启用悬浮迷你播放器（M6 正式语义；false=wide-docked）。 */
        desktopFloatingPlayerEnabled: z.boolean().optional(),
        /**
         * @deprecated 兼容别名：旧前端 Bundle 仍可能发送该字段。
         * 仅在 compatibility boundary 收敛为 desktopFloatingPlayerEnabled，不向下游传播。
         */
        floatingPlayerEnabled: z.boolean().optional(),
        /** 主题模式。 */
        themeMode: themeModeSchema.optional(),
    })
    .superRefine((val, ctx) => {
        if (
            val.desktopFloatingPlayerEnabled !== undefined &&
            val.floatingPlayerEnabled !== undefined &&
            val.desktopFloatingPlayerEnabled !== val.floatingPlayerEnabled
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'CONFLICTING_FLOATING_PLAYER_FIELDS',
                path: ['desktopFloatingPlayerEnabled'],
            });
        }
    });

/** 增量更新类型（含 legacy 兼容别名；下游必须经 normalizeUserConfigPatch 收敛）。 */
export type UserConfigPatch = z.infer<typeof userConfigPatchSchema>;

/**
 * 收敛后的增量类型：只含新产品语义字段，供 Store/facade/DB 层使用。
 * 兼容别名在此类型中不存在，从类型层面杜绝双字段传播。
 */
export type NormalizedUserConfigPatch = Omit<UserConfigPatch, 'floatingPlayerEnabled'>;

/**
 * 将含 legacy 别名的 patch 收敛为只含新语义的 patch（config compatibility boundary）。
 *
 * 规则：
 * - 仅新字段存在 → 直接透传；
 * - 仅旧字段存在 → 映射为 desktopFloatingPlayerEnabled；
 * - 两者都存在且相同 → 以新字段为准；
 * - 两者都存在且不同 → 抛错（调用方映射为 BAD_REQUEST）。
 *
 * @param patch 原始 patch（含可能的 legacy 别名）
 * @returns 只含新语义的 patch
 */
export const normalizeUserConfigPatch = (
    patch: UserConfigPatch
): NormalizedUserConfigPatch => {
    const { floatingPlayerEnabled: legacy, ...rest } = patch;
    const next = rest.desktopFloatingPlayerEnabled;
    if (next !== undefined && legacy !== undefined && next !== legacy) {
        throw new Error('CONFLICTING_FLOATING_PLAYER_FIELDS');
    }
    if (next !== undefined) {
        return rest;
    }
    if (legacy !== undefined) {
        return { ...rest, desktopFloatingPlayerEnabled: legacy };
    }
    return rest;
};

/**
 * 返回前端的用户配置 DTO（前端语义命名）。
 * M6-01：只暴露 desktopFloatingPlayerEnabled，不再传播 legacy 别名。
 */
export const userConfigDtoSchema = z.object({
    playDuration: z.number().int(),
    voiceId: z.string(),
    speed: z.number(),
    desktopFloatingPlayerEnabled: z.boolean(),
    themeMode: themeModeSchema,
});

/** 用户配置 DTO 类型。 */
export type UserConfigDTO = z.infer<typeof userConfigDtoSchema>;

/**
 * 系统级默认配置，与 Prisma schema 的 @default 对齐。
 * 同时用作：新建 UserConfig 行的兜底、访客/未登录客户端默认。
 */
export const DEFAULT_USER_CONFIG: UserConfigDTO = {
    playDuration: 30,
    voiceId: '',
    speed: 1.0,
    desktopFloatingPlayerEnabled: true,
    themeMode: 'system',
};
