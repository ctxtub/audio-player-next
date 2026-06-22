# Plan · 播放器页历史区平铺（分段切换面板）

配套规范：`docs/specs/2026-06-22-player-history-panel-tiling.md`

## 步骤

### 1. 重构 `HistoryRecords` 为纯内联列表
- 去掉 `Modal` 包裹与 `useModal`、`useImperativeHandle`、`showModal` ref（`HistoryRecordsRef`）。
- 默认导出列表组件，props 仅 `onSelectPrompt`；内部读 `recordsMap` + `sortMode` 渲染已排序列表与空状态。
- 移除组件内的排序按钮（上提到 `HistoryPanel` 头部）。
- 列表根容器适配内联（不再依赖 Modal 的高度），保留既有 item/操作按钮样式。
- 验证：`yarn tsc --noEmit` 不报该文件类型错误。

### 2. 重构 `GenerationHistory` 为纯内联列表
- 同上去 Modal/去 ref；默认导出列表组件（无 props）。
- 保留登录门：访客「登录后查看」、登录空「暂无生成历史」、有数据列表 + 回放/删除。

### 3. 新增 `HistoryPanel`
- `index.tsx`：`useState` 维护 `activeTab: 'prompt' | 'generation'`，默认 `'prompt'`。
- 头部：自研分段控件（role=tablist/tab，aria-selected）；右侧排序槽，仅 `activeTab==='prompt'` 时渲染「频率/时间」切换（读写 `promptHistoryStore` 的 `selectSortMode`/`setSortMode`）。
- 主体：按 `activeTab` 渲染 `HistoryRecords`（传 `onSelectPrompt`）或 `GenerationHistory`。
- `onSelectPrompt`：`setPendingAutoSend(prompt)` + `router.push('/chat')`（迁移自 `InputStatusSection`）。
- `index.module.scss`：玻璃面板容器、分段控件、头部行、`flex:1; min-height:0` + 列表区内部滚动；全部用 Design Token。

### 4. 接入页面并删除旧入口
- `app/(main)/player/index.tsx`：移除 `InputStatusSection` 引用与渲染，在 `AudioPlayer` 后渲染 `HistoryPanel`。
- 删除 `app/(main)/player/components/InputStatusSection/`（连带死样式）。
- `app/(main)/player/index.module.scss`：`.homePage`/`.pageSection` 撑满高度，使面板可 `flex:1` 填充。

### 5. 验证（落档结果）
- `yarn lint`、`yarn tsc --noEmit`、`yarn build` 全绿。
- 浏览器活体（访客态）：默认提示词历史；分段切换到生成历史显示「登录后查看」；排序切换仅提示词页出现；面板填满下方空间、不被底栏遮；控制台无报错。
- 截图留证。
