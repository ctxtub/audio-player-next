/**
 * 聊天 Router
 *
 * 提供流式聊天接口，使用 tRPC subscription + async generator。
 */

import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { createParser } from 'eventsource-parser';

import { router, publicProcedure } from '../init';
import { chatInputSchema } from '../schemas/chat';
import { chatCompletionStream, getOpenAIConfig } from '@/lib/server/openai';
import type { ChatStreamEvent } from '../schemas/chat';

/**
 * 解析 OpenAI SSE 流并 yield 事件。
 */
async function* parseOpenAIStream(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');

    let lastFinishReason: string | undefined;
    let usageSummary: ChatCompletionChunk['usage'] | undefined;

    const events: ChatStreamEvent[] = [];
    let resolveEvent: (() => void) | null = null;

    const parser = createParser({
        onEvent: (event) => {
            if (!event.data) return;

            if (event.data === '[DONE]') {
                events.push({
                    type: 'done',
                    finishReason: lastFinishReason ?? 'stop',
                    usage: usageSummary ? {
                        promptTokens: usageSummary.prompt_tokens,
                        completionTokens: usageSummary.completion_tokens,
                        totalTokens: usageSummary.total_tokens,
                    } : undefined,
                });
                resolveEvent?.();
                return;
            }

            try {
                const chunk = JSON.parse(event.data) as ChatCompletionChunk;
                const delta = chunk.choices?.[0]?.delta?.content;

                if (delta) {
                    events.push({ type: 'message', delta });
                    resolveEvent?.();
                }

                const finishReason = chunk.choices?.[0]?.finish_reason;
                if (finishReason) {
                    lastFinishReason = finishReason;
                }

                if (chunk.usage) {
                    usageSummary = chunk.usage;
                }
            } catch (error) {
                events.push({
                    type: 'error',
                    code: 'STREAM_PARSE_ERROR',
                    message: error instanceof Error ? error.message : '解析上游数据失败',
                });
                resolveEvent?.();
            }
        },
        onError: (parseError) => {
            events.push({
                type: 'error',
                code: 'STREAM_PARSE_ERROR',
                message: parseError.message,
            });
            resolveEvent?.();
        },
    });

    // 后台读取流并喂给 parser
    const readStream = async () => {
        try {
            while (true) {
                if (signal?.aborted) break;

                const { value, done } = await reader.read();
                if (done) break;

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

    const streamPromise = readStream();

    // 从 events 队列中 yield
    while (true) {
        if (events.length > 0) {
            const event = events.shift()!;
            yield event;

            if (event.type === 'done' || event.type === 'error') {
                break;
            }
        } else {
            // 等待新事件
            await new Promise<void>((resolve) => {
                resolveEvent = resolve;
                // 超时防止死锁
                setTimeout(resolve, 100);
            });
        }

        if (signal?.aborted) break;
    }

    await streamPromise;
}

export const chatRouter = router({
    /**
     * 流式聊天订阅。
     */
    stream: publicProcedure
        .input(chatInputSchema)
        .mutation(async function* ({ input, signal }) {
            const config = getOpenAIConfig();
            const controller = new AbortController();

            // 链接中断信号
            signal?.addEventListener('abort', () => controller.abort());

            const stream = await chatCompletionStream({
                controller,
                messages: input.messages,
                model: input.model ?? config.model,
                temperature: input.temperature,
                topP: input.top_p,
                maxTokens: input.max_tokens,
            });

            for await (const event of parseOpenAIStream(stream, signal)) {
                yield event;
            }
        }),
});
