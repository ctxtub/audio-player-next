import { SystemMessage } from "@langchain/core/messages";
import { getAgentModel } from "../model";
import { z } from "zod";
import { AgentState } from "../state";

/**
 * Supervisor 的输出结构定义
 */
const supervisorSchema = z.object({
    next: z.enum(["StoryAgent", "ChatAgent"]).describe("下一步应该交给哪个 Agent 处理。StoryAgent负责故事生成与续写，ChatAgent负责普通对话。"),
    intent: z.enum(["Story", "Chat", "Guidance"]).describe("用户的意图分类。Story:创作/生成/听故事; Chat:闲聊/打招呼; Guidance:在故事背景下修改或引导剧情。")
});

/**
 * Supervisor 节点逻辑
 */
export const supervisorNode = async (state: AgentState) => {
    const model = getAgentModel();

    const systemPrompt = new SystemMessage(
        `你是整个系统的路由主管 (Supervisor)。
你的职责是根据用户的输入和对话历史，判断用户的意图，并将任务分发给最合适的专家 (Agent)。

专家列表：
1. StoryAgent: 专业的文学创作者。擅长根据提示词创作新故事，或者根据用户的修改建议（如"把主角改成小猫"）续写/重写故事。
2. ChatAgent: 接待员。擅长处理日常闲聊、问候、或者回答关于系统功能的问题。

判断逻辑：
- 如果用户想听故事、写故事、或者针对当前故事提出修改意见，请选择 StoryAgent。
- 如果用户只是打招呼 (Hello/Hi) 或闲聊，请选择 ChatAgent。

请输出 JSON 格式的决策结果。`
    );

    // 使用 withStructuredOutput 强制输出 JSON
    // method: "functionCalling" 兼容性更好，避免 LLM 不支持 json_schema 的问题
    const runnable = model.withStructuredOutput(supervisorSchema, {
        method: "functionCalling"
    });

    const result = await runnable.invoke([
        systemPrompt,
        ...state.messages
    ]);

    return {
        next_step: result.next,
        user_intent: result.intent
    };
};
