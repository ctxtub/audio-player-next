/**
 * 标准消息结构，遵循 OpenAI API 风格。
 */
export interface AgentMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

/**
 * Agent 配置结构，支持按命名空间隔离与扩展。
 */
export interface AgentConfig {
    /**
     * 音频生成相关配置
     */
    audio?: {
        speed?: number;
        voiceId?: string;
    };
    /**
     * 允许传入其他任意 Key 以保持扩展性
     */
    [key: string]: any;
}

/**
 * Agent 类型定义，对应不同的业务能力与角色。
 */
export type AgentType = 'story_agent' | 'chat_agent' | 'guidance_agent' | 'summary_agent';

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

    /**
     * Agent 全局配置，按命名空间隔离。
     * 例如: { audio: { speed: 1.5 } }
     */
    agentConfig?: AgentConfig;
}
