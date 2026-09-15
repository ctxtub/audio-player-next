# Legacy StoryCard Cutover / Read-Compatible, New-Write Forbidden

功能域：08-创作Artifact

## 用户目标

新故事只写 `StoryArtifact`；旧 `StoryCard` 可继续读取、渲染、播放并随会话快照原样续存，但服务端永久拒绝任何此前不存在、被篡改或被复制扩增的 `StoryCard`。切流后 `storyCard` 是只读历史线格式，不再是运行时可生产的数据类型。

## 范围与边界声明

本场景限定于 Legacy writer 的死亡（M4-08 功能里程碑）：只加服务端持久化防线与回归，不做数据迁移、不做播放升级、不做 History UI 再设计、不做模块收口。

**包含的职责**：
- Modern runtime 冻结 `storyArtifact-only`：`user.submit / user.retry / stream.intent(Story) / stream.story_complete → promotion → ready` 全链零 `storyCard`（M4-08-01/02）
- Legacy reader 全保留：`StoryCardPart` 类型、`MessagePart` 联合、`isStoryCardPart`、`extractTextFromParts(storyCard.storyText)`、`decodeLegacyStoryCard`、`StoryCardPartRenderer`、`MessageParts` 的 `case 'storyCard'`（含 `onPlayStory` 透传与共享 playback CSS）、chat selectors（`isLatestMessage / nextStorySegment / hasStoryMessages`）、`stream.intent` 的 Legacy 只读识别（M4-08-03/04）
- M4-06 History codec 原样冻结：`serializePartsForHistory`（storyCard clone + `audioUrl=''`）与 `rehydratePartsFromHistory`（storyCard 浅 clone 透传，不转 `StoryArtifact`、不删 Legacy）一字不改（M4-08-05）
- 服务端 Legacy provenance guard（`lib/server/chatConversation.ts`）：纯辅助 `assertNoNewLegacyStoryCardWrites(currentRows, incomingMessages)`，fingerprint = `messageId + storyText + occurrence count`（multiset subset，不含 `audioUrl`）；事务内、`deleteMany` 之前执行；顺序冻结 `load current → assertFreshBaseline → provenance → replace`；`baseline` 可选但 guard恒为 always-on；user / guest 共用同一 helper；写入统一 sanitize Legacy `audioUrl → ''`（M4-08-06/07/08/09/10）
- 架构纯度静态回归：生产代码 Legacy 对象构造仅允许 allowlist 的 compatibility decoder（`decodeLegacyStoryCard`），reader 引用保留不删（M4-08-11）

**显式排除以下能力**（留后续模块，不在本场景声称）：
- Legacy 删除/migration/backfill：`storyCard → StoryArtifact / StoryWork / Library`、补 `sourceMessageId`、建 prompt/voice 快照、后台批量迁、打开时 lazy migration、保存时 opportunistic migration、DB migration 改历史（Legacy 在 M4-08 后依然是 Legacy）
- 播放现代化：Modern `StoryArtifact ready` 不因此获得播放按钮/Manifest/Playback Session/Mini Player/Expanded Player（归 M6/M7）；Legacy 旧 playback 原样保留
- History UI 再设计：不删 GenerationHistory、不改 Prompt History、不并入 Library、不移动 History 入口（M4-07 已 CLOSED）
- 最终模块 cleanup：不大规模重命名 StoryCard CSS、不删 legacy comments、不重构 MessageParts 框架、不统一 Chat/Library 视觉、不删 generationHistory 模型、不重写 playback selectors
- 行为性修改冻结边界：`lib/client/chatArtifactHistory.ts`、`lib/client/chatArtifactState.ts`、`types/chatArtifact.ts`、`lib/client/storyArtifactPromotion.ts`、`lib/client/chatPromotionOrchestration.ts`、`StoryArtifactPart.tsx`、`StoryCardPart.tsx`、promptHistoryStore、generationHistoryStore、Library API/M2 facade、Prisma schema

## 契约验收标准

### 1. Modern fresh Story produces zero storyCard（M4-08-01）
- 完整走一次 `user.submit → stream.intent(Story) → delta → story_complete → promotion → ready`，最终所有新 message parts 中 `storyCard count = 0`、`storyArtifact count = 1`。

### 2. Retry remains Modern-only（M4-08-02）
- generation retry（failed attempt → `user.retry`）新 assistant 为 `StoryArtifact draft`，绝不出现 `StoryCardPart`；随后 complete / promotion 仍正常。

### 3. Legacy persisted read compatibility（M4-08-03）
- 预置旧服务端数据（`assistant old-1`，`storyCard{storyText:"legacy story", audioUrl:"old-url"}`），`initForUser` 口径恢复后 `type === storyCard`、`storyText` 精确保留；不得出现 `StoryArtifact / StoryWork / promotion / library.create`；`isStoryCardPart / extractTextFromParts / decodeLegacyStoryCard` 只读铁律成立。

### 4. Legacy renderer remains usable（M4-08-04）
- 真实渲染历史 `storyCard`：`storyText` 可见；长正文「查看全文」有效且展示完整正文；playback action 存在；有 persisted `audioUrl` 时沿旧 `onPlayStory` callback；`audioUrl` 为空时走按正文重合成兼容路径（携带真实 `messageId`）。

### 5. Existing Legacy may round-trip（M4-08-05）
- DB 先存在 `old-1 + storyCard("legacy")`；客户端保存 `old-1 + storyCard("legacy", audioUrl="")` + 新 Modern `storyArtifact` 消息必须成功；保存后 old-1 仍是 `storyCard`、Modern 仍是 `storyArtifact`。

### 6. New Legacy origination rejected（M4-08-06，blocking）
- DB 此前没有 `message new-legacy` 时直接 server save（`parts=[{type:'storyCard',...}]`）必须以 `BAD_REQUEST`（非 `CONFLICT`）拒绝，且 DB snapshot 完全未变化；不依赖客户端静态 guard；user / guest 对称。

### 7. Legacy mutation / duplication rejected（M4-08-07）
- DB 为 `A → storyCard("OLD") × 1` 时：`A → "NEW"` 拒绝、`A → "OLD" × 2` 拒绝、跨消息复制拒绝；但 `A → 0 张`（删除）必须允许；多消息 multiset 部分删除允许。证明规则是 multiset subset 而非“messageId 曾经有过 Legacy 就随便写”。

### 8. Legacy audio persistence normalization（M4-08-08）
- DB 旧数据 `audioUrl="https://temporary..."`，现代客户端续存 `audioUrl=""` 必须视为同一张卡、保存成功；最终 user / guest DB 写入 `audioUrl` 均为 `""`。

### 9. No-baseline writer still blocked（M4-08-09，blocking）
- 直接调用 `saveConversation(messages)` 不提供 `baseMessageIds` 仍尝试新 `storyCard` 时必须拒绝；旧客户端/手写请求不是 cutover 绕过通道；user / guest 对称。

### 10. User / Guest symmetry（M4-08-10）
- 同一组 case（preservation PASS / origination REJECT）分别跑 user / guest 结果一致；guest keep-limit（120 → 100）既有行为不被破坏；cap 淘汰旧卡允许。

### 11. Architecture writer purity（M4-08-11）
- 生产代码（`app/**`、`lib/client/**`、`stores/**`、`components/**`）中 `{type:'storyCard'}` 对象构造仅允许出现在 allowlisted read boundary（`decodeLegacyStoryCard`）；显式不测试“源码零 storyCard 字符串”（reader 必须保留），只禁“能新产生 storyCard 的业务路径”。

### 12. Full compatibility / frozen-boundary regression（M4-08-12）
- 全量复跑 M4-08 targeted、M4-07、M4-06、M4-05、M4-04、M4-03、M4-02、chat persistence integration（user + guest）、creation-chat unit/integration、catalog CHECK、tooling、lint、tsc、build、`git diff --check`；静态确认 `chatArtifactHistory.ts` 语义 diff 为 0、M2 facade 语义 diff 为 0、StoryCard renderer 仍存在、`storyCard` MessagePart 联合仍存在、Modern 生成 writer count 为 0。

## 与 M4-09 / M4-10 的边界

- M4-08 不删除任何 Legacy reader；后续 cleanup/deprecation 必须建立在明确的数据淘汰/兼容策略之上，不得被本项顺手提前做掉。
- M4-08 不做 migration/backfill、不做 playback modernization、不做 History UI 再设计、不做最终模块 cleanup/closeout。

## Definition of Done（一句话）

所有新故事都只能写 `StoryArtifact`；旧 `StoryCard` 可以继续读取、渲染、播放并随 conversation snapshot 原样续存，但服务端以 persisted provenance 为依据，永久拒绝任何此前不存在、被篡改或被复制扩增的 `StoryCard`；整个 cutover 不转换 Legacy、不删除 Legacy reader、不改 M4-06 codec，也不触碰 Modern playback。
