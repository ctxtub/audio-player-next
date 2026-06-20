/**
 * 用户配置相关 Zod Schemas 与默认值。
 *
 * seed：首次建行时的初始值；patch：更新时的增量；DTO：返回前端的形状。
 */

import { z } from 'zod';

/** 主题模式枚举校验。 */
export const themeModeSchema = z.enum(['dark', 'light', 'system']);

/**
 * 用户配置增量更新 Schema：全字段可选，约束与 UserConfig 表对齐。
 */
export const userConfigPatchSchema = z.object({
    /** 播放时长（分钟），范围 10-120。 */
    playDuration: z.number().int().min(10).max(120).optional(),
    /** TTS 音色 ID，空串=系统默认。 */
    voiceId: z.string().max(64).optional(),
    /** 播放速率，范围 0.25-4.0。 */
    speed: z.number().min(0.25).max(4.0).optional(),
    /** 是否启用浮动播放器。 */
    floatingPlayerEnabled: z.boolean().optional(),
    /** 主题模式。 */
    themeMode: themeModeSchema.optional(),
});

/** 增量更新类型。 */
export type UserConfigPatch = z.infer<typeof userConfigPatchSchema>;

/** 首次建行迁移用 Seed，与 patch 同形，但语义为初始值。 */
export const userConfigSeedSchema = userConfigPatchSchema;
/** Seed 类型。 */
export type UserConfigSeed = z.infer<typeof userConfigSeedSchema>;

/**
 * 返回前端的用户配置 DTO（前端语义命名）。
 */
export const userConfigDtoSchema = z.object({
    playDuration: z.number().int(),
    voiceId: z.string(),
    speed: z.number(),
    floatingPlayerEnabled: z.boolean(),
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
    floatingPlayerEnabled: true,
    themeMode: 'system',
};
