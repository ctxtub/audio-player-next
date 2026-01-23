# AGENTS

## 目录职责
- 展示内容生成的实时预览，包括文本流式输出（打字机效果）与音频合成状态。
- 作为生成过程中的主要视觉反馈区域。

## 子目录结构
- `index.tsx`：组件实现。
- `index.module.scss`：组件样式。

## 关键协作与依赖
- 依赖 `@/stores/generationStore` 获取 `phase` (生成阶段) 和 `streamingText` (流式文本)。
- 仅在 `generating_text` 或 `generating_audio` 阶段显示。
