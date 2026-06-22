
import { BaseMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getAgentModel } from "@/lib/agent/model";

const SYSTEM_PROMPT = `你是一个专业的对话总结助手。你的任务是维护一段对话的简明摘要。

请遵循以下规则：
1. 提取对话中的关键信息、用户偏好、已生成的故事背景以及当前讨论的主题。
2. 忽略无关的闲聊或重复信息。
3. 摘要应清晰、连贯，方便后续的 AI 模型快速理解上下文。
4. 如果输入消息中包含之前的摘要，请结合新的对话内容进行更新，而不是简单拼接。
5. 保持客观，不要添加臆测。
6. 输出语言必须为**简体中文**。

你的输出将直接作为后续对话的 Context，请务必精炼。`;

/**
 * 将消息列表总结为简明文本。
 * 用于控制上下文窗口大小。
 *
 * @param messages 需要总结的消息列表 (可能包含之前的总结)
 * @returns 生成的总结文本
 */
export async function summarizeContext(messages: BaseMessage[]): Promise<string> {
    // Defensive check
    if (messages.length === 0) return "";

    const model = getAgentModel();

    const response = await model.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        ...messages,
        new HumanMessage("请对以上对话生成/更新摘要："),
    ]);

    if (typeof response.content === "string") {
        return response.content;
    } else if (Array.isArray(response.content)) {
        // Handle multimodal content (though unlikely for summary)
        return response.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("")
            .trim();
    }

    return "";
}
