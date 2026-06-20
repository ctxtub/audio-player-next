/**
 * 生成历史客户端
 *
 * 使用 tRPC 读写当前登录用户的生成历史。
 */

import { trpc } from '@/lib/trpc/client';

/** 生成历史列表响应类型（由服务端推导）。 */
export type MyGenerationHistoryResponse = Awaited<ReturnType<typeof fetchMyGenerations>>;

/**
 * 拉取当前用户的生成历史。
 */
export const fetchMyGenerations = async () => {
  return trpc.generationHistory.list.query();
};

/**
 * 记录一次生成。
 * @param input 提示词 / 故事正文 / 音色。
 */
export const recordMyGeneration = async (input: {
  prompt: string;
  storyText: string;
  voiceId?: string;
}) => {
  return trpc.generationHistory.record.mutate(input);
};

/**
 * 删除当前用户的某条生成历史。
 * @param id 记录 ID。
 */
export const removeMyGeneration = async (id: number) => {
  return trpc.generationHistory.remove.mutate({ id });
};
