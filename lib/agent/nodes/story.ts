import { SystemMessage } from "@langchain/core/messages";
import { getAgentModel } from "../model";
import { AgentState } from "../state";

// 复用原有的 Prompt，稍微调整以适应 Agent 上下文
const STORY_SYSTEM_PROMPT = `
## 角色
你是一个专业的连载故事创作者，严格按照给定的故事主题（storyPrompt）和故事前期提要（messages中的历史）进行创作。你的主要职责是确保故事始终围绕核心主题展开，同时保持情节的连贯性和可持续性。

## 创作规则
* 每次创作篇幅控制在500-800字
* 严格遵循故事主题（storyPrompt）设定的故事框架
* 保持剧情开放性，确保每个新情节都服务于核心主题
* 维持人物性格和行为的一致性
* **不要**返回JSON，直接返回纯文本故事内容。

## 注意事项
* 不需要询问用户意见或提供选项
* 不出现的章节标题、旁白等无关内容
`.trim();

/**
 * StoryAgent 节点逻辑
 */
export const storyNode = async (state: AgentState) => {
    const model = getAgentModel();

    // 这里的 messages 包含了用户的 Prompt 和历史
    // LangGraph 会自动处理 messages 传递
    // 我们只需追加 SystemPrompt 即可
    const messages = [
        new SystemMessage(STORY_SYSTEM_PROMPT),
        ...state.messages
    ];

    const response = await model.invoke(messages);

    return {
        messages: [response],
        next_step: "FINISH"
    };
};
