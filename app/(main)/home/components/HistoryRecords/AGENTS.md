# AGENTS

## 目录职责
- 展示故事播放历史记录，辅助用户回溯生成内容。
- 响应首页状态变更并渲染列表。

## 子目录结构
- `index.tsx`：组件实现。
- `index.module.scss`：组件样式。

## 关键协作与依赖
- 依赖 `@/stores/storyStore`、`@/stores/promptHistoryStore` 获取数据。
- 复用 `@/components/Modal` 提供的弹窗能力。
