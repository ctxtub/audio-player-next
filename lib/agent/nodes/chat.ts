
import { SystemMessage } from "@langchain/core/messages";
import { getAgentModel } from "../model";
import type { AgentState } from "@/types/agent";

const CHAT_SYSTEM_PROMPT = `
你是一个友好的故事工坊助手。
你的职责是：
1. 回答用户关于系统使用的问题。
2. 与用户进行轻松的闲聊。
3. 如果用户想要听故事，请引导他们明确表达“讲一个关于...的故事”，以便系统能识别并切换到故事模式。

请保持语气亲切、活泼。
`.trim();

/**
 * ChatAgent 节点逻辑
 */
export const chatNode = async (state: AgentState) => {
    const model = getAgentModel();

    const messages = [
        new SystemMessage(CHAT_SYSTEM_PROMPT),
        ...state.messages
    ];

    const response = await model.invoke(messages);

    return {
        messages: [response],
        next_step: "FINISH"
    };
};
