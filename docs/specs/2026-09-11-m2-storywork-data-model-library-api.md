# M2 — StoryWork 数据模型与 Library API 技术方案

> **评审修订注记（2026-09-11，ROBOT review 后定稿）**：
> 1. `contentHash` **采用现有 `utils/segmentation.ts` 的 `computeStoryContentHash`（12 位 hex 双流确定性哈希）与 `normalizeStoryText`（含行尾空格清理）**，不引入 SHA-256——现存 Playback 断点数据依赖此算法，字节级行为必须兼容（见 M5 §37 同一约束）。
> 2. `title` / `excerpt` 显式 `@default("")` 以支持 SQLite additive migration；业务新写入仍禁止空值。
> 3. **增补幂等契约（源 M4）**：`@@unique([userId, sourceMessageId])` / `@@unique([guestId, sourceMessageId])`；`library.create` 在 `sourceMessageId` 已存在且 contentHash 一致时返回现有记录，不一致返回 CONFLICT，绝不覆盖。SQLite UNIQUE 对 NULL 允许多行，Legacy 记录不受影响。

**所属 Phase**：P1
**前置假设**：M1 已确定 `/library`、`/library/[id]` 与 `/player` compatibility boundary。
**下游消费者**：M3 故事库 UI、M4 创作 Artifact、M5 Playback Session、M8 Canonical Audio。

---

# 0. 核心技术决策

M2 建议先固定以下决策：

| 决策                        | 推荐                                      |
| ------------------------- | --------------------------------------- |
| 领域名称                      | **StoryWork**                           |
| 数据库是否立即物理改表名              | **否**                                   |
| Prisma 是否切换为 StoryWork 语义 | **是，通过 `@@map` 保留旧物理表名**                |
| User / Guest 是否合并一张表      | **否，继续物理隔离**                            |
| 主体访问模型                    | **继续复用 `Subject`**                      |
| StoryWork ID              | 继续使用数据库自增 `Int`                         |
| 列表分页                      | **Keyset / opaque cursor**              |
| 默认 page size              | 20                                      |
| 最大 page size              | 50                                      |
| 登录用户作品数硬上限                | **取消**                                  |
| Guest 数据                  | 保持临时空间语义与 30 天 GC                       |
| 删除                        | **Soft delete → 30 天回收站 → hard delete** |
| title                     | **创建时服务端确定并持久化，禁止 UI 临时推导**             |
| Prompt / storyText        | 保持现有 2,000 / 20,000 字符输入上限              |
| 全文搜索                      | M2 V1 不做 FTS                            |
| Audio 数据                  | M2 只预留 DTO 扩展点，物理模型归 M8                 |
| 旧 `generationHistory` API | **保留 compatibility adapter 到 M9**       |

当前仓库的 User 和 Guest 已分别使用 `GenerationHistory` 与 `GuestGenerationHistory`，请求层通过 `Subject = user | guest` 统一访问；这种结构已经覆盖权限隔离、注册迁移以及 Guest GC，因此没有必要为了 StoryWork 重新设计 ownership。

---

# 1. 数据结构

## 1.1 模型命名与物理表迁移策略

推荐 Prisma 领域模型正式改名：

```prisma
StoryWork
GuestStoryWork
```

但保留现有 SQLite / libSQL 物理表：

```prisma
@@map("GenerationHistory")
@@map("GuestGenerationHistory")
```

即：

```text
Prisma domain                    physical SQLite table

StoryWork              ───────→ GenerationHistory
GuestStoryWork         ───────→ GuestGenerationHistory
```

理由：

1. 上层代码从 M2 开始使用正确的 StoryWork 领域语言；
2. 已存在数据无需 copy table；
3. 避免 SQLite 下为了纯命名执行一次不必要的大表重建；
4. compatibility router 仍可将 StoryWork 映射回旧 GenerationHistory DTO；
5. M9 删除兼容代码时，不需要再进行一次业务数据迁移。

项目当前使用 Prisma 7.5 + `@prisma/adapter-libsql`，datasource 为 SQLite，因此这里优先采用 additive schema migration，而不是为了领域命名做破坏性物理迁移。

---

## 1.2 StoryWork 目标结构

推荐目标 Prisma 模型：

```prisma
model StoryWork {
  id        Int      @id @default(autoincrement())

  userId    Int
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  title     String
  prompt    String
  storyText String
  excerpt   String

  voiceId   String   @default("")

  contentHash String  @default("")

  sourceMessageId String?

  favoritedAt DateTime?
  deletedAt   DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @default(now()) @updatedAt

  @@index([userId, deletedAt, createdAt, id])
  @@index([userId, favoritedAt, createdAt, id])
  @@index([userId, sourceMessageId])
  @@index([deletedAt])

  @@map("GenerationHistory")
}
```

Guest：

```prisma
model GuestStoryWork {
  id        Int      @id @default(autoincrement())

  guestId   String

  title     String
  prompt    String
  storyText String
  excerpt   String

  voiceId   String   @default("")

  contentHash String  @default("")

  sourceMessageId String?

  favoritedAt DateTime?
  deletedAt   DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @default(now()) @updatedAt

  @@index([guestId, deletedAt, createdAt, id])
  @@index([guestId, favoritedAt, createdAt, id])
  @@index([guestId, sourceMessageId])

  @@index([updatedAt])
  @@index([deletedAt])

  @@map("GuestGenerationHistory")
}
```

Guest 表目前已经有 `updatedAt`，且 Guest GC 正是根据该字段删除超过 30 天未更新的数据；该行为继续保留。

---

## 1.3 字段定义

| 字段                   | DB 类型        | API 约束           | 默认值           | 说明                        |
| -------------------- | ------------ | ---------------- | ------------- | ------------------------- |
| `id`                 | `Int`        | positive int     | autoincrement | Stable StoryWork identity |
| `userId` / `guestId` | Int / String | server only      | -             | Ownership                 |
| `title`              | String       | trim 后 `1..80`   | 服务生成          | 持久作品标题                    |
| `prompt`             | String       | `1..2000`        | -             | 保持现约束                     |
| `storyText`          | String       | `1..20000`       | -             | 内容 Source of Truth        |
| `excerpt`            | String       | `0..240`         | 自动生成          | Library list 用，避免传整个正文    |
| `voiceId`            | String       | `<=64`           | `""`          | 保持现行为                     |
| `contentHash`        | String       | 新数据固定合法 hash     | 自动生成          | M5/M8 内容 identity         |
| `sourceMessageId`    | String?      | `<=128`          | null          | 回溯 Chat Story Card        |
| `favoritedAt`        | DateTime?    | server generated | null          | null = 未收藏                |
| `deletedAt`          | DateTime?    | server generated | null          | null = active             |
| `createdAt`          | DateTime     | server           | now           | 创作时间                      |
| `updatedAt`          | DateTime     | server           | now           | metadata 修改时间             |

SQLite 本身不承担 `String(80)` 这种长度约束，长度及 trim 规则继续由 Zod + server domain validation 强制。

---

# 1.4 不进入 M2 的字段

产品方案曾列出：

```text
durationMs
audioStatus
audioAssetKey
audioVersion
Audio Manifest
```

这些字段**不建议现在直接塞进 StoryWork table**。

原因是其实际关系要由 M8 决定，很可能最终是：

```text
StoryWork
   1
   │
   1
StoryAudioManifest
   │
   └── AudioSegment[]
```

提前加 `audioAssetKey` 很容易把 M8 锁死成“一个 Story 一个文件”。

M2 DTO 只预留：

```ts
audio: null | {
  status: 'missing' | 'preparing' | 'ready' | 'failed'
  durationMs: number | null
}
```

M2 实现阶段恒为：

```ts
audio: null
```

M8 后续填充，不改变 M3 的 Story DTO 顶层结构。

---

# 1.5 不新增 `sourceConversationId`

当前 `ChatMessage` 数据模型实际上是“每主体单会话快照”，只有 `messageId`，没有稳定的 Conversation entity / conversationId。

因此 M2 不建议创建一个实际上没人能够可靠维护的：

```text
sourceConversationId
```

先只加入：

```text
sourceMessageId
```

以后如果 Chat 领域真正引入：

```text
Conversation.id
```

再添加正式 FK / identity。

这是刻意避免 speculative schema。

---

# 1.6 excerpt 生成

列表不应继续像当前 GenerationHistory DTO 一样，把最多 20,000 字符的 `storyText` 全量下发。

M2 新增持久化 `excerpt`。

统一函数：

```ts
buildStoryExcerpt(storyText)
```

规则：

1. `trim()`
2. `\r\n → \n`
3. 连续 whitespace 压成单个空格
4. 最多取 160 Unicode code points
5. 超过则添加 `…`
6. DB 字段/API 最大容忍 240 字符，为未来规则留空间

例如：

```text
很久以前，在月球的背面住着一只从未见过地球的小狐狸……
```

Story list 只返回 excerpt。

完整正文仅：

```text
library.get()
```

返回。

---

# 1.7 contentHash

StoryWork 应从建立时就拥有稳定内容 fingerprint。

~~推荐：SHA-256(normalizedStoryText) → 前 12 位~~（评审修订：见顶部注记 §1——**按现有 `computeStoryContentHash` 12 位双流算法执行**）

规范化：

```ts
text
  .replace(/\r\n?/g, '\n')
  .trim()
```

不进一步折叠段落间空白。

原因是：

> 会影响分段/播放结果的正文变化，也应该影响 hash。

当前 Playback persistence 已经使用 `contentHash` 与 `segmentationVersion` 检测恢复内容是否漂移，因此 M2 应把算法集中为 shared domain utility，后续 M5 禁止重新定义另一套 hash。

建议新增：

```text
lib/storyWork/contentIdentity.ts
```

供：

```text
M2
M5
M8
```

共同使用。

---

# 1.8 title 生成与持久化

## 原则

title 必须：

```text
创建 StoryWork 时一次确定
          ↓
       持久化
          ↓
Library / Player / Resume 全部读取同一个 title
```

禁止继续出现现在这种：

```ts
'音频故事'

record.prompt.slice(0, 20)

'作品回放'
```

分别临时推导 title 的情况。

---

## title resolution pipeline

创建接口允许：

```ts
title?: string
```

Server 使用：

```ts
resolveStoryTitle({
  proposedTitle,
  storyText,
  prompt
})
```

依次执行：

### 规则 1：调用方提供显式 title

如果：

```text
title.trim().length > 0
```

则：

* trim；
* 连续空白压缩；
* 去掉首尾成对的 `"` / `“”`；
* 最大 80 code points；
* 超长截断为 79 + `…`。

这是最高优先级。

M4 如果未来 Story Agent 能稳定输出 title，即直接使用。

---

### 规则 2：识别正文中的显式标题

只接受严格格式，不猜正文第一句话。

识别第一条非空行：

```text
# 月球上的小狐狸

## 月球上的小狐狸

《月球上的小狐狸》

【月球上的小狐狸】
```

且抽取结果：

```text
1..80 code points
```

才视为 Story title。

不把普通第一句话作为标题。

---

### 规则 3：从 prompt 构造 deterministic fallback

对 prompt：

```text
trim
→ 换行变空格
→ 连续空白压缩
→ 前 32 code points
```

超过 32：

```text
31 chars + …
```

例如：

```text
给我讲一个关于月球上的小狐狸寻找朋友的睡前故事
```

最终可以直接成为：

```text
给我讲一个关于月球上的小狐狸寻找朋友的睡前故事
```

不做复杂 NLP 删除“给我讲一个”之类前缀。

理由：

* deterministic；
* 无额外 LLM 调用；
* 不产生新的 AI 成本；
* 不会因为启发式误删导致标题语义错误。

---

### 规则 4：最终 fallback

理论上 `prompt` 当前不能为空，但为了 legacy / migration defensive handling：

```text
未命名故事
```

---

## 是否允许用户重命名

API 层建议从 M2 起支持：

```text
library.rename
```

即使 M3 第一版暂时不暴露 UI。

理由是 fallback title 永远可能不理想，而 title 已经成为长期 Asset identity。

**【产品需拍板 P-01】**
M3 V1 是否直接开放“重命名作品”。

技术侧推荐：**API 支持；UI 可以后置。**

---

# 2. Library API 契约

## 2.1 Router 命名

新增：

```text
lib/trpc/routers/library.ts
```

Root：

```ts
appRouter = router({
  ...
  library: libraryRouter,

  // compatibility only
  generationHistory: generationHistoryRouter,
})
```

旧 `generationHistory` router 保留到 M9。

当前 root router 已经以 `generationHistory` 暴露 list/record/remove，因此不能在 M2 直接删除，否则旧 `/player` compatibility 页面会被提前破坏。

---

# 2.2 DTO

## StoryWorkSummaryDTO

用于 list：

```ts
type StoryWorkSummaryDTO = {
  id: number

  title: string
  excerpt: string
  voiceId: string

  contentHash: string

  favoritedAt: string | null
  deletedAt: string | null

  createdAt: string
  updatedAt: string

  audio: {
    status: 'missing' | 'preparing' | 'ready' | 'failed'
    durationMs: number | null
  } | null
}
```

刻意不包含：

```text
storyText
prompt
playbackProgress
```

---

## StoryWorkDetailDTO

```ts
type StoryWorkDetailDTO = StoryWorkSummaryDTO & {
  prompt: string
  storyText: string

  sourceMessageId: string | null
}
```

---

# 2.3 list

```ts
library.list
```

### Input

```ts
{
  view?: 'active' | 'favorites' | 'trash'
  query?: string
  cursor?: string
  limit?: number
}
```

约束：

```text
view    default active
query   trim，0..100
limit   default 20，min 1，max 50
```

### Output

```ts
{
  items: StoryWorkSummaryDTO[]
  nextCursor: string | null
  hasMore: boolean
}
```

查询：

```text
active
deletedAt IS NULL

favorites
deletedAt IS NULL
AND favoritedAt IS NOT NULL

trash
deletedAt IS NOT NULL
```

V1 搜索范围：

```text
title
prompt
excerpt
```

不扫描完整 `storyText`。

理由是当前没有 SQLite FTS index，直接对 20k story body 使用 `%LIKE%` 会随着 Library 增长明显退化。

**【产品需拍板 P-02】**
“搜索故事”V1 是否必须搜索完整正文。

技术推荐：

> **P1 只搜索 title + prompt + excerpt。全文搜索作为独立 FTS 升级。**

---

# 2.4 Cursor 设计

不使用 offset。

使用 keyset：

```text
active / favorites:
ORDER BY createdAt DESC, id DESC

trash:
ORDER BY deletedAt DESC, id DESC
```

Cursor 对客户端完全 opaque：

```text
base64url(
  JSON.stringify({
    v: 1,
    view: 'active',
    q: '<query fingerprint>',
    t: '2026-09-11T10:20:30.000Z',
    id: 183
  })
)
```

服务端实际条件：

```text
createdAt < cursor.time

OR

createdAt == cursor.time
AND id < cursor.id
```

Trash 同理使用 `deletedAt`。

Cursor 内：

* 带 `v`，未来协议升级；
* 带 `view`；
* 带 query fingerprint；
* 带 sort timestamp；
* 带 id。

如果：

```text
cursor.view != input.view
```

或 query fingerprint 不匹配：

```text
BAD_REQUEST
```

Cursor 不需要签名。

它不是 authorization token；任何 cursor 查询仍然强制追加当前 Subject ownership。

每页实际：

```text
take = limit + 1
```

从而计算：

```text
hasMore
nextCursor
```

---

# 2.5 get

```ts
library.get
```

Input：

```ts
{
  id: number
}
```

Output：

```ts
StoryWorkDetailDTO
```

规则：

* 只允许当前 Subject；
* 默认只获取 active StoryWork；
* Trash item 不通过普通 `get` 暴露。

Trash Detail 如 M3 真有需求，再增加：

```text
library.getTrash
```

不建议用：

```ts
includeDeleted: true
```

让普通 API 随意绕过 lifecycle boundary。

---

# 2.6 create

```ts
library.create
```

主要消费者：

```text
M4
```

Input：

```ts
{
  title?: string

  prompt: string
  storyText: string
  voiceId?: string

  sourceMessageId?: string
}
```

约束继续沿用当前：

```text
prompt     1..2000
storyText  1..20000
voiceId    <=64
```

当前 GenerationHistory 的 record schema 正是这些约束，因此迁移无需改变生成内容容量。

Server 自动生成：

```text
title
excerpt
contentHash
createdAt
updatedAt
```

Output：

```text
StoryWorkDetailDTO
```

Rate limit 可以继续沿用当前 record 的策略：

```text
guest 20
authed 60
```

当前 router 已对 record mutation 应用这一限制。

---

# 2.7 rename

```ts
library.rename
```

Input：

```ts
{
  id: number
  title: string // trim 1..80
}
```

Output：

```ts
{
  id: number
  title: string
  updatedAt: string
}
```

只修改 metadata。

不会改变：

```text
contentHash
Audio identity
Playback identity
```

---

# 2.8 setFavorite

```ts
library.setFavorite
```

Input：

```ts
{
  id: number
  favorite: boolean
}
```

Server：

```text
true  → favoritedAt = now()
false → favoritedAt = null
```

Output：

```ts
{
  id: number
  favoritedAt: string | null
  updatedAt: string
}
```

采用 mutation set semantics，而不是 toggle：

```text
setFavorite(true)
```

比：

```text
toggleFavorite()
```

更适合重试、多端操作和 optimistic UI。

---

# 2.9 moveToTrash

```ts
library.moveToTrash
```

Input：

```ts
{ id: number }
```

行为：

```text
deletedAt = now()
```

幂等：

已在 trash：

```text
保持原 deletedAt
返回 success
```

而不是重新刷新 30 天生命周期。

---

# 2.10 restore

```ts
library.restore
```

Input：

```ts
{ id: number }
```

行为：

```text
deletedAt = null
```

如果记录已经 hard deleted：

```text
NOT_FOUND
```

---

# 2.11 deletePermanently

```ts
library.deletePermanently
```

Input：

```ts
{ id: number }
```

只能操作：

```text
deletedAt IS NOT NULL
```

不能直接永久删除 active work。

原因是避免 UI 或客户端 bug 绕过回收站保护。

Output：

```ts
{
  success: true
  id: number
}
```

M8 上线以后，该 domain operation 需要同时清理 Audio Manifest / object assets。

M5 上线以后，如果 Playback anchor 正引用该 StoryWork，也必须清理该 anchor。

这两个 hook 分别由 M8 / M5 注入，不在 M2 中提前实现完整状态机。

---

# 2.12 API 与下游边界

```text
                 StoryWork Domain
                      M2
                       │
          ┌────────────┼────────────┐
          │            │            │
          ▼            ▼            ▼
         M3           M4           M5
      Library UI   Creation      Playback
```

### M3 可以调用

```text
list
get
rename
setFavorite
moveToTrash
restore
deletePermanently
```

M3 不自行：

* 拼 title；
* 截 excerpt；
* 根据 prompt 构造 Story identity；
* 查询 Prisma。

---

### M4 可以调用

```text
create
```

M4 负责提供：

```text
prompt
storyText
voiceId
sourceMessageId
可能存在的 title
```

M4 不负责：

```text
contentHash
excerpt
fallback title
```

---

### M5 可以消费

```text
get(id)
```

或者 server domain 层直接调用：

```ts
getStoryWorkForSubject(subject, id)
```

从中获得：

```text
id
title
storyText
voiceId
contentHash
```

M5 不在 playback store 内重新复制一份 Story metadata source of truth。

---

### M8

M8 直接依赖 StoryWork repository / ID。

不允许浏览器通过 Library API 直接写：

```text
audioStatus
audioAssetKey
duration
manifest
```

这些属于 server-owned fields。

---

# 3. 文件级改动

## 3.1 新增

```text
lib/storyWork/
├── title.ts
├── excerpt.ts
├── contentIdentity.ts
└── cursor.ts

lib/server/
└── storyWork.ts

lib/trpc/schemas/
└── library.ts

lib/trpc/routers/
└── library.ts
```

职责：

### `lib/storyWork/title.ts`

```text
normalizeStoryTitle
resolveStoryTitle
```

纯函数，可 unit test。

### `excerpt.ts`

```text
buildStoryExcerpt
```

### `contentIdentity.ts`

```text
normalizeStoryTextForHash
computeStoryContentHash
```

作为 M5 / M8 共用 SSOT。

### `cursor.ts`

```text
encodeLibraryCursor
decodeLibraryCursor
buildCursorPredicate
```

---

## 3.2 修改

```text
prisma/schema.prisma
```

* `GenerationHistory` → Prisma `StoryWork @@map(...)`
* `GuestGenerationHistory` → `GuestStoryWork @@map(...)`
* 新增 metadata fields / indexes
* `User.generationHistory` → `User.storyWorks`

---

```text
lib/trpc/routers/index.ts
```

增加：

```ts
library: libraryRouter
```

保留：

```ts
generationHistory: generationHistoryRouter
```

当前 root router 明确注册了 `generationHistory`，因此 compatibility 应通过并存完成，而不是一次破坏式 rename。

---

```text
lib/server/generationHistory.ts
lib/trpc/schemas/generationHistory.ts
lib/trpc/routers/generationHistory.ts
```

不立即删除。

改造成 compatibility layer：

```text
GenerationHistory contract
       ↓
StoryWork domain
```

---

```text
lib/server/unifiedMigration.ts
```

修改 Guest registration migration：

* 移除 100 条 take；
* 迁移 StoryWork 新字段；
* 建立 Guest work ID → User work ID mapping；
* 为 playback migration 提供 mapping。

当前实现会把 Guest generation 按时间复制，但显式 `take: 100`；这必须在 M2 移除。

---

```text
lib/server/guestGc.ts
```

改为：

```text
guestStoryWork
```

语义保持 30 天 GC。

---

```text
lib/trpc/routers/auth.ts
```

只需要适配新的 registration migration 返回契约。

**不改变 login 行为。**

目前注册会迁移 Guest creative records，登录已有账号则不会迁移 Guest 数据。

---

## 3.3 Prisma Migration

新增：

```text
prisma/migrations/<timestamp>_story_work_library_domain/
migration.sql
```

要求 additive / data-preserving。

---

## 3.4 测试

新增建议：

```text
tests/unit/persistence-config/
├── story-work-title.unit.test.ts
├── story-work-content-identity.unit.test.ts
└── library-cursor.unit.test.ts

tests/integration/persistence-config/
├── story-work-crud.integration.test.ts
├── story-work-pagination.integration.test.ts
├── story-work-lifecycle.integration.test.ts
├── story-work-guest-registration.integration.test.ts
└── generation-history-compat.integration.test.ts
```

同时更新：

```text
tests/test-catalog.yaml
docs/e2e/...
docs/testing/...
```

具体 catalog ownership 仍归 M10，但 M2 的可执行 suite 在本模块落地。

---

# 4. 迁移步骤

## 4.1 Deployment Strategy

推荐采用：

```text
Schema expand
    ↓
Domain compatibility
    ↓
Data normalization
    ↓
New API enabled
    ↓
Old API compatibility
    ↓
M9 最终 contract
```

不做一次性的：

```text
rename table + rename API + rename route + rewrite UI
```

---

# 4.2 Step 1 — Additive schema migration

对旧两张表直接增加：

```text
title
excerpt
contentHash
sourceMessageId
favoritedAt
deletedAt
updatedAt（User 表）
```

迁移时允许 legacy metadata 使用安全默认：

```text
title       ""
excerpt     ""
contentHash ""
```

新业务代码禁止创建空 metadata。

旧 DB 在 migration 后立即仍然可读。

---

# 4.3 Step 2 — Legacy metadata normalization

旧 GenerationHistory 没有 title/excerpt/hash。

迁移策略不要依赖 LLM。

Legacy 记录首次进入新 domain 时：

```text
title == ""
OR
excerpt == ""
OR
contentHash == ""
```

使用与新记录完全相同的纯函数补齐。

建议提供：

```ts
hydrateLegacyStoryWorkMetadata(...)
```

并通过小 batch transaction 写回。

原因：

* 不依赖外部 API；
* 不需要停机；
* 不需要启动时扫描整个数据库；
* 迁移可以渐进完成。

首批 Library page 最多 20 条，因此最坏只需要补这一页旧记录。

如果希望发布后快速归一，可以另提供一次性 maintenance script；它不是 correctness 前提。

---

# 4.4 已经被 100 条裁剪的数据

这里必须明确：

> **此前已经被 `KEEP_LIMIT = 100` 删除的数据，M2 无法从现数据库恢复。**

当前服务每次新建 GenerationHistory 后都会删除超出最近 100 条的记录，因此被删记录已不存在于主数据库。

迁移只能做到：

```text
停止继续丢失
+
完整保留当前尚存数据
```

不能通过：

* prompt history；
* chat history；
* playback；
* createdAt；

可靠重建已经删除的 StoryWork。

如果生产环境另有：

```text
DB backup / volume snapshot
```

可以另做离线恢复，但不属于 M2 正常 migration。

### Migration observability

建议上线迁移期间记录：

```text
subject 当前 story count == 100
```

为：

```text
possiblyPreviouslyCapped
```

仅用于运维日志。

不能对用户宣称“丢过数据”，因为恰好 100 条也可能只是正常数量。

---

# 4.5 移除两个 100 条限制

不仅是：

```text
recordGenerationHistory()
```

里的：

```text
KEEP_LIMIT = 100
```

还必须移除注册迁移里的：

```ts
take: 100
```

当前 Guest registration migration 确实只复制最多 100 条 generation。

M2 后：

```text
登录用户：不按数量裁剪
Guest：不按数量裁剪，但继续受 TTL 控制
```

---

# 4.6 Guest → 新注册 User

继续保持当前产品安全模型：

```text
Guest
  │
  └── 注册新账号
           ↓
        migrate
```

迁移：

```text
StoryWork
Chat
PromptHistory
Playback anchor
Config
```

Guest 原记录继续保留，在 30 天 Guest GC 中自然删除。

当前代码已有这一行为。

---

## StoryWork ID mapping

这里需要修一个重要兼容点。

Guest：

```text
GuestStoryWork.id = 35
```

复制进入 User 表后可能变成：

```text
StoryWork.id = 481
```

因此 migration 必须构建：

```ts
Map<guestStoryWorkId, userStoryWorkId>
```

不能假设 ID 相同。

推荐不再使用纯 `createMany()` 处理 StoryWork migration，因为它无法直接拿到逐行的新 identity mapping。

改为 transaction 中：

```text
按 createdAt / id 稳定顺序读取
      ↓
逐条 create
      ↓
记录 oldId → newId
```

Guest 数据本身受现有限流/TTL 管理，这个注册路径的数据规模短期可以接受。

M5 后续迁移 playback：

```text
sourceType = generation
sourceId = "35"
```

时必须转换为：

```text
sourceId = "481"
```

这个 mapping 由 M2 migration service 提供，Playback 如何进一步演化成 `work` sourceType 归 M5。

---

# 4.7 登录已有账号

保持现状：

```text
Guest data
+
Login existing User A

≠

merge Guest into A
```

即：

```text
User A Library 保持原样
Guest Library 仍属于 Guest
```

这是明显的安全隔离边界，不能因为 Library 升级顺手改变。

现有 `login-existing-no-leak.integration.test.ts` 明确断言登录时 Guest 独有 generation 不得进入已有账号，Guest 数据自身也不得被删除。

M2 必须保留并更新这条测试。

---

# 4.8 Compatibility API

旧：

```ts
generationHistory.list()
```

继续返回：

```ts
GenerationHistoryDTO[]
```

内部：

```text
library active view
limit = 50
```

映射回：

```text
id
prompt
storyText
voiceId
createdAt
```

旧：

```text
generationHistory.record()
```

转：

```text
storyWork.create()
```

旧：

```text
generationHistory.remove()
```

推荐转成：

```text
moveToTrash()
```

而不是 hard delete。

从旧 `/player` 看：

```text
删除后记录消失
```

行为保持一致；

新系统则获得可恢复能力。

M9 再删除 compatibility router。

---

# 5. 生命周期

## 5.1 Active

条件：

```text
deletedAt IS NULL
```

普通：

```text
list
get
favorite
rename
play
```

都只针对 Active StoryWork。

---

# 5.2 Trash

执行：

```text
moveToTrash
```

后：

```text
deletedAt = firstDeletionTime
```

重复删除不更新时间。

回收站默认排序：

```text
deletedAt DESC
id DESC
```

---

# 5.3 Restore

30 天有效窗口内：

```text
restore
→ deletedAt = null
```

恢复后：

* 原 `createdAt` 不变；
* 原 favorite 不变；
* title 不变；
* Story identity 不变。

---

# 5.4 Permanent delete

用户主动：

```text
deletePermanently
```

或：

```text
deletedAt < now - retention
```

才 physically remove。

推荐 retention：

```text
30 days
```

**【产品需拍板 P-03】**
登录用户回收站最终是否确认 **30 天**。

技术推荐：30 天。

---

# 5.5 Trash cleanup

M2 不引入新的 cron 基础设施。

短期采用：

```text
opportunistic cleanup
```

在：

```text
library.list
library.create
library.moveToTrash
```

等 domain entry 中，以低成本执行：

```text
delete where:
owner == subject
AND deletedAt < 30 days ago
```

这样：

* 活跃用户自然清理；
* 不增加部署基础设施；
* 非活跃用户的 trash 可能物理上超过 30 天存在，但用户重新访问时立即清理。

后续如果 M8 Audio storage 要严格回收成本，应迁为 centralized scheduled GC。

---

# 5.6 Guest lifecycle

当前 Guest GC 按 `updatedAt < 30 days` 删除：

* GuestConfig；
* GuestChatMessage；
* GuestGenerationHistory；
* GuestPromptHistory；
* GuestPlaybackProgress。

M2 保持这一机制。

这意味着一个 Guest StoryWork 如果 30 天自身没有更新，即使这个 Guest 后来仍在使用产品，该旧 Story 也可能被 GC。

**【产品需拍板 P-04】**

Guest Library 的语义选择：

### A — 当前语义

```text
每个 Guest 作品最多约保留 30 天
```

### B — Guest inactivity

```text
只要 Guest 整体活跃，
他的历史作品都继续保留
```

技术推荐 M2 先使用 **A**：

* 与现有 GC 完全一致；
* 不增加 Guest activity ledger；
* Guest 本来就是临时空间。

UI 应在合适位置表达：

> 登录后长期保存作品。

---

# 5.7 移除 100 条后短期容量策略

登录用户：

```text
没有 story-count hard cap
```

但采用四层保护：

```text
分页：20 / max 50

写入：
保留现有 mutation rate limit

正文：
20,000 chars max

查询：
不用 offset，不默认传 storyText
```

当前 text-only StoryWork 即使增长到几千条，真正首先遇到的问题通常是查询/搜索体验，而不是单条存储。

因此 M2 不建议重新偷偷引入：

```text
1000 条自动删除
5000 条自动删除
```

任何未来容量限制都应该成为：

```text
显式 quota
```

而不是 silent truncation。

当 M8 引入真实音频资产后，容量策略必须重新评估，因为那时成本模型会从：

```text
KB 级文本
```

变成：

```text
MB 级音频
```

那属于 M8。

---

# 6. 验证方式

## 6.1 Unit

必须覆盖：

### Title

* explicit title；
* Markdown heading；
* `《title》`；
* `【title】`；
* prompt fallback；
* whitespace；
* emoji / Unicode；
* 80 char 边界；
* completely empty defensive fallback。

### Excerpt

* multiline；
* whitespace collapse；
* Chinese；
* emoji；
* truncate。

### contentHash

相同 normalization：

```text
CRLF / LF
```

结果一致；

正文实质变化：

```text
hash 必须变化
```

### Cursor

* encode/decode；
* malformed；
* version mismatch；
* view mismatch；
* query mismatch；
* same timestamp / different ID。

---

# 6.2 Integration — User

至少验证：

```text
create 205 StoryWorks
```

然后：

```text
DB count == 205
```

明确防止旧 100 cap 回归。

分页：

```text
20 + 20 + ...
```

必须：

* 无重复；
* 无遗漏；
* 顺序稳定。

还要覆盖相同 `createdAt` 的 ID tie-break。

---

# 6.3 Integration — Guest

现有 `guest-creative-sync.integration.test.ts` 已经测试：

* record/list/remove；
* multi-subject isolation；
* anonymous 401；
* GenerationHistory hard cap 100；
* 30-day GC。

M2 应将其中：

```text
Generation History Cap (100 records)
```

改成反向回归：

```text
105 条创建成功
DB count == 105
```

同时继续保留：

```text
Guest A 无法删除/读取 Guest B
```

---

# 6.4 Registration migration

测试至少创建：

```text
Guest StoryWorks > 100
```

注册后：

```text
所有 StoryWork 均进入新 User
```

并校验：

```text
prompt
storyText
voiceId
title
favorite
createdAt
```

保持。

同时验证 oldId → newId mapping。

---

# 6.5 Existing account login

现有：

```text
login-existing-no-leak.integration.test.ts
```

必须保持：

```text
User StoryWorks before == after

Guest StoryWorks before == after
```

登录不得触发 merge。

---

# 6.6 Lifecycle

覆盖：

```text
active
→ favorite
→ trash
→ restore
→ trash
→ permanent delete
```

并验证：

```text
active list
favorite list
trash list
get
```

的 visibility matrix。

建议固定：

| 状态      | active list | favorite list | trash list | get |
| ------- | ----------: | ------------: | ---------: | --: |
| Active  |           ✓ |   if favorite |          × |   ✓ |
| Trash   |           × |             × |          ✓ |   × |
| Deleted |           × |             × |          × |   × |

---

# 6.7 Legacy migration

准备旧 schema fixture：

```text
GenerationHistory:
id
userId
prompt
storyText
voiceId
createdAt
```

运行 migration。

验证：

1. 原记录数不变；
2. ID 不变；
3. createdAt 不变；
4. 新 Library API 可读取；
5. title fallback 正确；
6. excerpt 正确；
7. contentHash 最终被补齐；
8. 第二次读取不重复改变 metadata。

---

# 6.8 Compatibility

旧：

```text
generationHistory.list
generationHistory.record
generationHistory.remove
```

必须仍能被旧 `/player` 调用。

Compatibility test 一直到 M9 才删除。

---

# 7. 主要风险

| 风险                                         |   严重度 | 处理                                     |
| ------------------------------------------ | ----: | -------------------------------------- |
| 逻辑 model rename 导致旧 Prisma client 调用大量编译失败 |     中 | `@@map` 保留数据，只系统性改 generated-client 调用 |
| 已裁掉的 >100 历史不可恢复                           | 高/不可逆 | 明确承认，只停止进一步损失；有 backup 才另做恢复           |
| Guest 注册后 Work ID 改变，Playback sourceId 失效  | **高** | migration 显式生成 old→new ID map          |
| Cursor 在同 timestamp 下漏数据                   |     中 | timestamp + id 双键                      |
| Library list 返回完整 storyText 导致 payload 膨胀  |     中 | Summary / Detail DTO 分离                |
| title fallback 质量一般                        |     低 | deterministic fallback + rename API    |
| full-text LIKE 性能恶化                        |     中 | V1 不搜索 storyText，后续 FTS                |
| soft-delete 后 Playback 仍引用 Work            |     中 | M5 正式解决；hard delete 提供 integrity hook  |
| Guest TTL 行为造成用户误以为永久保存                    |     中 | 保持 Guest 临时语义并明确产品提示                   |
| contentHash 与 Playback 自己算法不一致             | **高** | M2 建 shared utility，M5/M8 禁止重复实现       |
| M8 后 audio fields 改坏 Library DTO           |     中 | M2 预留稳定 `audio` projection，物理模型后置      |

---

# 8. 需要产品层确认的事项

本模块没有阻塞技术设计的大型悬而未决项，但建议带走确认四点：

### P-01 — V1 是否开放作品重命名

推荐：

> **API 本期实现；M3 UI 可选择首版暴露。**

---

### P-02 — Library 搜索是否要求正文全文搜索

推荐：

> **P1 不做全文搜索，只搜 title / prompt / excerpt。**

如果产品明确要求 storyText 全文搜索，则应该单独设计 SQLite FTS，而不是直接 `LIKE '%query%'`。

---

### P-03 — 登录用户 Trash retention

推荐：

> **30 天。**

---

### P-04 — Guest retention 语义

推荐：

> **维持当前“单条 Guest 数据 30 天未更新即可 GC”的语义。**

并在产品层把 Guest 明确定义为临时空间。

---

# 9. M2 完成后的稳定契约

M2 完成后，下游模块看到的世界应该非常简单：

```text
                        StoryWork
                            │
             ┌──────────────┼──────────────┐
             │              │              │
          content         metadata       identity
             │              │              │
       storyText         title            id
       prompt            excerpt       contentHash
       voiceId          favorite
                         deleted
```

M3：

```text
只做 Library 展示与动作
```

M4：

```text
负责产生 StoryWork
```

M5：

```text
只通过 StoryWork.id
加载稳定的 title / storyText / voice / contentHash
```

M8：

```text
在 StoryWork identity 上挂 Canonical Audio
```

StoryWork 从这一层开始正式取代：

```text
“最近 100 条 GenerationHistory 日志”
```

成为：

```text
“长期稳定、可分页、可恢复、可被播放系统引用的内容资产”
```

这是 M2 最重要的技术边界。

有一个点我认为值得特别锁死：**Guest 注册迁移时的 StoryWork ID remap**。现有代码把 Guest generation copy 到 User 后，又原样复制 playback `sourceId`；随着 StoryWork 成为正式 identity，这个隐患不能再留到后面补。M2 应产出 ID mapping，M5 再基于这个契约完成播放状态模型。
