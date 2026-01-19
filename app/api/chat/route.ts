import { NextResponse } from "next/server";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

import { ServiceError } from "@/lib/http/server/ErrorHandler";
import {
  chatCompletionStream,
  getOpenAIConfig,
  type OpenAIConfig,
} from "@/lib/server/openai";

import {
  createOpenAIParser,
  formatSseEvent,
  streamOpenAIChunks,
} from "./utils/sse";

/** 默认采样温度，用于请求未显式指定时的回退值。 */
const DEFAULT_TEMPERATURE = 0.7;
/** 默认的 nucleus sampling 上限，用于请求未显式指定时的回退值。 */
const DEFAULT_TOP_P = 1;
/** 默认的最大输出 token 数，用于请求未显式指定时的回退值。 */
const DEFAULT_MAX_TOKENS = 2048;

/**
 * Chat 接口在 BFF 层的规范化请求结构。
 */
type NormalizedChatRequest = {
  model: string;
  messages: ChatCompletionMessageParam[];
  temperature: number;
  topP: number;
  maxTokens: number;
};

/**
 * 将错误信息转换为统一的 JSON 响应结构。
 * @param status HTTP 状态码。
 * @param code 业务错误码。
 * @param message 错误描述。
 */
const buildErrorResponse = (status: number, code: string, message: string) =>
  NextResponse.json(
    {
      error: {
        code,
        message,
      },
    },
    { status },
  );

/**
 * 将请求中的数字字段解析为合法的数值。
 * @param value 原始字段取值。
 * @param options 字段名称及允许的取值范围。
 */
const parseOptionalNumber = (
  value: unknown,
  options: { name: string; min?: number; max?: number },
): number | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numeric)) {
    throw new ServiceError({
      message: `${options.name} 必须是数值`,
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  if (options.min !== undefined && numeric < options.min) {
    throw new ServiceError({
      message: `${options.name} 不能小于 ${options.min}`,
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  if (options.max !== undefined && numeric > options.max) {
    throw new ServiceError({
      message: `${options.name} 不能大于 ${options.max}`,
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  return numeric;
};

/**
 * 将原始请求载荷规范化为后续调用所需的结构。
 * @param payload 原始 JSON 载荷。
 * @param config OpenAI 环境配置，用于填充默认值。
 */
const normalizeChatPayload = (
  payload: unknown,
  config: OpenAIConfig,
): NormalizedChatRequest => {
  if (!payload || typeof payload !== "object") {
    throw new ServiceError({
      message: "请求体必须是对象",
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  const source = payload as Record<string, unknown>;

  const rawMessages = source.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new ServiceError({
      message: "messages 必须是非空数组",
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  const messages = rawMessages.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new ServiceError({
        message: `messages[${index}] 必须是对象`,
        status: 400,
        code: "INVALID_REQUEST",
      });
    }

    const role = (item as Record<string, unknown>).role;
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new ServiceError({
        message: `messages[${index}].role 仅支持 system|user|assistant`,
        status: 400,
        code: "INVALID_REQUEST",
      });
    }

    const contentValue = (item as Record<string, unknown>).content;
    const content = typeof contentValue === "string" ? contentValue.trim() : "";
    if (!content) {
      throw new ServiceError({
        message: `messages[${index}].content 不能为空`,
        status: 400,
        code: "INVALID_REQUEST",
      });
    }

    return {
      role,
      content,
    } satisfies ChatCompletionMessageParam;
  });

  const modelField = typeof source.model === "string" ? source.model.trim() : "";
  const model = modelField || config.model || "gpt-4o-mini";

  const temperature =
    parseOptionalNumber(source.temperature, {
      name: "temperature",
      min: 0,
      max: 2,
    }) ?? config.temperature ?? DEFAULT_TEMPERATURE;

  const topP =
    parseOptionalNumber(source.top_p ?? source.topP, {
      name: "top_p",
      min: 0,
      max: 1,
    }) ?? DEFAULT_TOP_P;

  const maxTokens =
    parseOptionalNumber(source.max_tokens ?? source.maxTokens, {
      name: "max_tokens",
      min: 1,
    }) ?? config.maxTokens ?? DEFAULT_MAX_TOKENS;

  if (!Number.isInteger(maxTokens)) {
    throw new ServiceError({
      message: "max_tokens 必须是整数",
      status: 400,
      code: "INVALID_REQUEST",
    });
  }

  return {
    model,
    messages,
    temperature,
    topP,
    maxTokens,
  };
};

/**
 * 构造 `done` 事件的载荷，附带可用的 usage 信息。
 * @param finishReason OpenAI 返回的结束原因。
 * @param usage OpenAI 返回的 tokens 统计信息。
 */
const buildDonePayload = (
  finishReason: string | undefined,
  usage: ChatCompletionChunk["usage"] | undefined,
) => {
  const payload: {
    finishReason: string;
    usage?: ChatCompletionChunk["usage"];
  } = {
    finishReason: finishReason ?? "stop",
  };

  if (usage) {
    payload.usage = usage;
  }

  return payload;
};

/**
 * 处理 `/api/chat` 的 POST 请求，提供 SSE 流式返回能力。
 * @param req Next.js 路由处理器的 Request 对象。
 */
export const POST = async (req: Request) => {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch (error) {
    return buildErrorResponse(
      400,
      "INVALID_JSON",
      `请求体不是合法的 JSON: ${error instanceof Error ? error.message : "未知错误"}`,
    );
  }

  let config: OpenAIConfig;
  try {
    config = getOpenAIConfig();
  } catch (error) {
    if (error instanceof ServiceError) {
      return buildErrorResponse(error.status, error.code, error.message);
    }

    return buildErrorResponse(500, "SERVER_CONFIG_ERROR", "Chat 服务缺少必要配置");
  }

  let normalized: NormalizedChatRequest;
  try {
    normalized = normalizeChatPayload(payload, config);
  } catch (error) {
    if (error instanceof ServiceError) {
      return buildErrorResponse(error.status, error.code, error.message);
    }

    return buildErrorResponse(500, "INTERNAL_SERVER_ERROR", "Chat 接口发生未知错误");
  }

  const aborter = new AbortController();
  let upstreamStream: ReadableStream<Uint8Array>;
  try {
    upstreamStream = await chatCompletionStream({
      controller: aborter,
      messages: normalized.messages,
      model: normalized.model,
      temperature: normalized.temperature,
      topP: normalized.topP,
      maxTokens: normalized.maxTokens,
    });
  } catch (error) {
    if (error instanceof ServiceError) {
      return buildErrorResponse(error.status, error.code, error.message);
    }

    return buildErrorResponse(502, "UPSTREAM_NETWORK_ERROR", "调用 OpenAI 失败");
  }

  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastFinishReason: string | undefined;
      let usageSummary: ChatCompletionChunk["usage"] | undefined;

      const finalizeStream = (
        finishReason?: string,
        usage?: ChatCompletionChunk["usage"],
      ) => {
        if (closed) {
          return;
        }

        closed = true;
        controller.enqueue(
          formatSseEvent({
            event: "done",
            data: buildDonePayload(
              finishReason ?? lastFinishReason,
              usage ?? usageSummary,
            ),
          }),
        );
        controller.close();
      };

      const sendError = (code: string, message: string) => {
        if (closed) {
          return;
        }

        controller.enqueue(
          formatSseEvent({
            event: "error",
            data: { code, message },
          }),
        );
        finalizeStream("error");
        aborter.abort();
      };

      const parser = createOpenAIParser({
        onMessage: (message) => {
          if (!message.data) {
            return;
          }

          if (message.data === "[DONE]") {
            finalizeStream();
            return;
          }

          try {
            const chunk = JSON.parse(message.data) as ChatCompletionChunk;
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              controller.enqueue(formatSseEvent({ event: "message", data: { delta } }));
            }

            const finishReason = chunk.choices?.[0]?.finish_reason;
            if (finishReason) {
              lastFinishReason = finishReason;
            }

            if (chunk.usage) {
              usageSummary = chunk.usage;
            }
          } catch (error) {
            sendError(
              "STREAM_PARSE_ERROR",
              error instanceof Error ? error.message : "解析上游数据失败",
            );
          }
        },
        onError: (parseError) => {
          sendError("STREAM_PARSE_ERROR", parseError.message);
        },
      });

      streamOpenAIChunks(upstreamStream, parser)
        .then(() => {
          finalizeStream();
        })
        .catch((error) => {
          sendError(
            "STREAM_INTERRUPTED",
            error instanceof Error ? error.message : "上游流式响应中断",
          );
        });
    },
    cancel() {
      closed = true;
      aborter.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
};
