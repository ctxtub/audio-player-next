# AGENTS

## 目录职责
- tRPC HTTP 适配层的具体路由处理器。
- 将 Next.js Web Request/Response 转换为 tRPC 内部调用。

## 子目录结构
- `route.ts`：使用 `fetchRequestHandler` 处理 GET/POST 请求。

## 关键协作与依赖
- 依赖 `@/lib/trpc` 中的 `appRouter` 和 `createContext`。
- 作为整个后端 API 的 HTTP 入口暴露给客户端。
