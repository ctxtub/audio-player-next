import { trpc } from '@/lib/trpc/client';
import type { AgentMessage, AgentConfig } from '@/types/agent';

export type { AgentMessage, AgentConfig };

/**
 * Agent 流式回调接口。
 */
export interface AgentStreamCallbacks {
    /**
     * 接收到的新文本片段 (Token)。
     */
    onTextDelta: (delta: string) => void;
    /**
     * 识别到的用户意图。
     */
    onIntentDetected?: (intent: "Story" | "Chat" | "Guidance") => void;
    /**
     * 流式传输完成。
     */
    onComplete: () => void;
    /**
     * 发生错误。
     */
    onError: (error: Error) => void;
    /**
     * 开始生成语音。
     */
    onAudioStart?: () => void;
    /**
     * 接收到的语音音频数据 (Blob URL)。
     */
    onAudioComplete?: (audioUrl: string) => void;
}

/**
 * 统一 Agent 交互接口。
 * 负责发起 TRPC 请求并分发流式事件，不依赖任何 Store 状态。
 *
 * @param messages 完整的对话历史（含当前用户输入）。
 * @param callbacks 事件回调集合。
 * @param signal AbortSignal 用于取消请求。
 * @param config Agent 配置参数。
 */
export const interactWithAgent = async (
    messages: AgentMessage[],
    callbacks: AgentStreamCallbacks,
    signal?: AbortSignal,
    config?: AgentConfig
): Promise<void> => {
    try {
        const subscription = await trpc.agent.interact.mutate(
            { messages, agentConfig: config },
            { signal }
        );

        for await (const event of subscription) {
            if (event.type === 'token') {
                callbacks.onTextDelta(event.content);
            } else if (event.type === 'meta') {
                console.log('Detected Intent in AgentFlow:', event.intent);
                callbacks.onIntentDetected?.(event.intent as "Story" | "Chat" | "Guidance");
            } else if (event.type === 'audio_start') {
                callbacks.onAudioStart?.();
            } else if (event.type === 'audio') {
                if (callbacks.onAudioComplete) {
                    // Base64 -> Blob URL
                    try {
                        const binaryString = atob(event.content);
                        const bytes = new Uint8Array(binaryString.length);
                        for (let i = 0; i < binaryString.length; i++) {
                            bytes[i] = binaryString.charCodeAt(i);
                        }
                        const blob = new Blob([bytes], { type: 'audio/mpeg' });
                        const url = URL.createObjectURL(blob);
                        callbacks.onAudioComplete(url);
                    } catch (e) {
                        console.error('音频 Base64 解码失败:', e);
                    }
                }
            }
        }

        callbacks.onComplete();
    } catch (error) {
        callbacks.onError(error instanceof Error ? error : new Error('Agent interaction failed'));
    }
};

/**
 * 触发历史消息总结。
 * @param messages 需要总结的消息列表
 * @returns 总结后的文本
 */
export const summarizeContext = async (messages: AgentMessage[]): Promise<string> => {
    try {
        const summary = await trpc.agent.summarize.mutate({ messages });
        return summary;
    } catch (error) {
        console.error("Failed to summarize context:", error);
        throw error;
    }
};
