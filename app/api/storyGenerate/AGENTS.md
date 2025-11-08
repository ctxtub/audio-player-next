# AGENTS

## 目录职责
- 提供故事生成与续写的 API Route。
- 校验请求体并将业务委托给服务层。

## 子目录结构
- `route.ts`：API Route 实现。

## 关键协作与依赖
- 调用 `@/lib/server/OpenAIUpstream` 完成上游请求。
- 使用 `@/types/story` 统一请求与响应类型。
