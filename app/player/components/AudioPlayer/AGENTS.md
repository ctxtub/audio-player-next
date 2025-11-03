# AGENTS

## 目录职责
- 呈现播放器路由的音频控制界面，提供播放/暂停、进度条与倍速切换。
- 以视觉层面反馈播放状态，供用户在全屏页面操控音频。

## 子目录结构
- `index.tsx`：播放器组件实现。

## 关键协作与依赖
- 依赖 `@/stores/playbackStore` 获取播放状态并派发控制指令。
- 音频实际播放由 `@/components/AudioControllerHost` 承担，组件仅承担 UI 展示。
