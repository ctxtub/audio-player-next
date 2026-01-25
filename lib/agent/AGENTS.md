# AGENTS

## 目录职责
- 负责基于 LangGraph 的智能体工作流编排与执行。
- 管理多 Agent 协作系统（Supervisor模式），处理故事生成、对话闲聊与剧情引导等不同意图。

## 子目录结构
- `graph.ts`：定义状态图（StateGraph）与工作流拓扑，注册节点与边。
- `state.ts`：定义 AgentState 图状态结构。
- `model.ts`：统一获取 LLM 模型实例，提供 `getAgentModel` 与 `getStoryModel` 分别对应不同配置。
- `nodes/`：具体节点的业务逻辑实现。
    - `supervisor.ts`：路由节点，分析用户意图并分发任务。
    - `story.ts`：故事创作 Agent。
    - `chat.ts`：闲聊服务 Agent。
    - `guidance.ts`：剧情引导 Agent，处理用户干预指令。
    - `audio.ts`：音频生成节点（非 LLM）。

## 关键协作与依赖
- 被 `lib/trpc/routers/agent.ts` 引用，通过 `graph.invoke/streamEvents` 执行。
- 依赖 `@langchain/langgraph` 与 `@langchain/core`。
- 输出 `user_intent` 供前端切换 UI 状态（如 Chat/Story/Guidance 模式）。
