/**
 * 用户配置相关 Zod Schemas 与默认值。
 *
 * M6-01：领域语义迁移 floatingPlayerEnabled → desktopFloatingPlayerEnabled。
 * - DTO 只暴露 desktopFloatingPlayerEnabled（新产品语义唯一来源）。
 * - Patch 以 desktopFloatingPlayerEnabled 为准；legacy floatingPlayerEnabled
 *   仅在 config compatibility boundary 收敛（旧 Bundle 兼容），不得向 Store/DTO 传播。
 * - 两者同时出现且值不同 → BAD_REQUEST（由 superRefine 抛 ZodError，tRPC 映射为 BAD_REQUEST）。
 *
 * M7-03：领域语义迁移 playDuration → defaultSleepTimerEnabled + defaultSleepTimerMinutes。
 * - DTO 正式字段 defaultSleepTimerEnabled/defaultSleepTimerMinutes（spec §30）；
 * - 旧 playDuration 作为 compatibility alias 保留一个发布周期（与 M6 策略一致）；
 * - Patch 以新字段为准；legacy playDuration 仅在 boundary 收敛；
 *   两者同时出现且值不同 → BAD_REQUEST。
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
        /**
         * M7-03 正式字段：默认睡眠定时分钟数（10-120）。
         * 新 Session 默认 Timer 由 enabled + minutes 共同决定（spec §29）。
         */
        defaultSleepTimerMinutes: z.number().int().min(10).max(120).optional(),
        /** M7-03 正式字段：默认睡眠定时开关（false=新 Session 默认 off）。 */
        defaultSleepTimerEnabled: z.boolean().optional(),
        /**
         * @deprecated M7-03 compatibility alias：旧前端 Bundle 仍可能发送该字段。
         * 仅在 compatibility boundary 收敛为 defaultSleepTimerMinutes（同时隐含
         * enabled=true，保持旧“设置时长即启用”语义），不得向下游传播。
         * 与 M6 floatingPlayerEnabled 策略一致，保留一个发布周期。
         */
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
        // M7-03：新旧睡眠定时时长同时出现且不同 → BAD_REQUEST（与 M6 双字段策略一致）。
        if (
            val.defaultSleepTimerMinutes !== undefined &&
            val.playDuration !== undefined &&
            val.defaultSleepTimerMinutes !== val.playDuration
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'CONFLICTING_SLEEP_TIMER_FIELDS',
                path: ['defaultSleepTimerMinutes'],
            });
        }
    });

/** 增量更新类型（含 legacy 兼容别名；下游必须经 normalizeUserConfigPatch 收敛）。 */
export type UserConfigPatch = z.infer<typeof userConfigPatchSchema>;

/**
 * 收敛后的增量类型：只含新产品语义字段，供 Store/facade/DB 层使用。
 * 兼容别名在此类型中不存在，从类型层面杜绝双字段传播。
 */
export type NormalizedUserConfigPatch = Omit<UserConfigPatch, 'floatingPlayerEnabled' | 'playDuration'>;

/**
 * 将含 legacy 别名的 patch 收敛为只含新语义的 patch（config compatibility boundary）。
 *
 * 规则：
 * - 仅新字段存在 → 直接透传；
 * - 仅旧字段存在 → 映射为 desktopFloatingPlayerEnabled / defaultSleepTimerMinutes；
 * - 两者都存在且相同 → 以新字段为准；
 * - 两者都存在且不同 → 抛错（调用方映射为 BAD_REQUEST）。
 *
 * M7-03：旧 playDuration 映射为 defaultSleepTimerMinutes 时不碰
 * defaultSleepTimerEnabled（旧语义“设置时长”本身即启用意图由调用方显式 enabled 表达；
 * 纯旧 Bundle 只发 playDuration 时保持原值 enabled 不变——既有用户 enabled 默认为 true，
 * 行为保持 30 分钟默认，§29.2）。
 *
 * @param patch 原始 patch（含可能的 legacy 别名）
 * @returns 只含新语义的 patch
 */
export const normalizeUserConfigPatch = (
    patch: UserConfigPatch
): NormalizedUserConfigPatch => {
    const { floatingPlayerEnabled: legacy, playDuration: legacyDuration, ...rest } = patch;
    const next = rest.desktopFloatingPlayerEnabled;
    if (next !== undefined && legacy !== undefined && next !== legacy) {
        throw new Error('CONFLICTING_FLOATING_PLAYER_FIELDS');
    }
    const nextMinutes = rest.defaultSleepTimerMinutes;
    if (nextMinutes !== undefined && legacyDuration !== undefined && nextMinutes !== legacyDuration) {
        throw new Error('CONFLICTING_SLEEP_TIMER_FIELDS');
    }
    const out: NormalizedUserConfigPatch = { ...rest };
    if (next === undefined && legacy !== undefined) {
        out.desktopFloatingPlayerEnabled = legacy;
    }
    if (nextMinutes === undefined && legacyDuration !== undefined) {
        out.defaultSleepTimerMinutes = legacyDuration;
    }
    return out;
};

/**
 * 返回前端的用户配置 DTO（前端语义命名）。
 * M6-01：只暴露 desktopFloatingPlayerEnabled，不再传播 legacy 别名。
 * M7-03：正式暴露 defaultSleepTimerEnabled/defaultSleepTimerMinutes；
 * 旧 playDuration 作为 compatibility alias 同值保留一个发布周期（spec §30）。
 */
export const userConfigDtoSchema = z.object({
    defaultSleepTimerMinutes: z.number().int(),
    defaultSleepTimerEnabled: z.boolean(),
    /** @deprecated M7-03 compatibility alias：与 defaultSleepTimerMinutes 同值，保留一个发布周期。 */
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
    defaultSleepTimerMinutes: 30,
    defaultSleepTimerEnabled: true,
    playDuration: 30,
    voiceId: '',
    speed: 1.0,
    desktopFloatingPlayerEnabled: true,
    themeMode: 'system',
};
