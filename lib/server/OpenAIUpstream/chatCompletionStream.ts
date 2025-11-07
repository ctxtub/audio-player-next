import { ServiceError } from "@/lib/http/server/ErrorHandler";

import type { OpenAiChatMessage } from "./chatCompletion";
import { loadOpenAiEnvConfig } from "./env";

/**
 * OpenAI 流式 Chat Completion 调用的参数结构定义。
 */
export type StreamingChatCompletionOptions = {
  /** 用于取消请求的 AbortController。 */
  controller: AbortController;
  /** 发送给 OpenAI 的消息列表。 */
  messages: OpenAiChatMessage[];
  /** 可选的模型名称覆盖。 */
  model?: string;
  /** 可选的温度值。 */
  temperature?: number;
  /** 可选的 nucleus sampling 阈值。 */
  topP?: number;
  /** 可选的最大输出 token 数。 */
  maxTokens?: number;
};

/**
 * 调用 OpenAI Chat Completions 接口并返回原始的 SSE 流。
 * @param options 上游请求所需的参数集合。
 * @throws ServiceError 当入参非法或上游返回错误时抛出。
 */
export const invokeStreamingChatCompletion = async (
  options: StreamingChatCompletionOptions,
): Promise<ReadableStream<Uint8Array>> => {
  if (!Array.isArray(options.messages) || options.messages.length === 0) {
    throw new ServiceError({
      message: "调用 OpenAI 需要至少一条消息",
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  const config = loadOpenAiEnvConfig();
  const endpointBase = config.baseUrl ?? "https://api.openai.com/v1";
  const endpoint = `${endpointBase}/chat/completions`;

  const payload: Record<string, unknown> = {
    model: options.model ?? config.model,
    messages: options.messages,
    stream: true,
  };

  if (options.temperature !== undefined) {
    payload.temperature = options.temperature;
  } else if (config.temperature !== undefined) {
    payload.temperature = config.temperature;
  }

  if (options.topP !== undefined) {
    payload.top_p = options.topP;
  }

  if (options.maxTokens !== undefined) {
    payload.max_tokens = options.maxTokens;
  } else if (config.maxTokens !== undefined) {
    payload.max_tokens = config.maxTokens;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: options.controller.signal,
    });

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }

      throw new ServiceError({
        message: `OpenAI 返回错误: ${response.statusText || response.status}`,
        status: response.status || 502,
        code: "UPSTREAM_ERROR",
        details: errorBody,
      });
    }

    const stream = response.body;
    if (!stream) {
      throw new ServiceError({
        message: "OpenAI 响应不包含可读流",
        status: 502,
        code: "UPSTREAM_BAD_RESPONSE",
      });
    }

    return stream;
  } catch (error) {
    if (error instanceof ServiceError) {
      throw error;
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
