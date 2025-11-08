# AGENTS

## 目录职责
- 封装与 OpenAI Chat Completion 相关的上游调用，提供流式与非流式两种访问方式。
- 解析并缓存 OpenAI 所需的环境变量配置，供 API Route 与服务层复用。

## 子目录结构
- `env.ts`：负责解析 OpenAI 相关环境变量。
- `client.ts`：创建并缓存官方 SDK 客户端实例。
- `chatCompletion.ts`：封装非流式 Chat Completion 请求。
- `chatCompletionStream.ts`：封装流式 Chat Completion 请求。
- `index.ts`：集中导出本目录对外暴露的能力。

## 关键协作与依赖
- 被 `app/api/storyGenerate` 与 `app/api/chat` 等路由调用，提供统一的上游访问逻辑。
- 依赖 `@/lib/http/server/ErrorHandler` 将 OpenAI 错误映射为业务侧可理解的异常。
