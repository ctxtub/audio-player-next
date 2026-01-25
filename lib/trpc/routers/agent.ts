import { router, publicProcedure } from "../init";
import { graph } from "@/lib/agent/graph";
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";
import { TRPCError } from "@trpc/server";
import { interactSchema, summarizeContextSchema } from "../schemas/agent";
import { summarizeContext } from "@/lib/agent/nodes/summary";

export const agentRouter = router({
    /**
     * 统一的 Agent 交互接口。
     * 接收标准的消息历史数组，自动派发给 LangGraph。
     */
    interact: publicProcedure
        .input(interactSchema)
        .mutation(async function* ({ input, signal }) {
            const { messages } = input;

            if (messages.length === 0) {
                throw new TRPCError({
                    code: "BAD_REQUEST",
                    message: "消息列表不能为空",
                });
            }

            // 1. 转换消息格式为 LangChain BaseMessage
            const validMessages: BaseMessage[] = messages.map((msg) => {
                if (msg.role === "user") return new HumanMessage(msg.content);
                if (msg.role === "assistant") return new AIMessage(msg.content);
                if (msg.role === "system") return new SystemMessage(msg.content);
                return new HumanMessage(msg.content); // 默认回退到 HumanMessage
            });

            // 2. 构造初始状态
            const initialState = {
                messages: validMessages,
                agentConfig: input.agentConfig,
            };

            try {
                // 3. 运行 Graph 并流式获取事件
                const eventStream = await graph.streamEvents(initialState, {
                    version: "v2",
                    signal: signal,
                });

                for await (const event of eventStream) {
                    // 记录节点开始 (on_chain_start 且属于 Graph 节点)
                    if (event.event === "on_chain_start" && ["Supervisor", "StoryAgent", "ChatAgent", "GuidanceAgent", "AudioGenerator"].includes(event.name)) {
                        console.log(`--- Executing Node: ${event.name} (Start) ---`);

                        // 只有实际的 Agent (不含 Supervisor 和 AudioGenerator) 才需要通知前端更改名称
                        if (["StoryAgent", "ChatAgent", "GuidanceAgent"].includes(event.name)) {
                            yield {
                                type: "agent_active",
                                name: event.name,
                            };
                        }
                    }

                    // on_chat_model_stream: LLM 生成的 token 流
                    if (event.event === "on_chat_model_stream") {
                        const chunk = event.data.chunk;
                        if (chunk && chunk.content) {
                            yield {
                                type: "token",
                                content: chunk.content,
                                source: event.name,
                            };
                        }
                    }
                    // on_chain_end: Supervisor 决定意图
                    if (event.event === "on_chain_end" && event.name === "Supervisor") {
                        if (event.data.output && event.data.output.user_intent) {
                            yield {
                                type: "meta",
                                intent: event.data.output.user_intent,
                            };
                        }
                    }

                    // on_chain_start: AudioGenerator 开始生成
                    if (event.event === "on_chain_start" && event.name === "AudioGenerator") {
                        yield {
                            type: "audio_start",
                        };
                    }

                    // on_chain_end: AudioGenerator 生成音频完成
                    if (event.event === "on_chain_end" && event.name === "AudioGenerator") {
                        if (event.data.output && event.data.output.audio_data) {
                            yield {
                                type: "audio",
                                content: event.data.output.audio_data,
                            };
                        }
                    }

                    // 记录节点结束 (on_chain_end 且属于 Graph 节点)
                    if (event.event === "on_chain_end" && ["Supervisor", "StoryAgent", "ChatAgent", "GuidanceAgent", "AudioGenerator"].includes(event.name)) {
                        console.log(`--- Executing Node: ${event.name} (End) ---`);
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

    /**
     * 总结上下文接口。
     * 用于前端触发的历史消息折叠与总结。
     */
    summarize: publicProcedure
        .input(summarizeContextSchema)
        .mutation(async ({ input }) => {
            const { messages } = input;

            if (messages.length === 0) {
                return "";
            }

            // 转换消息格式
            const validMessages: BaseMessage[] = messages.map((msg) => {
                if (msg.role === "user") return new HumanMessage(msg.content);
                if (msg.role === "assistant") return new AIMessage(msg.content);
                if (msg.role === "system") return new SystemMessage(msg.content);
                return new HumanMessage(msg.content);
            });

            try {
                const summary = await summarizeContext(validMessages);
                return summary;
            } catch (error) {
                console.error("Context summarization failed:", error);
                throw new TRPCError({
                    code: "INTERNAL_SERVER_ERROR",
                    message: "总结生成失败",
                });
            }
        }),
});
