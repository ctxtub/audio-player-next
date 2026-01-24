# AGENTS

## 目录职责
- 实现 tRPC 的各个业务路由模块。
- 定义具体的 API 端点（Procedure）、参数校验与处理逻辑。

## 子目录结构
- `index.ts`：路由合并入口，导出 `appRouter`。
- `auth.ts`：认证相关路由（Mutation 登录/登出/用户信息）。
- `chat.ts`：对话相关路由（Mutation + Async Generator 对话流）。
- `tts.ts`：语音合成相关路由。
- `config.ts`：配置获取路由。

## 关键协作与依赖
- 引用 `@/lib/trpc/schemas` 进行入参校验。
- 调用 `@/lib/server` 执行业务逻辑。
- 导出类型定义供客户端推导。
