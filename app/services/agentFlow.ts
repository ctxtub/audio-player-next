import { trpc } from '@/lib/trpc/client';
import { useChatStore } from '@/stores/chatStore';
import { useConfigStore } from '@/stores/configStore';
import { fetchAudio } from '@/lib/client/ttsGenerate';

/**
 * 统一 Agent 交互服务。
 * 替代原有的 chatFlow 和 storyFlow 的请求部分。
 */
export const interactWithAgent = async (content: string) => {
    const chatStore = useChatStore.getState();

    // 1. 准备提交
    const { context } = chatStore.prepareNewSubmission(content);

    // 2. 将 context 转换为 Agent 需要的 { role, content } 格式
    const history = context.map((c) => ({
        role: c.role,
        content: String(c.content || ""),
    }));

    try {
        // 3. 发起请求
        const subscription = await trpc.agent.interact.mutate({
            content,
            history,
        });

        let currentIntent: "Story" | "Chat" | "Guidance" | null = null;

        // 4. 处理流式事件
        for await (const event of subscription) {
            if (event.type === 'meta') {
                currentIntent = event.intent as "Story" | "Chat" | "Guidance";
                console.log('Detected Intent:', currentIntent);
            } else if (event.type === 'token') {
                // 追加文本
                chatStore.appendAssistantDelta(event.content);
            }
        }

        // 5. 结束处理
        // 如果是故事模式，尝试自动生成音频
        const fullText = chatStore.activeAssistantMessage?.content || "";
        if (currentIntent === 'Story' && fullText) {
            // 异步生成音频，不阻塞当前流程
            triggerStoryPostProcessing(fullText, chatStore.activeAssistantMessage?.id);
        }

        // Finalize message
        chatStore.finalizeAssistantMessage({ type: 'done', finishReason: 'stop' });

    } catch (error) {
        console.error('Agent interaction failed:', error);
        chatStore.markFailure();
        throw error;
    }
};

/**
 * 故事后处理：生成音频
 */
const triggerStoryPostProcessing = async (text: string, messageId?: string) => {
    if (!text || !messageId) return;
    const config = useConfigStore.getState().apiConfig;
    try {
        const audioUrl = await fetchAudio(text, config.voiceId, config.speed);
        console.log('Audio generated:', audioUrl);
        // TODO: Update ChatStore message with audioUrl (Needs new action in ChatStore)
    } catch (error) {
        console.error('TTS failed:', error);
    }
};
