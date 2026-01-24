import { router, publicProcedure } from "../init";
import { z } from "zod";
import { graph } from "@/lib/agent/graph";
import { HumanMessage } from "@langchain/core/messages";
import { TRPCError } from "@trpc/server";

export const agentRouter = router({
    /**
     * 统一的 Agent 交互接口。
     * 前端只需传入 content 和 history，不再关心具体是 Story 还是 Chat。
     */
    interact: publicProcedure
        .input(
            z.object({
                content: z.string(),
                history: z.array(
                    z.object({
                        role: z.enum(["user", "assistant", "system"]),
                        content: z.string(),
                    })
                ).optional(),
            })
        )
        .mutation(async function* ({ input, signal }) {
            const { content, history = [] } = input;

            // 1. 转换历史消息格式为 LangChain BaseMessage
            const validHistory = history.map((msg) => {
                if (msg.role === "user") return new HumanMessage(msg.content);
                // 这里简化处理，assistant 和 system 都视为 HumanMessage 的上下文或者是 AIMessage
                // 但为了简单，暂时只取 User 和 Assistant
                return new HumanMessage(msg.content);
            });

            // 2. 构造初始状态
            // 将当前用户输入也加入 messages
            const currentMessage = new HumanMessage(content);
            const initialState = {
                messages: [...validHistory, currentMessage],
            };

            try {
                // 3. 运行 Graph 并流式获取事件
                // streamEvents 需要 langchain/core >= 0.2, 这里使用 streamMode="values" 或者直接 stream
                // 我们希望获取每个节点产生的 token 流，需要 streamEvents
                const eventStream = await graph.streamEvents(initialState, {
                    version: "v2",
                    signal: signal, // 传递 AbortSignal
                });

                for await (const event of eventStream) {
                    // 过滤感兴趣的事件类型
                    // on_chat_model_stream: LLM 生成的 token 流
                    if (event.event === "on_chat_model_stream") {
                        const chunk = event.data.chunk;
                        if (chunk && chunk.content) {
                            // yield 到前端
                            yield {
                                type: "token",
                                content: chunk.content,
                                // 可以附带 node 名字，让前端知道是谁在说话 (StoryAgent vs ChatAgent)
                                source: event.name,
                            };
                        }
                    }
                    // on_chain_end: 某个节点执行结束，可能包含该节点的输出
                    if (event.event === "on_chain_end" && event.name === "Supervisor") {
                        // Supervisor 决定了意图，我们可以把这个意图传给前端
                        // event.data.output 应该是 Supervisor 的返回值 { user_intent, next_step }
                        if (event.data.output && event.data.output.user_intent) {
                            yield {
                                type: "meta",
                                intent: event.data.output.user_intent,
                            };
                        }
                    }
                }
            } catch (error) {
                console.error("Agent execution failed:", error);
                throw new TRPCError({
                    code: "INTERNAL_SERVER_ERROR",
                    message: error instanceof Error ? error.message : "Agent 运行失败",
                });
            }
        }),
});
