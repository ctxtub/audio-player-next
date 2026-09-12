# Library 列表查询模型与 ViewModel 边界

功能域：07-故事库与作品资产

## 用户目标

Library 前端通过冻结的 Client Facade 建立稳定的列表/详情查询模型，列表使用固定 20 条的 opaque-cursor 无限分页，并在 UI ViewModel 层预留 Progress 与 Audio 合成边界，不复制或绕过服务端状态契约。

## 验收范围

本规范建立 M3-02 故事库查询模型（Query Model）与展示模型（ViewModel）合成边界契约：

1. **查询键分层规范 (Query Key Hierarchy)**：
   - 根级键：`libraryKeys.all = ['library']`；
   - 列表键：`libraryKeys.lists() = ['library', 'list']`；
   - 具名列表查询键：`libraryKeys.list({ view, query }) = ['library', 'list', { view, query }]`；
   - 详情根级键：`libraryKeys.details() = ['library', 'detail']`；
   - 详情实例键：`libraryKeys.detail(id) = ['library', 'detail', id]`；
   - **绝对禁止游标混入**：游标（`cursor`）绝不得写入 `list` 的 query key，游标仅作为 `useInfiniteQuery` 的内部 `pageParam` 存在。

2. **列表分页大小契约冻结 (Page Size = 20)**：
   - 列表查询模型分页大小严格锁定为 `DEFAULT_LIBRARY_LIMIT = 20`；
   - 生产查询 API（`libraryListInfiniteQueryOptions` 与 `useLibraryListInfiniteQuery`）禁止暴露任何 `limit` 参数 override，防止外部传入不同 limit 导致相同 query key 下产生分裂的缓存数据形状；
   - `queryFn` 委托调用 Client Facade 时恒定注入 `limit: 20`。

3. **无限滚动游标翻页契约 (Opaque-Cursor Continuation)**：
   - 初始页参数 `initialPageParam` 固定为 `undefined`；
   - `getNextPageParam` 严格遵循连续性语义：
     - 当且仅当 `lastPage.hasMore === true` 且 `lastPage.nextCursor != null` 时返回 `lastPage.nextCursor`；
     - 当 `lastPage.hasMore === false` 或 `lastPage.nextCursor == null` 时必须返回 `undefined`，明确指示终止后续分页请求；
     - 防御性拦截脏游标残留，杜绝无限死循环翻页。

4. **Client Facade 委托一致性**：
   - 列表 `queryFn` 严格且仅委托至 `libraryClient.list({ view, query, cursor, limit: 20 })`；
   - 详情 `queryFn` 严格且仅委托至 `libraryClient.get({ id })`；
   - 不绕过 Client Facade 直接调用底层 tRPC router 或服务端逻辑。

5. **ViewModel 合成与扩展接缝 (M5 & M8 Seam)**：
   - 列表项 ViewModel：`LibraryItemViewModel<TProgress = null>`，扩展 `StoryWorkSummaryDTO` 并注入 `progress: TProgress | null`；
   - 详情项 ViewModel：`LibraryDetailViewModel<TProgress = null>`，扩展 `StoryWorkDetailDTO` 并注入 `progress: TProgress | null`；
   - M3 阶段 `progress` 注入恒为 `null`；为 M5 预留按 `storyId` 外部批量注入播放进度投影的确定性接缝，无需重构查询或缓存；
   - 严格保真 `audio` 投影字段（`status` 与 `durationMs`），为 M8 音频合成预留稳定契约。

6. **静态架构守卫 (Forbidden Imports Guard)**：
   - 客户端查询与 ViewModel 模块（`lib/client/libraryQueries.ts`、`lib/client/libraryViewModel.ts`）严格禁止导入 `@/lib/trpc/client`、`@/lib/server/*`、`@prisma/*` 或 `@trpc/react-query`；
   - 保证客户端数据获取层纯粹依赖冻结的 Client Facade（`@/lib/client/library`）与 `@tanstack/react-query`。

## 关联实现与测试

- 查询模型：`lib/client/libraryQueries.ts`
- ViewModel 合成：`lib/client/libraryViewModel.ts`
- 验证套件：`tests/unit/persistence-config/library-query-model.unit.test.ts` (`exec-library-query-model`)
