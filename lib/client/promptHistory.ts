/**
 * 提示词历史客户端
 *
 * 使用 tRPC 读写当前登录用户的提示词历史。
 */

import { trpc } from '@/lib/trpc/client';

/** 提示词历史列表响应类型（由服务端推导）。 */
export type MyPromptHistoryResponse = Awaited<ReturnType<typeof fetchMyPromptHistory>>;

/**
 * 拉取当前用户的提示词历史。
 */
export const fetchMyPromptHistory = async () => {
  return trpc.promptHistory.list.query();
};

/**
 * 记录一次提示词使用。
 * @param prompt 提示词原文。
 */
export const recordMyPrompt = async (prompt: string) => {
  return trpc.promptHistory.record.mutate({ prompt });
};

/**
 * 删除当前用户的某条提示词历史。
 * @param prompt 提示词原文。
 */
export const removeMyPrompt = async (prompt: string) => {
  return trpc.promptHistory.remove.mutate({ prompt });
};
