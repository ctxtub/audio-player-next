# AGENTS

## 目录职责
- 实现首页 UI 与交互逻辑，承载故事创作入口。
- 初始化 ChatStore 状态，确保未访问聊天页时也能正常生成故事。
- 触发全局悬浮播放器播放新故事，保持播放过程中界面切换不打断音频。

## 子目录结构
- `components/`：首页专用组件集合。
- `index.tsx`：页面入口组件。
- `index.module.scss`：页面样式。

## 关键协作与依赖
- 依赖 `@/app/services/storyFlow` 驱动故事生成流程。
- 与 `@/stores/**` 协作管理配置、故事、播放与预加载状态。
- 重用 `@/components/**` 提供的通用 UI 能力。
