# Legacy Compatibility Containment / Artifact Boundary Cleanup

功能域：08-创作Artifact

## 用户目标

Legacy StoryCard 继续可读、可渲染、可兼容播放，但所有客户端 Legacy 结构知识被限制到显式 compatibility boundary；现代 Artifact state/store/promotion/UI 不再直接认识 storyCard，M4-06 History 与 M4-08 provenance 语义零变化。

## 范围与边界声明

本场景限定于客户端 Legacy 读逻辑的结构收敛（M4-09 功能里程碑）：只搬运所有权与建立防线，不改任何产品行为。

**包含的职责**：
- 新增唯一 client-side Legacy compatibility module（`lib/client/chatStoryCompatibility.ts`）：纯函数，只依赖 Chat types；收口 `decodeLegacyStoryCard / hasLegacyStoryCard / hasAnyStoryPart / hasStoryContent / findLegacyPlayableStoryCard`，语义与 M4-08 前逐字等价
- `decodeLegacyStoryCard` 从 `lib/client/chatArtifactState.ts` 迁出：前者回归 Modern lifecycle only（无 `storyCard / StoryCardPart / decodeLegacyStoryCard`），后者为 Legacy read compatibility；校验（object / `storyCard` / 非空 storyText / string audioUrl → 否则 null）逐字不变
- `stores/chatStore.ts` 不再直读 Legacy 数据结构：Story intent 保护、`isLatestMessage / nextStorySegment / hasStoryMessages` 全经 helper；`StoryCardPart` import = 0、wire 字面量 = 0；Story intent 遇历史卡不覆盖行为保留
- 过期 migration 注释事实修正：`pendingAutoSend` 由“来自 /player 历史记录选择”改为“History UI 选择后的待发送提示词；瞬态、单 slot、不持久化”；M4-02/03/04 invariant 设计注释保留
- repo-level compatibility allowlist：生产代码 Legacy schema awareness 仅允许 approved 边界；现代核心（chatStore / chatArtifactState / promotion adapter / promotion orchestration / StoryArtifactPart / ChatLayout / History UI / Library）零直接引用；M4-08 writer-purity（不能 create Legacy）与 M4-09 allowlist（不能随意依赖 Legacy）双防线并存

**显式排除以下能力**（留 M4-10 或更后，不在本场景声称）：
- transport-level fallback 改动：`findAssistantIndexById` 缺 id 回退、`stream.delta / finish / fail / abort` optional messageId 全保持（非 StoryCard Legacy 同一概念）
- 类型删除：`StoryCardPart / MessagePart` 联合 / `isStoryCardPart / extractTextFromParts` 全保留；History codec 不注入 decoder、不收紧校验、不转 Artifact/StoryWork
- 服务端重构：`lib/server/chatConversation.ts` provenance guard（multiset subset tuple）无行为改动；不拿 client helper 去服务端复用
- 渲染/播放重构：`StoryCardPartRenderer / onPlayStory / Legacy playback CSS / MessageParts` dispatcher 全保留；不统一 `StoryPartRenderer`、不重做 Chat CSS
- 数据迁移：不删 renderer/playback/codec/guard，不做 `storyCard → StoryArtifact / StoryWork`、backfill、DB migration；不碰 Modern playback/Manifest/Session、Mini/Expanded Player、History/Library UI 再设计
- 大重构：不重写 chatStore、不重做 MessagePart 框架、不重命名公共类型

## 契约验收标准

### 1. Legacy decoder relocation parity（M4-09-01）
- 合法（`storyCard` + 非空 storyText + string audioUrl）输出与 M4-08 前完全一致；非法（null / 错 type / 空 storyText / 非 string audioUrl）全部 null；`StoryArtifact` create = 0、`library.create` = 0、promotion = 0。

### 2. Modern Artifact state module purity（M4-09-02）
- 静态确认 `lib/client/chatArtifactState.ts` 不再出现 `storyCard / StoryCardPart / decodeLegacyStoryCard`；M4-01 Artifact state regressions 全过，证明只是 relocation。

### 3. Chat store no Legacy wire knowledge（M4-09-03）
- 静态要求 `stores/chatStore.ts` 不得出现 wire 字面量 / `StoryCardPart`，只经 helper 查询；现有 Chat Store regressions 全过；transport fallback 行为保持。

### 4. Legacy Story intent preservation（M4-09-04）
- 历史 assistant（parts = [legacy storyCard]）再 dispatch `stream.intent` Story：原卡精确保留、不建 storyArtifact/StoryWork、不 promotion；metadata.agentType 按原行为更新。

### 5. isLatestMessage parity（M4-09-05）
- 覆盖 legacy / 现代 Artifact / 纯文本 / 多故事消息，结果与重构前一致；空正文现代 Artifact（exists, storyText = ''）仍按“存在 story part”语义处理，不被 `hasStoryContent` 混掉。

### 6. hasStoryMessages parity（M4-09-06）
- 覆盖 legacy → true、现代非空 → true、现代空白 → false、纯文本 → false、excludeMessageId 原行为保持；不因 helper 合并改变 exclude 语义。

### 7. Legacy nextStorySegment parity（M4-09-07）
- 序列同时存在 Legacy 可播卡 / 现代 ready Artifact / 无音频 Legacy / 第二张可播卡：只返回下一个 Legacy playable，跳过现代与空音频，storyText/messageId 精确保留；不产生 StoryWork/audio manifest 查询。

### 8. MessagePart read compatibility（M4-09-08）
- `StoryCardPart ∈ MessagePart`、`isStoryCardPart` 正常、`extractTextFromParts(storyCard) → storyText`、`extractTextFromParts(storyArtifact) → artifact.storyText`；containment 不等于从 read type system 删除 Legacy。

### 9. M4-06 History contract unchanged（M4-09-09）
- 复跑 M4-06 targeted：legacy load → storyCard、save → audioUrl = '' 且不转 Artifact；draft → interrupted、complete/promoting → promotion_failed；零语义变化。

### 10. M4-08 provenance firewall unchanged（M4-09-10）
- 重跑 M4-08 server regression：preservation PASS / new REJECT / mutation REJECT / duplication REJECT / deletion PASS / no-baseline REJECT / collision REJECT / user-guest 对称；tuple-collision fixup 原样通过。

### 11. Legacy dependency allowlist（M4-09-11，blocking）
- 生产代码 Legacy schema awareness 仅出现在 approved 边界；现代核心（chatStore / chatArtifactState / promotion adapter / promotion orchestration / StoryArtifactPart / ChatLayout / History UI / Library）零直接引用；M4-08 new-constructor = 0 继续执行。

### 12. Full M4 backward regression（M4-09-12）
- 完整复跑 M4-09 targeted、M4-08、M4-07、M4-06、M4-05、M4-04、M4-03、M4-02、M4-01、chat persistence integration（user + guest）、creation-chat unit/integration、catalog CHECK、tooling、lint、tsc、build、`git diff --check`。

## 与 M4-10 的边界

- M4-09 做结构收敛，M4-10 做模块最终验收（完整 E2E contract matrix、跨 01～09 组合、reload/retry/stale/reset/legacy 共存、user/guest persistence、Architecture invariant final audit、catalog/Evidence/docs 冻结）。
- M4-10 原则上不再主动设计新架构；暴露 bug 则修 bug，否则直接关闭 M4。

## Definition of Done（一句话）

Legacy StoryCard 继续可读、可渲染、可兼容播放，但所有客户端 Legacy 结构知识被限制到显式 compatibility boundary；现代 Artifact state/store/promotion/UI 不再直接认识 storyCard，M4-06 History 与 M4-08 provenance 语义零变化。
