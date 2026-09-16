/**
 * Conversation 相关 Zod Schemas 与 DTO（change-id 2026-09-15-story-collection-continuous-creation）。
 *
 * 会话是创作上下文；一个 Conversation 至多一个 StoryCollection。
 */

import { z } from 'zod';
import { CONVERSATION_STATES } from '@/lib/storyCollection/constants';
import { chatMessageInputSchema } from './chatConversation';

/** 会话状态 */
export const conversationStateSchema = z.enum(CONVERSATION_STATES);
export type ConversationStateDto = z.infer<typeof conversationStateSchema>;

/** 会话 DTO */
export const conversationDtoSchema = z.object({
  id: z.string().min(1),
  state: conversationStateSchema,
  collectionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConversationDTO = z.infer<typeof conversationDtoSchema>;

/** conversation.get / close 入参 */
export const conversationIdInputSchema = z.object({
  id: z.string().min(1).max(64),
});
export type ConversationIdInput = z.infer<typeof conversationIdInputSchema>;

/**
 * conversation.createNew 入参：expectedOldId 为客户端已知的旧 active 会话，
 * 不匹配即 CONFLICT，防止多标签页并发覆盖（产品 API §3）。
 */
export const conversationCreateNewInputSchema = z.object({
  expectedOldId: z.string().min(1).max(64).optional(),
});
export type ConversationCreateNewInput = z.infer<typeof conversationCreateNewInputSchema>;

/** conversation.saveSnapshot 入参（会话内快照 replace） */
export const conversationSaveSnapshotInputSchema = z.object({
  conversationId: z.string().min(1).max(64),
  messages: z.array(chatMessageInputSchema).max(200),
  baseMessageIds: z.array(z.string().min(1)).max(200).optional(),
});
export type ConversationSaveSnapshotInput = z.infer<
  typeof conversationSaveSnapshotInputSchema
>;
