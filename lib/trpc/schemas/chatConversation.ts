/**
 * 聊天会话持久化相关 Zod Schemas 与 DTO。
 *
 * parts 采用宽松校验（用户自有数据，渲染层用类型守卫处理），服务端以 JSON 存取。
 */

import { z } from 'zod';

/** 单个消息片段的宽松结构。 */
const messagePartSchema = z.record(z.string(), z.unknown());

/** 待保存的单条消息入参。 */
export const chatMessageInputSchema = z.object({
    messageId: z.string().min(1),
    role: z.string().min(1),
    content: z.string().max(50000),
    parts: z.array(messagePartSchema).optional(),
    agentType: z.string().optional(),
    createdAt: z.string().optional(),
});

/** 保存整条会话的入参（快照 replace）。 */
export const saveConversationInputSchema = z.object({
    messages: z.array(chatMessageInputSchema).max(200),
});

/** 单条消息入参类型。 */
export type ChatMessageInput = z.infer<typeof chatMessageInputSchema>;

/** 返回前端的消息 DTO（parts 已解析回对象）。 */
export type ChatMessageDTO = {
    messageId: string;
    role: string;
    content: string;
    parts?: Array<Record<string, unknown>>;
    agentType?: string;
    createdAt?: string;
};
