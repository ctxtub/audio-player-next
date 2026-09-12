> M4 最重要的调整：故事文本成功 + TTS 成功才记历史的旧链路，改为 **StoryAgent 文本完成 → StoryWork 成立；TTS、播放、入库状态各自独立推进**，与 M2/M5/M8 对齐。

# M4 — 创作页 Artifact 化与 Prompt History 回迁技术方案

**所属 Phase**：P1
**前置模块**：M1 信息架构、M2 StoryWork
**后续衔接**：M5 Playback Session、M6 Mini Now Playing、M8 Canonical Audio、M9 Player 退役
**核心目标**：

1. Story 生成结果从“聊天里一段可播放消息”升级成拥有稳定 `StoryWork.id` 的 Artifact；
2. StoryWork 的成立与 TTS 成败解耦；
3. Prompt History 从 Legacy `/player` 回归创作入口；
4. 生成状态回归对应 Story Card，而不是继续依赖 `/player` 的全局状态面板。

---

# 0. 核心技术决策

| 决策                                     | 推荐                                     |
| -------------------------------------- | -------------------------------------- |
| StoryWork 创建时机                         | **StoryAgent 文本完成后立即创建**               |
| 是否等待 TTS 成功才创建                         | **否**                                  |
| 是否等待整个 Agent Graph 完成才创建               | **否**                                  |
| Story 文本完成信号                           | 新增显式 `story_complete` stream event     |
| StoryWork create 是否阻塞 TTS              | **否，并行执行**                             |
| StoryWork 保存失败是否判 Agent 请求失败           | **否**                                  |
| TTS 失败是否影响 StoryWork                   | **否**                                  |
| Prompt History 记录时机                    | Story 文本成功完成                           |
| 自动 preload continuation 是否创建 StoryWork | **否**                                  |
| StoryWork 与 Chat 关联                    | `sourceMessageId = assistantMessageId` |
| Chat Story Card 持久字段                   | `storyText + workId?`，`audioUrl` 仍瞬态   |
| Draft→Work promotion 调用方               | **M4 StoryArtifactFlow**               |
| Promotion 失败是否回滚 Work                  | **否**                                  |
| Prompt History 主入口                     | `/chat`                                |
| 最近创作默认排序                               | **recent**                             |
| 全量 Prompt History                      | 支持 recent / frequency 切换               |
| `/player` Prompt History               | P1-P3 保持 Legacy compatibility，M9 删除    |
| `GenerationPreview`                    | 逻辑职责被 Story Card 吸收；Legacy 组件留到 M9     |
| `PlaybackStatusBoard`                  | 拆分职责，不整体迁入 Chat                        |

---

# 1. 当前生成链路

当前 Story 流程大致是：

```text
user.submit
   ↓
assistant placeholder
   ↓
Supervisor → StoryAgent
   ↓
stream.delta
   ↓
StoryCardPart.storyText
   ↓
AudioGenerator starts
   ↓
TTS
   ↓
audio Blob URL
   ↓
stream.story_finish
   ↓
GenerationHistory.record
PromptHistory.addOrUpdate
```

关键问题是最后两步目前被放在：

```ts
if (audioUrl) {
  ...
  generationHistory.record(...)
  promptHistory.addOrUpdate(...)
}
```

里面。

所以当前实际语义是：

```text
Story text success
+
TTS success
=
Generation History success
```

如果 TTS 失败，`AudioGenerator` 会捕获错误并正常返回 `FINISH`，不会让整个 Agent 请求失败；但 `chatFlow` 因没有 `audioUrl` 而不会记录 GenerationHistory。

M4 必须修正这个边界。

---

# 2. 新的生成生命周期

目标：

```text
User Prompt
   ↓
Agent routing
   ↓
StoryAgent streaming
   ↓
┌─────────────────────────┐
│ Story text finalized     │
│      story_complete      │
└────────────┬────────────┘
             │
       ┌─────┴─────┐
       ▼           ▼
 StoryWork.create   AudioGenerator
       │                │
       │                ├─ success → playable
       │                └─ fail    → audio unavailable
       │
       ├─ success → workId
       └─ fail    → save failed
```

这两条链路从此独立。

---

# 3. StoryWork 的精确定义时点

StoryWork 成立条件：

```text
Supervisor intent == Story
AND
StoryAgent 已经完成有效非空正文
AND
recordHistory == true
```

不依赖：

```text
TTS
AudioGenerator
Playback
Agent graph 最终 onComplete
```

---

# 3.1 为什么不能继续用整个 Agent `onComplete`

当前 Story 路径：

```text
StoryAgent
   ↓
AudioGenerator
   ↓
END
```

Graph 的最终完成发生在 AudioGenerator 之后。

如果继续在最终：

```text
onComplete
```

创建 StoryWork，就仍然把内容资产的完成时间隐式绑定到了 TTS 阶段。

而产品定义已经明确：

> Story 是资产，Audio 是 Story 的一种消费形式。

因此需要显式：

```text
StoryAgent completed
```

事件。

---

# 4. Agent stream contract 调整

当前 Router 已经捕获：

```text
Supervisor on_chain_end
AudioGenerator on_chain_start
AudioGenerator on_chain_end
```

但没有：

```text
StoryAgent on_chain_end
```

事件。

M4 增加：

```ts
{
  type: 'story_complete',
  content: finalStoryText
}
```

---

# 4.1 Router

在：

```text
lib/trpc/routers/agent.ts
```

增加：

```ts
if (
  event.event === 'on_chain_end' &&
  event.name === 'StoryAgent'
) {
  const storyText =
    extractStoryTextFromNodeOutput(event.data.output)

  if (storyText.trim()) {
    yield {
      type: 'story_complete',
      content: storyText,
    }
  }
}
```

StoryNode 本身在结束时返回：

```ts
{
  messages: [response],
  next_step: 'FINISH'
}
```

因此这里具备比客户端 token accumulation 更权威的完整正文来源。

---

# 4.2 agentFlow

`AgentStreamCallbacks` 增加：

```ts
onStoryComplete?: (
  storyText: string
) => void
```

最终事件顺序对于 Story 应成为：

```text
meta Story
↓
token...
↓
story_complete
↓
audio_start
↓
audio       // optional
↓
complete
```

---

# 4.3 Defensive fallback

为了兼容 rollout 期间旧 Server：

如果：

```text
intent === Story
story_complete 未出现
generatedContent 非空
graph onComplete
```

Client 可以执行一次 fallback finalize。

但必须通过后续定义的：

```text
sourceMessageId idempotency
```

保证不会创建两个 StoryWork。

这属于 migration compatibility，不是长期主路径。

---

# 5. M2 需要增加一个小型幂等契约

M4 会出现：

* event retry；
* network retry；
* 用户点击“重试保存”；
* fallback finalize；

因此：

```text
library.create
```

不能是纯粹的“每调用一次 INSERT 一条”。

---

# 5.1 sourceMessageId 唯一性

建议对 M2 增补：

User：

```prisma
@@unique([userId, sourceMessageId])
```

Guest：

```prisma
@@unique([guestId, sourceMessageId])
```

SQLite UNIQUE 对 `NULL` 允许多行，因此：

```text
Legacy StoryWork:
sourceMessageId = null
```

不受影响。

---

# 5.2 create 幂等规则

当 input 有：

```text
sourceMessageId
```

时：

### 不存在

正常创建。

### 已存在且 contentHash 相同

返回现有 StoryWork。

### 已存在但 contentHash 不同

返回：

```text
CONFLICT
```

绝不覆盖已有作品。

这是 M4 对已通过 M2 的唯一 additive contract 要求，不改变 M2 领域设计。

---

# 6. StoryArtifactFlow

建议新增：

```text
app/services/storyArtifactFlow.ts
```

M4 所有“故事完成后怎么办”的逻辑从 `chatFlow.ts` 抽到这里。

核心：

```ts
finalizeStoryArtifact({
  assistantMessageId,
  triggerPrompt,
  storyText,
  voiceId,
  recordHistory,
})
```

---

# 6.1 职责

```text
Story text finalized
       ↓
PromptHistory record
       ↓
Chat Card → saving
       ↓
library.create
       ↓
Chat Card attach workId
       ↓
M5 promoteDraftToWork
```

它不负责：

```text
TTS
audio playback
Agent token streaming
```

---

# 7. `recordHistory` 语义继续保留

当前：

```ts
beginChatStream(
  content,
  {
    recordHistory?: boolean,
    origin?: ...
  }
)
```

已经用：

```text
recordHistory = false
```

区分自动 preload continuation。

M4 将它的含义正式升级为：

> **这次生成是否应该形成用户可见 Story Artifact。**

因此：

### 用户主动生成 Story

```text
recordHistory = true
→ StoryWork
→ Prompt History
```

### 自动 preload

```text
recordHistory = false
→ 不创建 StoryWork
→ 不增加 Prompt History
```

---

# 8. StoryWork create 输入

M4 传给 M2：

```ts
{
  prompt: triggerPrompt,
  storyText: finalStoryText,
  voiceId,
  sourceMessageId: assistantMessageId,
}
```

不传：

```text
title
contentHash
excerpt
```

除非未来 StoryAgent 正式提供明确 title。

当前 StoryAgent 明确要求返回纯正文、不要章节标题，所以 M4 V1 不应该自己再造一套标题算法。

title fallback 完全由 M2 负责。

---

# 9. Prompt History 记录时机

当前 Prompt History 和 Generation History 都发生在：

```text
audioUrl success
```

之后。

M4 调整为：

```text
story_complete
       ↓
if recordHistory:
    promptHistory.addOrUpdate(triggerPrompt)
```

也就是说：

> 一个 Prompt 成功生成完整 Story 文本，就算一次有效创作。

TTS 是否失败不影响 Prompt History。

---

# 9.1 不记录的情况

以下全部不增加：

```text
Chat intent
Guidance intent
StoryAgent 在文本完成前失败
Abort before story_complete
Automatic preload continuation
```

---

# 10. StoryWork create 不阻塞 AudioGenerator

`story_complete` 到达后：

```ts
storyWorkPromise =
  finalizeStoryArtifact(...)
```

但不：

```ts
await storyWorkPromise
```

阻塞 Agent stream。

与此同时：

```text
AudioGenerator
```

正常继续。

理由：

* DB 网络写不应该增加首段语音等待；
* TTS 与 Library persistence 没有因果依赖；
* 两者失败策略不同。

---

# 11. 整个 Chat 请求结束时如何处理 create Promise

`executeChatStream` 应跟踪：

```ts
let storyWorkPromise:
  Promise<StoryWork | null> | null
```

Agent stream 结束以后，可以等待它 settle：

```text
await Promise.allSettled(...)
```

但：

> StoryWork 保存失败不能让 `beginChatStream()` 抛出“聊天失败”。

否则用户明明已经看到完整 Story，却会看到：

```text
发送失败
```

语义错误。

---

# 12. StoryWork 保存失败

Story 内容：

```text
成功
```

Library persistence：

```text
失败
```

Story Card 应表现：

```text
故事已生成

⚠ 尚未保存到故事库
[重试保存]

如果已有音频：
[播放故事]
```

不能：

```text
重新执行整个 Agent
```

“重试保存”只重新：

```text
library.create
```

因为有 `sourceMessageId` 幂等保护，不会产生重复 Work。

---

# 13. TTS 失败

StoryWork：

```text
正常保存
```

Prompt History：

```text
正常增加
```

Card：

```text
故事已保存到故事库
语音暂不可用

[查看全文]
[重试播放]
```

M4 阶段的“重试播放”可以继续走现有：

```text
playStoryText()
```

重新 TTS。

M8 上线后自然变成：

```text
ensureSegment()
```

无需改变 Story identity。

---

# 14. Abort 边界

这里必须区分两个时间点。

---

## 14.1 story_complete 之前 Abort

```text
Story 尚未完成
```

结果：

```text
不创建 StoryWork
不记录 Prompt History
清理 sending assistant placeholder
```

继续沿用当前失败/取消处理。

---

## 14.2 story_complete 之后、TTS 完成前 Abort

此时：

```text
Story content 已经正式完成
```

因此：

```text
StoryWork 保留
Prompt History 保留
```

不应该因为后续 Audio 被取消，把已经生成成功的内容资产抹掉。

推荐 Chat Card：

```text
delivered
audio unavailable / cancelled
```

而不是把整个 Story Card 从会话删除。

当前 `AbortError` 会调用：

```ts
resetActiveSession()
```

M4 需要根据：

```text
hasFinalizedStory
```

区分行为。

---

# 15. Story Artifact Card 数据结构

当前：

```ts
type StoryCardPart = {
  type: 'storyCard'
  storyText: string
  audioUrl: string
}
```

M4 推荐扩展：

```ts
type StoryCardPart = {
  type: 'storyCard'

  storyText: string

  // 当前 Legacy / ephemeral playback
  audioUrl: string

  // 新增：稳定 StoryWork identity
  workId?: number

  // 区分 M4 之后的新 Artifact 与旧聊天卡
  artifactVersion?: 1
}
```

---

# 15.1 为什么需要 artifactVersion

旧 Chat snapshot 中已经有大量：

```text
storyCard
workId absent
```

如果简单定义：

```text
没有 workId = 保存失败
```

那么所有旧 Story Card 都会突然显示：

> 尚未保存到故事库。

这是错误的。

因此：

```text
artifactVersion absent
→ Legacy Story Card

artifactVersion = 1
→ 新 Artifact lifecycle
```

---

# 15.2 Legacy Card

旧卡：

```text
不自动创建 StoryWork
```

原因：

旧 GenerationHistory 可能已经迁入 Library，但没有可靠 `sourceMessageId`，自动创建会产生重复作品。

Legacy Card：

* 保持可查看；
* 保持可播放；
* 不显示“保存失败”；
* 不自动写 Library。

---

# 16. Chat Snapshot

当前保存会话时：

```ts
storyCard
→ audioUrl: ''
```

明确不持久化临时 Blob URL。

M4 保持。

但：

```text
workId
artifactVersion
```

必须正常持久化。

最终 snapshot：

```ts
{
  type: 'storyCard',
  storyText,
  audioUrl: '',
  workId: 481,
  artifactVersion: 1,
}
```

Chat conversation schema 对 Message Parts 本来就是宽松 JSON，因此无需数据库 schema migration。

---

# 17. Artifact Card 的状态不要做成一个错误的线性 Enum

表面产品过程看起来像：

```text
生成中
→ 语音准备
→ 可播放
→ 已入故事库
```

但技术上：

```text
StoryWork 保存
```

和：

```text
Audio 准备
```

是并行的。

例如可能出现：

```text
已入故事库
+
语音仍在准备
```

甚至：

```text
语音可播放
+
故事库保存失败
```

因此不要建立：

```ts
type ArtifactState =
  'generating'
  | 'audio'
  | 'playable'
  | 'saved'
```

这种假线性状态机。

---

# 18. Artifact Card 的三个正交维度

## Content

```ts
type StoryContentState =
  | 'generating'
  | 'complete'
  | 'failed'
```

## Library

```ts
type StoryLibraryState =
  | 'not_applicable'
  | 'saving'
  | 'saved'
  | 'save_failed'
```

## Audio

```ts
type StoryAudioState =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'unavailable'
```

---

# 19. UI 展示优先级

### 文本生成

```text
正在创作故事…
```

### 文本完成，Work 与 Audio 都处理中

```text
故事已完成
正在准备语音…
正在保存到故事库…
```

### Work 先保存成功

```text
✓ 已保存到故事库
正在准备语音…
```

### Audio 先成功

```text
▶ 播放故事
正在保存到故事库…
```

### 两者都成功

```text
✓ 已保存到故事库

[播放故事]
[查看全文]
```

### Work fail + Audio success

```text
⚠ 尚未保存到故事库

[播放故事]
[重试保存]
```

### Work success + Audio fail

```text
✓ 已保存到故事库
语音暂不可用

[重新准备语音]
[查看全文]
```

---

# 20. Runtime 状态归属

现有 `generationStore` 是全局单实例：

```text
phase
streamingText
errorMessage
```

没有：

```text
activeMessageId
```

而当前 StoryCard 判断：

```ts
isGlobalGenerating &&
!part.audioUrl
```

所以任何：

```text
audioUrl === ''
```

的旧恢复 Story Card，在另一个新 Story 正在生成时，都可能被误认为“当前生成卡”。

M4 应修正。

---

# 21. generationStore 增加 activeMessageId

调整为：

```ts
type GenerationStore = {
  activeMessageId: string | null

  phase:
    | 'idle'
    | 'generating_text'
    | 'generating_audio'
    | 'ready'
    | 'error'

  streamingText: string
  errorMessage?: string

  start: (messageId: string) => void
  ...
}
```

Story Card：

```ts
const isActiveGeneration =
  generation.activeMessageId === messageId
```

只有：

```text
当前 message
+
generation phase
```

共同成立，才显示生成动画。

---

# 22. StoryCardPartRenderer 改造

当前组件已经具备：

* 打字流；
* “正在创作故事”；
* 音波动画；
* 查看全文；
* 播放；
* 暂停；
* 断点继续。

因此不需要新建第二套 Artifact Card。

直接演进：

```text
StoryCardPartRenderer
        ↓
Story Artifact Card
```

即可。

---

# 22.1 新职责

增加：

```text
workId indicator
library save state
save retry
audio unavailable
```

播放部分 M5 上线以后改为：

```text
workId
→ Work playback

no workId
→ Draft playback
```

---

# 23. Artifact save runtime state

不建议把：

```text
saving
save_failed
```

永久存进 StoryCard JSON。

这些属于瞬态。

推荐放：

```text
ChatMessage.metadata.storyArtifact
```

例如：

```ts
storyArtifact?: {
  libraryState:
    | 'saving'
    | 'saved'
    | 'save_failed'

  audioState:
    | 'idle'
    | 'preparing'
    | 'ready'
    | 'unavailable'
}
```

当前 `toSnapshot()` 只持久化：

```text
agentType
```

而不会把完整 message metadata 写入服务端，因此这些瞬态字段不会污染历史 snapshot。

Reload 后：

```text
workId exists
→ libraryState = saved

artifactVersion=1
workId absent
→ 可表现为未保存/可重试

Legacy no artifactVersion
→ legacy
```

---

# 24. ChatStore Actions

推荐增加明确 action：

```ts
stream.story_text_complete

artifact.story_work_saving
artifact.story_work_attached
artifact.story_work_failed

stream.story_audio_start
stream.story_audio_ready
stream.story_audio_unavailable
```

不要让 `chatFlow` 直接：

```text
find message
mutate nested parts
```

保持当前 reducer-style dispatch 约束。

---

# 25. `stream.story_finish` 演进

当前：

```ts
stream.story_finish {
  storyText,
  audioUrl
}
```

一次把所有事情完成。

M4 之后它可以收敛为：

```text
interaction final delivery
```

而 Story 本身已经经过：

```text
story_text_complete
audio_ready / unavailable
work_attached
```

逐步进入卡片。

这样 Card lifecycle 不再被最后一次事件“一把覆盖”。

---

# 26. Draft → Work Promotion

M5 已定义：

```text
draft(messageId)
↓
work(workId)
```

M4 是最清楚：

> “这个 Draft 对应的 StoryWork 刚刚创建成功”

的模块。

因此：

> **Draft promotion 的调用方属于 M4。**

---

# 26.1 调用点

`library.create()` resolve 后：

```text
StoryArtifactFlow
    ↓
ChatStore attach workId
    ↓
M5 promoteDraftToWork
```

概念代码：

```ts
const work = await createStoryWork(...)

chatStore.dispatch({
  type: 'artifact.story_work_attached',
  messageId,
  workId: work.id,
})

await promoteDraftToWorkIfActive({
  messageId,
  workId: work.id,
})
```

---

# 26.2 M4 在 M5 之前实施怎么办

模块实施顺序仍然是：

```text
M4
↓
M5
```

因此 M4 首次落地时：

```text
只完成：
StoryWork create
+
Story Card workId attachment
```

当前播放仍使用旧：

```text
chat / messageId
```

M5 实施时再在同一 `StoryArtifactFlow` 成功回调中接入：

```text
promoteDraftToWork
```

调用 ownership 不改变。

---

# 26.3 Promotion 失败

例如用户已经切换到另一个 Story：

```text
M5 → STALE_SESSION
```

结果：

```text
StoryWork creation = success
Chat Card workId = success
Promotion = irrelevant
```

不得：

```text
回滚 StoryWork
```

Promotion 是运行态优化，不是资产创建 transaction 的一部分。

---

# 27. Audio 比 StoryWork 先完成

可能：

```text
TTS ready
↓
Work DB request 尚未返回
```

用户此时点击播放：

```text
Draft(messageId)
```

正常播放。

稍后 Work create：

```text
promoteDraftToWork
```

不中断音频。

这就是 M5 Draft promotion 存在的主要现实场景。

---

# 28. StoryWork 比 Audio 先完成

更常见：

```text
StoryWork saved
↓
AudioGenerator still working
```

Card：

```text
✓ 已保存到故事库
正在准备语音…
```

之后直接建立 Work playback。

---

# 29. Prompt History 回迁

当前 `/player/HistoryPanel`：

```text
提示词历史
生成历史
```

两个 Tab。Prompt 选择后：

```ts
setPendingAutoSend(prompt)
router.push('/chat')
```

M4 将 Prompt History 的**正式产品入口**迁至 `/chat`。

---

# 30. 创作页 Prompt History 信息架构

推荐两级。

## 空状态主入口

当前 `HeaderArea` 已经只在：

```text
messages.length === 0
```

时出现，并展示固定推荐主题。

调整为：

```text
你好，我是 Agent 助手
告诉我你想听什么故事

推荐创作
[星际冒险] [动物朋友] [...]

最近创作
[月球上的狐狸]
[深海城市]
[森林探险]

[查看全部]
```

---

# 31. 最近创作数量

推荐：

```text
Desktop: 6
Mobile: 4
```

或者由 responsive layout 自然控制显示行数。

技术上统一取：

```ts
sortHistoryRecords(records, 'recent')
  .slice(0, RECENT_PROMPT_LIMIT)
```

Primary 区域永远：

```text
recent
```

不受全量历史排序选择影响。

---

# 32. 全量 Prompt History

点击：

```text
查看全部
```

打开：

移动：

```text
Glass Bottom Sheet
```

桌面：

```text
Glass Popover / Panel
```

展示：

```text
最近 | 常用
```

对应已有：

```ts
SortMode =
  'recent'
  | 'frequency'
```

当前 Store 已经具备完整两套排序算法。

---

# 32.1 默认排序修改

当前：

```ts
sortMode: 'frequency'
```

推荐 M4 改为：

```ts
sortMode: 'recent'
```

理由：

这里的产品名称已经是：

> 最近创作

不是：

> 常用 Prompt 排行榜。

用户仍可切到：

```text
常用
```

---

# 33. 非空 Chat 时如何访问 Prompt History

如果 Prompt History 只塞进 `HeaderArea`：

```text
messages.length > 0
```

后就完全无法访问。

因此推荐在 Composer 上方增加一个轻量入口：

```text
[ 最近创作 ]
```

不展开 chips，只作为 History Panel trigger。

例如：

```text
┌──────────────────────────────┐
│ 最近创作                     │
│ ┌──────────────────────────┐ │
│ │ 描述你想听的故事…        │ │
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

这样 Prompt History 真正从 `/player` 迁走以后仍然随时可访问。

---

# 34. Prompt reuse 链路

正式复用行为仍然走：

```text
setPendingAutoSend
```

而不是新建另一套逻辑。

新 Chat UI：

```text
select prompt
    ↓
setPendingAutoSend(prompt)
```

因为已经在 `/chat`：

```text
不需要 router.push('/chat')
```

---

# 34.1 现有消费逻辑继续复用

`ChatLayout` 当前已经：

1. 检查 `pendingAutoSend`；
2. 如果正在发送则保留 pending；
3. 等发送结束再次消费；
4. `resetStoryFlow()`；
5. 清 pending；
6. 填入 Composer；
7. 自动 `handleSubmit()`。

这是一个已经相当完整的排队语义。

M4 不需要重写。

---

# 34.2 注释与领域命名

当前 ChatStore 注释：

> 来自 `/player` 历史记录选择。

M4 改成：

> 跨入口触发“重新创作”的待发 Prompt。

避免以后领域代码继续依赖旧路由语义。

---

# 35. 选择 Prompt 时是否继续自动发送

推荐保留当前行为：

```text
点击“再次创作”
→ 开新干净会话
→ 自动提交
```

因为现有 `/player` 行为就是这样，迁移后不会改变用户语义。

UI 必须明确用：

```text
再次创作
```

而不是模糊的：

```text
选择
```

避免用户以为只是填充输入框。

**【产品拍板 M4-P01】**

推荐：

> 最近创作 / Prompt History 点击后继续自动发送，而非只填充 Composer。

---

# 36. Prompt 删除

全量 Prompt History Panel 继续提供：

```text
删除
```

空状态的 4/6 个快捷 chips 不直接显示删除按钮。

避免 Hero 区域变成管理后台。

当前 `PromptHistoryStore.remove()` 已经具备 optimistic local delete + server delete。

---

# 37. `/player` HistoryPanel 衔接

M1 已确定：

```text
/player
=
Frozen Compatibility Surface
```

因此 M4：

### 新增

```text
/chat Prompt History
```

### 不删除

```text
/player HistoryPanel Prompt tab
```

过渡期两者同时存在。

---

# 37.1 为什么不是 M4 直接删除

否则旧 Bookmark：

```text
/player
```

在 M9 之前就发生功能缩水，违反 M1 compatibility contract。

M9 最终：

```text
/player HistoryPanel
```

整体删除。

---

# 38. Prompt UI 组件抽取

建议新增通用：

```text
components/PromptHistory/
├── PromptHistoryPanel.tsx
├── PromptHistoryList.tsx
└── index.module.scss
```

M4 的 Chat 使用。

Legacy：

```text
/player/components/HistoryRecords
```

可以：

### 推荐

改成薄 adapter，复用新的：

```text
PromptHistoryList
```

但必须保持：

* 原文案；
* 原排序入口；
* 原 auto-send；
* 原删除；

行为不变。

这是内部重构，不改变 `/player` compatibility surface。

如果为了降低 P1 diff，也可以暂时保留两套 renderer，M9 再删旧版。

技术推荐前者，避免数据展示逻辑漂移。

---

# 39. GenerationPreview 去向

当前 `/player/GenerationPreview`：

* 订阅 `generationStore.phase`；
* 展示 streamingText；
* generating_text → 打字；
* generating_audio → 音波 Overlay。

而当前 `StoryCardPartRenderer` 已经拥有几乎相同能力：

* generating_text；
* generating_audio；
* streaming Story；
* audio Overlay。

因此：

> **GenerationPreview 不应该“移动到 Chat”，而应该被 Story Artifact Card 吸收。**

M4 不新建：

```text
ChatGenerationPreview
```

---

# 39.1 M4 后职责

正式产品：

```text
Generation Status
→ 当前 Story Artifact Card
```

Legacy：

```text
/player/GenerationPreview
→ 继续存在直到 M9
```

M9 删除。

---

# 40. PlaybackStatusBoard 去向

当前 `PlaybackStatusBoard` 实际混合三类职责：

```text
1. generation phase
   正在创作 / 正在生成语音

2. preload
   加载 / retry / ready

3. playback timer
   播放倒计时
```

所以它不能整体搬进某一个新页面。

---

# 40.1 拆分归属

### Generation

```text
M4
→ Story Artifact Card
```

### Preload / playback preparation

```text
M5 Playback Session
→ M6/M7 Now Playing presentation
```

### Countdown

```text
M7 Expanded Now Playing
→ Sleep Timer
```

因此：

> `PlaybackStatusBoard` 最终没有新的一对一替代组件。

它会被职责拆散。

---

# 40.2 Compatibility

同 GenerationPreview：

```text
/player/PlaybackStatusBoard
```

M4 不删除、不改变产品行为。

M9 最终物理清理。

---

# 41. Story Card 播放入口演进

当前 StoryCard：

```text
audioUrl exists
→ onPlayStory(audioUrl)

audioUrl missing
→ playStoryText(storyText, messageId)
```

并基于当前 `playbackProgressStore.sourceId == messageId` 判断恢复位置。

M4 P1 可以继续这一行为。

---

# 41.1 M5 后

变成：

```text
workId exists
→ Work playback

artifactVersion=1 && workId absent
→ Draft playback

Legacy Card
→ legacy Draft playback
```

StoryCard 自身不直接理解：

```text
sourceType
sourceId
isOneShot
```

只调用 M5 Playback service。

---

# 42. 新 Story Card 恢复

会话 Reload：

```text
audioUrl = ''
workId = 481
artifactVersion = 1
```

Card：

```text
✓ 已保存到故事库
[播放故事]
```

M5：

```text
work(481)
```

恢复。

M8 后：

```text
canonical audio
```

直接接管音频来源。

---

# 43. Story Card 与 Library 的关系

Story Card 是：

```text
Conversation Artifact Reference
```

StoryWork 是：

```text
Durable Content Asset
```

Card 可以消失：

* 清空 Chat；
* Conversation snapshot 被替换；

但 Work 不能因此删除。

因此：

```text
resetStoryFlow()
```

绝对不得 cascade：

```text
delete StoryWork
```

这条边界必须通过 integration test 锁死。

---

# 44. Retry Chat 与 Artifact

当前 `retryChatStream()`：

* 找最后失败 User；
* 创建新的 Assistant placeholder；
* 重跑 stream。

因此 retry 后：

```text
新的 assistantMessageId
```

如果这次 Story 成功：

```text
新的 StoryWork
```

这是正确的。

旧失败 attempt：

```text
没有 StoryWork
```

---

# 45. “重试保存”不是 Chat Retry

必须分开：

```text
Agent Retry
→ 重新生成 Story

Artifact Save Retry
→ 同一 Story text
→ library.create(sourceMessageId)
```

两个按钮不能复用同一 handler。

---

# 46. 文件级改动

## 新增

```text
app/services/
└── storyArtifactFlow.ts
```

---

```text
components/PromptHistory/
├── PromptHistoryPanel.tsx
├── PromptHistoryList.tsx
├── RecentPromptList.tsx
└── index.module.scss
```

或者放到：

```text
app/(main)/chat/components/PromptHistory/
```

两者均可。

推荐放 Chat 下，因为目前只有创作域消费；Legacy Player 可继续保留自己的 adapter。

---

# 47. 修改

```text
lib/trpc/routers/agent.ts
```

新增：

```text
story_complete
```

stream event。

---

```text
app/services/agentFlow.ts
```

新增：

```ts
onStoryComplete
```

callback。

---

```text
app/services/chatFlow.ts
```

调整：

```text
executeChatStream assistantMessageId input
StoryArtifactFlow orchestration
TTS 与 Work persistence 解耦
Prompt history timing
Abort boundary
```

移除：

```text
GenerationHistoryStore.record(...)
```

正式业务写路径。

---

```text
types/chat.ts
```

新增：

```text
StoryCardPart.workId
StoryCardPart.artifactVersion

ChatMessageMetadata.storyArtifact
```

---

```text
stores/chatStore.ts
```

增加：

```text
story_text_complete
story work saving/attached/failed
story audio start/ready/unavailable
```

并更新：

```text
pendingAutoSend
```

注释。

---

```text
stores/generationStore.ts
```

增加：

```text
activeMessageId
start(messageId)
```

解决旧恢复卡被全局 generation phase 误命中的问题。

---

```text
app/(main)/chat/components/MessageParts/StoryCardPart.tsx
```

升级为 Artifact UI。

---

```text
app/(main)/chat/components/ChatLayout/index.tsx
```

接入：

```text
Recent Prompt
Prompt History trigger
```

保留 pendingAutoSend 消费链。

---

```text
app/(main)/chat/components/ChatLayout/HeaderArea.tsx
```

增加：

```text
recent prompts slot
```

或拆成独立区域。

---

```text
app/(main)/chat/components/ChatLayout/InputArea.tsx
```

增加轻量：

```text
最近创作
```

入口。

---

```text
stores/promptHistoryStore.ts
```

默认：

```text
frequency
→ recent
```

保留两种 sorter。

---

# 48. Compatibility 文件

以下正式业务不再依赖，但 M4 不删除：

```text
stores/generationHistoryStore.ts

app/(main)/player/components/
├── HistoryPanel
├── HistoryRecords
├── GenerationHistory
├── GenerationPreview
└── PlaybackStatusBoard
```

`generationHistoryStore` 继续服务 Legacy `/player`，直到 M9。

新 Chat 创建 StoryWork 直接使用 M2 Library Client，不再通过 Legacy Store。

---

# 49. 与 M2 接口

M4 只需要：

```text
library.create
```

以及：

```text
StoryWorkDetailDTO
```

成功后只关心：

```text
id
title
contentHash
voiceId
```

Chat Card 持久化：

```text
workId
```

不把整个 StoryWork DTO 复制进 ChatStore。

---

# 50. 与 M5 接口

最终：

```text
M4 creates Work
       ↓
workId
       ↓
M5 promoteDraftToWork
```

M4 不处理：

```text
sessionId matching
stale session
progress migration
hash reset
```

这些完全属于 M5。

---

# 51. 与 M8 接口

M4 不主动创建：

```text
Audio Manifest
```

M4 仍然接受当前 Agent AudioGenerator 返回的临时音频。

M8 上线以后：

```text
Work playback
→ Canonical Audio
```

而 Chat Artifact 生命周期不需要改变。

这是为什么 M4 必须先把：

```text
StoryWork
```

和：

```text
audio readiness
```

拆开。

---

# 52. 迁移步骤

建议内部按 5 个 slice。

## M4-A — Story completion event

```text
Agent Router
→ story_complete
→ agentFlow callback
```

不改变现有 UI。

---

## M4-B — StoryWork creation

```text
story_complete
→ StoryArtifactFlow
→ library.create
```

加入：

```text
workId
artifactVersion
```

Chat persistence。

同时停止新的：

```text
generationHistory.record
```

业务写入。

Legacy reader 保留。

---

## M4-C — Artifact Card

升级 StoryCard：

```text
activeMessageId
save state
audio state
retry save
```

消除全局 generation 错绑旧 Card 的问题。

---

## M4-D — Prompt History

将正式入口放进 `/chat`：

```text
empty state recent prompts
+
persistent history trigger
```

保留 pendingAutoSend。

---

## M4-E — Legacy ownership declaration

测试锁定：

```text
/player components remain
```

并在 Spec 标记 M9 删除清单。

---

# 53. 一个重要迁移问题：Legacy GenerationHistory

M2 已将现有 GenerationHistory 数据映射成 StoryWork。

M4 上线以后，新 Story：

```text
只写 library.create
```

不能同时：

```text
library.create
+
generationHistory.record
```

否则会重复写两个 StoryWork。

因此 cutover 必须是明确的：

```text
Before M4:
GenerationHistory.record = write path

After M4:
library.create = write path

generationHistory.record =
compatibility only for Legacy /player/client
```

如果 Legacy `/player` 本身没有创作入口，就不会产生新的重复写。

---

# 54. 验证 — Story success + Audio success

输入 Story Prompt。

期望：

```text
story_complete exactly once

StoryWork create exactly once

sourceMessageId =
assistant message ID

Prompt useCount +1

Card:
artifactVersion=1
workId exists
audio ready

Chat snapshot:
workId exists
audioUrl=''
```

---

# 55. 验证 — Story success + Audio failure

Fake AudioGenerator failure。

期望：

```text
StoryWork exists
Prompt History incremented
Chat message delivered
workId exists

Card:
已保存到故事库
语音暂不可用
```

不得：

```text
Generation/Chat failed
```

这是 M4 最重要的 regression。

---

# 56. 验证 — Story text failure

StoryAgent 在：

```text
story_complete
```

前失败。

期望：

```text
StoryWork count unchanged
Prompt History unchanged
Assistant failed
```

Chat Retry 可以重新运行。

---

# 57. 验证 — Work save failure

Fake：

```text
library.create → failure
```

但 TTS success。

期望：

```text
Story text remains
audio playable
workId absent

Card:
保存失败
[重试保存]
```

点击 retry：

```text
不调用 Agent
不调用 Story TTS
仅 library.create
```

成功后 attach Work。

---

# 58. 验证 — Idempotency

模拟：

```text
story_complete duplicated
+
user retry save
```

同一个：

```text
sourceMessageId
```

最终：

```text
StoryWork count == 1
```

---

# 59. 验证 — Preload

```text
beginChatStream(
  AUTO_CONTINUE_PROMPT,
  { recordHistory:false, origin:'preload' }
)
```

即使：

```text
StoryAgent success
TTS success
```

也必须：

```text
StoryWork count unchanged
PromptHistory unchanged
```

保持当前 preload 隔离语义。

---

# 60. 验证 — Chat / Guidance

两类 Intent：

```text
无 StoryWork
无 Prompt History
```

---

# 61. 验证 — Abort before finalize

```text
streaming text
→ abort
```

期望：

```text
无 Work
无 Prompt History
```

---

# 62. 验证 — Abort after finalize

```text
story_complete
→ Work create
→ Audio preparing
→ abort
```

期望：

```text
Work 保留
Prompt History 保留
Story Card 保留有效正文
Audio unavailable
```

---

# 63. 验证 — Generation identity

准备：

```text
Old Story Card A
audioUrl=''
```

开始生成：

```text
Story B
```

必须：

```text
A 不显示“正在创作”
B 显示 generation animation
```

这是 `activeMessageId` 的关键 regression test。

---

# 64. 验证 — Snapshot

生成 Work：

```text
workId = 481
audioUrl = blob:...
```

保存、刷新。

恢复：

```text
workId == 481
audioUrl == ''
artifactVersion == 1
```

Card：

```text
仍显示已保存到故事库
```

---

# 65. 验证 — Legacy Card

旧 snapshot：

```text
storyCard
storyText
audioUrl=''
无 workId
无 artifactVersion
```

恢复以后：

* 不显示“保存失败”；
* 不自动创建 Work；
* 仍可按原方式播放。

---

# 66. 验证 — Prompt History

空 Chat：

```text
最近创作
```

按照：

```text
lastUsed DESC
```

展示。

Full Panel：

```text
recent
frequency
```

切换结果继续与 `sortHistoryRecords()` 一致。

---

# 67. 验证 — pendingAutoSend

点击：

```text
再次创作 A
```

空闲时：

```text
resetStoryFlow
→ 自动发送 A
```

发送中点击 B：

```text
Composer 显示 B
pending 保留
当前请求完成
→ 自动发送 B
```

保持现有保护行为。

---

# 68. 验证 — Chat Reset

存在：

```text
StoryWork 481
```

然后：

```text
resetStoryFlow()
```

必须：

```text
Chat cleared
StoryWork 481 still exists
```

禁止 Artifact 被 Conversation lifecycle cascade 删除。

---

# 69. 验证 — Draft Promotion（M5 联调）

场景 1：

```text
Audio ready
→ Draft playback starts
→ Work create resolves
```

期望：

```text
M5 promoteDraftToWork
sessionId unchanged
audio uninterrupted
```

场景 2：

```text
用户已经切到 Work B
→ Work A create resolves
```

Promotion：

```text
STALE_SESSION
```

但：

```text
Work A remains saved
```

---

# 70. Browser / E2E

M10 至少登记：

```text
Story Card 文本流式增长

文本完成后 Story 已出现在 Library，
即使语音仍准备中

TTS failure 仍然产生 Library Story

点击 Story Card 播放

点击查看全文

Prompt History 从 /chat 可访问

最近创作自动重新创作

发送中点击最近 Prompt 会排队

刷新恢复 Story Card → Work identity 保持

Legacy /player Prompt History 仍然存在

Legacy /player GenerationPreview / StatusBoard 仍然存在
```

最后三条一直保持到 M9。

---

# 71. 主要风险

| 风险                                   |   严重度 | 处理                                                 |
| ------------------------------------ | ----: | -------------------------------------------------- |
| StoryWork 仍被 TTS 成功条件绑住              | **高** | 显式 `story_complete`                                |
| story_complete / retry 创建重复 Work     | **高** | owner + sourceMessageId unique + idempotent create |
| Work save failure被误判成整个 Chat failure |     高 | 独立 Artifact save state                             |
| TTS failure 导致完整 Story 丢失            | **高** | StoryWork 在 AudioGenerator 前启动创建                   |
| 全局 generationStore 让历史卡一起显示生成动画      |     高 | `activeMessageId`                                  |
| Legacy Story Card 被误标为“保存失败”         |     中 | `artifactVersion`                                  |
| Chat reset 意外删除 Library Work         |     高 | 严格领域隔离 + integration test                          |
| Work create 比 Audio 慢导致播放身份竞态        |     高 | Draft→Work promotion                               |
| Work create 比 Audio 快但 Card 仍走 Draft |     中 | Card workId / M5 source resolution                 |
| Prompt History 新旧入口行为漂移              |     中 | 复用同 Store / sort utility / pendingAutoSend         |
| Prompt chip 点击直接发送让用户意外              |  产品风险 | 明确“再次创作”动作文案，见 P01                                 |
| Prompt History 只放空状态导致会话中不可访问        |     中 | Composer 附近长期入口                                    |
| M4 提前删除 `/player` legacy components  |     高 | M1 compatibility tests 锁死                          |

---

# 72. 拍板项

## M4-P01 — 最近创作点击行为

推荐：

> **保持现有语义：点击“再次创作”即新开干净创作上下文并自动发送。**

不改成单纯填入 Composer。

原因：

* 延续现有 Prompt History 行为；
* `pendingAutoSend` 已有完整发送中排队逻辑；
* 操作命名可以清楚表达副作用。

---

## M4-P02 — StoryWork 保存失败后的用户能力

推荐：

> **Story Card 明确显示“尚未保存到故事库”，并提供“重试保存”。**

不要只 Toast 一次然后让用户失去恢复入口。

---

## M4-P03 — Story 文本完成后用户取消语音生成

推荐：

> **已经完成的 StoryWork 保留；只取消 Audio。**

Story Content 的成功不可被下游 TTS cancellation 反向撤销。

---

# 73. M4 完成后的职责图

```text
                      /chat
                        │
                        ▼
                   User Prompt
                        │
                        ▼
                 Agent Story Flow
                        │
                 story_complete
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
   Story Artifact Flow             Audio Flow
          │                           │
   ┌──────┴──────┐             preparing
   ▼             ▼                   │
StoryWork    PromptHistory       ready / fail
   │
   ▼
workId
   │
   ├────────→ Story Card
   │
   ├────────→ Library
   │
   └────────→ M5 Draft Promotion
```

最终 Story Card 负责表达：

> “刚刚创作出的这篇故事现在是什么状态？”

Library 负责表达：

> “我拥有过哪些作品？”

Global Now Playing 负责表达：

> “我现在正在听什么？”

Prompt History 则回到：

> “我下一次想从什么创作起点开始？”

这四种职责从 M4 开始正式分开。

M4 里我认为最值得锁死的两个技术点是：**`story_complete` 必须成为显式 Agent 事件**，以及 **`sourceMessageId` 必须具备服务端幂等约束**。前者把 Story 和 TTS 真正解耦，后者让自动保存、重试保存和流事件 fallback 都可以安全存在。
