# StoryWork 详情读取与访问语义

功能域：07-故事库与作品资产

## 用户目标

用户访问特定故事作品详情页面时，能够安全、精准地读取故事全量正文、元信息与创作提示词；在作品不存在、已被移入回收站或无权访问时，体验统一且安全的不可用保护界面，杜绝资源存在性与归属探测。

## 验收范围

本规范建立 M3-06 故事库详情只读与访问语义（Detail Read / Access Semantics）契约：

1. **路由契约与 ID 参数校验**：
   - 维持 `app/(main)/library/[id]/page.tsx` 的路由参数定义与校验规则；
   - 严格要求故事 ID 为正整数（positive integer: 1, 2, 3...），非法字符与非正整数由路由边界安全拦截；
   - 保持 Next.js App Router 动态段契约不发生破坏性变更。

2. **Query Model 委托接入**：
   - 严格委托 M3-02 已建立的详情查询模型：`useLibraryDetailQuery(id)`（底层映射 `libraryClient.get({ id })` 与 `['library', 'detail', id]` 缓存键）；
   - 依赖 React Query 管理缓存与生命周期，禁止绕开 Query Model 直连底层客户端。

3. **统一不可用语义与防探测铁律 (Uniform Unavailable)**：
   - 核心安全原则：`NOT_FOUND`、`UNAUTHORIZED`、跨主体他人作品 (foreign-owned)、回收站中作品 (trashed) 以及不存在的作品，客户端界面展示**完全一致**（渲染 `LibraryUnavailable` 组件）；
   - 严格保持 M2 服务端刻意设计的不可区分性，彻底杜绝黑客通过侧信道（HTTP 状态、错误文案或差异化 UI）探测作品存在性或归属主体；
   - **零探测查询约束**：客户端严禁为了判断“该作品是否在回收站中”而发起额外的 `libraryClient.list({ view: 'trash' })` 探测查询。

4. **纯只读约束与数据字段边界**：
   - 本阶段为**纯读取**实现，严格禁止提前引入或暴露 Rename、Favorite、MoveToTrash、Restore 或 Permanent Delete 等变更操作（全部归 M3-07 统一接管）；
   - 字段边界：仅读取并渲染 `StoryWorkDetailDTO` 自身声明的合法字段（`id`, `title`, `excerpt`, `voiceId`, `contentHash`, `favoritedAt`, `createdAt`, `updatedAt`, `audio`, `prompt`, `storyText`, `sourceMessageId`）；
   - 严格禁止跨越读取 `GenerationHistory`、`PlaybackProgress` 或音频内部物理表；
   - **ViewModel 播放进度缝隙**：通过 `composeLibraryDetailViewModel(data, null)` 将 `work.progress` 严格保真为 `null`，为 M5 进度接入系统预留干净的注入点。

5. **全生命周期状态覆盖**：
   - **Loading 状态**：展示与正文结构匹配的 Liquid Glass 骨架屏占位；
   - **Unavailable 状态**：呈现统一不可用卡片与“返回故事库”快捷导航；
   - **Error 状态**：针对非不可用的系统级或网络级瞬态异常，呈现友好错误提示与重试机制（`refetch`）；
   - **Success 状态**：优雅呈现故事全量正文、元数据标签、音频信息、生成 Prompt 与来源追踪。

## 关联实现与测试

- 路由入口与正整数校验：`app/(main)/library/[id]/page.tsx`
- 客户端详情 Shell：`app/(main)/library/[id]/index.tsx`、`app/(main)/library/[id]/index.module.scss`
- 纯只读详情组件：`components/Library/StoryDetail.tsx`、`components/Library/storyDetail.module.scss`
- 统一不可用组件：`components/Library/LibraryUnavailable.tsx`、`components/Library/libraryUnavailable.module.scss`
- 详情读取与访问语义测试：`tests/unit/persistence-config/library-detail-read.unit.test.ts` (`exec-library-detail-read`)
