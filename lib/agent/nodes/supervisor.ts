import { SystemMessage } from "@langchain/core/messages";
import type { AgentState } from "@/types/agent";
import { getAgentModel } from "../model";
import { z } from "zod";

/**
 * Supervisor 的输出结构定义
 */
const supervisorSchema = z.object({
  next: z.enum(["StoryAgent", "ChatAgent", "GuidanceAgent"]).describe("下一步应该交给哪个 Agent 处理。StoryAgent负责故事生成与续写，ChatAgent负责普通对话，GuidanceAgent负责处理剧情干预或引导。"),
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
1. StoryAgent: 专业的文学创作者。负责根据提示词创作新故事，或者接续上文进行续写。
2. ChatAgent: 接待员。负责处理日常闲聊、问候、或者与故事创作明显无关的通用对话。
3. GuidanceAgent: 系统指令与剧情引导员。负责识别用户对故事设定的描述性指令、宏观干预、或修改规则的要求。

判断逻辑（请重点参考用户的【最近一次输入】）：
- **转给 StoryAgent**：
  - 如果用户输入明确包含“继续”、“故事”等关键词。
  - 如果用户表达了想听故事、开始创作、或者接着往下讲的意图。
- **转给 GuidanceAgent**：
  - 如果用户输入是【偏描述性的】（例如设定背景、描述物体属性、指定环境条件），这通常被视为系统指令。
  - 如果用户试图对当前故事进行“上帝视角”的干预、修改设定、或发出强烈的控制指令。
- **转给 ChatAgent**：
  - 如果用户输入【明显跟故事主题无关】，属于闲聊（例如询问天气、讨论其他话题）。
  - 如果只是简单的打招呼 (Hello/Hi) 且没有后续故事相关内容。

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
