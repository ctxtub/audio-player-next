/**
 * 聊天流式客户端
 *
 * 使用 tRPC subscription 进行流式聊天。
 */

import { trpc } from '@/lib/trpc/client';
import type { ChatCompletionPayload, ChatStreamEvent } from '@/types/chat';

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
 * 创建聊天流式客户端。
 */
export const createChatStreamClient = () => {
  return {
    /**
     * 发起聊天流式请求，通过 tRPC subscription 接收事件。
     * @param payload 请求体，包含对话上下文。
     * @param options 包含 AbortSignal 与事件回调。
     */
    startStream: async (
      payload: ChatCompletionPayload,
      options: StartStreamOptions,
    ): Promise<void> => {
      return new Promise((resolve, reject) => {
        const subscription = trpc.chat.stream.subscribe(
          {
            model: payload.model,
            messages: payload.messages.map((m) => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : '',
            })),
            temperature: payload.temperature,
            top_p: payload.top_p,
            max_tokens: payload.max_tokens,
          },
          {
            onData: (event) => {
              options.onEvent(event as ChatStreamEvent);

              if (event.type === 'done' || event.type === 'error') {
                subscription.unsubscribe();
                resolve();
              }
            },
            onError: (error) => {
              subscription.unsubscribe();
              reject(error);
            },
            onComplete: () => {
              resolve();
            },
          }
        );

        // 处理取消信号
        options.signal?.addEventListener('abort', () => {
          subscription.unsubscribe();
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    },
  };
};
