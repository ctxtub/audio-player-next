import {
  createParser,
  type EventSourceMessage,
  type EventSourceParser,
  type ParseError,
} from "eventsource-parser";

/** 文本编码器用于将 SSE 帧转换为字节数组写入响应。 */
const textEncoder = new TextEncoder();

/**
 * SSE 事件的结构定义，限定事件名与数据载荷类型。
 */
export type SseEventPayload = {
  event: "message" | "done" | "error";
  data: unknown;
};

/**
 * 创建 OpenAI 流式响应的解析器。
 * @param onMessage 当解析出有效事件时的回调函数。
 */
export const createOpenAIParser = (
  callbacks: {
    onMessage: (event: EventSourceMessage) => void;
    onError?: (error: ParseError) => void;
  },
): EventSourceParser =>
  createParser({
    onEvent: callbacks.onMessage,
    onError: callbacks.onError,
  });

/**
 * 将结构化的 SSE 事件编码为字节数组，便于写入 ReadableStream。
 * @param payload 需要发送给客户端的 SSE 事件。
 */
export const formatSseEvent = (payload: SseEventPayload): Uint8Array => {
  const serialized = `event: ${payload.event}\ndata: ${JSON.stringify(payload.data)}\n\n`;
  return textEncoder.encode(serialized);
};

/**
 * 读取上游返回的可读流并持续喂给 SSE 解析器。
 * @param upstream 来自 OpenAI 的原始可读流。
 * @param parser 事件解析器实例。
 */
export const streamOpenAIChunks = async (
  upstream: ReadableStream<Uint8Array>,
  parser: EventSourceParser,
): Promise<void> => {
  const reader = upstream.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      if (value) {
        const decoded = decoder.decode(value, { stream: true });
        parser.feed(decoded);
      }
    }

    const remaining = decoder.decode();
    if (remaining) {
      parser.feed(remaining);
    }
  } finally {
    reader.releaseLock();
  }
};
