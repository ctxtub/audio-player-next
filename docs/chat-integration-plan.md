# /chat 页面与 /api/chat 接入方案

## 背景与目标
- `/chat` 页面当前仍以内置示例数据与 `setTimeout` 模拟助手回复，尚未接入真实会话服务。
- `/api/chat` BFF 已具备 OpenAI 代理与 SSE 推流能力，但缺少前端消费方，同时错误帧未追加 `done` 事件。
- 目标：在保持现有布局（消息区 + 输入区）的前提下，串联前端与 BFF 的流式对话能力，并评估补齐错误帧的 `done` 事件。

## 现状概述
### 前端（`app/chat/components/ChatLayout`）
- 通过 `useState` 维护 `messages`/`pendingMessage`，利用定时器模拟发送与回复。
- `MessageArea` ➜ `ChatLog` 负责渲染消息，支持 `sending`/`failed` 展示与重试占位。
- `InputArea` ➜ `Composer` 提供输入框与发送按钮，外部需要传入 `onSubmit`、`isSending`、`disabled`。

### BFF（`app/api/chat/route.ts`）
- 校验参数后将请求转发至 OpenAI，使用 `formatSseEvent` 输出 `message`、`done`、`error` 帧。
- `sendError` 目前直接发送 `error` 并关闭流，未附带 `done`，与设计文档不符。

## 系统交互示意
1. 用户在 `Composer` 输入文本触发 `ChatLayout.handleSubmit`。
2. `ChatLayout` 创建用户消息占位、发起 `startChatStream`（新增）服务，请求 `/api/chat`。
3. 前端读取 SSE：
   - `message` 帧 ➜ 将 `delta` 追加到当前助手消息。
   - `done` 帧 ➜ 标记助手消息完成、写入 `finishReason` & `usage`（可选）。
   - `error` 帧 ➜ 更新占位消息为 `failed`，允许重试。
4. 重试时重新拼接最近一轮对话上下文，并再次走步骤 2。
5. BFF 发生错误时同时推送 `error` 与 `done`，前端统一结束流。

## 客户端改造方案
### 状态与数据结构
- 参考 Story 约定，将 `/chat` 页面状态集中在 `stores/chatStore.ts`（Zustand）内，提供以下字段与动作：
  - `messages: ChatMessage[]`（含用户、助手、系统消息）。
  - `pendingMessage: ChatPendingMessage | null`。
  - `activeAssistantMessage: ChatMessage | null`（跟踪当前流式拼装中的助手消息，`status: 'sending'`）。
  - `currentAbortController: AbortController | null`（支持取消与组件卸载时中止）。
  - `conversationContext: ChatCompletionMessageParam[]`，由最近的消息（含系统提示）映射而来，作为 BFF 请求体。
  - `actions`：`submitMessage`、`appendAssistantDelta`、`finalizeAssistantMessage`、`markFailure`、`resetConversation` 等。
- `ChatLayout` 通过 `useChatStore` Selector 读取必要状态，同时保持组件内部无额外状态。`Composer` 依赖 `isSending`/`disabled` 等派生数据，可由 store 计算。

### 目录结构与分层对齐
- **类型层**：在 `types/chat.ts` 定义 `ChatMessage`、`ChatStreamEvent`、`ChatCompletionPayload` 等跨端复用类型，沿用故事模块的集中管理方式。
- **服务层（客户端）**：比照 `lib/client/storyGenerate.ts`，在 `lib/client/chatStream.ts` 编写 `createChatStreamClient`，封装 `/api/chat` 的 POST 请求、SSE 解析与错误转换，内部复用 `browserHttp` 与 `eventsource-parser`，统一抛出 `ChatStreamEvent`。
- **服务层（服务端）**：若需对接其他上游供应商，参照 `lib/server/OpenAIUpstream`，在 `lib/server/chat` 下维护对 OpenAI Chat API 的适配器与参数校验逻辑，供 BFF 与 Server Actions 使用。
- **流程层**：仿照 `app/services/storyFlow.ts`，新增 `app/services/chatFlow.ts` 暴露 `beginChatStream`、`retryChatStream` 等高阶方法，负责 orchestrate Zustand 动作、调用客户端服务、管理 `AbortController`。
- **页面层**：`app/chat/components` 仅通过 `chatStore` selector 与 `chatFlow` 暴露的方法交互，保持组件纯粹展示与交互职责。

### 请求封装
- `chatFlow` 内部通过 `createChatStreamClient` 发起请求：
  - 调用 `browserHttp.post` 发送 JSON 请求体，并传入 `AbortSignal` 控制取消。
  - 利用 `eventsource-parser` 解析 SSE，按 `message`/`done`/`error` 组装为 `ChatStreamEvent` 后回调到 store。
  - 遇到解析异常时抛出 `ChatStreamError`（与故事模块的 `StoryApiError` 对齐），方便上层区分网络、业务或中断场景。
- `ChatLayout` 通过调用 `chatFlow.beginChatStream`/`retryChatStream` 将解析结果映射到状态更新。

### 组件改动要点
- `handleSubmit`
  1. 将用户输入加入 `messages`，设置 `pendingMessage`。
  2. 创建助手占位消息 `activeAssistantMessage`（id 基于时间戳）。
  3. 调用 `startChatStream` 并监听流事件：
     - `message`：拼接 `delta` 至 `activeAssistantMessage.content`，实时渲染。
     - `done`：将 `activeAssistantMessage` 追加到 `messages`（`status: 'delivered'`）、清空占位；记录 `finishReason/usage` 供后续展示（暂存于 message.meta）。
     - `error`：更新 `pendingMessage.status = 'failed'`，清理助手占位，保留错误提示。
  4. 成功后清空 `pendingMessage`，允许新的输入。
- `handleRetry`
  - 针对 `pendingMessage.status === 'failed'` 再次执行提交逻辑，沿用同一 `content`。
- 卸载与中断
  - `useEffect` 清理：组件卸载或新请求前调用 `abortController.abort()`。
  - 处理 `fetch` 中断抛出的 `DOMException`，避免 Toast。

### UI 行为
- 在助手流式回复时，底部滚动保持跟随（现有 `ChatLog` 已提供）。
- 发送中禁用 `Composer`，`isSending` 取决于 `pendingMessage.status` 或 `activeAssistantMessage` 是否存在。
- 错误时通过 `Toast` 提示（复用 `Composer` 内的异常捕获），并在消息列表展示“发送失败，可重试”。

## BFF 修复评估
### 问题
- `sendError` 直接 `controller.close()`，客户端无法收到 `done` 事件，可能导致事件源挂起。

### 建议改动
1. 拆分 `closed` 标记与帧发送逻辑：允许在错误时先写入 `error`，再统一调用 `finalize('error')`。
2. `sendError` 处理流程：
   - `controller.enqueue(errorFrame)`。
   - `controller.enqueue(doneFrame)`（`finishReason: 'error'`，usage 可省略）。
   - `controller.close()` 并 `aborter.abort()`。
3. 确认正常结束路径不会重复发送 `done`：`closed` 标记在 `finalize` 内设置，避免二次调用。
4. 需要更新前端解析：`done` 事件到来后无论是否伴随错误均结束流。

### 回归测试
- 单元测试建议：为 `sendError` 新增用例验证帧顺序；或在集成测试中模拟上游异常，确保客户端收到 `error` + `done`。

## 数据协议对齐
- 请求体：
  ```jsonc
  {
    "model": "gpt-4o-mini",        // 可选
    "messages": [
      { "role": "system", "content": "你是故事助手" },
      { "role": "user", "content": "讲一个太空冒险" }
    ],
    "temperature": 0.7,              // 可选
    "top_p": 1,                      // 可选
    "max_tokens": 1024               // 可选
  }
  ```
- SSE 响应：
  - `event: message` ➜ `{ "delta": "部分内容" }`
  - `event: done` ➜ `{ "finishReason": "stop", "usage": { ... } }`
  - `event: error` ➜ `{ "code": "STREAM_PARSE_ERROR", "message": "解析失败" }`

## 风险与缓解
- **网络中断**：`fetch` 流被动结束 → 监听 `AbortError`，回滚 `pendingMessage` 为 `failed`。
- **多次并发发送**：`Composer` 已禁用发送按钮，仍需在状态层防止重复 `handleSubmit`。
- **长对话上下文**：考虑追加 `system`/历史裁剪策略，短期内可保留全部消息，后续接入截断逻辑。

## 验证计划
1. 单元测试或 Storybook 手动验证流式拼接效果（未来补充）。
2. 手动操作 `/chat`：发送成功、错误重试、刷新后首屏渲染。
3. 后端本地触发异常（断网或 mock 错误）验证 `error` + `done` 流程。

## 后续扩展
- 接入会话存档（Zustand 或 Server Action）。
- `done` 帧中的 `usage` 用于展示 token 消耗或费用估算。
- 增加消息头部（昵称、头像）等 UI 功能作为下一阶段改进。
