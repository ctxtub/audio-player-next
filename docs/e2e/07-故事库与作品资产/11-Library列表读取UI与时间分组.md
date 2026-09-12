# Library 列表读取 UI 与时间分组

功能域：07-故事库与作品资产

## 用户目标

故事库提供跨页打平的统一时间分组、三视图切换、无限滚动加载与无 Detail Link 的回收站卡片只读浏览体验。

## 验收范围

本规范建立 M3-04 故事库列表读取 UI 与时间分组（List Read UI）契约：

1. **单向数据链与内存防重**：
   - 数据链严格为：`useLibraryFilters()` → canonical `{ view, q }` → `useLibraryListInfiniteQuery()` → `data.pages.flatMap(page.items)` → `composeLibraryItemListViewModel(...)` → **flatten 后统一时间分组** → render；
   - 严禁逐页（page-by-page）分组；
   - 严禁手工管理游标（cursor）；
   - 严禁新增 `libraryStore`，严禁在 UI 中直接调用 `libraryClient`；
   - 基于 `StoryWork.id` 执行防御性去重，保证多页重叠或重试时不渲染重复卡片。

2. **跨页同时间组聚类（Pagination Time Group Regression）**：
   - 当第 1 页最后一条记录与第 2 页第一条记录属于同一时间区间（例如同为「今天」）时，多页打平后在整个列表视图中必须**只渲染一个**该区间的统一分组标题；
   - 绝不因分页边界产生割裂的重复分组标题（如两次出现「今天」）。

3. **视图分组字段与卡片链接边界**：
   - `active` 与 `favorites` 视图：时间分组字段为 `createdAt`，作品卡片标题必须生成指向 `/library/[id]` 的导航链接；
   - `trash` 视图：时间分组字段为 `deletedAt`（客户端提供 fail-safe 容错，缺失时兜底 `createdAt`）；
   - **回收站卡片无 Detail Link 铁律**：在 `trash` 视图下，卡片内部绝不能生成任何指向 `/library/[id]` 的链接元素。

4. **无限滚动三重 Gate 守护**：
   - 无限滚动仅当满足 `hasNextPage && !isFetchingNextPage && sentinel.isIntersecting` 时才触发 `fetchNextPage()`；
   - 必须配备并发防重锁（In-flight lock），绝不允许同一时刻或重复交叉触发两次 `fetchNextPage()`；
   - 提供手动点击「加载更多」作为 Observer 不可用或弱网时的交互兜底。

5. **全量 UI 状态覆盖**：
   - 至少完整覆盖 8 种视图状态：
     1. 初始加载骨架屏（initial loading / 6 skeleton cards）；
     2. 初始失败重试（initial error + retry button）；
     3. 全部空状态（active empty / 去创作 CTA）；
     4. 收藏空状态（favorites empty）；
     5. 回收站空状态（trash empty / 30天清理提示）；
     6. 搜索无结果空状态（search empty / 清除搜索）；
     7. 触底次页加载（next-page loading）；
     8. 终态没有更多（terminal no-more）。

6. **只读纯净契约**：
   - 本模块仅实现读取与展示逻辑，严禁提前触发或引入收藏/删除/恢复/物理删除等 Mutation 操作。

## 关联实现与测试

- 时间分组领域纯函数：`lib/client/libraryGrouping.ts`
- 列表视图与子组件：`app/(main)/library/`
- 列表读取与时间分组单元测试：`tests/unit/persistence-config/library-list-read-ui.unit.test.ts` (`exec-library-list-read-ui`)
