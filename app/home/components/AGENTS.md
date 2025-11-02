# AGENTS

## 目录职责
- 存放首页页面专用的拆分组件，实现历史记录与输入状态等模块。
- 保持组件按功能分目录，方便独立演进。

## 子目录结构
- `HistoryRecords/`：播放历史展示。
- `InputStatusSection/`：输入与状态组合模块。

## 关键协作与依赖
- 组件依赖 `@/stores/**`、`@/app/services/storyFlow` 共享业务状态。
- 使用 `@/components/**` 中的通用 UI 组件提升一致性。
