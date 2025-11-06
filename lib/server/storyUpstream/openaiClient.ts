import OpenAI, { APIError } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { ServiceError } from "@/lib/http/server/ErrorHandler";

import { loadOpenAiEnvConfig } from "./config";
import type { OpenAiEnvConfig } from "./config";

/**
 * 对外暴露的消息类型，与 OpenAI SDK 定义保持一致。
 */
export type StoryMessage = ChatCompletionMessageParam;

/**
 * 复用的 OpenAI 客户端实例，避免重复初始化。
 */
let cachedClient: OpenAI | null = null;

/**
 * 根据配置创建或返回复用的 OpenAI 客户端。
 * @param config 已解析好的环境配置。
 */
const getOrCreateClient = (config: OpenAiEnvConfig): OpenAI => {
  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  return cachedClient;
};

/**
 * 调用 OpenAI Chat Completions 接口，返回官方 SDK 的原始结构。
 * @param messages 已经在 BFF 层组装好的消息序列。
 * @returns OpenAI SDK 原样返回的 ChatCompletion 结果。
 * @throws ServiceError 当上游返回错误或网络异常时抛出。
 */
export const invokeChatCompletion = async (
  messages: StoryMessage[],
): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ServiceError({
      message: "调用 OpenAI 需要至少一条消息", 
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  const config = loadOpenAiEnvConfig();
  const client = getOrCreateClient(config);

  try {
    const payload: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: config.model,
      messages,
    };

    if (config.temperature !== undefined) {
      payload.temperature = config.temperature;
    }

    if (config.maxTokens !== undefined) {
      payload.max_tokens = config.maxTokens;
    }

    return await client.chat.completions.create(payload);
  } catch (error) {
    if (error instanceof ServiceError) {
      throw error;
    }

    if (error instanceof APIError) {
      const statusCode = typeof error.status === "number" && error.status > 0 ? error.status : 502;
      throw new ServiceError({
        message: error.message,
        status: statusCode,
        code: "UPSTREAM_ERROR",
        details: {
          type: error.type,
          param: error.param,
          code: error.code,
          headers: error.headers,
        },
        cause: error,
      });
    }

    throw new ServiceError({
      message: error instanceof Error ? error.message : "OpenAI 请求失败", 
      status: 502,
      code: "UPSTREAM_NETWORK_ERROR",
      details: error,
      cause: error,
    });
  }
};
