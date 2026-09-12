# M3 — 故事库列表与作品详情技术方案

**所属 Phase**：P1
**前置模块**：M1 路由、M2 StoryWork
**后续衔接**：M4 StoryWork 创建后刷新 Library、M5 Work Progress / Playback、M8 Audio Projection
**核心目标**：

1. 建立 `/library` 的可分页、可搜索 StoryWork 浏览体验；
2. 建立 `/library/[id]` 稳定作品详情；
3. 完成收藏 / Trash / Restore / Permanent Delete 生命周期 UI；
4. 把远端 Library 数据从 Zustand 列表模型切换到 TanStack Query；
5. 为 M5 Progress、M8 Audio 状态提供稳定 ViewModel 合成边界。

---

# 0. 核心技术决策

| 决策                             | 推荐                                                             |
| ------------------------------ | -------------------------------------------------------------- |
| Library server state           | **TanStack Query**                                             |
| 是否新增 `libraryStore`            | **否**                                                          |
| tRPC 接入方式                      | 保留现有 vanilla `trpc` client，TanStack `queryFn` 调 client wrapper |
| 是否本模块整体迁移到 `@trpc/react-query` | **否**                                                          |
| QueryClient Provider           | `(main)` 全局共享                                                  |
| 身份切换                           | cancel + clear 全部 server-state cache                           |
| List                           | `useInfiniteQuery` + M2 opaque cursor                          |
| page size                      | 20                                                             |
| cursor 是否进 URL                 | **否**                                                          |
| view/search 是否进 URL            | **是**                                                          |
| View                           | `active / favorites / trash`                                   |
| 搜索 debounce                    | **300 ms**                                                     |
| 搜索字段                           | 由 M2：title / prompt / excerpt                                  |
| 时间分组                           | active/favorites 按 `createdAt`；trash 按 `deletedAt`             |
| Progress                       | M5 batch query，与 Story summary 在 UI ViewModel 层合成              |
| Move to Trash                  | **不做阻塞二次确认，提供 Undo**                                           |
| Permanent Delete               | **必须二次确认**                                                     |
| Favorite / Restore             | 不确认                                                            |
| Trash item 是否可进 Detail         | **否，先恢复**                                                      |
| Detail canonical route         | `/library/[id]`                                                |
| Detail Unauthorized            | 与 Not Found 统一表现                                               |
| Bulk selection / 清空回收站         | V1 不做                                                          |

---

# 1. 为什么 M3 不新增 libraryStore

当前 `generationHistoryStore` 的模式是：

```text
AccountSync
   ↓
initForUser()
   ↓
fetch entire generation list
   ↓
Zustand records[]
   ↓
record/remove 自己修改数组
```

删除采用：

```text
保存 prev
→ 本地 filter
→ request
→ 失败恢复 prev
```

而且旧 GenerationHistory 页面还会从完整 `storyText` 在客户端自己截摘要。

M2 后 Library 的状态空间变成：

```text
active + query=A + page 1..N

favorites + query=A + page 1..N

trash + query=B + page 1..N

detail(123)
detail(481)

work progress batches
```

如果继续 Zustand，就需要自行实现：

* query-key；
* cursor page cache；
* request 去重；
* stale data；
* refetch；
* mutation invalidation；
* rollback；
* GC；
* search query isolation。

这些已经是 TanStack Query 的职责。

---

# 2. 新的状态边界

M3 后：

```text
Zustand
│
├── Auth / Config
├── PromptHistory
├── Chat
├── Playback runtime
└── 其他 client/domain state

TanStack Query
│
└── Library remote server state
    ├── list pages
    ├── detail
    └── M5 progress queries
```

原则：

> **Zustand 管用户会话中的持续客户端状态；TanStack Query 管可重新从服务器获得的远端资源。**

不是要求本轮顺手迁移所有旧 Store。

---

# 3. Query Provider

当前 app 虽然安装：

```text
@tanstack/react-query
@trpc/react-query
```

但 `lib/trpc/client.ts` 实际使用的是普通 `createTRPCClient()`，应用中没有 QueryClient Provider。

M3 增加：

```text
lib/query/
├── queryClient.ts
└── libraryKeys.ts

components/
└── ServerStateQueryProvider/
    └── index.tsx
```

---

# 3.1 Main Layout

当前：

```text
AccountSyncProvider
  ├── app
  ├── MainTabBar
  ├── AudioControllerHost
  └── FloatingPlayer
```

都位于同一 `(main)` layout。

目标：

```text
AccountSyncProvider
  ↓
ServerStateQueryProvider
  │
  ├── ThemeConfigBridge
  ├── Page Content
  ├── MainTabBar
  ├── AudioControllerHost
  └── FloatingPlayer
```

这样：

```text
/chat
/library
/library/[id]
/setting
```

共用同一个 QueryClient。

M4 在 `/chat` 创建新 StoryWork 后，也能 invalidation Library cache。

---

# 3.2 QueryClient

推荐：

```ts
new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
```

Library query 自身进一步设置：

```text
staleTime = 30s
gcTime = 10min
```

不建议把 Library 的具体 staleTime 设置成全局默认。

---

# 3.3 身份隔离

这是 Query 引入后必须视为安全约束的问题。

当前 AccountSync 已经特别防御：

> 账号切换后旧请求不得把上一账号数据写回新账号 Store。

Query Cache 必须达到同级别隔离。

`ServerStateQueryProvider`：

```text
mount
→ clear existing browser QueryClient

auth identity change
→ cancelQueries()
→ clear()
```

监听至少：

```text
isLogin
isGuest
username
```

变化。

进入 `(main)` 时也无条件进行一次 cache reset，从而覆盖：

```text
Guest A
→ 离开 Main
→ Guest B
→ 再进入 Main
```

这种 module-level QueryClient 尚存的情况。

不能只靠：

```text
query key = ['library']
```

然后希望 cookie 自动解决缓存隔离。

---

# 4. 为什么不同时引入 @trpc/react-query

M3 推荐：

```ts
useInfiniteQuery({
  queryKey,
  queryFn: ({ pageParam }) =>
    fetchLibraryWorks(...)
})
```

而：

```ts
fetchLibraryWorks()
```

继续内部调用现有：

```ts
trpc.library.list.query()
```

理由：

1. 当前项目全部 client wrapper 都是这种模式；
2. M3 只需要引入一个 Query Provider；
3. 不需要同时迁移现有 tRPC client architecture；
4. 降低本模块横切范围。

`@trpc/react-query` 可以未来统一迁移，但不应绑在 Library 上线。

---

# 5. Client API

新增/补齐：

```text
lib/client/library.ts
```

提供：

```ts
listStoryWorks(input)
getStoryWork(id)

renameStoryWork(input)
setStoryWorkFavorite(input)
moveStoryWorkToTrash(id)
restoreStoryWork(id)
deleteStoryWorkPermanently(id)
```

UI 不直接写：

```ts
trpc.library...
```

保持现有：

```text
UI
↓
lib/client/*
↓
tRPC
```

习惯。

---

# 6. Query Key

统一：

```ts
libraryKeys = {
  all: ['library'],

  lists: () =>
    ['library', 'list'],

  list: ({
    view,
    query,
  }) =>
    ['library', 'list', {
      view,
      query,
    }],

  details: () =>
    ['library', 'detail'],

  detail: (id) =>
    ['library', 'detail', id],
}
```

注意：

> Cursor 不进入 Query Key。

Cursor 是：

```text
InfiniteQuery pageParam
```

不是新的业务查询。

---

# 7. URL State

Library 的稳定浏览条件进入 URL：

```text
/library

/library?view=favorites

/library?view=trash

/library?q=月球

/library?view=favorites&q=狐狸
```

默认：

```text
view = active
```

URL 中省略：

```text
?view=active
```

---

# 7.1 为什么 view/query 进 URL

这样支持：

* Refresh；
* Back；
* Bookmark；
* detail 返回；
* 调试；
* E2E 稳定定位。

但：

```text
cursor
```

不进入 URL。

无限滚动位置属于一次浏览 session，而不是用户应该 Bookmark 的页面状态。

---

# 7.2 URL 更新策略

筛选与搜索都使用：

```text
router.replace()
```

不是：

```text
router.push()
```

避免浏览器 Back 变成：

```text
狐狸
→ 狐
→ 空
→ 收藏
→ 全部
```

这种过滤历史。

进入 Story Detail 才正常：

```text
router.push('/library/481')
```

---

# 8. List Query

最终：

```ts
useInfiniteQuery({
  queryKey: libraryKeys.list({
    view,
    query: normalizedQuery,
  }),

  initialPageParam: null,

  queryFn: ({ pageParam }) =>
    listStoryWorks({
      view,
      query: normalizedQuery || undefined,
      cursor: pageParam ?? undefined,
      limit: 20,
    }),

  getNextPageParam: (lastPage) =>
    lastPage.nextCursor ?? undefined,

  staleTime: 30_000,
  gcTime: 10 * 60_000,
})
```

完全消费 M2 的：

```text
opaque cursor
```

Client 不 decode。

---

# 9. Infinite Scroll

列表底部：

```text
Story Cards
    ↓
LoadMoreSentinel
```

使用：

```text
IntersectionObserver
```

推荐：

```text
rootMargin: '600px 0px'
```

即：

> 用户真正滚到底之前提前拉下一页。

触发条件：

```text
hasNextPage
&&
!isFetchingNextPage
```

---

# 9.1 Fallback

不要完全依赖 IntersectionObserver。

Sentinel 同时可以表现为：

```text
[加载更多]
```

在：

* Observer 不可用；
* 自动加载失败；

时允许手动点击。

这是 accessibility 和错误恢复兜底。

---

# 9.2 next-page failure

已有内容绝不能被全屏 Error 覆盖。

例如：

```text
20 条 Story
──────────────
加载更多失败
[重试]
```

继续保留前 20 条。

只有 Initial Query Failure 才使用全页面 Error State。

---

# 10. Page Flatten

ViewModel：

```ts
const items = data.pages.flatMap(
  page => page.items
)
```

再做 defensive：

```text
dedupe by StoryWork.id
```

Keyset 正常情况下不会重复，但：

* mutation；
* refetch；
* 网络 retry；

不应该把重复卡片暴露给用户。

---

# 11. 搜索

## 11.1 Input state

区分：

```text
rawSearchInput
```

与：

```text
URL / effective query
```

流程：

```text
用户输入
   ↓
rawSearchInput
   ↓
300ms debounce
   ↓
trim
   ↓
router.replace(?q=...)
   ↓
Infinite Query Key 变化
```

---

# 11.2 Chinese IME

必须支持：

```text
compositionstart
compositionend
```

IME composing 期间：

> 不提交 debounced search。

否则中文输入可能在拼音中间不断发：

```text
h
hu
hul
狐狸
```

---

# 11.3 Max length

和 M2：

```text
query <= 100
```

保持一致。

Search input：

```text
maxLength=100
```

外部 URL 若传入超长 q：

```text
normalize + slice(0,100)
```

并 canonicalize URL。

---

# 11.4 Query change

当：

```text
view
或
effective query
```

变化：

* 新 Query Key；
* Cursor 自动回第一页；
* scroll container 回 top；
* 旧 cursor 永远不复用。

---

# 11.5 Search 时是否保留之前结果

输入 debounce 的 300ms 内：

> 继续显示当前结果。

真正 effective query 改变后：

> 不使用上一 Query 的 Story cards 伪装成新搜索结果。

使用新查询：

```text
search loading overlay / skeleton
```

不设置跨 query 的 `placeholderData`。

避免：

```text
搜索“海洋”
```

却短暂显示：

```text
“月球”的结果
```

---

# 12. View 组合

正式支持：

```text
active
favorites
trash
```

搜索作用于当前 view：

```text
favorites + q
trash + q
```

切换 view 时推荐：

> 保留当前 q。

因此：

```text
全部里搜狐狸
→ 收藏
```

语义是：

> 收藏中的狐狸。

用户清空输入时恢复整个 view。

---

# 13. Library Toolbar

推荐结构：

```text
┌────────────────────────────┐
│ 故事库                     │
│                            │
│ 🔍 搜索故事                 │
│                            │
│ [全部] [收藏]       [回收站]│
└────────────────────────────┘
```

`Trash` 视觉弱于：

```text
全部 / 收藏
```

但依然是一等可发现入口。

不需要另建：

```text
/library/trash
```

因为它仍是 Library 的过滤视图。

---

# 14. 时间分组

Server 保持全局排序：

### active / favorites

```text
createdAt DESC
id DESC
```

### trash

```text
deletedAt DESC
id DESC
```

M3 在**所有已加载 pages flatten 后**统一分组。

不能：

```text
每一页单独 group
```

否则 page boundary 可能产生：

```text
今天
Card...

今天
Card...
```

重复 Header。

---

# 14.1 分组定义

active / favorites：

```text
今天
昨天
本周
更早
```

依据：

```text
createdAt
```

Trash：

同样标签，但依据：

```text
deletedAt
```

即表达：

> 什么时候删除。

---

# 14.2 “本周”

定义：

```text
用户设备本地时间
周一 00:00 开始
```

不用新增 date library。

新增纯函数：

```text
groupStoryWorksByTime(
  items,
  view,
  now,
)
```

测试显式传 `now`，禁止依赖测试机当前时间。

---

# 15. List 状态

## Initial loading

```text
Header / Toolbar 已显示

下面：
6 个 StoryCard Skeleton
```

不使用：

```text
PageLoading
```

覆盖整个 App。

---

## Empty — Active

无搜索：

> 还没有故事
> 完成一次创作后，作品会保存在这里。

CTA：

```text
去创作
```

→ `/chat`

---

## Empty — Favorites

> 还没有收藏的故事

不需要大 CTA。

---

## Empty — Trash

> 回收站为空

补充：

> 移入回收站的作品会在 30 天后永久删除。

---

## Empty — Search

任意 view：

> 没有找到匹配“月球”的故事

提供：

```text
清除搜索
```

---

## Initial failure

```text
故事库加载失败
[重试]
```

保留 Toolbar，使用户仍然知道自己在哪。

---

## Background refetch

已有内容继续显示。

只显示轻量：

```text
refresh indicator
```

不 Skeleton 整页。

---

# 16. Story Card ViewModel

不要让 JSX 直接同时读取：

```text
StoryWork
Playback Progress
Playback Session
Audio state
```

新增：

```ts
type StoryCardViewModel = {
  work: StoryWorkSummaryDTO

  playback: {
    state:
      | 'not_started'
      | 'in_progress'
      | 'completed'

    progress: number

    isCurrent: boolean
    sessionStatus?: PlaybackSessionStatus
  } | null

  primaryAction: StoryPrimaryAction
}
```

---

# 17. M5 getWorkProgressBatch 合成

M5 最终提供：

```text
playback.getWorkProgressBatch
```

最多：

```text
50 ids
```

M3 对当前已经加载的 work ids：

```text
[1..N]
```

按最多 50 切 chunk：

```text
chunk 1: ids 1..50
chunk 2: ids 51..100
...
```

每个 chunk 是独立 TanStack Query：

```text
['playback', 'work-progress', sortedIds]
```

结果合并：

```ts
Map<workId, WorkPlaybackProgressDTO>
```

然后与 Story Summary 合成。

---

# 17.1 为什么不一张 Card 一个 Query

否则加载 100 条：

```text
100 queries
```

即使 HTTP batching，也产生大量独立 cache/query bookkeeping。

Batch 50 与 M5 接口一致。

---

# 17.2 为什么不把 Progress 写入 Library cache

因为：

```text
StoryWork metadata
```

和：

```text
user playback interaction
```

生命周期不同。

不把：

```text
progress: 0.42
```

偷偷 merge 进 `StoryWorkSummaryDTO`。

---

# 17.3 M3 先于 M5 落地

实施顺序上 M3 早于 M5。

因此 M3 的 Card contract 从第一天就允许：

```text
playback = null
```

此时：

```text
CTA = 播放
不显示长期进度
```

M5 上线后：

```text
useWorkProgressMap()
```

接入即可。

StoryCard JSX 不需要重写。

---

# 18. Story Card 结构

推荐：

```text
┌────────────────────────────┐
│ 月球上的小狐狸         ☆   │
│ 一只小狐狸第一次离开……     │
│                            │
│ 小雅 · 8 分钟 · 昨天 20:31 │
│                            │
│ ━━━━━━━●━━━━━ 42%          │
│                            │
│ [▶ 继续播放]           ⋯   │
└────────────────────────────┘
```

Card 分为：

```text
Header
├── title
└── favorite indicator

Content
└── excerpt

Meta
├── voice
├── duration
└── date

Playback
├── progress
└── primary CTA

Actions
└── overflow
```

---

# 18.1 Detail navigation

不要：

```html
<a>
  整张 Card
  <button>播放</button>
</a>
```

产生交互元素嵌套。

推荐：

```text
Card article

Title/content region
→ Link /library/[id]

Playback button
→ independent button

Overflow
→ independent button
```

---

# 19. CTA 派生规则

集中为纯函数：

```ts
deriveStoryPlaybackAction({
  historicalProgress,
  currentSession,
  audio,
})
```

Story Card 与 Detail 共用。

禁止两处自己写一套判断。

---

# 19.1 Current Session 优先级最高

如果当前 M5 Session：

```text
source = work(this.id)
```

则：

### playing

```text
CTA = 暂停
```

### paused / ready

```text
CTA = 继续播放
```

### synthesizing

```text
CTA = 准备中
```

### ended

```text
CTA = 再次播放
```

### error

```text
CTA = 重试播放
```

---

# 19.2 非 Current Work

使用 WorkPlaybackProgress：

### not_started

```text
播放
```

### in_progress

```text
继续播放
```

即使：

```text
completedAt != null
```

也仍然按 M5-P01：

```text
继续播放
```

### completed

```text
再次播放
```

---

# 19.3 M8 Audio 状态

未来：

### missing

不改变 CTA。

点击播放后 lazy materialize。

### preparing

显示：

```text
正在准备
```

### failed

CTA：

```text
重试播放
```

### ready

正常。

AudioStatus 不改变：

```text
Work playback identity
```

---

# 20. Progress 展示

仅：

```text
in_progress
```

时展示明显进度。

M5 阶段：

```text
paragraph-level ratio
```

所以视觉上：

```text
42%
```

可以展示，但不显示：

```text
03:42 / 08:16
```

这种伪精确作品时长。

M8 ready 后才有正式：

```text
duration
story-level timeline
```

---

# 21. Story Card Actions

Active：

```text
播放 / 继续 / 暂停
收藏 / 取消收藏
查看详情
再次创作
移到回收站
```

可选：

```text
重命名
```

取决于 M2-P01 产品决策。

---

# 21.1 “再次创作”

M3 从 Detail DTO 获得：

```text
prompt
```

调用 M4：

```text
setPendingAutoSend(prompt)
router.push('/chat')
```

行为即 M4 已拍板的自动重新创作。

---

# 21.2 “继续创作”

这和：

```text
用原 Prompt 再创作
```

不是同一个语义。

真正“基于这篇 Story 继续”需要 M4 提供：

```text
continueFromStoryWork(workId)
```

的上下文契约。

M3 不自行把：

```text
storyText + 魔法 prompt
```

拼出来。

因此：

> P1 可以先提供“再次创作”；“继续创作”按钮只有在 M4 工作上下文契约存在后开启。

---

# 22. Library Playback 边界

M3 UI 不直接调用旧：

```text
replayGeneration(record)
```

新增稳定 facade：

```text
app/services/libraryPlayback.ts
```

UI 永远：

```ts
playStoryWork(workId, mode)
```

---

# 22.1 M3 P1 implementation

M5 尚未落地时：

```text
playStoryWork(workId)
   ↓
library.get(workId)
   ↓
legacy paragraph replay
```

内部复用现有 story playback。

---

# 22.2 M5 上线后

同一个 facade：

```text
playStoryWork
   ↓
beginPlaybackSession({
     source: work(workId)
   })
```

StoryCard 不改。

这是 M3/M5 的实施接力点。

---

# 23. Detail Query

`/library/[id]`：

M1 已负责：

```text
id structural parsing
```

M3 Client Page：

```ts
useQuery({
  queryKey: libraryKeys.detail(id),

  queryFn: () =>
    getStoryWork(id),

  staleTime: 30_000,
})
```

不从：

```text
list.items.find(...)
```

把 Summary 当 Detail 使用。

---

# 23.1 为什么 Detail 必须独立 query

M2 Summary 明确不包含：

```text
storyText
prompt
sourceMessageId
```

因此 Detail 请求是必要的。

也避免列表把 20 × 20k 正文全部下载。

---

# 24. Detail prefetch

Story Card：

```text
pointerenter
focus
```

时可以：

```text
queryClient.prefetchQuery(
  libraryKeys.detail(id)
)
```

移动端不依赖 prefetch。

用户直接点击仍然正常加载。

这是体验优化，不是 correctness requirement。

---

# 25. Detail Loading

页面 Shell 立即显示：

```text
‹ 故事库
```

正文区域 Skeleton。

如果 list cache 能找到相同 Work 的 Summary，可以先显示：

```text
title
excerpt
metadata
```

但不制造假 `storyText`。

也就是说：

> Summary 可以做 visual placeholder，不可以伪装成 DetailDTO。

---

# 26. Detail Not Found / Unauthorized

M2：

```text
不存在
或
不属于当前 Subject
```

必须给同一个：

```text
NOT_FOUND
```

M3 统一呈现：

```text
这个故事不存在或已无法访问

[返回故事库]
```

不能区分：

```text
“存在，但这是别人的故事”
```

避免 ownership enumeration。

该视觉与：

```text
/library/[id]/not-found.tsx
```

保持一致。

---

# 27. Detail 页面动作

```text
播放 / 继续播放 / 再次播放
收藏
查看 Prompt
再次创作
继续创作（依赖 M4 contract）
重命名（若开放）
移到回收站
```

使用和 Card 完全相同的：

```text
deriveStoryPlaybackAction()
```

---

# 28. Detail 与 List Cache 接力

Mutation 后不得出现：

```text
详情已经收藏
但返回列表还是未收藏
```

因此 Mutation cache helper 同时维护：

```text
library.detail(id)
+
所有已缓存 library.list(...)
```

推荐新增：

```text
lib/query/libraryCache.ts
```

提供：

```ts
patchStoryInLibraryCaches(...)
removeStoryFromLibraryCaches(...)
invalidateLibraryLists(...)
```

组件自己不要遍历 Query Cache。

---

# 29. Detail 返回列表

正常从 List：

```text
/library?view=favorites&q=狐狸
→ /library/481
```

进入 Detail 后：

```text
Browser Back
```

会自然恢复原 URL 和 Query cache。

不在 Detail URL 追加：

```text
?returnTo=...
```

---

# 29.1 Header

提供：

```text
‹
故事库
```

移动端返回按钮优先：

```text
router.back()
```

同时页面中提供真正：

```text
Link('/library')
```

作为 deterministic breadcrumb/fallback。

---

# 30. Favorite

行为：

```text
☆ → ★
```

立即 optimistic update。

不做确认。

Mutation：

```text
library.setFavorite({
  id,
  favorite,
})
```

---

# 30.1 Cache 行为

当前 Active：

```text
只 patch favoritedAt
```

当前 Favorites，执行取消：

```text
立即从当前 list 移除
```

其他 Favorites cache：

```text
invalidate
```

如果 Active 中点收藏：

> 不尝试手工精确插入尚未打开的 Favorites page。

成功后：

```text
invalidate favorites lists
```

这样比人工维护所有 cursor 顺序可靠。

---

# 31. Move to Trash

推荐：

> **不弹 Blocking Confirm。**

原因：

1. 动作从 `⋯` 菜单触发，本身已经是 deliberate action；
2. 可恢复；
3. 真正不可逆操作是 Permanent Delete。

成功：

```text
Card 从 Active/Favorites 消失
Toast:
已移到回收站 · 撤销
```

---

# 31.1 Undo

当前 `GlassToast` 只支持文本与 success/fail icon，没有 action。

M3 推荐增补：

```ts
action?: {
  label: string
  onClick: () => void
}
```

例如：

```text
已移到回收站       撤销
```

Undo：

```text
library.restore(id)
```

---

# 31.2 如果 Trash mutation 失败

Optimistic removal 回滚。

Toast：

```text
移动失败，请稍后重试
```

---

# 32. 从 Detail 删除

成功 moveToTrash：

```text
不再留在 /library/[id]
```

推荐：

```text
router.replace('/library')
```

避免用户留在一个普通 `get()` 已经返回 NOT_FOUND 的详情 URL。

如果是从带 filter 的列表进入，Browser history 中原列表仍然存在，用户可以通过 Back/forward；但删除完成后的 deterministic landing 统一 Library。

---

# 33. Trash View

Trash card：

```text
┌────────────────────────────┐
│ 月球上的小狐狸             │
│ 一只小狐狸第一次离开……     │
│                            │
│ 昨天移入回收站             │
│ 29 天后永久删除            │
│                            │
│ [恢复]                 ⋯   │
└────────────────────────────┘
```

主 CTA：

```text
恢复
```

Overflow：

```text
永久删除
```

---

# 33.1 Trash 不进入 Detail

M2 普通：

```text
library.get
```

明确只返回 Active Work。

因此 M3 不为 Trash Card 导航：

```text
/library/[id]
```

也不新增：

```text
library.getTrash
```

V1 Trash 的目的只是：

```text
恢复
或
彻底删除
```

Story excerpt 已足够用户识别。

---

# 34. Restore

点击：

```text
恢复
```

不做确认。

Optimistic：

```text
从 Trash list 移除
```

Server success 后：

```text
invalidate active
invalidate favorites
invalidate trash
```

如果该 Story 原来：

```text
favoritedAt != null
```

恢复后自然重新进入 Favorites。

---

# 35. Permanent Delete

必须 Blocking Confirm：

```text
永久删除《月球上的小狐狸》？

删除后无法恢复。
```

按钮：

```text
取消
永久删除
```

Destructive button 使用 Design Token 的 error 状态。

不要求用户输入 Story title。

单作品删除不需要这么重。

---

# 35.1 删除条件

UI 只在：

```text
Trash view
```

暴露 Permanent Delete。

不要在 Active overflow 提供：

```text
永久删除
```

绕过 M2 lifecycle。

---

# 35.2 删除后的 Cache

成功：

```text
remove detail(id)
remove from all list caches
invalidate trash
```

M5 上线后额外：

```text
invalidatePlaybackReferencesForWork
```

和 client session cleanup。

M8 storage cleanup 由服务端 lifecycle 负责，M3 不理解 Object Storage。

---

# 36. Confirm Dialog

当前 `components/ui` 只有 GlassButton / Selector / Slider / Switch / Toast，没有现成 Dialog。

M3 新增：

```text
components/ui/GlassConfirmDialog
```

建议基于项目已经依赖的：

```text
react-aria-components
```

实现：

* Focus trap；
* Escape；
* aria-labelledby；
* aria-describedby；
* destructive action；
* Glass surface；
* DESIGN_SPEC token。

不要自己手写不可访问的 modal。

---

# 37. 是否做“清空回收站”

V1：

> **不做。**

原因：

M2 没有 bulk permanent delete contract；

一次性清空属于更高风险 destructive action，需要：

* bulk transaction；
* M8 object cleanup；
* 大规模 tombstone；
* 更重确认。

等 Library 实际规模需要时单独设计。

---

# 38. Query Mutation 基础模式

Mutation 统一：

```text
onMutate
→ cancel relevant queries
→ snapshot relevant cache
→ optimistic patch

onError
→ restore snapshot
→ Toast

onSuccess
→ patch canonical server response

onSettled
→ invalidate minimal affected keys
```

不要简单：

```text
每次 mutation 后 invalidate ['library']
```

让整个 Library 闪烁重载。

---

# 39. Query cache helper

新增：

```text
lib/query/libraryCache.ts
```

包含：

```ts
patchStorySummary(queryClient, id, patch)

removeStoryFromLists(queryClient, id)

invalidateActiveLists(...)
invalidateFavoriteLists(...)
invalidateTrashLists(...)

primeStoryDetail(...)
```

M3/M4 共用。

---

# 40. M4 create 后 Cache

M4：

```text
library.create
→ StoryWorkDetailDTO
```

成功后：

```text
prime detail(work.id)
invalidate active lists
```

如果：

```text
favoritedAt != null
```

再 invalidate favorites。

不直接手工把 Story 插到：

```text
第 1 页 index 0
```

原因：

可能存在：

* query；
* view；
* cursor；
* createdAt order。

Server 重新查询是权威排序。

---

# 41. Rename

如果 M2-P01 决定 UI 开放：

Detail / Card overflow：

```text
重命名
```

使用轻量 Glass Dialog。

成功后：

```text
patch title
```

到：

```text
detail
所有 list caches
```

不 invalid playback progress。

M5 已确定 title rename 不改变 content identity。

---

# 42. Guest 行为

新 Library 对：

```text
User
Guest
```

都可使用。

不再沿用旧 GenerationHistory UI 的：

> 登录后查看。

旧组件注释仍保留了“登录专属”的历史语义，但 AccountSync 实际已经会在 Guest 下初始化 generationHistory。

M3 应统一 Subject 行为。

Guest 可增加非阻塞提示：

```text
访客作品为临时保存
登录后可长期保留
```

不影响主要 Library 操作。

---

# 43. Scroll 行为

`/library`：

View/query 不变时：

```text
Detail → Browser Back
```

依赖：

* TanStack cache；
* Browser scroll restoration；

恢复列表。

切换：

```text
view/query
```

时显式 scroll top。

---

# 43.1 Infinite scroll 与 Detail 回来

不要：

```text
返回 Library
→ 主动 refetch 全部页
→ 列表重新缩回第一页
```

TanStack InfiniteData 在 cache 内保留已加载 pages。

因此 Detail 返回时：

> 用户仍然看到之前已经滚到的位置附近。

---

# 44. List 刷新

不提供传统：

```text
Pull to Refresh
```

V1。

以下事件 invalidate：

* M4 create；
* favorite；
* restore；
* delete；
* permanent delete；
* rename。

另外：

```text
staleTime 30s
```

后重新进入 Library 可以自动 refetch active query。

---

# 45. M8 Audio Projection 合成

StorySummary：

```ts
audio: {
  status,
  durationMs,
}
```

M3 只消费。

### ready

Meta：

```text
8 分钟
```

### missing

不显示任何负面状态。

### preparing

小型：

```text
语音准备中
```

### failed

```text
语音准备失败
```

不在 M3 内调用 TTS。

---

# 46. File-level 改动

## 新增 — Query infrastructure

```text
lib/query/
├── queryClient.ts
├── libraryKeys.ts
└── libraryCache.ts

components/
└── ServerStateQueryProvider/
    └── index.tsx
```

---

## 新增 — Library Client

```text
lib/client/
└── library.ts
```

---

## 新增 — Hooks

```text
app/(main)/library/hooks/
├── useLibraryFilters.ts
├── useLibraryInfiniteQuery.ts
├── useLibraryMutations.ts
├── useStoryWorkDetail.ts
└── useWorkProgressMap.ts   // M5 接入点
```

---

## 新增 — List UI

```text
app/(main)/library/components/
├── LibraryToolbar/
├── LibraryList/
├── LibraryTimeGroup/
├── StoryCard/
├── LibrarySkeleton/
├── LibraryEmpty/
├── LibraryError/
├── LoadMoreSentinel/
└── TrashStoryCard/
```

---

## 新增 — shared domain UI utility

```text
app/(main)/library/utils/
├── groupStoryWorksByTime.ts
├── deriveStoryPlaybackAction.ts
└── parseLibrarySearchParams.ts
```

---

## 新增 — Detail

M1 skeleton 中正式填充：

```text
app/(main)/library/[id]/
├── index.tsx
├── index.module.scss
└── components/
    ├── StoryDetailHeader.tsx
    ├── StoryBody.tsx
    ├── StoryActions.tsx
    └── StoryMeta.tsx
```

---

## 新增 — Playback facade

```text
app/services/
└── libraryPlayback.ts
```

M3 P1 → legacy；

M5 → Playback Session。

---

## 新增 — destructive UI

```text
components/ui/
├── GlassConfirmDialog.tsx
└── GlassConfirmDialog.module.scss
```

---

# 47. 修改文件

```text
app/(main)/layout.tsx
```

接入：

```text
ServerStateQueryProvider
```

当前 shared layout 已经承载 AccountSync、TabBar、AudioHost，非常适合在此放跨 `/chat` 与 `/library` 的 QueryClient。

---

```text
components/ui/GlassToast.tsx
```

增加可选：

```text
action
```

保持旧调用完全兼容。

---

```text
app/(main)/library/index.tsx
app/(main)/library/index.module.scss
```

M1 route shell → 正式页面。

---

```text
app/(main)/library/[id]/index.tsx
```

M1 shell → Detail。

---

# 48. 不修改

M3 不修改：

```text
M2 StoryWork schema
M5 Playback DB schema
M8 Audio Manifest

/player/**
generationHistoryStore
```

最后两者仍受 M1 Frozen Compatibility 保护。

---

# 49. 实施步骤

建议内部拆成：

```text
M3-A Query infrastructure
↓
M3-B Library list + search + cursor
↓
M3-C Story Card + legacy playback facade
↓
M3-D Detail
↓
M3-E Favorite / Trash lifecycle
↓
M3-F M5 playback progress integration
↓
M3-G M8 audio projection integration
```

其中：

```text
A-E
```

可在 P1 完成。

F/G 在对应基础模块上线后接入。

---

# 50. 验证 — Query / Pagination

准备：

```text
65 StoryWorks
```

page size：

```text
20
```

滚动：

```text
20
→ 40
→ 60
→ 65
```

验证：

* 无重复；
* 无遗漏；
* 顺序正确；
* `nextCursor=null` 后不再请求。

---

# 51. 验证 — 新记录插入

已加载：

```text
page 1
page 2
```

服务器新增 Work X。

invalidate 后：

> 不允许列表出现重复旧记录或丢失边界记录。

最终 flattened IDs 唯一。

---

# 52. 验证 — Query 切换

```text
active q=""
→ active q="狐狸"
→ favorites q="狐狸"
→ trash q="狐狸"
```

每一组独立 cache。

Cursor 不交叉使用。

---

# 53. 验证 — Search debounce

快速输入：

```text
月
月球
月球狐
月球狐狸
```

300ms 内结束。

期望：

```text
Library API only receives final effective query
```

IME 输入同样测试。

---

# 54. 验证 — Search clear

有查询：

```text
q=狐狸
```

点击清除：

```text
URL q removed
cursor reset
active view retained
scroll top
```

---

# 55. 验证 — 时间分组跨页

令：

```text
page1 最后一条 = 今天
page2 第一条 = 今天
```

UI：

```text
今天
  ...
  page1 item
  page2 item
```

只出现一个：

```text
今天
```

Header。

---

# 56. 验证 — Trash grouping

Trash 按：

```text
deletedAt
```

而不是：

```text
createdAt
```

分组。

一篇 3 个月前创建、今天删除的故事：

```text
今天
```

---

# 57. 验证 — Initial states

分别覆盖：

```text
loading
active empty
favorite empty
trash empty
search empty
initial error
```

---

# 58. 验证 — Load-more error

第一页成功、第二页失败。

必须：

```text
第一页卡片仍可操作
```

并出现：

```text
加载更多失败
[重试]
```

---

# 59. 验证 — Progress 合成（M5）

Works：

```text
A not_started
B 42%
C completed
```

Card：

```text
A 播放
B 继续播放 + 42%
C 再次播放
```

M5-P01 情况：

```text
D:
completedAt != null
但 current progress = 40%
```

CTA：

```text
继续播放
```

---

# 60. 验证 — Current playback

Library 中 Work B 当前播放：

```text
M5 status = playing
```

B Card：

```text
暂停
```

其他 Work：

仍按自己长期 Progress。

---

# 61. 验证 — Detail

```text
/library/481
```

正常获取：

* title；
* storyText；
* prompt；
* metadata；
* actions。

不能依赖：

```text
Library list 已经加载过
```

Direct Bookmark 同样可访问。

---

# 62. 验证 — Unauthorized

尝试访问另一个 Subject 的 id：

```text
/library/481
```

和不存在 ID：

```text
/library/999999
```

用户看到完全一致：

```text
这个故事不存在或已无法访问
```

---

# 63. 验证 — Favorite

Active Card：

```text
收藏
```

立即变成 Favorite。

进入：

```text
view=favorites
```

能看到。

Favorites 中取消：

> Card optimistic 消失。

Server failure：

> Card 恢复。

---

# 64. 验证 — Move Trash + Undo

Active：

```text
移到回收站
```

Card 立即消失。

Toast：

```text
已移到回收站 · 撤销
```

点击撤销：

```text
restore
```

Story 重新进入 Active。

---

# 65. 验证 — Trash Restore

Trash：

```text
恢复
```

Card 消失。

Active 中重新出现。

favorite 状态保持。

---

# 66. 验证 — Permanent Delete

Trash：

```text
永久删除
```

必须先 Dialog。

Cancel：

```text
无请求
```

Confirm：

```text
deletePermanently
```

成功：

```text
所有 Library cache 无该 ID
Detail cache removed
```

---

# 67. 验证 — Detail 删除

Detail：

```text
移到回收站
```

成功：

```text
/library/[id]
→ /library
```

不能停留在已不可访问的详情页。

---

# 68. 验证 — Query cache 账号隔离

场景：

```text
User A
→ Library 加载 A 的作品

logout
→ User B login
```

在 B 的第一次网络请求返回前：

> 绝不能短暂显示 A 的 Library Card。

要求：

```text
cancelQueries
+
clear QueryClient
```

身份切换测试必须作为安全测试，而非普通 UI 测试。

---

# 69. 验证 — Main layout navigation

已加载 Library 3 页：

```text
/library
→ /chat
→ /library
```

Query cache 仍在。

但 AudioController 不因 Query Provider 引入而 remount。

---

# 70. Browser / E2E

M10 至少登记：

```text
Library 首屏
无限滚动
搜索 debounce
切换全部 / 收藏 / 回收站
时间分组
播放 CTA
Story Detail direct deep-link
Detail browser back
收藏 optimistic
Trash + Undo
Restore
Permanent Delete confirm
Initial error / next-page error
Guest Library
User switch no data leak
M4 新生成 Story 出现在 Library
M5 progress 显示
```

---

# 71. 主要风险

| 风险                                      |   严重度 | 处理                                                       |
| --------------------------------------- | ----: | -------------------------------------------------------- |
| 新增 QueryClient 后账号间缓存泄漏                 | **高** | mount reset + identity change cancel/clear + 安全测试        |
| LibraryStore + Query 双 Source of Truth  | **高** | 明确不新增 libraryStore                                       |
| Cursor 被放入 query key 导致每页成为不同业务 query   |     中 | cursor 只做 pageParam                                      |
| view/query 切换错误复用旧 cursor               |     高 | Query Key 包含完整 effective filter                          |
| Infinite pages 分别时间分组造成重复 Header        |     中 | flatten 后统一 group                                        |
| M5 尚未上线导致 Progress 设计阻塞 P1              |     中 | Card playback 可 nullable，后续 adapter 注入                   |
| Detail 用 Summary 冒充 Detail              |     中 | 永远独立 `library.get`                                       |
| 收藏 optimistic 后 favorites cursor 难人工维护  |     中 | 当前 view 最小 patch，其余 invalidate                           |
| Trash 可恢复操作弹太多确认导致交互沉重                  |     低 | move/restore 无 confirm，永久删除才 confirm                     |
| Undo toast 引入 race                      |     中 | restore 本身幂等；失败再 invalidate                              |
| Trash item 打开 Detail 违反 M2 get contract |     中 | Trash Card 不导航 Detail                                    |
| 全文 search 被前端误认为支持                      |     低 | UI 不宣传“全文搜索”，遵循 M2 title/prompt/excerpt                  |
| Query Provider remount 导致跨页 cache 丢失    |     高 | Provider 必须在 `(main)` shared layout                      |
| M4 新 Work 后 Library cache 30s 内不更新      |     中 | M4 success 主动 invalidate Library list                    |
| Permanent delete 与 M5 当前播放竞态            |     高 | M5 上线后 deletion hook + client invalidation               |
| M8 Audio 状态轮询不足                         |     中 | playback/ensure 操作主动 patch/invalidate，不靠 Library polling |

---

# 72. 拍板项

## M3-P01 — Library 状态管理

推荐：

> **采用 TanStack Query，不新增 libraryStore。**

只迁 Library server state，不要求本轮改造其他 Zustand Store。

---

## M3-P02 — Move to Trash 是否二次确认

推荐：

> **不弹 Modal；使用“移到回收站”菜单动作 + 可撤销 Toast。**

真正不可逆的 Permanent Delete 才做强确认。

---

## M3-P03 — Trash 是否允许查看 Story Detail

推荐：

> **不允许。**

Trash 只提供：

```text
摘要
删除时间
恢复
永久删除
```

恢复后才能重新访问正式 Detail。

这样无需给 M2 增加 `getTrash` 特例。

---

## M3-P04 — Library Filter 是否进入 URL

推荐：

> **view + q 进入 URL；cursor 不进入。**

例如：

```text
/library?view=favorites&q=月球
```

便于 Refresh / Bookmark / Back，同时不把无限滚动 session 状态暴露成 URL contract。

---

## M3-P05 — V1 是否提供“继续创作”

推荐：

> **M3 不伪造该能力。**

P1 先提供已经有稳定契约的：

```text
再次创作
```

真正：

```text
继续这篇 Story
```

等 M4 定义 `StoryWork → Chat context` 契约后开启。

---

# 73. M3 完成后的数据流

```text
                      URL State
                 view / search query
                        │
                        ▼
               TanStack Infinite Query
                        │
                        ▼
                  M2 Library API
                        │
                        ▼
              StoryWorkSummaryDTO[]
                        │
             ┌──────────┴──────────┐
             ▼                     ▼
      M5 Work Progress       M8 Audio Projection
             │                     │
             └──────────┬──────────┘
                        ▼
               StoryCardViewModel
                        │
                 ┌──────┴──────┐
                 ▼             ▼
            Story Card      Story Detail
```

Library 页面从这一模块开始只负责：

> **把 StoryWork 资产正确、高效、一致地呈现给用户，并编排用户对这些资产的操作。**

它不拥有 Story 数据本身，也不拥有 Playback 状态，更不拥有 Audio Asset。这三个领域分别继续归 M2、M5、M8。

M3 这里我认为最值得固定的是 **不建 `libraryStore`**。旧 `generationHistoryStore` 的“整表同步进 Zustand”是历史规模下的合理设计，但在 Story Library 的 cursor/search/detail 模型下继续复制，会把 M3 变成自研一套残缺的 React Query；现在正好是把 server state 和 client state 边界理顺的节点。
