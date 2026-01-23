# AGENTS

## 目录职责
- 提供播放器独立路由，承载全屏播放界面与故事展示。
- 依托全局悬浮播放器在本路由内挂载完整播放内容。

## 子目录结构
- `page.tsx`：播放器页面入口。
- `index.tsx`：播放器页面主组件实现。
- `index.module.scss`：播放器页面样式。
- `components/`：播放器页面私有组件集合。

## 关键协作与依赖
- 与 `@/components/FloatingPlayer` 协作提醒浮窗展示并共享播放控制。
- 复用 `@/stores/**`、`@/app/services/storyFlow` 维护播放状态。
- 引入 `@/components/PlaybackStatusBoard` 展示播放倒计时与预加载信息。
