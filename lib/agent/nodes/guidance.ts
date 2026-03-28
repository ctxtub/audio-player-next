import { SystemMessage } from "@langchain/core/messages";
import { getAgentModel } from "../model";
import type { AgentState } from "@/types/agent";

const GUIDANCE_SYSTEM_PROMPT = `
## 角色
你是一个故事剧情引导助手 (Guidance Agent)。
你的职责是当用户试图干预、修改或对故事走向提出指导性意见时，生成一个明确的“指令确认”文本。

## 任务
1. 分析用户的意图（例如：用户想要杀死某个角色、改变场景、强制发生某个事件）。
2. 生成一段简明扼要的确认指令/描述，概括即将对故事施加的影响。
3. 这段文本将展示给用户进行确认（或作为系统反馈）。

## 示例
用户输入："把这个主角写死吧"
你输出："确认指令：在接下来的章节中安排主角因意外或战斗牺牲。"

用户输入："让他去森林"
你输出："引导指令：将场景转移至森林，并展开新的探索。"

## 注意事项
* 保持语气客观、机械、像系统指令。
* 只要返回指令内容即可，不要有多余的寒暄。
`.trim();

/**
 * GuidanceAgent 节点逻辑
 */
export const guidanceNode = async (state: AgentState) => {
    const model = getAgentModel();

    const messages = [
        new SystemMessage(GUIDANCE_SYSTEM_PROMPT),
        ...state.messages
    ];

    const response = await model.invoke(messages);

    return {
        messages: [response],
    };
};
