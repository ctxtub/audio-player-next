/**
 * 生成历史相关 Zod Schemas 与 DTO。
 */

import { z } from 'zod';

/** 记录一次生成的入参。 */
export const recordInputSchema = z.object({
    prompt: z.string().min(1, '提示词不能为空').max(2000, '提示词过长'),
    storyText: z.string().min(1, '故事内容不能为空').max(20000, '故事内容过长'),
    voiceId: z.string().max(64).optional(),
});

/** 删除某条生成历史的入参。 */
export const removeInputSchema = z.object({
    id: z.number().int(),
});

/**
 * 返回前端的生成历史 DTO（createdAt 为 ISO 字符串）。
 */
export const generationHistoryDtoSchema = z.object({
    id: z.number().int(),
    prompt: z.string(),
    storyText: z.string(),
    voiceId: z.string(),
    createdAt: z.string(),
});

/** 生成历史 DTO 类型。 */
export type GenerationHistoryDTO = z.infer<typeof generationHistoryDtoSchema>;
