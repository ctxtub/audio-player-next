# AGENTS

## 目录职责
- 提供音频生成阶段的视觉反馈动画（动态音波）。

## 子目录结构
- `index.tsx`：组件实现。
- `index.module.scss`：组件样式。

## 关键协作与依赖
- 依赖 `@/stores/generationStore` 获取 `phase` 以控制显隐。
