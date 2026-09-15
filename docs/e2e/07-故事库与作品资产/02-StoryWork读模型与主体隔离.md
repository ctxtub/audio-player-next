# StoryWork 读模型、分页检索与主体隔离

功能域：07-故事库与作品资产

## 用户目标

当前登录用户或具名访客能够安全、稳定地浏览自己的故事库作品列表，按视图过滤（活跃/收藏/回收站），使用不透明游标进行确定性 Keyset 无缝分页，安全检索标题、提示词与摘要（严禁正文泄露检索），并在读取详情时获得强隔离保护（非属主、不存在及已软删除作品统一返回 NOT_FOUND 语义）。同时保证旧数据的平滑懒修补（Lazy Backfill）与索引一致性。

## 范围与边界声明

本场景覆盖服务端 StoryWork Read Service 读模型能力（由 L2 集成测试基于隔离数据库严格断言）。
**明确排除以下后续能力**（属 M2-04～M2-09 里程碑，本用例不声称其覆盖）：
- 创作入库与幂等消解（`createStoryWork` / `sourceMessageId` idempotency，属 M2-04）
- 作品重命名、收藏切换与软删除/恢复等写操作（`rename` / `setFavorite` / `trash` / `restore` mutations，属 M2-05）
- tRPC Router 路由接入与对外 HTTP/RPC 暴露（属 M2-06）
- 历史表与既有 `generationHistory` 服务的全面割接（legacy generationHistory cutover，属 M2-07）
- 访客注册升级向用户资产的批量迁移（registration migration，属 M2-08）
- 30 天访客数据过期清理与 GC 策略（30d GC，属 M2-09）

## 契约验收标准

### 1. 视图过滤与排序规则 (views & ordering)
- `active` 视图：仅返回未删除的作品（`deletedAt IS NULL`），严禁包含回收站条目；按 `createdAt DESC, id DESC` 确定性排序。
- `favorites` 视图：仅返回活跃且已收藏的作品（`deletedAt IS NULL AND favoritedAt IS NOT NULL`），严禁包含未收藏项及已软删除的收藏项；按 `createdAt DESC, id DESC` 确定性排序。
- `trash` 视图：仅返回已软删除的作品（`deletedAt IS NOT NULL`）；按 `deletedAt DESC, id DESC` 确定性排序。

### 2. 确定性 Keyset 分页 (keyset pagination)
- 严禁使用 SQL `OFFSET`；完全基于 `(time, id)` 复合游标进行 Keyset 推进。
- 同一时间戳多条记录严格以 `id DESC` 决定先后顺序，在多页拉取（如 65 条 → 20→20→20→5）全流程中保证零重复、零遗漏。

### 3. 游标强绑定与上下文安全 (cursor view/query binding)
- 游标内置视图（`view`）与搜索词指纹（`q`）。
- 服务层反序列化后严格校验游标与当前请求的 `view` 及 `query` 是否一致；若跨视图、跨检索词或游标格式损坏，一律以 `BAD_REQUEST` 拒绝。

### 4. hasMore 派生恒等式 (hasMore derivation identity)
- `hasMore` 必须唯一由 `nextCursor` 派生，严格满足恒等式：`hasMore === (nextCursor !== null)`，严禁独立计算或状态分叉。

### 5. 检索范围与正文隔离安全 (search bounds)
- 检索关键词仅匹配作品的标题（`title`）、提示词（`prompt`）与摘要（`excerpt`）。
- **严格不得扫描故事正文（`storyText`）**；正文独有关键词严禁被检索命中，防止大数据扫描与正文敏感词泄露。

### 6. 主体隔离与不可区分 NOT_FOUND (subject isolation & uniform NOT_FOUND)
- 所有读操作必须从明确的 `Subject`（`User` 或 `Guest`）进入，强约束 `userId` 或 `guestId` 属主过滤。
- 用户之间（User A / User B）、访客之间（Guest A / Guest B）及跨类型主体间严格互不可见。
- 详情读取（`getStoryWorkForSubject`）仅允许返回 `deletedAt IS NULL` 的活跃作品。
- 不存在记录（missing）、其他主体作品（foreign）以及本主体已软删除作品（trash）对外统一抛出不可区分的 `NOT_FOUND`（“作品不存在”），防止资源探测与信息渗漏。

### 7. 旧数据懒修补与一致性 (legacy metadata lazy backfill)
- 首次读取当前 Subject 时，若存在旧数据（`contentHash` / `title` / `excerpt` 为空），使用领域派生算法自动补齐并立即持久化落库。
- 修复作用域严格受限于当前 Subject，绝不跨主体修数据。
- 懒修复在搜索执行前完成，确保旧作品能被摘要检索命中；二次读取不再重复触发写操作。

## 关联实现与测试

- 核心服务：`lib/server/storyWork.ts`
- 领域算法：`lib/storyWork/metadata.ts`, `lib/storyWork/cursor.ts`
- 数据契约：`lib/trpc/schemas/library.ts`
- 验证套件：`tests/integration/persistence-config/story-work-read.integration.test.ts` (`exec-story-work-read`)
