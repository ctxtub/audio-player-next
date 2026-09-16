# Collection Library 两层列表与集合生命周期

功能域：07-故事库与作品资产

## 用户目标

用户在故事库顶层看到的是作品集（Collection）卡片而非零散作品；在集合详情中看到成员作品按集合内 position 顺序排列并可逐 Work 播放；集合支持重命名、收藏、软删除、恢复、Undo 与永久删除，全部集合级生效。

## 前置条件

- 服务可用，数据库已执行必要迁移。
- 真实注册用户（`ensureRegisteredByApi`），独立洁净数据空间。
- 经真实 tRPC（`conversation.createNew` + `collection.promoteArtifact`）预置同一会话的 3 个作品 → 同属一个 Collection（position 0/1/2）。

## 操作步骤

1. **集合种子**：同一 `conversationId` 下 promote 3 个不同 `sourceMessageId` 的作品（标题含可断言关键词）。
2. **顶层列表**：访问 `/library`，确认出现且仅出现 1 张集合卡片（`collection-card-{id}`），卡片展示集合标题与 `3 个作品` 计数；旧式零散作品卡片不再作为顶层项出现。
3. **集合详情与成员顺序**：点击集合卡片进入 `/library/collections/{id}`，确认 3 个成员按 position 升序排列（标题顺序与种子顺序一致），每个成员有独立播放入口。
4. **逐 Work 播放**：点击第 2 个成员的播放，确认播放会话 source 为该 Work（`workId` 一致），不串到其他成员。
5. **重命名**：在详情页重命名集合，返回列表确认标题同步。
6. **收藏**：收藏集合，切换收藏视图确认出现；取消收藏确认消失。
7. **软删除 + Undo**：删除集合，确认列表消失且 Undo 浮条出现；点击撤销，确认集合恢复。
8. **回收站恢复**：再次删除，不撤销；切回收站视图确认出现且无详情入口；点击恢复，确认回到全部视图。
9. **永久删除**：第三次删除 → 回收站 → 永久删除二次确认 → 确认集合与成员在全部/收藏/回收站视图彻底消失，直接访问详情呈统一不可用。

## 验收标准

- 列表顶层项恒为 Collection（含 workCount），搜索命中集内 Work 时仍按 Collection 去重（服务端已保证，UI 不二次聚合）。
- 成员顺序严格等于服务端 position 升序；播放 source 精确到成员 workId。
- 集合软删除后其成员播放授权 fail closed（详情不可用）。
- 永久删除走二次确认；全程控制台无未捕获异常。

## 关联实现与测试

- 场景测试：`tests/system/browser/scenarios/library-collection.spec.ts`
- 可执行 ID：`exec-l3-collection-library`
- 契约规范：`docs/specs/2026-09-15-story-collection-continuous-creation-technical-design.md` §3/§6
