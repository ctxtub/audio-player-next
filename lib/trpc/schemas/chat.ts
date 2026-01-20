/**
 * 聊天相关 Zod Schemas
 */

import { z } from 'zod';

/**
 * 单条消息 Schema。
 */
export const messageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1, 'content 不能为空'),
});

/**
 * 聊天流式请求 Schema。
 */
export const chatInputSchema = z.object({
    model: z.string().optional(),
    messages: z.array(messageSchema).min(1, 'messages 不能为空'),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
});

/**
 * 聊天请求类型。
 */
export type ChatInput = z.infer<typeof chatInputSchema>;

/**
 * 流式消息事件 Schema。
 */
export const chatStreamMessageSchema = z.object({
    type: z.literal('message'),
    delta: z.string(),
});

/**
 * 流式完成事件 Schema。
 */
export const chatStreamDoneSchema = z.object({
    type: z.literal('done'),
    finishReason: z.string(),
    usage: z.object({
        promptTokens: z.number().optional(),
        completionTokens: z.number().optional(),
        totalTokens: z.number().optional(),
    }).optional(),
});

/**
 * 流式错误事件 Schema。
 */
export const chatStreamErrorSchema = z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
});

/**
 * 聊天流式事件联合类型 Schema。
 */
export const chatStreamEventSchema = z.discriminatedUnion('type', [
    chatStreamMessageSchema,
    chatStreamDoneSchema,
    chatStreamErrorSchema,
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
