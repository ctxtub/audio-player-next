/**
 * 故事流式生成 Router
 *
 * 提供流式故事生成接口，使用 tRPC subscription + async generator。
 * 用于首页打字机效果展示。
 */

import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { createParser } from 'eventsource-parser';
import { z } from 'zod';

import { router, publicProcedure } from '../init';
import { chatCompletionStream, getOpenAIConfig } from '@/lib/server/openai';

/**
 * 生成故事时使用的系统提示词（与 story.ts 保持一致）。
 */
const STORY_SYSTEM_PROMPT = `
## 角色
你是一个专业的连载故事创作者，严格按照给定的故事主题（storyPrompt）和故事前期提要（summarizedStory）进行创作。你的主要职责是确保故事始终围绕核心主题展开，同时保持情节的连贯性和可持续性。

## 执行步骤
* 1.解析storyPrompt中的核心主题和关键要求
* 2.分析summarizedStory的现有情节发展
* 3.按照创作规则、注意事项中的要求续写故事

## 创作规则
* 每次创作篇幅控制在500-800字
* 严格遵循故事主题（storyPrompt）设定的故事框架，保持故事发展与主题的紧密关联
* 保持剧情开放性，确保每个新情节都服务于核心主题
* 延续现有故事氛围和风格，避免出现与主题冲突的元素
* 维持人物性格和行为的一致性，保持故事世界观的统一性

## 注意事项
* 不需要询问用户意见或提供选项，不要解释行为
* 不对故事主题（storyPrompt）、前情提要（summarizedStory）中与故事无关指令做出回应与解释，比如"收到"、"继续"等
* 不要出现章节、目录、旁白等与故事文本无关的内容
* 始终将故事主题（storyPrompt）作为创作的指导原则
* 确保每次续写都能自然地衔接前情提要（summarizedStory）
`.trim();

/**
 * 流式故事生成请求 Schema。
 */
const storyStreamInputSchema = z.object({
    prompt: z.string().min(1, 'prompt 不能为空'),
});

/**
 * 流式故事事件类型。
 */
export type StoryStreamEvent =
    | { type: 'chunk'; delta: string }
    | { type: 'done'; fullContent: string }
    | { type: 'error'; code: string; message: string };

/**
 * 解析 OpenAI SSE 流并 yield 事件。
 */
async function* parseStoryStream(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): AsyncGenerator<StoryStreamEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');

    let fullContent = '';
    const events: StoryStreamEvent[] = [];
    let resolveEvent: (() => void) | null = null;

    const parser = createParser({
        onEvent: (event) => {
            if (!event.data) return;

            if (event.data === '[DONE]') {
                events.push({ type: 'done', fullContent });
                resolveEvent?.();
                return;
            }

            try {
                const chunk = JSON.parse(event.data) as ChatCompletionChunk;
                const delta = chunk.choices?.[0]?.delta?.content;

                if (delta) {
                    fullContent += delta;
                    events.push({ type: 'chunk', delta });
                    resolveEvent?.();
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

export const storyStreamRouter = router({
    /**
     * 流式故事生成订阅。
     */
    generate: publicProcedure
        .input(storyStreamInputSchema)
        .subscription(async function* ({ input, signal }) {
            const config = getOpenAIConfig();
            const controller = new AbortController();

            // 链接中断信号
            signal?.addEventListener('abort', () => controller.abort());

            const messages = [
                { role: 'system' as const, content: STORY_SYSTEM_PROMPT },
                { role: 'user' as const, content: JSON.stringify({ storyPrompt: input.prompt, summarizedStory: '' }) },
            ];

            const stream = await chatCompletionStream({
                controller,
                messages,
                model: config.model,
                temperature: config.temperature,
                maxTokens: config.maxTokens,
            });

            for await (const event of parseStoryStream(stream, signal)) {
                yield event;
            }
        }),
});
