# AGENTS

## 目录职责
- 存放 tRPC 相关的核心基础设施与业务路由实现。
- 提供类型安全的 API 定义、入参校验 Schema 与服务端上下文。

## 子目录结构
- `routers/`：业务路由实现集合（`chat`、`story`、`tts`、`auth` 等）。
- `schemas/`：Zod 校验 Schema 定义，复用于前端表单校验与后端接口参数校验，包含 `loginInputSchema`、`registerInputSchema`。
- `init.ts`：tRPC 实例初始化与中间件配置。
- `context.ts`：tRPC 请求上下文创建，使用 `@/lib/session` 解码 auth cookie 生成 `session`。
- `client.ts`：前端使用的 tRPC Client 实例与 React Hook 配置。

## 关键协作与依赖
- 依赖 `@/lib/server/**` 调用底层 OpenAI 或数据库服务。
- `routers/auth.ts` 依赖 `@/lib/db`（Prisma）、`@/lib/session`（编解码）、`bcryptjs`（密码哈希）。
- `context.ts` 依赖 `@/lib/session` 解析登录态 cookie。
- 被 `app/api/trpc/[trpc]/route.ts` 引用以暴露 HTTP 端点。
- 被 `lib/client/**` 和前端组件引用以发起类型安全请求。
