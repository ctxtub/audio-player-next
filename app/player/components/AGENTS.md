# AGENTS

## 目录职责
- 存放播放器页面私有组件，实现全屏播放视图的布局与挂载容器。

## 子目录结构
- `AudioPlayer/`：播放器页面专用的音频播放组件与样式。

## 关键协作与依赖
- 依赖 `@/components/FloatingPlayer` 提供的门户显隐控制与浮层入口。
- `AudioPlayer` 通过 `@/stores/playbackStore` 获取播放状态，并由 `@/components/AudioControllerHost` 承担音频宿主。
