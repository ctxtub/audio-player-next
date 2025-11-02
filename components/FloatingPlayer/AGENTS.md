# AGENTS

## 目录职责
- 提供常驻布局的悬浮播放器组件，统一控制浮窗显示与音频交互。
- 维护播放器拖拽与 UI 状态，并在内部注册音频控制器。
- 协同业务服务处理故事段落切换与播放错误提示。

## 子目录结构
- `index.tsx`：悬浮播放器组件实现与控制 Hook 复导出。
- `utils.ts`：悬浮拖拽状态与位置计算工具函数。
- `index.module.scss`：悬浮播放器样式。

## 关键协作与依赖
- 依赖 `@/components/AudioControllerHost` 提供的播放控制，并复用 `@/components/StoryViewer` 展示文本。
- 通过 `@/stores/playbackStore` 协调跨路由播放状态与浮窗显隐。
- 读取 `@/stores/configStore` 中的配置开关控制浮窗默认展示。
