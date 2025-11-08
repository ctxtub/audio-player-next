import OpenAI, { APIError } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { ServiceError } from "@/lib/http/server/ErrorHandler";

import { getOrCreateOpenAiClient } from "./client";
import { loadOpenAiEnvConfig } from "./env";

/** OpenAI Chat Completion 接口使用的消息结构，与官方 SDK 对齐。 */
export type OpenAiChatMessage = ChatCompletionMessageParam;

/**
 * 调用 OpenAI Chat Completions 接口，返回官方 SDK 的原始结构。
 * @param messages BFF 层组装好的消息序列。
 * @returns OpenAI SDK 原样返回的 ChatCompletion 结果。
 * @throws ServiceError 当入参非法或上游返回错误时抛出。
 */
export const invokeChatCompletion = async (
  messages: OpenAiChatMessage[],
): Promise<OpenAI.Chat.Completions.ChatCompletion> => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ServiceError({
      message: "调用 OpenAI 需要至少一条消息",
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  const config = loadOpenAiEnvConfig();
  const client = getOrCreateOpenAiClient(config);

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
