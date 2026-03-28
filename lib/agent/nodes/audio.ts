import type { AgentState } from "@/types/agent";
import { synthesizeSpeech, getTtsConfig } from "@/lib/server/openai";

/**
 * AudioGenerator 节点逻辑
 *
 * 负责检查最近的一条消息，如果是 AI 生成的文本，则调用 TTS 生成音频。
 * 生成的音频数据将附加到特定的状态字段或通过事件流返回。
 * 目前 LangGraph State 主要是 Messages，音频数据通常过大不适合持久化在 State 中。
 * 但我们可以在这里即时调用流式输出，或者暂时将 Base64 数据放入特定的输出通道。
 *
 * 在本方案中（配合 lib/trpc/routers/agent.ts 的实现），
 * 我们将把音频数据暂存入一个临时字段或直接通过副作用流出。
 * 但 LangGraph 节点必须返回 State update。
 *
 * 因此，我们定义一种约定：
 * 该节点执行 TTS，并将结果作为一种特殊的 ToolMessage 或额外字段附加。
 * 但鉴于我们需要流式传回 Router，Router 监听的是 streamEvents。
 *
 * 当我们在 Graph Node 内部“产生”数据时，可以通过 `DispatchCustomEvent` (LangChain) 或者简单的返回。
 * 我们的 Router 监听的是 `on_chain_end`? 不，Router 监听的是 streamEvents。
 * 我们可以让这个节点返回一个特殊的 Output，Router 在 `on_chain_end` (针对这个 Node) 时捕获。
 */
export const audioNode = async (state: AgentState) => {
    const lastMessage = state.messages[state.messages.length - 1];

    // 只要有 content 且非空字符串即可，因为我们在 Graph 中确定了它是 StoryNode 的输出
    const hasContent = lastMessage && typeof lastMessage.content === 'string' && lastMessage.content.trim().length > 0;

    if (!hasContent) {
        return {
            next_step: "FINISH"
        };
    }

    const text = lastMessage.content as string;

    try {
        const config = getTtsConfig();
        const { speed, voiceId } = state.agentConfig?.audio || {};

        // 使用配置或默认值生成音频
        const result = await synthesizeSpeech(
            text,
            voiceId || config.voiceId,
            speed
        );

        const base64Data = Buffer.from(result.audioData).toString('base64');

        // 将音频数据 (Base64) 作为输出返回
        // 注意：这不会直接修改 state.messages，而是作为 Node 的 output
        // Router 端会在 streamEvents 中捕获到这个 Node 的输出
        return {
            audio_data: base64Data,
            next_step: "FINISH"
        };
    } catch (error) {
        console.error("Audio generation failed:", error);
        // 音频生成失败不应阻断流程，仅记录
        return {
            next_step: "FINISH"
        };
    }
};
