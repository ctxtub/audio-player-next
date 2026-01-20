/**
 * 故事生成客户端
 *
 * 使用 tRPC 请求故事生成与续写。
 */

import { trpc } from '@/lib/trpc/client';
import type { StoryApiRequest, StoryApiResponse } from '@/types/story';

/**
 * 生成或续写故事。
 * @param request 故事请求参数。
 * @returns 故事内容与可选的摘要。
 */
export const generateStory = async (request: StoryApiRequest): Promise<StoryApiResponse> => {
  const result = await trpc.story.generate.mutate(request);
  return {
    storyContent: result.storyContent,
    summaryContent: result.summaryContent ?? undefined,
  };
};

/**
 * 续写故事（便捷方法）。
 * @param prompt 故事主题。
 * @param storyContent 已有故事内容。
 * @param options 可选配置。
 * @returns 续写的故事内容。
 */
export const continueStory = async (
  prompt: string,
  storyContent: string,
  options?: { withSummary?: boolean }
): Promise<StoryApiResponse> => {
  return generateStory({
    mode: 'continue',
    prompt,
    storyContent,
    withSummary: options?.withSummary,
  });
};
