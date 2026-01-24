import { StateGraph, END } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { AgentState } from "./state";
import { supervisorNode } from "./nodes/supervisor";
import { storyNode } from "./nodes/story";
import { chatNode } from "./nodes/chat";

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
    },
});

// 添加节点
workflow.addNode("Supervisor", supervisorNode);
workflow.addNode("StoryAgent", storyNode);
workflow.addNode("ChatAgent", chatNode);

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
);

// 3. Agents -> END
// 目前 Agent 执行完就结束，未来可以在这里添加循环（比如 HumanFeedback）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
workflow.addEdge("StoryAgent" as any, END);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
workflow.addEdge("ChatAgent" as any, END);

// 编译图
export const graph = workflow.compile();
