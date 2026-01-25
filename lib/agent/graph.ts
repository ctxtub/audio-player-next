import { StateGraph, END } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import type { AgentState } from "@/types/agent";
import { supervisorNode } from "./nodes/supervisor";
import { storyNode } from "./nodes/story";
import { chatNode } from "./nodes/chat";
import { audioNode } from "./nodes/audio";
import { guidanceNode } from "./nodes/guidance";

// 定义 StateGraph
const workflow = new StateGraph<AgentState>({
    channels: {
        messages: {
            value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
            default: () => [],
        },
        user_intent: {
            value: (x: "Chat" | "Story" | "Guidance" | undefined, y: "Chat" | "Story" | "Guidance" | undefined) => y ?? x,
            default: () => undefined,
        },
        next_step: {
            value: (x: string | undefined, y: string | undefined) => y ?? x,
            default: () => "Supervisor",
        },
        agentConfig: {
            value: (x: any, y: any) => y ?? x,
            default: () => ({}),
        },
    },
});

// 添加节点
workflow.addNode("Supervisor", supervisorNode);
workflow.addNode("StoryAgent", storyNode);
workflow.addNode("ChatAgent", chatNode);
workflow.addNode("GuidanceAgent", guidanceNode);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
workflow.addNode("AudioGenerator", audioNode as any);

// 添加边 (Edges)
// 1. 起点 -> Supervisor
// @ts-expect-error: LangGraph Node key typing issue
workflow.setEntryPoint("Supervisor");

// 2. Supervisor -> Conditional Logic
workflow.addConditionalEdges(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "Supervisor" as any,
    (state) => {
        // 根据 Supervisor 的输出决定下一步
        // 这里的返回值必须匹配下方 mapping 的 key
        return state.next_step ?? "ChatAgent";
    },
    {
        StoryAgent: "StoryAgent",
        ChatAgent: "ChatAgent",
        GuidanceAgent: "GuidanceAgent",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
);

// 3. Agents -> END/Next
// StoryAgent 完成后进入 AudioGenerator
// eslint-disable-next-line @typescript-eslint/no-explicit-any
workflow.addEdge("StoryAgent" as any, "AudioGenerator" as any);

// AudioGenerator -> END
// eslint-disable-next-line @typescript-eslint/no-explicit-any
workflow.addEdge("AudioGenerator" as any, END);

// ChatAgent -> END
// eslint-disable-next-line @typescript-eslint/no-explicit-any
workflow.addEdge("ChatAgent" as any, END);

// GuidanceAgent -> END
// eslint-disable-next-line @typescript-eslint/no-explicit-any
workflow.addEdge("GuidanceAgent" as any, END);

// 编译图
export const graph = workflow.compile();
