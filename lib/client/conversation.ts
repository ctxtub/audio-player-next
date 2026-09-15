/**
 * Conversation 客户端门面（change-id 2026-09-15-story-collection-continuous-creation T1）。
 */

import { trpc } from '@/lib/trpc/client';
import type { ChatMessageInput } from '@/lib/trpc/schemas/chatConversation';
import type { ConversationDTO } from '@/lib/trpc/schemas/conversation';

export type { ConversationDTO };

export const getActiveConversation = (): Promise<ConversationDTO | null> =>
  trpc.conversation.getActive.query();

export const getConversation = (id: string): Promise<ConversationDTO> =>
  trpc.conversation.get.query({ id });

export const createNewConversation = (expectedOldId?: string): Promise<ConversationDTO> =>
  trpc.conversation.createNew.mutate(expectedOldId !== undefined ? { expectedOldId } : {});

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
