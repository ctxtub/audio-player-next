# AGENTS

## 目录职责
- 封装客户端对后端 API 的调用逻辑。
- 屏蔽底层通信细节（tRPC 或 Fetch），向 UI 层暴露语义化的异步函数。

## 子目录结构
- `auth.ts`：身份验证相关操作，包含 `login`、`register`、`logout`、`fetchProfile`、`enterGuestMode`。
- `appConfig.ts`：获取应用运行时配置。
- `chatStream.ts`：【已废弃】原聊天流式生成调用封装，请使用 `agentFlow.ts`。
- `storyGenerateStream.ts`：【已废弃】原故事生成流式调用封装，请使用 `agentFlow.ts`。
- `ttsGenerate.ts`：语音合成调用。

## 关键协作与依赖
- 依赖 `@/lib/trpc/client` 发起类型安全的 tRPC 请求。
- 返回值遵循 `@/types` 定义的数据结构。
