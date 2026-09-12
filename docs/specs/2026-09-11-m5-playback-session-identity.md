# M5 — Playback Session 与播放 Identity 状态模型技术方案

**所属 Phase**：P2
**前置模块**：M2 StoryWork 数据模型与 Library API
**直接下游**：M6 Mini Now Playing、M7 Expanded Now Playing、M8 Canonical Audio
**前置假设**：M2 已提供稳定的 `StoryWork.id / title / storyText / voiceId / contentHash / sourceMessageId`，并提供 Guest→User `guestStoryWorkId → userStoryWorkId` 映射。

---

# 0. 核心结论

M5 不建议只做：

```text
sourceType:
chat → draft
generation → work
```

真正需要解决的是当前播放模型中混在一起的三种状态：

```text
① Audio Transport
   当前 <audio> 是否在播、当前段时间、倍速

② Current Playback Session / Anchor
   用户当前正在听哪一个内容，可否刷新恢复

③ StoryWork Playback Progress
   某一篇作品长期听到了哪里、是否听完
```

当前系统基本把 ② 和 ③ 都压在一张 `UserPlaybackProgress / GuestPlaybackProgress` 里，而且每主体只允许一条记录。Prisma 明确用 `userId @unique` / `guestId @unique` 表示“单一活跃播放锚点”。

这能够回答：

> “用户刷新页面后，上一次正在听什么？”

但无法回答：

> “故事库里的 30 个作品分别听到了多少？”

因此 M5 的核心结构调整确定为：

```text
                    Playback
                       │
          ┌────────────┼─────────────┐
          │            │             │
          ▼            ▼             ▼
 Audio Transport   Session Anchor   Work Progress
   内存状态          单主体 0/1 条     每作品 0/1 条
```

同时确定：

* Domain identity 从 `chat | generation` 演进为 **`draft | work`**；
* Work 永远通过 **StoryWork.id** 标识；
* Work title / contentHash 永远读取 M2 StoryWork，不再播放时临时推导；
* `playbackStore` 缩回 Audio Transport；
* `playbackProgressStore` 演进为真正的 Playback Session Store；
* `isOneShot` 不再在多个 store 重复保存，而变成单一内部播放策略；
* Guest 注册迁移必须消费 M2 的 Work ID remap；
* Audio URL 继续视为瞬态，不进入 M5 持久化；
* M8 以后只替换音频来源，不改变本模块的 Session / Work identity。

---

# 1. 现状与主要问题

## 1.1 playbackStore 当前职责过多

当前 `stores/playbackStore.ts` 同时包含：

```text
Audio transport
- audioController
- currentAudioUrl
- isPlaying
- currentTime
- duration
- playbackRate

Timer
- remainingMs
- totalAllowedMs

Session identity
- sessionId
- sourceType
- sourceId
- title
- currentMessageId

Story progress
- currentParagraphIndex
- totalParagraphs

Resume/UI
- isRehydratedReady
- isFloatingVisible

Continuation policy
- isOneShot
```

其中 `sourceType` 当前只能是：

```ts
'chat' | 'generation'
```

并且 `hydrateFromProgress()` 会把持久化进度再次复制进 playbackStore。

---

## 1.2 playbackProgressStore 又保存了一套同样的 identity

当前 `playbackProgressStore` 同时保存：

```text
sourceType
sourceId
sessionId
title
storyText
contentHash
paragraphs
paragraph progress
voiceId
speed
timer
isOneShot
```

因此出现：

```text
playbackStore.isOneShot
+
playbackProgressStore.isOneShot
```

当前 `storyFlow` 甚至必须同时检查两个值以避免错误续写，代码注释已经明确承认两者可能不同步。

M5 必须消除这种双写。

---

## 1.3 当前断点只保存一个作品

Prisma 当前：

```text
UserPlaybackProgress
    userId @unique

GuestPlaybackProgress
    guestId @unique
```

意味着切换 Story B 后，Story A 的断点被 Story B 覆盖。

而故事完成时当前实现直接调用：

```text
clearProgress()
```

删除这唯一一条断点。

所以现在无法支持 Story Library 需要的：

```text
故事 A 42%
故事 B 已完成
故事 C 未播放
```

---

# 2. M5 目标状态

目标职责划分：

```text
usePlaybackStore
     │
     └── Audio Transport

usePlaybackSessionStore
     │
     ├── 当前 Source Identity
     ├── 当前 Story segmentation
     ├── 当前 paragraph
     ├── resume / rehydrate
     ├── continuation policy
     └── server checkpoint orchestration

Server PlaybackAnchor
     │
     └── 当前主体最后一个 Now Playing

StoryPlaybackProgress
     │
     └── 每一个 StoryWork 独立长期断点
```

---

# 3. Identity 模型

## 3.1 PlaybackSourceRef

业务层不再使用：

```ts
{
  sourceType: string
  sourceId: string
}
```

推荐改成 discriminated union：

```ts
type PlaybackSourceRef =
  | {
      kind: 'draft'
      messageId: string
    }
  | {
      kind: 'work'
      workId: number
    }
```

这样可以彻底消除：

```text
generation sourceId = String(123)
```

这种弱类型 identity。

---

# 3.2 Draft 定义

Draft 指：

> 尚未拥有稳定 StoryWork identity 的 Chat Story Artifact。

Identity：

```text
ChatMessage.messageId
```

特点：

* 来源于当前 Chat；
* 内容可能仍与生成流程有关；
* 可以拥有当前播放 Session；
* 可以拥有当前 Anchor；
* **不拥有长期 Per-Work Progress**；
* 一旦 StoryWork 建立，应尽快提升为 Work identity。

---

# 3.3 Work 定义

Work 指：

> M2 中已经持久化完成的 StoryWork。

Identity：

```text
StoryWork.id
```

以下全部必须来自 StoryWork：

```text
title
storyText
voiceId
contentHash
```

播放层不得再次：

```text
prompt.slice(...)
'音频故事'
'作品回放'
```

推导 identity。

当前历史回放恰恰仍然通过 `record.prompt.slice(0, 20)` 临时产生 title；M5 将删除这一行为。

---

# 3.4 Draft → Work Promotion

M4 创建 StoryWork 和当前音频播放可能存在时序差：

```text
Story Card delivered
      ↓
开始播放
      ↓
当前 source = draft(messageId)
      ↓
StoryWork create 成功
      ↓
获得 workId
```

不应该停止播放再重新建立 Session。

因此 M5 明确定义：

```text
promoteDraftToWork
```

转换：

```text
draft(messageId)
      ↓
work(workId)
```

保持：

```text
sessionId
当前音频
当前 paragraph
播放状态
计时器
```

不变。

替换：

```text
source identity
title
contentHash
voiceId
```

为 M2 StoryWork authoritative value。

如果当前 Draft `contentHash` 与新 Work `contentHash` 不一致：

> 不迁移旧断点位置，安全回退 paragraph 0。

---

# 4. Session ID

当前 `sessionId` 经常直接等于 `messageId`。

M5 改为真正的 Playback Session identity：

```ts
sessionId = crypto.randomUUID()
```

每次：

```text
开始新的 Work
明确“从头播放”
切换 Source
```

都创建新 sessionId。

普通：

```text
pause → resume
刷新 → rehydrate
跨页面导航
```

保持原 sessionId。

---

## 4.1 为什么 sessionId 必须真正唯一

最重要的作用不是展示，而是防止异步 stale write：

```text
播放 A
   ↓
异步保存 A progress
   ↓
用户切换 B
   ↓
B 成为当前 Anchor
   ↓
旧 A save 晚到
```

当前系统存在这种理论风险。

M5 服务端规则：

> **只有 sessionId 与当前 PlaybackAnchor.sessionId 相同的 checkpoint 才有权更新当前 Anchor。**

旧 Session 晚到时：

```text
STALE_SESSION
```

直接忽略，不允许覆盖新 Now Playing。

---

# 5. 持久化数据结构

## 5.1 Current Playback Anchor

当前：

```text
UserPlaybackProgress
GuestPlaybackProgress
```

实际语义已经是 Anchor。

推荐 Prisma domain rename：

```text
UserPlaybackAnchor
GuestPlaybackAnchor
```

物理表继续：

```prisma
@@map("UserPlaybackProgress")
@@map("GuestPlaybackProgress")
```

与 M2 StoryWork 的迁移策略保持一致。

---

## 5.2 UserPlaybackAnchor

概念结构：

```prisma
model UserPlaybackAnchor {
  id     Int @id @default(autoincrement())

  userId Int  @unique
  user   User @relation(...)

  sourceKind String @map("sourceType")
  sourceId   String

  sessionId String?

  anchorState String @default("ready")

  title     String
  contentHash String @default("")
  segmentationVersion String @default("v1")

  lastCompletedParagraphIndex Int @default(-1)
  nextParagraphIndex          Int @default(0)
  totalParagraphs             Int @default(1)

  voiceId String @default("")
  speed   Float  @default(1.0)

  remainingAllowedMs Int?
  totalAllowedMs     Int?

  // Legacy compatibility; new domain logic不再读取
  isOneShot Boolean @default(false)

  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())

  @@map("UserPlaybackProgress")
}
```

Guest 对称设计。

---

# 5.3 sourceKind

数据库值正式改成：

```text
draft
work
```

migration：

```text
chat       → draft
generation → work
```

物理列仍可保留名称：

```text
sourceType
```

Prisma 使用：

```prisma
sourceKind String @map("sourceType")
```

避免为了列名进行 SQLite table rebuild。

---

# 5.4 anchorState

新增：

```text
ready
ended
```

只持久化稳定 resting state。

不持久化：

```text
playing
synthesizing
error
```

原因是进程重启以后这些运行态本身已经失效。

读取 Anchor 后永远进入：

```text
ready
```

或者：

```text
ended
```

不会 autoplay。

---

# 6. Per-Work Playback Progress

新增用户表：

```prisma
model StoryPlaybackProgress {
  id Int @id @default(autoincrement())

  storyWorkId Int @unique
  storyWork   StoryWork
    @relation(fields: [storyWorkId], references: [id], onDelete: Cascade)

  contentHash         String @default("")
  segmentationVersion String @default("v1")

  lastCompletedParagraphIndex Int @default(-1)
  nextParagraphIndex          Int @default(0)
  totalParagraphs             Int @default(1)

  completedAt DateTime?
  lastPlayedAt DateTime @default(now())

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([lastPlayedAt])
}
```

Guest：

```prisma
model GuestStoryPlaybackProgress {
  id Int @id @default(autoincrement())

  storyWorkId Int @unique
  storyWork   GuestStoryWork
    @relation(fields: [storyWorkId], references: [id], onDelete: Cascade)

  contentHash         String @default("")
  segmentationVersion String @default("v1")

  lastCompletedParagraphIndex Int @default(-1)
  nextParagraphIndex          Int @default(0)
  totalParagraphs             Int @default(1)

  completedAt DateTime?
  lastPlayedAt DateTime @default(now())

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([lastPlayedAt])
  @@index([updatedAt])
}
```

---

# 6.1 为什么 Progress 不放进 StoryWork

Playback Progress 是：

```text
User interaction state
```

而不是：

```text
Story artifact metadata
```

后续即使 M8 修改 Audio Asset，StoryWork identity 不需要改变。

---

# 6.2 为什么不重复存 userId / guestId

`StoryPlaybackProgress` 已经通过 FK：

```text
StoryPlaybackProgress
      ↓
StoryWork
      ↓
User
```

确定 ownership。

避免：

```text
progress.userId = 1
work.userId = 2
```

这种冗余字段产生不一致。

服务端所有 Progress 访问先通过 Subject-owned StoryWork resolve。

---

# 6.3 Progress 不记录当前段内秒数

M5 继续保持当前断点语义：

> 恢复到“当前 paragraph 开头”。

当前系统持久化的也是：

```text
lastCompletedParagraphIndex
nextParagraphIndex
```

而不是 audio `currentTime`。

不在 M5 新增：

```text
segmentOffsetMs
```

理由：

当前音频需要重新 TTS，同一段重新生成后时长并不是可靠的 canonical timeline。

精确秒级 Resume 留给 M8 Canonical Audio。

---

# 7. Work Playback 状态

Server 不额外存一个容易漂移的 `status` 字段。

根据 Progress 推导：

### 未播放

不存在 Progress row：

```text
not_started
```

### 播放中 / 未完成

存在 Progress：

```text
nextParagraphIndex < totalParagraphs
```

→

```text
in_progress
```

### 当前播放已经完成

```text
nextParagraphIndex >= totalParagraphs
```

→

```text
completed
```

额外：

```text
completedAt
```

表示该作品历史上至少完整听完过一次。

---

# 7.1 Progress Ratio

V1 为 paragraph-level：

```text
completedParagraphs =
  min(totalParagraphs, lastCompletedParagraphIndex + 1)

progress =
  completedParagraphs / totalParagraphs
```

不伪装成秒级精度。

M8 有完整 Audio Manifest 后再升级为 duration-weighted progress。

---

# 8. completedAt 与“再次播放”

推荐：

作品第一次听完：

```text
completedAt = now
position = total / total
```

用户点击：

```text
再次播放
```

新的 Session 从 paragraph 0 开始，同时：

```text
position → 0
completedAt 保留
```

如果第二次只听到 40% 就离开：

```text
resumeState = in_progress
completedAt != null
```

含义：

> 这个作品历史上听完过，但本次重播停在 40%。

Library CTA 应为：

```text
继续播放
```

而不是因为曾经听完就永远显示“再次播放”。

**【产品拍板 M5-P01】**

技术推荐采用上述语义。

---

# 9. Runtime Store 拆分

## 9.1 playbackStore

M5 后缩回：

> Audio Transport Store

保留：

```text
audioController
currentAudioUrl

isPlaying
currentTime
duration
playbackRate

remainingMs
totalAllowedMs

countdown internals
```

以及控制动作：

```text
playAudio
resumeAudio
pauseAudio
seekAudio
setPlaybackRate
ensureUnlocked
registerAudioController
```

---

## 9.2 从 playbackStore 移除

以下不再属于 Transport：

```text
sessionId
currentMessageId

sourceType
sourceId
title

isOneShot
isRehydratedReady

currentParagraphIndex
totalParagraphs

isFloatingVisible
```

其中 `isFloatingVisible` 属于 M6 presentation state。

M5 可临时提供 compatibility selector，但不再把它作为 playback engine 状态。

---

# 10. playbackSessionStore

推荐：

```text
stores/playbackSessionStore.ts
```

取代现有 `playbackProgressStore` 的领域职责。

状态：

```ts
type PlaybackSessionStatus =
  | 'idle'
  | 'hydrating'
  | 'ready'
  | 'synthesizing'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'
```

核心 state：

```ts
{
  sessionId: string | null

  source: PlaybackSourceRef | null

  title: string

  storyText: string
  paragraphs: string[]

  contentHash: string
  segmentationVersion: string

  lastCompletedParagraphIndex: number
  nextParagraphIndex: number
  totalParagraphs: number

  voiceId: string
  speed: number

  continuationMode: 'finite' | 'extendable'

  status: PlaybackSessionStatus

  prefetchedAudioUrl: string | null
  prefetchingIndex: number | null

  lastSavedKey: string | null
}
```

---

# 11. isOneShot 演进

`isOneShot` 当前名字并不能准确表达实际语义。

它实际控制的是：

> **当前内容播放结束之后，是否允许继续向 AI 请求新的故事内容。**

因此新 runtime domain 改为：

```ts
type PlaybackContinuationMode =
  | 'finite'
  | 'extendable'
```

映射：

```text
isOneShot = true
→ finite

isOneShot = false
→ historically potentially extendable
```

但现有逻辑还有额外：

```text
progressState.sourceId && totalParagraphs > 0
```

守卫，因此一些 `isOneShot=false` 的持久化 Chat Story 实际依然不会续写。

M5 将这个混乱规则收敛为：

### Work

永远：

```text
finite
```

### Rehydrated Draft

永远：

```text
finite
```

原因：

刷新后自动触发新的 AI 内容生成风险过高。

### Live Draft

只有实时生成链明确要求：

```text
extendable
```

才允许调用下一段 AI generation。

---

## 11.1 DB 的 isOneShot

现有物理字段暂时保留到兼容迁移结束。

M5 新 domain 不再读取它作为业务 Source of Truth。

兼容层：

```text
continuationMode === finite
→ old isOneShot = true
```

M9 再决定是否物理删除旧列。

---

# 12. 一个重要 invariant

> **所有持久化 Anchor 在重新水合之后都视为 finite。**

也就是说：

即使用户关闭 App 时正在听一个可继续生成的 Draft：

```text
reload
  ↓
恢复已有文本
  ↓
播到当前已有文本结尾
  ↓
停止
```

不会在后台自动：

```text
“请继续故事”
```

这是 M5 建议固定的安全边界。

---

# 13. Playback API

继续使用：

```text
playback router
```

但从 CRUD Progress 升级成 Session API。

---

# 13.1 Source schema

```ts
const playbackSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('draft'),
    messageId: z.string().min(1).max(128),
  }),

  z.object({
    kind: z.literal('work'),
    workId: z.number().int().positive(),
  }),
])
```

---

# 13.2 PlaybackAnchorDTO

```ts
type PlaybackAnchorDTO = {
  sessionId: string

  source: PlaybackSourceRef

  state: 'ready' | 'ended'

  title: string

  contentHash: string
  segmentationVersion: string

  lastCompletedParagraphIndex: number
  nextParagraphIndex: number
  totalParagraphs: number

  voiceId: string
  speed: number

  remainingAllowedMs: number | null
  totalAllowedMs: number | null

  updatedAt: string
}
```

不包含：

```text
storyText
audioUrl
currentTime
isPlaying
```

---

# 13.3 WorkPlaybackProgressDTO

```ts
type WorkPlaybackProgressDTO = {
  workId: number

  state:
    | 'not_started'
    | 'in_progress'
    | 'completed'

  progress: number

  lastCompletedParagraphIndex: number
  nextParagraphIndex: number
  totalParagraphs: number

  completedAt: string | null
  lastPlayedAt: string | null
}
```

M3 只消费这个 View DTO。

---

# 14. API 方法列表

M5 后正式 API：

```text
playback.getAnchor
playback.beginSession
playback.saveCheckpoint
playback.completeSession
playback.clearAnchor
playback.promoteDraftToWork
playback.getWorkProgressBatch
```

旧：

```text
getProgress
saveProgress
clearProgress
```

作为 compatibility procedure 暂时保留，M9 删除。

---

# 15. playback.getAnchor

Input：

```text
none
```

Output：

```text
PlaybackAnchorDTO | null
```

Server 读取当前 Subject 唯一 Anchor。

同时执行 legacy normalization：

```text
chat       → draft
generation → work
```

旧 `sessionId=null`：

```text
server 生成 UUID
写回
```

---

# 16. playback.beginSession

Input：

```ts
{
  sessionId: string // UUID

  source: PlaybackSourceRef

  mode:
    | 'resume'
    | 'restart'

  speed: number

  remainingAllowedMs?: number | null
  totalAllowedMs?: number | null

  // 仅 Draft
  draftSnapshot?: {
    title: string
    contentHash: string
    totalParagraphs: number
    voiceId: string
  }
}
```

---

## 16.1 Work Begin

Server 根据：

```text
workId + Subject
```

读取 M2 StoryWork。

authoritative：

```text
title
contentHash
voiceId
storyText
```

paragraph count 通过现有：

```text
normalizeStoryText
segmentStoryText
```

计算。

不信任客户端传入 Story metadata。

---

## 16.2 Work Resume

存在 WorkProgress：

```text
读取 nextParagraphIndex
```

并验证：

```text
progress.contentHash == StoryWork.contentHash
progress.segmentationVersion == current SEGMENTATION_VERSION
```

一致：

```text
继续
```

不一致：

```text
reset paragraph 0
更新 Progress hash/version
```

---

## 16.3 Work Restart

明确：

```text
position → paragraph 0
```

保留：

```text
completedAt
```

并创建新的 sessionId。

因此不再需要当前：

```text
forceReset
```

这种特殊 save 参数。

---

## 16.4 Draft Begin

Draft 必须验证：

```text
ChatMessage.messageId 属于当前 Subject
```

Draft metadata 可以使用 client snapshot。

Server 不允许：

```text
replay-text-*
```

等瞬态 ID 被持久化。

当前 store 已经专门有这一门禁，M5 将它提升到 server contract，而不是只依赖客户端。

---

# 17. playback.saveCheckpoint

Input：

```ts
{
  sessionId: string

  contentHash: string
  segmentationVersion: string

  lastCompletedParagraphIndex: number
  nextParagraphIndex: number
  totalParagraphs: number

  speed: number

  remainingAllowedMs?: number | null
  totalAllowedMs?: number | null
}
```

不再由客户端发送：

```text
source
title
```

因为当前 Source 必须由 Anchor.sessionId 决定。

---

## 17.1 Stale Session Guard

查询当前 Anchor：

```text
anchor.sessionId !== input.sessionId
```

返回：

```ts
{
  accepted: false,
  reason: 'STALE_SESSION'
}
```

绝不覆盖。

---

## 17.2 Monotonic Progress Guard

同一 Session：

```text
incoming.nextParagraphIndex
<
existing.nextParagraphIndex
```

不允许回退。

当前 server 已经有类似保护；M5 保留这一性质。

显式“从头播放”必须建立新 Session，不再通过：

```text
forceReset: true
```

绕过单调性。

---

# 18. saveCheckpoint 的 Work 行为

如果：

```text
source.kind == work
```

一个 transaction 同时：

```text
UPDATE PlaybackAnchor
+
UPSERT StoryPlaybackProgress
```

保证：

```text
Current Now Playing
和
Library progress
```

不会出现一边成功、一边失败。

---

# 19. playback.completeSession

Input：

```ts
{
  sessionId: string
}
```

Server 首先验证 current Anchor。

Work：

```text
lastCompletedParagraphIndex = total - 1
nextParagraphIndex = total

StoryPlaybackProgress.completedAt = now
StoryPlaybackProgress.lastPlayedAt = now

Anchor.anchorState = ended
```

Draft：

```text
Anchor.anchorState = ended
```

不创建 Work Progress。

---

# 20. 完播后 Anchor 是否保留

推荐：

> **保留 ended Anchor。**

这样当前 App 与刷新以后仍然可以知道：

```text
刚刚听完的是《月球上的小狐狸》
```

Mini Player 可以显示：

```text
↻ 再次播放
```

而不是故事结束的一瞬间整个 Now Playing 消失。

当前实现是完播后直接清空断点。

**【产品拍板 M5-P02】**

推荐：

```text
Work completion
→ 保留 ended Now Playing Anchor
```

直到：

* 用户开始另一个内容；
* 用户主动关闭 Now Playing；
* Work 被永久删除。

---

# 21. playback.clearAnchor

Input：

```ts
{
  sessionId: string
}
```

只能清理当前 session。

如果 sessionId 不匹配：

```text
no-op
```

避免旧异步 cleanup：

```text
A.clear()
```

把已经播放中的：

```text
B
```

错误删除。

服务端内部可以另提供：

```text
forceClearAnchorForSubject()
```

用于 logout / account reset。

---

# 22. playback.getWorkProgressBatch

M3 Story Library 使用。

Input：

```ts
{
  workIds: number[] // 1..50
}
```

Output：

```ts
{
  items: WorkPlaybackProgressDTO[]
}
```

推荐对传入的每一个 workId 都返回结果。

不存在 DB row：

```text
state = not_started
progress = 0
```

避免 M3 自己猜 null semantics。

---

# 23. 为什么不把 Work Progress 加回 Library.list

M2 和 M5 保持职责独立：

```text
Library API
→ Content metadata

Playback API
→ Playback interaction state
```

M3 可以并行：

```text
library.list()
+
playback.getWorkProgressBatch(ids)
```

再组合 Card ViewModel。

后续如果性能确实需要，Server 可以增加 composition query，但不应反向污染 M2 StoryWork domain。

---

# 24. playback.promoteDraftToWork

Input：

```ts
{
  sessionId: string
  workId: number
}
```

Server：

1. 找当前 Anchor；
2. 确认 sessionId 匹配；
3. 当前 Source 必须是 `draft`；
4. 加载 StoryWork；
5. 校验：

```text
StoryWork.sourceMessageId
==
Draft.messageId
```

6. 更新 Anchor：

```text
source → work(workId)
title → work.title
contentHash → work.contentHash
voiceId → work.voiceId
```

7. 将当前 paragraph checkpoint 迁入 `StoryPlaybackProgress`。

---

## 24.1 Hash 不一致

如果：

```text
draft hash != StoryWork.contentHash
```

则：

```text
Source promotion 成功
Progress reset = 0
```

不允许拿旧段落位置套在不同正文上。

---

# 25. Rehydrate 流程

页面启动：

```text
PlaybackSessionStore.init()
       ↓
playback.getAnchor()
       ↓
resolve Source
```

---

## 25.1 Work Rehydrate

不要再像当前 `generation` 路径那样：

```text
先加载 generationHistoryStore 最近 N 条
再 find(id)
```

当前实现确实依赖 GenerationHistory store 查 source。

故事库已经分页以后，这种方式必然会出现：

> Anchor 指向第 300 条作品，但客户端只加载第一页。

M5 必须：

```text
library.get(workId)
```

按 ID 精确 resolve。

---

## 25.2 Draft Rehydrate

流程：

```text
初始化 ChatStore
      ↓
按 messageId 查 StoryCard
      ↓
检查正文
```

不存在：

```text
清理 dangling Anchor
```

保持当前已有的 fail-closed 行为。当前实现已经在 Chat source 缺失时清本地状态并删除断点。

---

# 25.3 Hash Validation

统一使用 M2 修订后保留的现有：

```text
normalizeStoryText
computeStoryContentHash
SEGMENTATION_VERSION
```

现有逻辑已经是：

```text
currentHash != savedHash
OR segmentationVersion changed
→ reset paragraph 0
```

M5 保留此规则。

---

# 25.4 Title 变化

Work：

```text
StoryWork.title
```

如果和 Anchor snapshot 不同：

```text
更新 Anchor.title
```

**不重置 progress。**

Title 属于 metadata，不属于 content identity。

---

# 25.5 Rehydrate 最终状态

成功后：

```text
PlaybackSessionStore.status = ready
```

Transport：

```text
isPlaying = false
audioUrl = null
currentTime = 0
duration = 0
```

不 autoplay。

用户点击播放后：

```text
合成当前 paragraph
→ AudioController.play
```

当前系统已经遵循“hydrate 后停驻 READY/PAUSED，不自动起播”的原则；M5 延续。

---

# 26. AudioControllerHost 演进

当前 `AudioControllerHost` 已经是合理的全局 `<audio>` ownership：

* unlock；
* play；
* pause；
* resume；
* seek；
* playbackRate；
* timeupdate；
* ended。

它通过 `registerAudioController()` 挂到 Store。

这个底层结构保留。

---

## 26.1 需要移出的职责

当前 Host 直接 import：

```text
storyFlow
ChatStore
PreloadStore
PlaybackProgressStore
```

并在 near-end / ended 中处理较多故事领域逻辑。

目标：

```text
AudioControllerHost
      ↓
只报告 Audio events

PlaybackSessionFlow
      ↓
决定 segment / continuation / checkpoint
```

Host 不应该知道：

```text
chat
work
generation
AI 续写
```

---

# 27. 新 PlaybackSessionFlow

建议新增：

```text
app/services/playbackSessionFlow.ts
```

负责：

```text
beginPlayback
resumePlayback
playParagraph
handleNearEnd
handleEnded
pause
restart
promoteDraftToWork
stop
```

而：

```text
storyFlow.ts
```

回到：

> 故事生成流程。

现在 `storyFlow.ts` 中大量播放 session / preload / ended 逻辑可以逐步移出。

---

# 28. Continuation 统一

现在 `handleNearEnd` / `handleSegmentEnded` 中存在：

```text
playbackStore.isOneShot
progressStore.isOneShot
sourceId guard
currentMessageId guard
```

多个规则组合。

M5 之后只允许：

```ts
if (session.continuationMode === 'extendable') {
   // 可以触发 AI continuation
}
```

否则：

```text
播完现有 paragraphs
→ ended
```

这是 M5 最重要的状态机收敛之一。

---

# 29. 删除语义

## 29.1 Work Move to Trash

M2 已确定：

> 已经在播放的 Work 可以继续当前 Session，但不允许建立新的播放。

M5 定义：

```text
beginSession(work in trash)
→ WORK_UNAVAILABLE
```

但当前已经存在的 session：

```text
允许继续
允许 checkpoint
允许 completion
```

直到：

* 当前 session 完成；
* 用户停止；
* 页面刷新。

---

## 29.2 Trash Work 刷新后

推荐：

```text
getAnchor
→ 发现 Work 已进入 Trash
→ 清除 Anchor
→ 不 rehydrate
```

所以“允许继续”只意味着：

> 当前内存播放不被突然打断。

而不意味着 Trash 作品可以永久作为 Now Playing 恢复。

**【产品拍板 M5-P03】**

推荐采用该规则。

---

# 29.3 Permanent Delete

永久删除必须：

```text
StoryWork DELETE
      ↓
FK CASCADE
      ↓
StoryPlaybackProgress DELETE
```

同时 M5 提供 domain hook：

```text
invalidatePlaybackReferencesForWork(workId)
```

清理：

```text
PlaybackAnchor
```

如果当前前端正在播放该 Work：

M3 删除成功后调用：

```text
playbackSessionStore.invalidateWork(workId)
```

执行：

```text
pause audio
clear session
clear Now Playing
```

---

# 30. Replay / Resume 状态定义

| 操作       | Session             | WorkProgress     | completedAt |
| -------- | ------------------- | ---------------- | ----------- |
| 第一次播放    | new UUID            | 从 0 建立           | null        |
| Pause    | 保持                  | 保存当前 paragraph   | 不变          |
| Refresh  | 保持                  | 不变               | 不变          |
| Continue | 保持                  | 从 next paragraph | 不变          |
| 播完       | 保持 → ended          | next = total     | now         |
| 再次播放     | **new UUID**        | reset position 0 | **保留**      |
| 从头播放     | **new UUID**        | reset position 0 | 保留          |
| 切换其他作品   | new Source/new UUID | 原作品 Progress 保留  | 保留          |

---

# 31. Guest → User Migration

这是 M5 与 M2 最重要的衔接。

M2 registration migration 提供：

```ts
storyWorkIdMap:
Map<guestStoryWorkId, userStoryWorkId>
```

---

# 31.1 Draft Anchor

Guest：

```text
source = draft(messageId)
```

Chat migration 当前保持：

```text
messageId
```

因此：

```text
sourceId 原样迁移
```

---

# 31.2 Work Anchor

Guest：

```text
source = work(35)
```

不能直接：

```text
User source = work(35)
```

必须：

```text
35
 ↓ M2 map
481
```

迁移为：

```text
work(481)
```

当前迁移函数确实直接复制 `sourceId`，这是需要修复的隐患。

---

# 31.3 Missing Mapping

如果：

```text
Guest Anchor → work(35)
```

但：

```text
storyWorkIdMap 没有 35
```

必须：

```text
drop Anchor
```

而不是创建 dangling playback state。

fail closed。

---

# 31.4 Per-Work Progress

所有：

```text
GuestStoryPlaybackProgress
```

按照同一个 map：

```text
guestWorkId
→
userWorkId
```

迁移。

Guest 原记录继续保留直到原有 Guest GC。

---

# 32. Legacy 数据 migration

## Step 1 — Expand schema

新增：

```text
anchorState
StoryPlaybackProgress
GuestStoryPlaybackProgress
```

不删除旧字段。

---

## Step 2 — Canonicalize source type

```sql
chat       → draft
generation → work
```

User + Guest 两张 Anchor 表都执行。

新代码仍保留 parser：

```text
chat / generation / draft / work
```

至少一个兼容周期。

---

## Step 3 — Existing Work Anchor → Work Progress

对于现存：

```text
sourceKind = work
```

Anchor：

1. parse `sourceId`；
2. 查 StoryWork；
3. 存在则创建 StoryPlaybackProgress；
4. 复制：

   * contentHash
   * segmentationVersion
   * lastCompletedParagraphIndex
   * nextParagraphIndex
   * totalParagraphs
5. `completedAt = null`。

为什么不能恢复“历史完成态”：

当前作品一旦完播就已经 `clearProgress()`，数据库里没有历史信息。

所以只能迁移：

> 当前仍存在的唯一断点。

过去听完过哪些作品无法重建。

---

# 33. sessionId Legacy Repair

现有：

```text
sessionId nullable
```

不做 SQLite 强制 NOT NULL table rebuild。

保留 nullable schema。

`getAnchor` 遇到：

```text
null / invalid UUID
```

则：

```text
生成 UUID
写回
```

新写入全部要求 UUID。

---

# 34. Client API Compatibility

现有：

```text
lib/client/playbackProgress.ts
```

只包装：

```text
getProgress
saveProgress
clearProgress
```

M5 新增：

```text
lib/client/playbackSession.ts
```

正式暴露：

```text
getPlaybackAnchor
beginPlaybackSession
savePlaybackCheckpoint
completePlaybackSession
clearPlaybackAnchor
promoteDraftPlaybackToWork
getWorkPlaybackProgressBatch
```

旧文件保留 adapter 一个迁移周期。

---

# 35. 文件级改动

## 新增

```text
lib/playback/
├── source.ts
├── session.ts
├── progress.ts
└── legacy.ts

stores/
└── playbackSessionStore.ts

app/services/
└── playbackSessionFlow.ts

lib/client/
└── playbackSession.ts

lib/server/
└── playbackSession.ts
```

---

## 修改

```text
prisma/schema.prisma
```

* logical rename PlaybackProgress → PlaybackAnchor；
* sourceType logical → sourceKind；
* 新增 anchorState；
* 新增 User / Guest Work Progress tables；
* StoryWork 增加 progress relation。

---

```text
lib/trpc/schemas/playback.ts
```

从：

```text
chat | generation
```

升级成：

```text
PlaybackSourceRef
PlaybackAnchorDTO
WorkPlaybackProgressDTO
```

并保留 legacy parser。

---

```text
lib/trpc/routers/playback.ts
```

新增 Session API。

当前 router 只有：

```text
getProgress
saveProgress
clearProgress
```

并继续复用 `Subject` 与 rate limit。

---

```text
lib/server/playbackProgress.ts
```

逐步被：

```text
lib/server/playbackSession.ts
```

替代。

---

```text
stores/playbackStore.ts
```

删除 semantic identity 副本，缩回 Transport。

---

```text
stores/playbackProgressStore.ts
```

迁移至：

```text
playbackSessionStore.ts
```

可以暂时做 re-export adapter，完成所有调用点迁移后删除旧实现。

---

```text
components/AudioControllerHost/index.tsx
```

去除 Story/Chat 领域判断，只向 Playback Session Flow 报告事件。

---

```text
app/services/storyFlow.ts
```

把播放状态机和 segment playback orchestration 迁出。

---

```text
lib/server/unifiedMigration.ts
```

消费 M2：

```text
storyWorkIdMap
```

修复 Work Anchor source ID。

---

```text
lib/server/guestGc.ts
```

加入 Guest Work Playback Progress 的生命周期清理；Work FK cascade 为主。

---

# 36. 与 M2 的接口边界

M5 只能从 M2 获取：

```text
getStoryWorkForSubject(subject, workId)
```

得到：

```text
id
title
storyText
voiceId
contentHash
sourceMessageId
deletedAt
```

不得：

```text
重新 compute Work title
重新定义 contentHash
直接查询 GenerationHistory legacy DTO
```

---

# 37. contentHash 唯一实现

M5 所有地方统一：

```text
utils/segmentation.ts
```

现有：

```text
normalizeStoryText
computeStoryContentHash
segmentStoryText
SEGMENTATION_VERSION
```

作为唯一 SSOT。其 normalization 包含 CRLF/CR 统一、行尾空格清理及 trim；hash 为现有 12 位 deterministic short hash。

如果 M2 后续只是移动文件：

> 只能移动实现，不能改变算法行为。

需要加入 regression fixture 锁死输出。

---

# 38. 验证方式

## Unit

必须覆盖：

### Identity

```text
chat       → draft
generation → work
draft      → draft
work       → work
```

以及：

```text
workId 必须 positive int
draft messageId 禁止 replay-text-*
```

### Hash compatibility

固定若干 legacy fixture：

```text
CRLF
CR
行尾空格
中文
emoji
多段文本
```

新 shared utility 输出必须和现有实现完全一致。

### Progress derivation

覆盖：

```text
not_started
in_progress
completed
replay after completed
```

### Continuation

```text
work → finite
rehydrated draft → finite
live draft explicit extendable → extendable
```

### Session stale guard

```text
session A checkpoint
当前 anchor = B
→ A rejected
```

---

# 39. Integration — Anchor

测试：

```text
begin A
save A
pause
getAnchor
```

字段完全一致。

然后：

```text
begin B
late save A
```

确认：

```text
Anchor remains B
```

---

# 40. Integration — Work Progress

至少构造：

```text
Work A
Work B
Work C
```

分别产生：

```text
A = 40%
B = completed
C = not_started
```

`getWorkProgressBatch` 必须准确返回三种状态。

然后播放 Work D：

> 不得覆盖 A/B 的长期 Progress。

---

# 41. Integration — Completion

验证：

```text
last paragraph ended
```

以后：

```text
WorkProgress:
next = total
completedAt != null

Anchor:
state = ended
```

不得像现实现一样删掉 Work completion history。

---

# 42. Integration — Restart

已完成 Story：

```text
completedAt = T1
```

restart：

```text
new sessionId
position = 0
completedAt = T1
```

播到一半：

```text
state = in_progress
completedAt = T1
```

---

# 43. Integration — Hash Drift

保存：

```text
contentHash H1
segmentationVersion v1
```

Source resolve 后：

```text
H2 != H1
```

必须：

```text
position reset 0
```

并禁止恢复旧 paragraph。

---

# 44. Integration — Title Rename

StoryWork：

```text
title A
```

Anchor 保存 A。

之后 M2：

```text
rename → title B
```

rehydrate：

```text
Now Playing title = B
```

但：

```text
paragraph position 不变
```

---

# 45. Integration — Draft → Work Promotion

正在播放：

```text
draft(message-1)
paragraph 4 / 12
```

创建：

```text
StoryWork.id = 51
sourceMessageId = message-1
```

promotion 后：

```text
source = work(51)
sessionId 不变
paragraph = 4
audio 不重启
```

且创建 Work Progress。

---

# 46. Integration — Guest Registration

构造：

```text
Guest Work id = 35
Guest Anchor = work(35)
Guest Progress work(35)
```

M2 migration：

```text
35 → 481
```

注册完成后必须：

```text
User Anchor = work(481)
User Progress = work(481)
```

不得出现：

```text
work(35)
```

dangling source。

---

# 47. Integration — Login Existing User

继续保持：

```text
Guest playback
```

不得 merge 到已有 User。

与 M2 的 no-leak 安全规则一致。

---

# 48. Integration — Trash

当前 Work 正在播放：

```text
moveToTrash
```

验证：

```text
当前内存 Audio 不立即停止
checkpoint 仍可完成
```

但刷新：

```text
getAnchor
→ null
```

再次：

```text
beginSession(workId)
→ WORK_UNAVAILABLE
```

---

# 49. Browser / E2E

M10 Test Catalog 中至少需要以下用户行为：

```text
跨 /chat /library /setting 播放不断

播放 Work → Pause → Refresh → Ready → Resume

Work A → Work B → stale A save 不覆盖 B

Work 完播 → Library 显示完成

已完成 Work 再次播放 → 半途退出 → Continue

Draft 播放中完成 StoryWork 创建 → 无缝 promotion

删除当前作品

Guest 注册后 Resume identity 正确

Audio unlock 行为不回归

pause 时禁止自动 preload / auto continue
```

现有 AudioControllerHost 已经对移动端 unlock、pause、seek、near-end 等行为有明确处理，重构时这些行为必须作为 regression boundary，而不是重新实现。

---

# 50. 主要风险

| 风险                                              |   严重度 | 应对                                                                        |
| ----------------------------------------------- | ----: | ------------------------------------------------------------------------- |
| playbackStore / progressStore 当前大量双写，迁移时产生状态不同步 |     高 | M5 一次性确立 Session single source，旧 store 只做代理                               |
| `chat/generation → draft/work` 破坏 legacy rows   |     高 | DB backfill + parser 同时接受四种值                                              |
| Guest Work ID 未 remap                           | **高** | 强依赖 M2 map；missing map fail closed                                        |
| Library 分页后 resume 查不到老 Work                    | **高** | Work resume 必须 `library.get(id)`，禁止从 list store find                      |
| stale async save 覆盖新 Now Playing                | **高** | UUID session + server session guard                                       |
| 完播后历史状态再次被清除                                    |     高 | Work Progress 与 Anchor 分表                                                 |
| title rename 错误触发断点失效                           |     中 | contentHash 才参与 drift；title 仅 metadata                                    |
| old `isOneShot=false` 被错误恢复成可自动续写               |     高 | 所有 rehydrated session 强制 finite                                           |
| Draft→Work 时 hash 不一致                           |     中 | promotion 成功但 progress reset 0                                            |
| Soft delete 与当前 Session 冲突                      |     中 | 允许内存完成；禁止新 Session/刷新恢复                                                   |
| Progress 百分比看似不平滑                               |     低 | 明确 paragraph-level；M8 再升级 duration progress                               |
| Work 切换后旧 TTS promise 回来开始播放                    |     高 | 除 server session guard 外，client synth result 也必须检查 sessionId 后才能 `play()` |

最后一项尤其重要：

> **session guard 不仅要保护数据库写入，也要保护异步 TTS 返回。**

例如：

```text
A 开始 TTS
→ 用户切 B
→ B 已开始播放
→ A 的 fetchAudio 晚返回
```

A 的结果必须检查：

```text
currentSessionId === originatingSessionId
```

否则直接 revoke blob / discard，不允许覆盖 B。

---

# 51. 需要产品层拍板

### M5-P01 — 已完整听过一次后，再次播放到一半

推荐：

```text
CTA = 继续播放
```

同时保留：

```text
completedAt
```

表示历史上听完过。

---

### M5-P02 — Work 完播后 Now Playing 是否保留

推荐：

> **保留 ended Now Playing。**

用户仍可直接“再次播放”，直到选择另一作品或主动关闭。

---

### M5-P03 — 当前播放 Work 被移到回收站

推荐：

> **当前内存 Session 可以继续；刷新以后不再恢复，也不能新建播放 Session。**

---

# 52. M5 完成后的最终职责图

```text
                           StoryWork (M2)
                          id/title/hash/text
                                │
                                ▼
                       Playback Session
                                │
                  ┌─────────────┼──────────────┐
                  │             │              │
                  ▼             ▼              ▼
             Draft Source    Work Source   Continuation
             messageId       workId        finite/extendable
                  │             │
                  └──────┬──────┘
                         ▼
                PlaybackSessionStore
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
      PlaybackStore            Server Anchor
    Audio Transport           Current Now Playing
                                     │
                                     │ work only
                                     ▼
                           StoryPlaybackProgress
                             Per-Work durable state
```

对 M6 / M7 而言，最终接口非常干净：

```text
Mini / Expanded 想知道：
“现在正在听什么？”
→ PlaybackSessionStore

想知道：
“当前段播到哪里？”
→ PlaybackStore

Story Library 想知道：
“这个作品以前听到哪里？”
→ WorkPlaybackProgress
```

这三个问题不再由同一个 Store / 同一张数据库表承担。

---

# 53. 实施顺序建议

M5 内部建议拆成 5 个 implementation slice：

```text
A. Domain types + Prisma expand + legacy canonicalization
        ↓
B. Playback Session / Anchor server API
        ↓
C. Per-Work Progress + Guest ID remap
        ↓
D. Client Session Store + playbackStore 去重
        ↓
E. AudioControllerHost / storyFlow orchestration 收敛
```

其中 A-C 可以先建立数据契约；D-E 才切换运行时播放链。

每个 slice 都应保持：

```text
yarn test
yarn test:static
typecheck
production build
```

可通过，并按仓库现有 SDD 流程先补 M5 Spec/Plan，再进入实现。

M5 里我认为最值得评审重点看的不是 `draft/work` 改名本身，而是两个决定：**“Anchor 与 Per-Work Progress 分表”**以及**“真正的 UUID Session 防 stale async TTS / stale save”**。这两件事一旦定稳，M6/M7 基本就是消费一个干净的播放领域模型，而不用继续继承现在两个 Store 互相镜像的复杂度。
