# Chat BFF 接口技术方案

## 1. 背景与目标
- **目标**：为 Chat 页面提供一个符合公司规范的 BFF 接口，代理访问 OpenAI Chat Completions，并通过 SSE 实现打字机式响应。
- **范围**：BFF 接口 `/api/chat`，客户端调用流程，OpenAI 通信细节，以及错误处理与安全控制。

## 2. BFF 接口定义
### 2.1 路径与方法
- `POST /api/chat`

### 2.2 请求头
| Header | 必填 | 描述 |
| --- | --- | --- |
| `Content-Type` | 是 | 固定 `application/json` |
| `Accept` | 是 | 需指定 `text/event-stream` 以启用 SSE |

> ⚠️ 注意：根据评审要求，`/api/chat` **不需要** 附带 `Authorization` 或任何自定义 `metadata` 头部。

### 2.3 请求体
```json
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "你是一个音频助手" },
    { "role": "user", "content": "你好" }
  ],
  "temperature": 0.7,
  "top_p": 1,
  "max_tokens": 2048
}
```

| 字段 | 类型 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 否 | 默认读取 `process.env.OPENAI_MODEL`，若缺省则回退到 `gpt-4o-mini` |
| `messages` | `Array<{ role: 'system' | 'user' | 'assistant'; content: string }>` | 是 | 传入上下文消息；BFF 负责校验 role 与 content 非空 |
| `temperature` | number | 否 | 范围 0-2，默认 0.7 |
| `top_p` | number | 否 | 范围 0-1，默认 1 |
| `max_tokens` | number | 否 | 默认 2048 |

> ⚠️ 额外说明：接口不接收 `metadata`、`user` 等扩展字段，客户端无需拼接。

### 2.4 响应体（SSE 流）
BFF 返回 `text/event-stream`，每帧结构如下：
```
event: message
data: {"delta":"当前增量内容"}

```

附加事件：
- **error**：错误时输出 `error` 事件并在最终关闭流前发送 `done`。
- **done**：流结束信号，附带 `finishReason`、`usage`（如 tokens）等统计信息。

## 3. 伪代码
```ts
export async function POST(request: Request) {
  // 1. 解析 JSON：沿用故事接口的通用模式
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    return buildErrorResponse( // 来自 app/api/storyGenerate/route.ts
      400,
      "INVALID_JSON",
      `请求体不是合法的 JSON: ${error instanceof Error ? error.message : "未知错误"}`,
    );
  }

  // 2. 结构校验：与 normalizeRequest 一致的 ServiceError 范式
  let normalized: NormalizedChatRequest;
  try {
    normalized = normalizeChatPayload(payload); // 新增工具，复用故事接口的判空/类型校验写法
  } catch (error) {
    if (error instanceof ServiceError) {
      return buildErrorResponse(error.status, error.code, error.message);
    }
    return buildErrorResponse(500, "INTERNAL_SERVER_ERROR", "Chat 接口发生未知错误");
  }

  // 3. 请求上游：调用故事接口已存在的公共方法
  const aborter = new AbortController();
  const upstreamStream = await invokeStreamingChatCompletion({
    controller: aborter,
    messages: normalized.messages,
    model: normalized.model,
    temperature: normalized.temperature,
    topP: normalized.topP,
    maxTokens: normalized.maxTokens,
  });

  // 4. 透传流式响应：保持与故事接口公共工具一致
  const stream = new ReadableStream({
    start(controller) {
      const parser = createParser((event) => {
        if (event.type !== "event" || !event.data) return;
        if (event.data === "[DONE]") {
          controller.enqueue(formatSse({ event: "done", data: { finishReason: "stop" } }));
          controller.close();
          return;
        }

        const chunk = JSON.parse(event.data);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          controller.enqueue(formatSse({ event: "message", data: { delta } }));
        }

        const finish = chunk.choices?.[0]?.finish_reason;
        if (finish) {
          controller.enqueue(formatSse({ event: "done", data: { finishReason: finish } }));
          controller.close();
        }
      });

      streamOpenAIChunks(upstreamStream, parser, controller); // 与故事接口共用的底层读取函数
    },
    cancel() {
      aborter.abort();
    },
  });

  // 5. 返回 SSE 响应
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
```

其中 `streamOpenAIChunks` 负责从 `ReadableStreamDefaultReader` 读取原始字节并喂给 `eventsource-parser`，`formatSse` 将事件对象转换为字符串：
```
formatSse({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
```

伪代码中的 `normalizeChatPayload` 需遵循故事生成接口的公共范式：
- 通过 `ServiceError` 抛出可预期的业务错误，字段判空逻辑比照 `normalizeRequest`。
- 复用 `buildErrorResponse`（位于 `app/api/storyGenerate/route.ts`），保持响应格式一致。

`invokeStreamingChatCompletion` 建议封装在 `lib/server/OpenAIUpstream` 下，与现有的 `invokeChatCompletion` 共用 `loadOpenAiEnvConfig` 和 `getOrCreateOpenAiClient` 等公共配置解析逻辑，以便故事生成接口和 Chat 接口共用上游访问能力。

## 4. 客户端对接流程
1. **触发请求**：在 Chat 组件内，监听用户输入并构造消息数组。
2. **发起调用**：
   ```ts
   const response = await fetch('/api/chat', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       Accept: 'text/event-stream'
     },
     body: JSON.stringify(payload)
   });
   if (!response.body) throw new Error('SSE not supported');
   ```
3. **解析 SSE**：使用 `eventsource-parser` 或自定义 `TextDecoder` 按行解析；将 `message` 事件中的 `delta` 拼接到当前回答。
4. **结束处理**：
   - `done` 事件：更新上下文、写入历史记录。
   - `error` 事件：展示错误提示，允许用户重试。
5. **取消能力**：通过 `AbortController` 暂停未完成的请求。

## 5. 安全与健壮性
- **鉴权**：若后续需要对接用户体系，可在路由层引入已有的 Session 校验逻辑。
- **错误分类**：将 OpenAI 响应的 401/429/500 等转换为 `error` 事件并附带提示文案；握手阶段失败直接返回 JSON 错误。
- **配置管理**：所有 OpenAI 相关配置来自环境变量（`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`）。

## 6. 依赖建议
- `eventsource-parser`：解析 OpenAI 流式响应。

## 7. 验证步骤
1. 设置环境变量并在本地启用代理：`OPENAI_API_KEY=...`。
2. 启动开发服务器：`yarn dev`。
3. 在浏览器打开 Chat 页面，输入对话，检查是否实时输出。
4. 模拟错误（例如断开网络），验证 `error` 事件是否触发及前端回退逻辑。
5. 运行 `yarn lint`、`yarn tsc --noEmit`、`yarn build`，确保构建链路完整。
