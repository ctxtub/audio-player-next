import {
  getStorySystemPrompt,
  getSummarySystemPrompt,
  loadLlmEnvConfig,
} from '@/lib/server/storyUpstream/config';
import type { LlmClientConfig } from '@/lib/server/storyUpstream/config';
import { serverHttp } from '@/lib/http/server';
import { HttpError } from '@/lib/http/common/ErrorHandler';
import { ServiceError } from '@/lib/http/server/ErrorHandler';
import type { StoryApiRequest, StoryApiResponse, StoryMode } from '@/types/story';

type ChatRole = 'system' | 'user' | 'assistant';

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type LlmUsagePayload = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type ChatCompletionChoice = {
  index: number;
  message?: {
    role?: ChatRole;
    content?: string | null;
  };
};

type ChatCompletionResponse = {
  id?: string;
  object?: string;
  created?: number;
  choices: ChatCompletionChoice[];
  usage?: LlmUsagePayload;
};

type StoryPromptPayload = {
  storyPrompt: string;
  summarizedStory: string;
};

const allowedModes: StoryMode[] = ['generate', 'continue'];

/**
 * 调用上游 Chat Completion 接口并处理错误。
 * @param body 请求体。
 * @param config LLM 客户端配置。
 */
const performChatCompletion = async (
  body: Record<string, unknown>,
  config: LlmClientConfig
): Promise<ChatCompletionResponse> => {
  try {
    const response = await serverHttp.post<ChatCompletionResponse>(
      `${config.apiBaseUrl}/v1/chat/completions`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
      }
    );

    if (!response.data || typeof response.data !== 'object') {
      throw new ServiceError({
        message: '上游返回格式无法解析',
        status: 502,
        code: 'UPSTREAM_PARSE_ERROR',
        details: {
          payload: response.data,
        },
      });
    }

    return response.data;
  } catch (error) {
    if (error instanceof ServiceError) {
      throw error;
    }

    if (error instanceof HttpError) {
      const status = typeof error.status === 'number' && error.status > 0 ? error.status : 502;
      throw new ServiceError({
        message: error.message,
        status,
        code: error.code ?? 'UPSTREAM_ERROR',
        details: error.details,
        cause: error,
      });
    }

    throw new ServiceError({
      message: error instanceof Error ? error.message : '未知错误',
      status: 502,
      code: 'UPSTREAM_NETWORK_ERROR',
      details: error,
      cause: error,
    });
  }
};

/**
 * 对已有故事文本生成摘要。
 * @param story 原始故事文本。
 * @returns 摘要文本，若未启用摘要模型则返回 null。
 * @throws ServiceError 当上游返回异常或结果缺失时抛出。
 */
export const summarizeStory = async (
  story: string
): Promise<string | null> => {
  if (!story?.trim()) {
    return null;
  }

  const config = loadLlmEnvConfig();
  if (!config.summaryModel) {
    return null;
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: getSummarySystemPrompt(),
    },
    {
      role: 'user',
      content: story,
    },
  ];

  const response = await performChatCompletion(
    {
      model: config.summaryModel,
      messages,
      temperature: 0.3,
    },
    config
  );

  const firstChoice = response.choices?.[0];
  const summary = firstChoice?.message?.content;

  if (!summary || typeof summary !== 'string') {
    throw new ServiceError({
      message: '摘要结果缺失',
      status: 502,
      code: 'UPSTREAM_INVALID_RESPONSE',
      details: {
        response,
      },
    });
  }

  return summary;
};

/**
 * 根据提示词或摘要向上游请求生成故事。
 * @param params.prompt 原始提示词。
 * @param params.summarizedStory 提供给模型的前情摘要。
 * @param params.temperature 采样温度，默认 0.7。
 * @returns 故事文本及 token 使用信息。
 * @throws ServiceError 当请求非法或上游失败时抛出。
 */
export const fetchStory = async (
  params: {
    prompt: string;
    summarizedStory?: string;
    temperature?: number;
  }
): Promise<{ story: string }> => {
  const { prompt, summarizedStory = '', temperature = 0.7 } = params;

  if (!prompt?.trim()) {
    throw new ServiceError({
      message: '故事主题不能为空',
      status: 400,
      code: 'INVALID_REQUEST',
    });
  }

  const payload: StoryPromptPayload = {
    storyPrompt: prompt,
    summarizedStory,
  };

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: getStorySystemPrompt(),
    },
    {
      role: 'user',
      content: JSON.stringify(payload),
    },
  ];

  const config = loadLlmEnvConfig();

  const response = await performChatCompletion(
    {
      model: config.storyModel,
      messages,
      temperature,
    },
    config
  );

  const firstChoice = response.choices?.[0];
  const content = firstChoice?.message?.content;

  if (!content || typeof content !== 'string') {
    throw new ServiceError({
      message: '故事结果缺失',
      status: 502,
      code: 'UPSTREAM_INVALID_RESPONSE',
      details: {
        response,
      },
    });
  }

  return {
    story: content,
  };
};

/**
 * 处理故事生成/续写请求，并在当前层统一做入参校验。
 * @param payload 请求体。
 */
export const handleStoryRequest = async (
  payload: unknown
): Promise<StoryApiResponse> => {
  if (!payload || typeof payload !== 'object') {
    throw new ServiceError({
      message: '请求体必须是对象',
      status: 400,
      code: 'INVALID_REQUEST',
    });
  }

  const request = payload as Partial<StoryApiRequest>;
  const { mode, prompt, storyContent, withSummary } = request;

  if (!mode || !allowedModes.includes(mode)) {
    throw new ServiceError({
      message: 'mode 参数只能是 generate 或 continue',
      status: 400,
      code: 'INVALID_REQUEST',
    });
  }

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ServiceError({
      message: 'prompt 不能为空',
      status: 400,
      code: 'INVALID_REQUEST',
    });
  }

  if (withSummary !== undefined && typeof withSummary !== 'boolean') {
    throw new ServiceError({
      message: 'withSummary 必须是布尔值',
      status: 400,
      code: 'INVALID_REQUEST',
    });
  }

  const storyMode = mode as StoryMode;
  const storyText = typeof storyContent === 'string' ? storyContent : undefined;
  const shouldSummarize = storyMode === 'continue' ? withSummary === true : false;

  if (storyMode === 'continue' && (!storyText || !storyText.trim())) {
    throw new ServiceError({
      message: '续写模式需要提供 storyContent',
      status: 400,
      code: 'INVALID_REQUEST',
    });
  }

  let summary: string | null = null;

  if (storyMode === 'continue' && shouldSummarize && storyText) {
    summary = await summarizeStory(storyText);
  }

  const { story } = await fetchStory({
    prompt: prompt.trim(),
    summarizedStory: storyMode === 'continue' ? summary ?? storyText ?? '' : '',
  });

  const response: StoryApiResponse = {
    story,
  };

  if (summary) {
    response.summary = summary;
  }

  return response;
};
