# StoryCollection、连续创作与单音频播放技术方案

**状态**：READY FOR IMPLEMENTATION
**日期**：2026-09-15
**change-id**：`2026-09-15-story-collection-continuous-creation`
**产品输入**：`docs/specs/2026-09-15-conversation-story-collection-product-adjustment.md`
**规划目标 SHA**：`e6def28a649494b5db8fec58bfe92c7c05f8c3c2`
**边界**：不授权 push、merge、deploy、Actions 或生产数据操作

## 1. 目标架构

```text
Conversation 1 ── 1 StoryCollection ── N StoryWork ── 1 active StoryAudioAsset
                         │
                         └── ContinuousCreationRun（最多 1 个 next-work job）
```

- Conversation 保存上下文；Collection 保存标题与集合级生命周期；Work 保存单条完整作品。
- Promotion Service 是 Artifact → Collection/Work 的唯一写入口。
- Playback Session 以 `workId` 为曲目身份；UI 不消费 paragraph/segment identity。
- StoryAudio Service 可内部拆批 TTS，但只发布一个 canonical 音频对象。
- Continuous Creation Orchestrator 只调度下一 Work，不直接写库或控制 `<audio>`。

## 2. 数据模型

User / Guest 保持物理隔离，服务层继续以 `Subject` 收敛。新增对称的 `Conversation`、`StoryCollection`、`StoryAudioAsset`；Guest 模型增加 `guestId` 与 `updatedAt` GC 索引。

```text
Conversation
  id UUID, owner, state(active|closed), createdAt, updatedAt
  unique(owner, active-state) 由服务事务保证

StoryCollection
  id, owner, conversationId(unique), title, titleSource(ai|fallback|user),
  favoritedAt, deletedAt, createdAt, updatedAt

StoryWork
  + collectionId, position
  unique(collectionId, position)
  unique(collectionId, sourceMessageId)

ChatMessage
  + conversationId
  unique(conversationId, position)
  unique(conversationId, messageId)

StoryAudioAsset
  id, workId, version, contentHash, voiceId, ttsProfileHash,
  status, storageKey, contentType, byteLength, durationMs, checksum,
  leaseId, leaseExpiresAt, lastAccessedAt, readyAt, supersededAt
  unique(workId, version)
  index(status, lastAccessedAt)
```

### 首作建集与标题

Promotion 输入必须携带 `conversationId + sourceMessageId + storyText + prompt + voiceId`。验证 ownership 和 Artifact complete 后：

1. 集合不存在时在事务外短超时生成 AI 标题；失败走严格正文标题 → prompt 摘要 → `未命名作品集`。
2. 事务内按 `conversationId` upsert Collection，并以 `sourceMessageId` 幂等创建 Work。
3. position 在集合内事务分配；同 source + 同 hash 返回既有 Work，不同 hash 返回 CONFLICT。
4. AI 标题只生成一次；用户重命名后 `titleSource=user`，自动流程不得覆盖。

## 3. API

```text
conversation.getActive / get / createNew / saveSnapshot / close
collection.list / get / rename / setFavorite / softDelete / restore / deleteForever
storyAudio.ensure({ workId, sessionId }) / getProjection
GET /api/audio/assets/:assetId
```

`conversation.createNew(expectedOldId)` 关闭旧 active Conversation 并创建新 UUID，不删除旧 Collection。Collection list 返回轻量 Summary；详情按 Work position 返回成员。搜索命中 Work 时仍按 Collection 去重。

集合永久删除级联 Work、进度与音频元数据，并通过 deletion outbox 删除对象。软删除集合后，详情、播放授权和连续创作均 fail closed。

`storyAudio.ensure` 不接受 segmentIndex；同一资产 identity single-flight + lease fencing。identity 为 contentHash、voice、provider/model/synthesisVersion、format；播放速度不进入 identity。

## 4. 单音频合成、进度与缓存

长文本允许内部安全分块：

```text
text chunks → TTS chunks → format validation → concatenate/remux
            → duration/checksum → atomic publish one asset
```

内部 chunk 不授权、不独立播放、不写进度、不刷新 TTL。任一 chunk 失败则整个 Asset failed，并清理临时对象。

播放进度改为 `workId + positionMs + durationMs + completedAt + sessionId`。每 10 秒节流写，暂停、页面隐藏、切曲和结束立即写；服务端以 sessionId 与单调位置守卫。旧 paragraph anchor 不猜测换算成秒，迁移时安全归零。

ready Asset 使用 30 天滑动 TTL；授权读取限频刷新 `lastAccessedAt`。GC 跳过 playing/preparing/有效 lease，删除二进制但保留 Work、Collection 和进度；再次播放按原 profile 重建。

## 5. 客户端状态机

`chatStore` 增加 `conversationId / collectionId / collectionTitle / epoch`。所有 generation、promotion、audio 和 continuation 回调必须携带 conversationId + epoch，不匹配只清理资源。

### 新建创作

唯一服务 `startNewCreation()`：

1. 对草稿、在途生成、未保存 Artifact 做确认。
2. 先 `epoch++` 使旧回调失效。
3. abort generation、promotion、continuous job、audio ensure。
4. pause + unload audio，revoke Blob，clear Playback Session/Anchor。
5. reset preload/generation/Now Playing/message runtime。
6. `createNew(expectedOldId)`，初始化空会话。
7. 连续创作默认 enabled；复制设置页播放时长为本次 `budgetMs` 快照。

远端失败时保持无声安全态并允许重试，绝不恢复旧播放。

### 连续创作

新 `continuousCreationStore` 取代旧 `preloadStore`：

```text
disabled → enabled_idle → generating_next → preparing_audio → next_ready
                                      └────→ error
current ended + not ready → waiting_next
remaining=0 → ended_budget
```

预算只在 audio 实际 playing 且非 waiting/stalled 时递减。调度条件为 enabled、预算有效、当前 track 正在播放、进入窗口、无 next job、epoch 匹配。窗口取下一作品准备耗时移动平均并 clamp 30–120 秒，冷启动 60 秒；严格 work lookahead=1。

当前 track ended 时，ready 则自动播下一 Work，否则进入 waiting_next 且不扣预算。预算耗尽、关闭、新建创作、切集合、登出、删除集合均 abort。用户手动输入优先，取消未完成自动续作。

### Playback Session

目标状态只包含 source(work/draft)、collection identity、audioAssetId、positionMs、durationMs 和 idle/preparing/ready/playing/paused/waiting_next/ended/error。删除 `prefetchNextParagraph`、`handleParagraphEnded` 和客户端 segment API。只有整 track ended 才通知连续创作。

## 6. UI

- Chat：集合标题；完整 Artifact 原位播放；连续创作开关、剩余预算和状态卡；删除 Prompt/Generation History；“清除”改“新建创作”。
- Library：顶层 Collection，详情列 Work；收藏/删除/恢复均集合级。
- Now Playing：主标题 Collection、副标题 Work、整 track timeline；显示 waiting_next 与剩余预算。
- Library 滚动容器消费共享变量 `--main-tabbar-occupied-height`、`--mini-player-occupied-height`、`--bottom-chrome-gap` 加 safe-area。变量由 MainChrome 提供；禁止最后卡片固定 margin。

## 7. 迁移与退役

采用 expand → backfill → switch reads → contract：

1. 新增表与 nullable FK。
2. 当前 ChatMessage 快照进入一个 legacy Conversation。
3. 既有 Work 默认一 Work 一 Collection；只有可靠 conversation/sourceMessageId 证据才合并，禁止按时间猜测。
4. 切新读写并验证 ownership、数量和孤儿。
5. Prompt History 不迁移；删除表前先停止写入并清理客户端 key。
6. Generation History 旧 router/store/DTO 退役；StoryWork 物理表重命名单独评估。
7. 新 AudioAsset 验收后再移除旧 Segment；对象经 outbox 清理。

终局产品代码禁止 PromptHistory、generationHistory store/router、HistoryPanel、客户端 StoryAudioSegment、nextParagraphIndex 和 legacy AUTO_CONTINUE_PROMPT orchestration。migration 与 archived docs 可 allowlist。

生产 backfill、contract migration、物理删除分开发版且另需授权。

## 8. 测试与完成门

- L1：标题、DTO/cursor、continuous state machine/预算/lookahead、asset identity/TTL/progress、bottom inset。
- L2：User/Guest ownership、首作并发晋升、backfill、chunk 合并单 Asset、lease/stale/GC、createNew guard、集合级联。
- L3：同会话多 Work 单 Collection；一 Work 一 timeline；连续创作默认开并到预算耗尽；新建创作强重置；Mini 安全区；History 消失。

每个场景先写 `docs/e2e` 并登记 Catalog；先 RED 后 GREEN。最终门：

```bash
yarn test:catalog
yarn lint
yarn tsc --noEmit --incremental false
yarn test:unit
yarn test:integration
yarn test:tooling
yarn test:browser
yarn build
git diff --check
```

回滚点保留在 read switch 与 AudioAsset feature flag；contract migration 最后执行。本任务测试严禁生产端口和共享数据库。
