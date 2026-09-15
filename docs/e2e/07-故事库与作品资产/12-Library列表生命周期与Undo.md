# Library 列表生命周期与 Undo

功能域：07-故事库与作品资产

## 用户目标

故事库列表支持作品收藏切换、软删除与串行安全撤销、回收站恢复与二次确认永久删除，并在跨页面（列表与详情页）导航间共享撤销生命周期，同时严格保护 opaque cursor 无限分页缓存不被脏注入。

## 验收范围

本规范建立 M3-05 故事库列表生命周期操作与 Undo（List Lifecycle / Optimistic Cache / Undo）契约：

1. **共享 Undo 生命周期与无 Store 约束**：
   - 在 `app/(main)/library/layout.tsx` 中挂载 `LibraryUndoProvider`，实现 `/library` 列表页与 `/library/[id]` 详情页共享同一撤销上下文；
   - 用户在详情页执行移入回收站并自动跳回列表页时，Undo 悬浮条不因页面组件卸载而丢失；
   - Undo 仅作为瞬态命令与 UI 状态由 React Context 与 useState 驱动，**严格禁止新增或引入 `libraryStore`**；
   - 统一由 `lib/client/libraryMutations.ts` 集中管理缓存 patch、快照回滚与查询失效。

2. **收藏 / 取消收藏切换 (Favorite)**：
   - 乐观更新：取消在途查询 → 截取快照 → patch 当前已加载 item 的 `favoritedAt`；
   - **核心不变性**：在 `active` 视图收藏作品时，**绝对禁止直接向已有的 favorites infinite cache 追加记录**（无法预测服务端 opaque cursor 与分页归属）；正确行为为仅更新当前 active 卡片状态，并由 query invalidation 在访问收藏页时按需拉取；
   - 在 `favorites` 视图取消收藏时，允许从当前已加载的 pages 中移除并触发失效；
   - 失败时自动根据快照回滚；成功后对齐服务端返回的最新 DTO。

3. **移入回收站与串行 Undo 防竞态 (Move to Trash & Serial Undo)**：
   - 移入回收站无需二次确认；
   - 乐观更新：采用 view-aware 变更算子，仅从 `active` / `favorites` 的已加载缓存中移除该项（绝不追加到 trash 缓存）；
   - 发起 `moveToTrash` RPC，并在 Undo Provider 中注册当前 session，返回独立递增 `token`；
   - **Undo 核心竞态防御**：当用户在 move RPC 仍在进行（pending）时点击「撤销」，**严格禁止立即调用 restore(id)**，必须严格串行：`await movePromise → then restore(id)`，彻底避免 restore 遭遇 409 CONFLICT 导致作品最终误入回收站的致命竞态；
   - **Token-aware 失败清理（B1）**：move 失败时严格通过 `dismissUndo(token)` 清除当前会话，若期间已发起新的 move 会话（token 已递增），旧失败清理视为 no-op，严禁无条件清除冲掉新 Undo；
   - **局部逆向回滚（B3）**：失败时仅对本 mutation 修改过的特定条目执行逆向局部回滚，严禁使用全量 snapshot 覆盖，防止覆盖并发的其他作品操作；
   - Undo 成功后不要本地 splice 回 active 列表，由 `invalidateQueries` 重新安全同步。

4. **回收站恢复 (Restore)**：
   - 回收站内点击恢复无需二次确认；
   - 乐观从 trash 列表中移除该项；
   - **核心不变性**：绝对禁止本地向 active 列表追加该项；
   - 成功后触发 active/favorites/trash 相关查询失效；失败则根据局部日志逆向回滚。

5. **永久删除与二次确认 (Permanent Delete)**：
   - **必须强制二次确认**；未确认前严格执行**零 RPC 调用**；
   - 悲观执行：仅在用户明确确认后发起 `deletePermanently` RPC；
   - 请求成功后从 trash 缓存中移除并失效对应查询；
   - 不展示 Undo，严禁在网络成功前执行危险的乐观删除。

6. **缓存不变性与 Opaque Cursor 防护 (Cache Invariants)**：
   - **View-aware 视图隔离（B2）**：每个 list query 独立从自身 queryKey 读取 `view`（active/favorites/trash）并执行对应操作，绝不将全局当前视图作为统一布尔盲目应用于所有缓存；
   - 乐观更新与移除仅允许针对当前 loaded items 进行，严格禁止凭客户端臆测向另一个无限列表注入或追加 item；
   - 各页的 `nextCursor`、`hasMore` 以及 `data.pageParams` 在任何 patch/remove 或 rollback 操作后必须保持严格一致与原样不变；
   - **局部逆向回滚一致性（B3）**：Favorite、MoveToTrash、Restore 均复用统一的 Mutation Journal 逆向局部补丁机制，彻底避免三套并发回滚语义冲突。

## 关联实现与测试

- 集中 Mutation 与缓存算子：`lib/client/libraryMutations.ts`
- 撤销生命周期 Provider 与样式：`components/Library/LibraryUndoProvider.tsx`、`components/Library/libraryUndo.module.scss`
- 路由共享布局：`app/(main)/library/layout.tsx`
- 作品卡片交互接入：`app/(main)/library/components/StoryWorkCard.tsx`
- 列表生命周期与 Undo 单元测试：`tests/unit/persistence-config/library-list-lifecycle-undo.unit.test.ts` (`exec-library-list-lifecycle-undo`)
