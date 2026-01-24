/**
 * 聊天故事流服务
 *
 * 在聊天上下文中执行故事生成流程，融合 chatFlow 的消息管理与 storyFlow 的生成能力。
 * 生成结果以 StoryCardPart 形式呈现在对话中。
 */

import { fetchAudio } from '@/lib/client/ttsGenerate';
import { generateStoryStream } from '@/lib/client/storyGenerateStream';
import { useConfigStore } from '@/stores/configStore';
import { useChatStore } from '@/stores/chatStore';
import { useGenerationStore } from '@/stores/generationStore';

/**
 * 确保配置已加载并合法。
 * @returns 当前有效的配置对象
 */
const ensureConfigReady = () => {
    const configState = useConfigStore.getState();
    if (!configState.isConfigValid()) {
        throw new Error('请先完成配置，再开始生成故事');
    }
    return configState.apiConfig;
};

/**
 * 聊天故事流的返回结果。
 */
export type ChatStoryResult = {
    /** 生成的故事文本。 */
    storyText: string;
    /** 生成的音频地址。 */
    audioUrl: string;
};

/**
 * 在聊天上下文中执行故事生成流程。
 *
 * 流程：
 * 1. 创建用户消息占位
 * 2. 流式生成故事文本（更新 generationStore 供 UI 展示）
 * 3. 生成音频
 * 4. 完成消息，转换为 StoryCardPart
 *
 * @param prompt 用户输入的故事主题
 * @returns 生成结果，包含故事文本和音频地址
 */
export const beginChatStoryStream = async (
    prompt: string,
): Promise<ChatStoryResult> => {
    const apiConfig = ensureConfigReady();
    const generationStore = useGenerationStore.getState();

    // 1. 准备故事类型的消息占位（从一开始就使用 StoryCardPart）
    useChatStore.getState().prepareStorySubmission(prompt);

    // 2. 重置生成状态，进入文本生成阶段
    generationStore.reset();
    generationStore.setPhase('generating_text');

    // 3. 流式生成故事文本
    const storyText = await new Promise<string>((resolve, reject) => {
        generateStoryStream(prompt, {
            onChunk: (chunk) => {
                // 同时更新 chatStore 和 generationStore
                useChatStore.getState().appendAssistantDelta(chunk);
                useGenerationStore.getState().appendText(chunk);
            },
            onComplete: (content) => {
                resolve(content);
            },
            onError: (error) => {
                reject(error);
            },
        });
    });

    // 4. 进入音频生成阶段
    generationStore.setPhase('generating_audio');

    try {
        const audioUrl = await fetchAudio(storyText, apiConfig.voiceId);

        // 5. 完成消息，附带故事卡片元数据
        useChatStore.getState().finalizeStoryMessage({
            storyText,
            audioUrl,
        });

        generationStore.setPhase('ready');

        return { storyText, audioUrl };
    } catch (error) {
        generationStore.setError(
            error instanceof Error ? error.message : '音频生成失败',
        );
        useChatStore.getState().markFailure();
        throw error;
    }
};

/**
 * 取消当前的聊天故事流。
 */
export const cancelChatStoryStream = () => {
    useGenerationStore.getState().reset();
    useChatStore.getState().resetActiveSession();
};
