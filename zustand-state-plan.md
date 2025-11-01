# Zustand 状态管理改造方案

## 背景与目标
- 统一跨页面状态源，消除重复维护 `apiConfig`、播放信息等导致的竞态与不一致。
- 将副作用（接口请求、定时器、localStorage 操作等）迁移到 store 层，降低组件复杂度并提升可测性。
- 为后续扩展（多端渲染、多播放器、独立设置页面等）预留清晰的状态边界。

## 状态类型改造建议


### 提示词历史状态（PromptHistory）
#### 依赖分析
- **数据来源**：`localStorage` 中的历史记录、用户手动保存/删除操作。
- **数据消费者**：`InputStatusSection` 快速入口、`HistoryRecords` 弹窗。
- **外部依赖**：与其他 store 耦合较弱，仅 Story store 会写入使用记录。

#### Store 设计
- **状态**：`items: PromptHistoryItem[]`、`sortMode`。
- **动作**：
  - `hydrate()`：初始化时读取 localStorage，剔除超过 30 天的记录。
  - `upsert(prompt)`：更新使用次数与时间。
  - `remove(prompt)`：用户删除记录时调用。
  - `setSortMode(mode)`：切换排序方式并重新排序。
- **实现要点**：
  - 使用 `persist` 包装自定义 storage，解析失败时回退默认值。
  - 提供 `selectSortedItems()` 以减少组件层排序逻辑。
