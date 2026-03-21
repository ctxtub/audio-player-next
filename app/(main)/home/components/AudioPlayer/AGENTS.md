# AudioPlayer Component

## 职责
- 展示播放器核心交互界面（黑胶唱片样式）。
- 提供播放/暂停控制。
- 展示播放进度条与时间。
- 提供倍速切换功能。

## 结构
- `index.tsx`: 组件主逻辑与 JSX。
- `index.module.scss`: 样式定义。

## 依赖
- `@/stores/playbackStore`: 获取播放状态（时间、时长、倍速）。
- `@/public/icons/*`: 播放控制图标。
- `antd-mobile`: Toast 提示。
