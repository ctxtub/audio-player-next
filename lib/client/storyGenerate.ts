import type { StoryApiRequest, StoryApiResponse } from '@/types/story';
import { browserHttp } from '@/lib/http/browser';
import { HttpError } from '@/lib/http/common/ErrorHandler';

/**
 * 故事 API 客户端错误，用于在前端统一处理异常。
 */
export class StoryApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId?: string;

  constructor(message: string, status: number, code: string, requestId?: string) {
    super(message);
    this.name = 'StoryApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * 调用统一的故事服务端代理。
 * @param payload Story API 请求体。
 * @returns 服务端返回的故事结果。
 * @throws StoryApiError
 */
const callStoryApi = async (payload: StoryApiRequest): Promise<StoryApiResponse> => {
  try {
    const response = await browserHttp.post<StoryApiResponse>('/api/story', payload, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = response.data;
    if (!data || typeof data !== 'object') {
      throw new StoryApiError(
        '故事服务返回结果无法解析',
        502,
        'STORY_API_INVALID_RESPONSE'
      );
    }

    if (typeof (data as StoryApiResponse).story !== 'string') {
      throw new StoryApiError(
        '故事内容缺失',
        502,
        'STORY_API_INVALID_RESPONSE'
      );
    }

    return data as StoryApiResponse;
  } catch (error) {
    if (error instanceof StoryApiError) {
      throw error;
    }

    if (error instanceof HttpError) {
      throw new StoryApiError(
        error.message,
        error.status,
        error.code || 'STORY_API_ERROR',
        error.requestId
      );
    }

    throw new StoryApiError(
      error instanceof Error ? error.message : '网络错误',
      0,
      'NETWORK_ERROR'
    );
  }
};

/**
 * 请求生成首段故事。
 * @param prompt 用户输入的提示词。
 * @returns 故事结果。
 */
export const generateStory = async (prompt: string): Promise<StoryApiResponse> => {
  return callStoryApi({
    mode: 'generate',
    prompt,
  });
};

/**
 * 请求续写故事。
 * @param prompt 原始提示词。
 * @param storyContent 已生成的故事文本。
 * @param options.withSummary 是否让服务端先生成摘要。
 * @returns 新的故事片段。
 */
export const continueStory = async (
  prompt: string,
  storyContent: string,
  options: { withSummary?: boolean } = {}
): Promise<StoryApiResponse> => {
  return callStoryApi({
    mode: 'continue',
    prompt,
    storyContent,
    withSummary: options.withSummary ?? false,
  });
};
