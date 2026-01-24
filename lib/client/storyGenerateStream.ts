/**
 * 故事流式生成客户端
 *
 * 使用 tRPC subscription 请求流式故事生成。
 */

import { trpc } from '@/lib/trpc/client';

/**
 * 流式生成故事。
 * @param prompt 故事提示词。
 * @param handlers 回调处理函数。
 * @returns 用于取消订阅的 unsubscribe 函数。
 */
export const generateStoryStream = async (
    prompt: string,
    handlers: {
        onChunk: (chunk: string) => void;
        onComplete: (fullContent: string) => void;
        onError: (error: Error) => void;
    },
    previousStory?: { summarizedStory: string }
) => {
    const controller = new AbortController();

    try {
        const stream = await trpc.storyStream.generate.mutate(
            { prompt, previousStory },
            { signal: controller.signal }
        );

        for await (const event of stream) {
            if (event.type === 'chunk') {
                handlers.onChunk(event.delta);
            } else if (event.type === 'done') {
                handlers.onComplete(event.fullContent);
            } else if (event.type === 'error') {
                handlers.onError(new Error(event.message));
            }
        }
    } catch (err) {
        handlers.onError(err instanceof Error ? err : new Error('Unknown error'));
    }

    return {
        unsubscribe: () => controller.abort(),
    };
};
