# AGENTS

## 目录职责
- 管理全局状态，使用 Zustand 提供轻量化 store。
- 将配置、播放、故事等状态统一托管。

## 子目录结构
- `configStore.ts`：应用配置状态。
- `playbackStore.ts`：播放进度与控制状态。
- `preloadStore.ts`：音频预加载状态。
- `promptHistoryStore.ts`：提示词与历史记录。
- `storyStore.ts`：故事生成状态。

## 关键协作与依赖
- 与 `@/app/**` 页面及 `@/lib/**` 服务协作，提供实时状态。
- 借助 `@/types/**` 增强类型安全。
