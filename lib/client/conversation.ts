/**
 * Conversation 客户端门面（change-id 2026-09-15-story-collection-continuous-creation）。
 */

import { trpc } from '@/lib/trpc/client';
import type { ChatMessageInput, ChatMessageDTO } from '@/lib/trpc/schemas/chatConversation';
import type { ConversationDTO } from '@/lib/trpc/schemas/conversation';

export type { ConversationDTO };

export const getActiveConversation = (): Promise<ConversationDTO | null> =>
  trpc.conversation.getActive.query();

export const getConversation = (id: string): Promise<ConversationDTO> =>
  trpc.conversation.get.query({ id });

/**
 * 读取指定会话的消息（  会话级读路径）。
 * @param conversationId 目标会话 id
 * @returns 该会话的消息 DTO 列表
 */
export const fetchConversationMessages = (conversationId: string): Promise<ChatMessageDTO[]> =>
  trpc.conversation.getMessages.query({ id: conversationId });

export const createNewConversation = (expectedOldId?: string): Promise<ConversationDTO> =>
  trpc.conversation.createNew.mutate(expectedOldId !== undefined ? { expectedOldId } : {});

/**
 * 确保当前主体存在 active Conversation（  会话级持久化前置）。
 *
 * 无 active 会话时创建一个（关闭旧 active、创建新 UUID）；并发下唯一索引冲突则
 * 回读 active，仍无才上抛。读取/写入路径因此总有一个确定的 conversationId。
 * @returns 当前 active 会话 DTO
 */
export const ensureActiveConversation = async (): Promise<ConversationDTO> => {
  const active = await getActiveConversation();
  if (active) {
    return active;
  }
  try {
    return await createNewConversation();
  } catch (error) {
    const retry = await getActiveConversation().catch(() => null);
    if (retry) {
      return retry;
    }
    throw error;
  }
};

export const saveConversationSnapshot = (
  conversationId: string,
  messages: ChatMessageInput[],
  baseMessageIds?: string[],
) =>
  trpc.conversation.saveSnapshot.mutate(
    baseMessageIds !== undefined
      ? { conversationId, messages, baseMessageIds }
      : { conversationId, messages },
  );

export const closeConversation = (id: string): Promise<ConversationDTO> =>
  trpc.conversation.close.mutate({ id });
