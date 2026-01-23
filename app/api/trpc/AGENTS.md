# AGENTS

## 目录职责
- Next.js App Router 的 tRPC 适配层。
- 将 HTTP 请求转发给 `@/lib/trpc` 定义的路由处理函数。

## 子目录结构
- `[trpc]/route.ts`：统一的 API 路由入口，处理所有 `/api/trpc/*` 请求。

## 关键协作与依赖
- 依赖 `@/lib/trpc/routers` 获取应用路由定义。
- 依赖 `@/lib/trpc/context` 创建请求上下文。
