# AGENTS

## 目录职责
- 聚合前后端可复用的业务服务层，实现 OpenAI 等上游服务的封装。
- 提供统一的 HTTP/tRPC 客户端、错误类型与服务端配置加载逻辑，供 `app/` 路由与 `app/api/` 使用。
- 负责在不同运行时（浏览器、服务端）之间复用协议与校验规则，减少重复实现。

## 子目录结构
- `client/`：浏览器端调用 API 的客户端封装，内部使用 tRPC 客户端，包含故事生成、应用配置、语音合成与认证操作访问逻辑。
- `trpc/`：tRPC 基础设施层，包含路由集合（`routers`）、校验 Schema（`schemas`）、客户端初始化与 Context 上下文。
- `server/`：服务端对接 OpenAI API 的统一模块（`openai.ts`），负责环境变量解析、客户端管理及 Chat/TTS API 封装。
- `agent/`：LangGraph 驱动的智能体编排层，包含图定义、节点逻辑与状态管理。
- `db.ts`：Prisma Client 单例，使用 `@prisma/adapter-libsql` 适配 SQLite（Prisma 7 driver adapter 模式）；数据库文件路径由 `DATABASE_URL` 环境变量指定。
- `session.ts`：会话编解码工具，`encodeSession`/`decodeSession` 使用 `TextEncoder`/`btoa` 实现，兼容 Edge Runtime 与 Node.js，供 `middleware.ts` 与 `trpc/context.ts` 共用，禁止在此文件引入 Node.js 专属模块。

## 关键协作与依赖
- 依赖 `@/types/**` 中的请求与响应类型来确保严格的类型约束。
- 与 `app/api/**` server actions/tRPC api 协作，为路由处理器提供后端逻辑。
- `client/` 目录使用 `trpc/` 提供的类型安全客户端与服务端通信。
- `db.ts` 被 `trpc/routers/auth.ts` 引用；`session.ts` 被 `middleware.ts` 与 `trpc/context.ts` 双端引用。
