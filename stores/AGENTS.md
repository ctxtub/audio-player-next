# AGENTS

## 目录职责
- 管理全局状态，使用 Zustand 提供轻量化 store。
- 将配置、播放、故事等状态统一托管，并封装音频播放控制。

## 子目录结构
- `configStore.ts`：应用配置状态（播放时长、首选语音、浮动播放器开关）。
- `playbackStore.ts`：播放进度、音频控制器与倒计时状态。
- `preloadStore.ts`：音频预加载状态。
- `promptHistoryStore.ts`：提示词与历史记录。
- `storyStore.ts`：故事生成状态。
- `authStore.ts`：登录态状态管理，负责登录、登出与资料查询。
- `chatStore.ts`：聊天页面的会话状态与流式消息管理。

## 关键协作与依赖
- 与 `@/app/**` 页面及 `@/lib/**` 服务协作，提供实时状态。
- 借助 `@/types/**` 增强类型安全。
