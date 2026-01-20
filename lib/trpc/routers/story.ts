/**
 * 故事生成 Router
 *
 * 提供故事生成与续写接口。
 */

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type OpenAI from 'openai';

import { router, publicProcedure, TRPCError } from '../init';
import { storyInputSchema } from '../schemas/story';
import { chatCompletion } from '@/lib/server/openai';

/**
 * 生成故事时使用的系统提示词。
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
 * 生成摘要时使用的系统提示词。
 */
const SUMMARY_SYSTEM_PROMPT = `
角色：连载故事摘要分析师

## 执行要求
* 1.按照剧情提取每个章节的关键情节，突出人物发展和关系变化
* 2.每个编号对应一个关键情节，使用简洁清晰的语言描述
* 3.关键情节定义: 新角色出场、重大事件、关系变化、情节转折

## 输出格式
1. [章节] + [关键事件]
2. [章节] + [关键事件]
3. [章节] + [关键事件]
...
`.trim();

/**
 * 从 OpenAI 返回中提取文本内容。
 */
const pickFirstChoiceText = (
    completion: OpenAI.Chat.Completions.ChatCompletion,
): string | null => {
    const content = completion.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.trim() ? content : null;
};

/**
 * 构造消息序列。
 */
type BuildStoryMessagesOptions =
    | { mode: 'generate'; prompt: string }
    | { mode: 'continue'; prompt: string; storyContent: string; summaryMode?: boolean };

const buildStoryMessages = (options: BuildStoryMessagesOptions): ChatCompletionMessageParam[] => {
    if (options.mode === 'generate') {
        return [
            { role: 'system', content: STORY_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify({ storyPrompt: options.prompt, summarizedStory: '' }) },
        ];
    }

    if (options.summaryMode) {
        return [
            { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
            { role: 'user', content: options.storyContent },
        ];
    }

    return [
        { role: 'system', content: STORY_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ storyPrompt: options.prompt, summarizedStory: options.storyContent }) },
    ];
};

/**
 * 调用 OpenAI 并解析故事文本。
 */
const requestStoryContent = async (options: BuildStoryMessagesOptions): Promise<string> => {
    const messages = buildStoryMessages(options);
    const completion = await chatCompletion(messages);
    const story = pickFirstChoiceText(completion);

    if (!story) {
        throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'OpenAI 返回的故事内容为空',
        });
    }

    return story;
};

export const storyRouter = router({
    /**
     * 生成/续写故事接口。
     */
    generate: publicProcedure
        .input(storyInputSchema)
        .mutation(async ({ input }) => {
            if (input.mode === 'generate') {
                const storyContent = await requestStoryContent({
                    mode: 'generate',
                    prompt: input.prompt,
                });

                return { storyContent, summaryContent: null };
            }

            // 续写模式
            let summary: string | null = null;
            if (input.withSummary) {
                summary = await requestStoryContent({
                    mode: 'continue',
                    prompt: input.prompt,
                    storyContent: input.storyContent,
                    summaryMode: true,
                });
            }

            const context = summary ?? input.storyContent;
            const storyContent = await requestStoryContent({
                mode: 'continue',
                prompt: input.prompt,
                storyContent: context,
            });

            return {
                storyContent,
                summaryContent: summary,
            };
        }),
});
