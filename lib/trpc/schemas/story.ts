/**
 * 故事生成相关 Zod Schemas
 */

import { z } from 'zod';

/**
 * 故事生成请求 Schema。
 */
export const storyGenerateInputSchema = z.object({
    mode: z.literal('generate'),
    prompt: z.string().min(1, 'prompt 不能为空'),
});

/**
 * 故事续写请求 Schema。
 */
export const storyContinueInputSchema = z.object({
    mode: z.literal('continue'),
    prompt: z.string().min(1, 'prompt 不能为空'),
    storyContent: z.string().min(1, '续写模式需要提供 storyContent'),
    withSummary: z.boolean().optional(),
});

/**
 * 故事请求联合类型 Schema。
 */
export const storyInputSchema = z.discriminatedUnion('mode', [
    storyGenerateInputSchema,
    storyContinueInputSchema,
]);

/**
 * 故事请求类型。
 */
export type StoryInput = z.infer<typeof storyInputSchema>;

/**
 * 故事响应 Schema。
 */
export const storyOutputSchema = z.object({
    storyContent: z.string(),
    summaryContent: z.string().nullish(),
});

export type StoryOutput = z.infer<typeof storyOutputSchema>;
