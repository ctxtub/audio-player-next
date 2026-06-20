/**
 * 提示词历史相关 Zod Schemas 与 DTO。
 */

import { z } from 'zod';

/** 记录一次提示词使用的入参。 */
export const recordInputSchema = z.object({
    prompt: z.string().min(1, '提示词不能为空').max(2000, '提示词过长'),
});

/** 删除某条提示词历史的入参。 */
export const removeInputSchema = z.object({
    prompt: z.string().min(1),
});

/**
 * 返回前端的提示词历史 DTO（与现有 HistoryRecord 同形，lastUsed 为 ISO 字符串）。
 */
export const promptHistoryDtoSchema = z.object({
    prompt: z.string(),
    lastUsed: z.string(),
    useCount: z.number().int(),
});

/** 提示词历史 DTO 类型。 */
export type PromptHistoryDTO = z.infer<typeof promptHistoryDtoSchema>;
