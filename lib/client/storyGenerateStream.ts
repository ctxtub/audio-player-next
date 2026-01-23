/**
 * 故事流式生成客户端
 *
 * 使用 tRPC subscription 请求流式故事生成。
 */

import { trpc } from '@/lib/trpc/client';
import type { StoryStreamEvent } from '@/lib/trpc/routers/storyStream';

/**
 * 流式生成故事。
 * @param prompt 故事提示词。
 * @param handlers 回调处理函数。
 * @returns 用于取消订阅的 unsubscribe 函数。
 */
export const generateStoryStream = (
    prompt: string,
    handlers: {
        onChunk: (chunk: string) => void;
        onComplete: (fullContent: string) => void;
        onError: (error: Error) => void;
    }
) => {
    const subscription = trpc.storyStream.generate.subscribe(
        { prompt },
        {
            onData(event: StoryStreamEvent) {
                if (event.type === 'chunk') {
                    handlers.onChunk(event.delta);
                } else if (event.type === 'done') {
                    handlers.onComplete(event.fullContent);
                } else if (event.type === 'error') {
                    handlers.onError(new Error(event.message));
                }
            },
            onError(err) {
                handlers.onError(err);
            },
        }
    );

    return subscription;
};
