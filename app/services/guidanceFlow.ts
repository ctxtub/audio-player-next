import { interactWithAgent, type AgentMessage } from './agentFlow';

/**
 * 启动 Guidance 会话生成流程。
 * 目前 Guidance 行为较为简单，主要负责生成指导性文本。
 * 未来可扩展为生成特定 UI 组件或操作指令。
 *
 * @param context 对话上下文
 * @param onDelta 文本增量回调
 * @param onComplete 完成回调
 */
export const executeGuidanceGeneration = async (
    context: AgentMessage[],
    callbacks: {
        onDelta: (chunk: string) => void;
        onComplete: () => void;
        onError: (error: Error) => void;
    }
): Promise<void> => {
    try {
        await interactWithAgent(
            context,
            {
                onTextDelta: (delta) => {
                    callbacks.onDelta(delta);
                },
                onIntentDetected: (intent) => {
                    console.log('Detected Intent in Guidance:', intent);
                },
                onComplete: () => {
                    callbacks.onComplete();
                },
                onError: (error) => {
                    callbacks.onError(error);
                },
            }
        );
    } catch (error) {
        callbacks.onError(error instanceof Error ? error : new Error('Guidance generation failed'));
    }
};
