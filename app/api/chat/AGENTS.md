# AGENTS

## 目录职责
- Chat 页面对应的 BFF API Route，负责将客户端请求转发给上游 LLM 并以 SSE 推流返回。

## 子目录结构
- `route.ts`：`/api/chat` 接口实现。
- `utils/`：SSE 封装等私有工具函数。

## 关键协作与依赖
- 依赖 `@/lib/server/OpenAIUpstream` 中的 OpenAI 客户端配置与请求封装。
- 复用 `ServiceError` 错误体系，保持与 `storyGenerate` 接口一致的响应格式。
