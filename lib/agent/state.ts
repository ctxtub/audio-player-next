import { BaseMessage } from "@langchain/core/messages";

/**
 * Graph 的核心状态定义
 */
export interface AgentState {
    /**
     * 消息历史，包含 HumanMessage, AIMessage, SystemMessage 等。
     * 这是 Agent 做出决策的主要上下文来源。
     */
    messages: BaseMessage[];

    /**
     * 用户当前的意图分类。
     * 由 Supervisor 节点分析后写入。
     */
    user_intent?: "Chat" | "Story" | "Guidance";

    /**
     * 下一步的动作指令。
     * 例如: "goto:StoryAgent", "goto:ChatAgent", "FINISH"
     */
    next_step?: string;
}
