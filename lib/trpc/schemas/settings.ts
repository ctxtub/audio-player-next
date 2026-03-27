/**
 * 用户设置相关 Zod Schemas
 */

import { z } from 'zod';

/**
 * 用户设置保存请求 Schema，所有字段均可选以支持增量更新。
 */
export const saveSettingsSchema = z.object({
  playDuration: z.number().int().min(10).max(60).optional(),
  voiceId: z.string().min(1).optional(),
  speed: z.number().min(0.25).max(4.0).optional(),
  floatingPlayerEnabled: z.boolean().optional(),
  themeMode: z.enum(['light', 'dark', 'system']).optional(),
});

/**
 * 用户设置保存请求类型。
 */
export type SaveSettingsInput = z.infer<typeof saveSettingsSchema>;

/**
 * 用户设置响应结构。
 */
export const userSettingsSchema = z.object({
  playDuration: z.number(),
  voiceId: z.string(),
  speed: z.number(),
  floatingPlayerEnabled: z.boolean(),
  themeMode: z.enum(['light', 'dark', 'system']),
});

/**
 * 用户设置类型。
 */
export type UserSettings = z.infer<typeof userSettingsSchema>;
