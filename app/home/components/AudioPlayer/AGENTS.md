# AGENTS

## 目录职责
- 实现首页音频播放器的 UI 与交互逻辑。
- 通过 ref 暴露播放控制方法供页面调用。

## 子目录结构
- `index.tsx`：组件实现。
- `index.module.scss`：组件样式。

## 关键协作与依赖
- 依赖 `@/stores/**` 状态及 `@/app/services/storyFlow` 提供的控制方法。
- 使用 `@/public/icons/**` 的矢量资源构建播放器 UI。
