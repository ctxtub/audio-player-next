
/**
 * 故事流式生成客户端
 *
 * 负责组装故事生成上下文（System Prompt + Chat Context），并调用 Chat Router。
 */

import { trpc } from '@/lib/trpc/client';
import { useChatStore } from '@/stores/chatStore';

/**
 * 故事生成使用的系统提示词
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
 * 流式生成故事。
 * @param prompt 故事提示词或续写指令。
 * @param handlers 回调处理函数。
 * @returns 用于取消订阅的 unsubscribe 函数。
 */
export const generateStoryStream = async (
    prompt: string,
    handlers: {
        onChunk: (chunk: string) => void;
        onComplete: (fullContent: string) => void;
        onError: (error: Error) => void;
    }
) => {
    const controller = new AbortController();

    // 1. 获取上下文
    const chatStore = useChatStore.getState();
    const history = chatStore.conversationContext; // 获取已有的对话历史 (标准 Role 格式)

    // 2. 构造消息体
    const messages = [
        { role: 'system', content: STORY_SYSTEM_PROMPT },
        ...history,
    ] as any[];

    // 避免重复添加：如果 history 的最后一条消息内容与 prompt 一致（且角色为 user），则认为已在上下文中
    const lastMsg = history[history.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== prompt) {
        messages.push({ role: 'user', content: prompt });
    }

    // 内部累积文本，因为 Chat Router 的 done 事件不包含 fullContent
    let fullContent = '';

    try {
        const stream = await trpc.chat.stream.mutate(
            { messages },
            { signal: controller.signal }
        );

        for await (const event of stream) {
            if (event.type === 'message') {
                const delta = event.delta;
                fullContent += delta;
                handlers.onChunk(delta);
            } else if (event.type === 'done') {
                handlers.onComplete(fullContent);
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
