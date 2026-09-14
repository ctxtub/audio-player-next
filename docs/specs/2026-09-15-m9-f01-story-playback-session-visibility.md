# M9-F01 Active Playback Session Visibility Closure（2026-09-15）

- 分支：`feat/story-library-upgrade-20260912`；起点 `parent=8761135b50bc0cd3bcd5f54dc7aa1ae1e5eac51a`（已核对 `HEAD == origin` 且干净树）。
- 状态：M9-01~M9-04 CLOSED/FROZEN；M9=HOLD；唯一 blocking=M9-F01（本 spec）。
- 本 spec 为新增 dated plan，不改写任何已发布历史 spec/doc 的既有事实陈述。

## 1. 问题（已独立确认的 invariant 破口）

用户已听到故事（Transport 播放中），但 `PlaybackSessionStore.source=null / status=idle`
→ Mini 不存在 → Expanded 不可达。Mini 冻结公式 `source !== null && status !== 'idle'`
正确、不允许修改。必须恢复全局 invariant：

> 任何用户可感知的故事播放开始时，都必须已经存在正式 Playback Session。
> 不得再出现 `Transport.isPlaying === true && PlaybackSessionStore.source === null`。

根因：Legacy/历史 StoryCard 与 Generation History 仍有直接调用 Transport
（`playbackStore.playAudio()`）的用户播放入口，`playbackStore` 已实际播放，
但从未建立 Playback Session。

## 2. Ownership（冻结边界内）

- `PlaybackSessionStore` = Session SSOT（唯一事实源，不动）。
- `playbackStore` = Transport only（仍是正式 Transport API，可由 Session/Flow 调用；
  禁止业务 UI 直接把它当“播放故事”领域入口）。
- Mini 显隐公式不动；Mini 不得读 Transport 作为第二存在性来源。
- M5 source union（`draft | work`）不动；M8 canonical audio contract 不动；P3B 不实现。
- 不恢复 `FloatingPlayer` / `playbackProgressStore` / 旧 `/player` 页面 /
  `getProgress|saveProgress|clearProgress`。
- `AudioControllerHost` 继续是唯一 `<audio>` owner（设置页试音用自有 `new Audio`
  播固定一句话，非故事入口，本项不碰，见 §7 审计表）。
- `replay-text-*` 永不成为持久 Draft identity；legacy `part.audioUrl` 无 segment
  identity，不得当 paragraph 0 播放（否则整篇播完继续推 paragraph 1 造成重播）。

## 3. 设计

### 3.1 Flow 新增三个正式入口（`app/services/playbackSessionFlow.ts`，唯一播放决策面）

- `buildStoryCardDraftMetadata({messageId, storyText?, title?, voiceId?})`
  集中构造 Draft begin metadata：canonical resolver
 （`resolvePlaybackDraftSnapshot(messageId)` Modern-first→Legacy-fallback）优先，
  卡片自带 `storyText` 仅为 fallback；`normalizeStoryText` → `segmentStoryText`
  → `computeStoryContentHash`；`totalParagraphs = max(1, paragraphs.length)`；
  `title = 显式 ?? snapshot.title ?? deriveDraftTitle(首行≤60字)`；
  `voiceId = 显式 ?? config`；`speed = config`；失败一律 fail-closed 返回 null。
  不新增 StoryCard metadata SSOT。
- `playStoryCard({messageId, storyText?, title?, voiceId?})` 决策树（全部读 Session SSOT）：
  - 非法 messageId（空/`replay-text-*`）或无可用正文 → fail-closed no-op；
  - same Draft（`source.kind==='draft' && messageId` 相等）：
    `playing` 或 transport `isPlaying` → 正式 `pause`；
    `ended` 或 `next >= total` → 正式 `restart`（M5 restart 契约：新 sessionId）；
    否则（ready/paused/error，含合法断点 `0<next<total`）→ `resumePlayback()`，
    保持 `sessionId` 与 canonical `nextParagraphIndex`，TTS 只合成 `paragraphs[next]`；
  - 无 Session 或另一张卡 → `beginPlayback({source:{kind:'draft',messageId},
    mode:'restart', draftSnapshot})`（restart+新 UUID 对 server 恒合法，见 §4），
    随后 source-match 守卫（防切卡竞态）→ `playParagraph(next,{explicit:true})`。
    Session 在第一次 `Transport.play` 之前已存在（begin→hydrate 同步落 source，
    `playParagraph` 起播）。
- `playWorkFromHistory(workId)`：`isValidWorkId` 否则 fail-closed；same Work 走
  pause/resume/restart 同构树；否则 `beginPlayback({source:{kind:'work',workId},
  mode:'restart'})` + source-match 守卫 + `playParagraph(next,{explicit:true})`，
  finite（不触发 AI continuation）。“回放”语义 = 从头有限重播。
- `autoplayDraftStory({messageId, storyText, ...})`：生成完成后 autoplay 专用，
  恒 fresh-restart + `playParagraph(0,{explicit:true})`（transport 可能残留旧轨道，
  非 explicit 会被 H-07 窗口守卫拦截）。调用方（chatFlow）先 `flushPendingSave`
  再 begin（Draft begin 要求 ChatMessage 行存在）；旧整篇 blob 吊销丢弃——
  不得当 paragraph 0 播放（§2 同理）。
- 三个入口 post-begin 均有 source-match 守卫：
  `begin` 返回后若当前 source ≠ 请求 source， abort（新切换已落地）。
- **串行临界区 + 请求代（本次实现新增，必须保留）**：`beginPlayback → hydrateFromAnchor`
  直接 `set({source})` 且 store 水合为「最后写入者胜出」（`hydrateFromAnchor` 不 bump
  `hydrationEpoch`），并发 begin 会让旧请求晚到的 hydrate 覆盖新 source。因此
  `playStoryCard` / `playWorkFromHistory` / `autoplayDraftStory` 的「决策 + begin」
  统一经 `runSerialized`（单一 promise 链）执行，并以单调递增 `playRequestSeq`
  判定最新意图：进入临界区时 token 已过期→放弃；begin 后 token 过期→abort 不 play。
  起播 `playParagraph` 在临界区**之外**经 `playPlanned` 二次校验（`sessionId` +
  `isCurrentSource`），故切卡不必等待旧卡在途 TTS；旧卡 TTS 晚到由 store
  `originatingSessionId` 守卫丢弃。语义 = 最终 source/声音属于最后一次用户操作，
  且不存在双路 begin 抢写。

### 3.2 UI 迁移

- `StoryCardPart`：删除 `resume/part.audioUrl/playStoryText` 自有决策与
  `onPlayStory(part.audioUrl)` Transport shortcut；`handlePlay` 只交
  `{messageId, storyText}` 给 `playStoryCard`（`audioUrl` 根本不传入 Flow，
  第一版不复用旧音频缓存：identity/segmentation 正确 > 复用缓存）。
  按钮态保留：`isThisCardPlaying = sameDraft && transport.isPlaying`
 （presentation 读 Transport 允许；存在性仍只看 Session）。
- `ChatLayout`：删除 `handlePlayStory` + `playAudio` ownership；
  `MessageArea→ChatLog→MessageBubble→MessageParts(+TextPart)` 的 `onPlayStory`
  链整体删除（StoryCard 是唯一消费方，TextPart 仅透传未用）。
  唯一保留的 Transport 直用是发送前的 `usePlaybackStore.ensureUnlocked()`
  （音频解锁，非故事播放决策，不选音源；不构成第二播放入口）。
- `GenerationHistory`：`handleReplay` 改调 `playWorkFromHistory(record.id)`。
- `chatFlow` autoplay：`startStoryPlayback(assistantMessageId, pendingAudioBlob)`
  改为 flush → `autoplayDraftStory` → 吊销 blob。
- `storyFlow` 删除 dead 故事入口：
  `startStoryPlayback` / `synthesizeAndPlayOnce` / `replayGeneration` /
  `playStoryText`（迁移后无产品调用方）及仅服务它们的 import；
  保留 `shouldYieldToPlaybackSession` + `handleNearEnd`/`handleSegmentEnded` +
  `handlePlaybackStart/Pause` + `updatePlaybackProgress` + `resetStoryFlow`
 （无会话 legacy 传输锁 dead-compat；Host 经 Flow 间接触达，无 UI 可达路径，
  由 L1 静态 oracle 锁定“产品代码 `playAudio` 调用点 ⊆ SessionStore”证明不可达）。

### 3.3 Draft identity / segmentation 一致性

- `source = {kind:'draft', messageId}`（稳定真实 messageId；禁 `replay-text-*`）。
- `Session.paragraphs.length === Session.totalParagraphs`（hydrate 本地按同一
  canonical 重算；server `draftSnapshot.totalParagraphs` 与 Flow 同源计算，
  漂移则 hydrate fail-closed/drift-reset，L2 锁定）。

## 4. Server 契约（复用，不改动；Flow 侧写法服从以下既有守卫）

- `assertValidBeginSessionTransition`：same source + resume + 换 UUID → BAD_REQUEST
 （故“同卡续播”永不 begin，只 `resumePlayback`；“新卡/无 Session”恒用 restart+新 UUID）。
- Draft begin 要求 ChatMessage 行存在（autoplay 前 flush；StoryCard 卡片即历史行）。
- Work begin metadata 以服务端 StoryWork 为准（client 不得带 draftSnapshot）；
  `record.id` 即 Work id（`StoryWork @@map("GenerationHistory")`，DTO 直透行 id；
  guest 走 Guest 表，subject 由服务端从会话推导，client 只传 workId）。

## 5. 竞态

- 切卡（A 在途 TTS → 点 B）：B begin（新 sessionId）→ B hydrate 落 source=B →
  A 的 `playParagraph` 以 originatingSessionId 校验丢弃（revoke，不抢 Transport）；
  A 的 post-begin source-match 亦 abort。Mini title/source 终态 = B。
- 同卡双击：两次 begin 串行，后者胜，前者 source-match abort + TTS stale 丢弃；
  单 `<audio>` 元素保证只有一路声音（连击终态=最后一次操作，满足既有 02-05 契约）。
- 同卡“播放中点暂停”：`pausePlayback`（transport 逻辑停 + 物理停 + checkpoint）。
- ended 重播：`restart` 产生新 sessionId（M5 §30），从 `paragraphs[0]` 起播。

## 6. 测试契约

- L1（重写 `tests/unit/playback/storycard-session-resume.unit.test.ts`，删除
  “legacy fallback 后 source 仍 null”错误 oracle）：A 无 Session+legacy audioUrl→
  新 Draft Session（messageId/seg/hash/total 对齐，先 Session 后 audio，Mini 可见，
  且实际播放 URL ≠ legacy URL）；B 纯 storyText→TTS 输入=`paragraphs[0]`；
  C next>0 断点→同 sessionId 从断点段 resume；D1 A 在途 TTS→B 获胜+A 丢弃；
  D2 旧 begin 晚到→不 play（source 仍 B）；E History→`{kind:'work',workId}`+finite
  +audio+`/library/{id}` 目标；F ended→restart 新 sessionId 从 0 起播；
  G 同卡播放中→pause；H 静态审计（storyFlow/ChatLayout/StoryCard/History 无
  Transport 故事入口；产品 `playAudio` 调用点 `deepStrictEqual
  ['stores/playbackSessionStore.ts']`）。fake controller 每次 `play()` 断言
  `source!==null && status!=='idle'`（播放时刻 Session 先在，见
  `installSessionGuardedController`）。
- L2（新增 `tests/integration/playback/storycard-session-flow.integration.test.ts`，
  真实隔离库 + 真 server fn + 真 hydrate/segmentation；client 仅桩到真 server）：
  A legacy 卡（含 audioUrl）→ Flow 建 Draft Session，server Anchor draft/messageId、
  hash/total 对齐，TTS=`paragraphs[0]` 且播放 URL≠legacy；B `replay-text-*`
  fail-closed（不 begin/不落 Anchor）；C server 门：同 source 新 UUID resume、
  同 UUID restart 均 BAD_REQUEST，新 UUID restart 接受；D Work 切换两次 begin
  最终收敛最后一次；E 同 Work 出声中→pause（sessionId 不变、不合成），断点位
  resume→sessionId 不变、只补合成断点段。
- L3（新增 `tests/system/browser/scenarios/story-playback-global-controls-reachable.spec.ts`，
  chromium+webkit，retries=0，不预置 Session、不合成媒体事件）：
  用例 1 真实创作后经隔离库把 assistant 行改写为 Legacy `storyCard`（`audioUrl`
  有值/空串两种形态），清 Anchor 冷态刷新→点击真实“播放故事”→**同帧** oracle：
  `<audio>` 真实推进 + `[data-testid=mini-now-playing]` 可见 + `data-status=playing`
  + 音源为 provider 合成产物（`blob:`/`data:audio*`，legacy URL 未被播放），
  并轮询真 server Anchor=`draft`；
  用例 2 真实 History UI「回放此故事」→ Anchor=`work` 且 `sourceId`=该 Work id +
  同帧 audio+Mini playing。不放宽 timeout、不弱化“audio+Mini 同时成立”。
- 受影响旧测试同步（行为已按本 spec 合法变更）：
  `playback-runtime-orchestration`（legacy synth 段改 assert Flow/Store 守卫）、
  `legacy-cutover` M4-08-04（StoryCard 点击改走 Flow）、`artifact-chat-ui`
 （dispatcher/legacy 接线改无 onPlayStory）、`history-ui-relocation`
 （`replayGeneration(record)`→`playWorkFromHistory(record.id)`）、
  `artifact-module-closure`（`playStoryText` 保留断言→Flow 入口断言）。

## 7. 全入口审计清单（结论）

| 入口 | 结论 |
|---|---|
| StoryCard（audioUrl 有/无） | 已迁移 `playStoryCard` |
| Generation History 回放 | 已迁移 `playWorkFromHistory`（work source） |
| `startStoryPlayback`（autoplay） | 已迁移 `autoplayDraftStory`，函数删除 |
| `playStoryText` / `synthesizeAndPlayOnce` | dead，删除 |
| `replayGeneration` | dead（History 已迁），删除 |
| ChatLayout `handlePlayStory` + `onPlayStory` 链 | dead ownership，删除 |
| 设置页试音（固定一句话，自有 Audio） | 非故事入口，保留（既有 PLANNED case 覆盖双声源已知态） |
| `storyFlow.handleNearEnd/Ended` + Flow no-session 分支 | 无 UI 可达（静态锁定），dead-compat 保留 |
| Mini/Expanded 按钮（pause/resume/restart） | 已在 Flow 内（`useMiniPrimaryAction`/Expanded controls），不动 |

## 8. 目录/文档

- 新增 `docs/e2e/03-播放状态与内核一致性/13-故事播放全局控制可达.md`；
  最小更新 `02-…-11`（E2E-02-11-02 改 work-session 语义）、
  `03-…-10`（实现参考改 Session Flow）、`02-…-05`（实现参考改 Flow 入口）；
  `09-…-03`（M9-03 历史事实不改写，仅加 2026-09-15 后续演进导引）。
- `tests/test-catalog.yaml`：新增 case `story-playback-global-controls-reachable`
  （ACTIVE，executables 含 L1/L2/L3 新绑定）；`generation-history-play-once`
  追加新 L3 executable（回放语义升级仍被覆盖）；新增 executables
  `exec-storycard-session-flow`（L2）、`exec-l3-story-playback-global-controls`（L3）。
- `scripts/run-tests.mjs` SUITES 注册新 L2。

## 9. 门禁与交付

`test:catalog / lint / tsc --noEmit --incremental false / test:unit /
test:integration / build / git diff --check` + 新 targeted browser
（chromium+webkit）；条件允许追加 `test:browser` 全量（历史 debt 单列 baseline，
不顺手修 M10）。单一原子提交 `fix(M9-F01): route story playback entries
through PlaybackSessionFlow` 后 push 仅工作分支。

## 10. 剩余风险（诚实登记）

- autoplay 改走 draft session：每次生成完成新增 1 次 begin + para0 TTS
  （旧整篇 blob 废弃），首播延迟与 TTS 成本上升；若 `flushPendingSave` 失败
  则静默无 autoplay（fail-closed，聊天持久化本身亦已失败）。
- History 回放改 restart 语义：显式回放从头开始并重置该 Work 进度锚点
  （completedAt 保留）；旧 one-shot“不碰进度”语义不再保留。
- L3 种子 legacy 卡经 DB 定向写（fixture 手段），与“用户亲手生成 legacy 卡”
  不等价——L1/L2 覆盖 Flow 真实迁移，L3 覆盖真实 UI 点击 + 真实 Session/音频链。
