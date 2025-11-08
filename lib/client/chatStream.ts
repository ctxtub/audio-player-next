import { createParser } from 'eventsource-parser';

import { browserHttp } from '@/lib/http/browser';
import type { ChatCompletionPayload, ChatStreamEvent } from '@/types/chat';

/**
 * 聊天流式客户端错误，封装状态码与错误码便于上层处理。
 */
export class ChatStreamError extends Error {
  public readonly status: number;

  public readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ChatStreamError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 启动流式会话时可配置的选项集合。
 */
type StartStreamOptions = {
  /** 取消控制信号。 */
  signal?: AbortSignal;
  /** 收到流式事件时的回调。 */
  onEvent: (event: ChatStreamEvent) => void;
};

/**
 * 规范化 axios 默认头部，仅保留字符串类型。
 */
const extractDefaultHeaders = (): Record<string, string> => {
  const headers = browserHttp.defaults.headers ?? {};
  const common: Record<string, unknown> = {
    ...(headers.common ?? {}),
    ...(headers.post ?? {}),
  };
  const normalized: Record<string, string> = {};
  Object.entries(common).forEach(([key, value]) => {
    if (typeof value === 'string') {
      normalized[key] = value;
    }
  });
  normalized['Content-Type'] = 'application/json';
  return normalized;
};

/**
 * 拼接基础地址与相对路径，确保不会出现重复斜杠。
 * @param base axios 默认的 baseURL。 
 * @param path 目标路径。
 */
const joinUrl = (base: string | undefined, path: string) => {
  if (!base) {
    return path;
  }
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
};

/**
 * 创建聊天流式客户端，封装请求发送与 SSE 解析。
 */
export const createChatStreamClient = () => {
  const baseURL = browserHttp.defaults.baseURL;
  const defaultHeaders = extractDefaultHeaders();

  return {
    /**
     * 发起聊天流式请求，持续解析服务器返回的 SSE 事件。
     * @param payload 请求体，包含对话上下文。
     * @param options 包含 AbortSignal 与事件回调。
     */
    startStream: async (
      payload: ChatCompletionPayload,
      options: StartStreamOptions,
    ): Promise<void> => {
      const url = joinUrl(baseURL, '/api/chat');

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: defaultHeaders,
          body: JSON.stringify(payload),
          signal: options.signal,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        throw new ChatStreamError(
          error instanceof Error ? error.message : '网络异常，无法建立聊天连接',
          0,
          'NETWORK_ERROR',
        );
      }

      if (!response.ok) {
        let message = `聊天服务请求失败，状态码 ${response.status}`;
        let code = 'CHAT_STREAM_ERROR';
        try {
          const data = (await response.json()) as {
            error?: { code?: string; message?: string };
          };
          if (data?.error?.message) {
            message = data.error.message;
          }
          if (data?.error?.code) {
            code = data.error.code;
          }
        } catch {
          // 忽略解析失败，保持默认错误描述。
        }
        throw new ChatStreamError(message, response.status, code);
      }

      if (!response.body) {
        throw new ChatStreamError('聊天服务未返回可读流', response.status, 'EMPTY_STREAM');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let streamTerminated = false;

      const parser = createParser({
        onEvent: (event) => {
          if (!event.data) {
            return;
          }

          if (event.event === 'message') {
            try {
              const parsed = JSON.parse(event.data) as { delta?: string };
              if (parsed.delta) {
                options.onEvent({ type: 'message', delta: parsed.delta });
              }
            } catch (error) {
              streamTerminated = true;
              options.onEvent({
                type: 'error',
                code: 'STREAM_PARSE_ERROR',
                message: error instanceof Error ? error.message : '解析 message 事件失败',
              });
            }
            return;
          }

          if (event.event === 'done') {
            try {
              const parsed = JSON.parse(event.data) as {
                finishReason?: string;
                usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
              };
              options.onEvent({
                type: 'done',
                finishReason: parsed.finishReason ?? 'stop',
                usage: parsed.usage,
              });
            } catch {
              options.onEvent({
                type: 'done',
                finishReason: 'stop',
              });
            }
            streamTerminated = true;
            return;
          }

          if (event.event === 'error') {
            try {
              const parsed = JSON.parse(event.data) as { code?: string; message?: string };
              options.onEvent({
                type: 'error',
                code: parsed.code ?? 'CHAT_STREAM_ERROR',
                message: parsed.message ?? '聊天流式调用失败',
              });
            } catch (error) {
              options.onEvent({
                type: 'error',
                code: 'CHAT_STREAM_ERROR',
                message: error instanceof Error ? error.message : '聊天流式调用失败',
              });
            }
            streamTerminated = true;
          }
        },
        onError: (parseError) => {
          streamTerminated = true;
          options.onEvent({
            type: 'error',
            code: 'STREAM_PARSE_ERROR',
            message: parseError.message,
          });
        },
      });

      try {
        while (!streamTerminated) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            const chunk = decoder.decode(value, { stream: true });
            parser.feed(chunk);
          }
          if (streamTerminated) {
            break;
          }
        }
        if (!streamTerminated) {
          const remaining = decoder.decode();
          if (remaining) {
            parser.feed(remaining);
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
};
