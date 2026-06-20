/**
 * 聊天会话客户端
 *
 * 使用 tRPC 读取与快照保存当前登录用户的会话。
 */

import { trpc } from '@/lib/trpc/client';
import type { ChatMessageInput } from '@/lib/trpc/schemas/chatConversation';

/** 会话读取响应类型（由服务端推导）。 */
export type MyConversationResponse = Awaited<ReturnType<typeof fetchMyConversation>>;

/**
 * 拉取当前用户的会话消息。
 */
export const fetchMyConversation = async () => {
  return trpc.chat.getConversation.query();
};

/**
 * 快照保存当前用户的会话（整条替换）。
 * @param messages 待保存的消息快照。
 */
export const saveMyConversation = async (messages: ChatMessageInput[]) => {
  return trpc.chat.saveConversation.mutate({ messages });
};
