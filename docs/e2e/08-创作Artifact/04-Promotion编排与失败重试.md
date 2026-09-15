# Promotion 编排 / 失败 / 中断治理

功能域：08-创作Artifact

## 用户目标

故事正文 `complete` 后自动进入作品 promotion 编排（`complete → startPromotion() → promoteStoryArtifact() → ready / promotion_failed`）：成功绑定作品并可读，失败保留完整正文与快照并支持只重发入库的重试；任何 stale promotion 结果与中断事件都不得污染当前会话。

## 范围与边界声明

本场景限定于 Chat 编排层的 promotion 自动触发、失败语义、幂等重试与 stale/中断治理（由 L1 单元测试直接断言），严格限定于编排层。

**包含的职责**：
- `story_complete` 同步推进 `draft → complete → promoting` 并 kick 唯一一次 `library.create`；成功回写 `ready(storyWorkId)`，失败回写 `promotion_failed`
- stale 归属：`assistant message id ＋ transient promotionToken` 双重归属（token 仅为客户端 async race guard，不进持久领域模型）；epoch 作废 `resetChat` / `reset` / `resetActiveSession` 之后到达的旧结果
- 两条正交状态机：`stream fail/abort before complete → interrupted` 且 `create ＝ 0`；`complete` 后 promotion 在途时，后续 `done/fail` 不得把 `promoting/ready` 倒退为 `interrupted`
- 失败语义：`promotion_failed` 保留完整 `storyText` / `sourceMessageId` / `prompt` / `voice` 快照；delivery 不动；不重生成、不换 `sourceMessageId`、不自动重试
- 幂等重试：`promotion.retry` 仅 `promotion_failed` 可用，只再次 `library.create`（同一 messageId 在途去重，快速双击只发一次），绝不触达 generation transport
- CONFLICT 保持明确 failure：不自动换 `sourceMessageId`，不重新生成

**显式排除以下能力**（留后续模块，不在本场景声称）：
- Artifact UI 的最终视觉（`promotion_failed` 的「保存失败，可重试保存」展示归 M4-05；本项只提供 `promotion_failed` 状态与 `promotion.retry` 入口作为 UI 基础）
- 播放预接与音频可用性（StoryArtifactPart 播放预接问题留 M4-05）
- promotion adapter 自身的映射/幂等（归 E2E-08-03）与 M2 幂等键语义

## 契约验收标准

### 1. 成功编排（exactly-once kick → ready）
- `story_complete` → 恰好一次 `library.create`（frozen 五字段）→ `ready(storyWorkId)`，`sourceMessageId` 恒为该 assistant message id。
- 重复 `story_complete` / 后续 `done` 不产生第二次 promotion。

### 2. 失败保留全部快照
- promotion reject → `promotion_failed`；`storyText` / `sourceMessageId` / `prompt` / `voiceId` 全保留，`error` 记录；ChatMessage delivery 不置 `failed`；不重生成、不换源、不自动重试。

### 3. 重试只重发入库
- `promotion.retry` 仅 `promotion_failed` 可用；重试只再次 `library.create`（input 与首次一致），不新建 assistant 消息、不触达 generation transport；成功 → `ready` 且 `sourceMessageId` 不变。
- 两次快速 `promotion.retry` 最多一个 in-flight create。

### 4. stale promotion 零污染
- Attempt A `complete → promotion A pending`；generation retry 建立 Attempt B（A 被替换）→ promotion A 后到的 success/reject 一律 no-op：不把 B 改 `ready`、不把 StoryWork A 绑到 B、不复活 A。
- `resetChat()` / `reset()` / `resetActiveSession()` 之后到达的旧 promotion resolve/reject 一律 no-op。
- 归属判定不得只看 `sourceMessageId` 找到就写回；必须确认目标消息当前 Artifact 仍是该次 promotion 对应的 `promoting` generation（`status === 'promoting'` 且 `sourceMessageId` 一致，且 token/epoch 匹配）。

### 5. 中断边界正交
- `stream fail/abort before complete → interrupted`，且 `library.create` 调用次数为 0。
- `complete` 后 promotion 在途（`promoting`）或已 `ready` 时，后续 `stream done/fail` 不得倒退为 `interrupted`，不得取消在途 promotion。

### 6. 冲突明确失败
- CONFLICT（同 `sourceMessageId` 异文）→ `promotion_failed`（error 含 CONFLICT），不自动换 `sourceMessageId`，不重新生成，调用次数不增加。

### 7. 静态架构纯净度守卫
- 编排经唯一通道调用 adapter（`promoteStoryArtifact`），严禁直调 `library.create`、严禁 import `lib/server/*` / `prisma` / generation transport（`agentFlow` / `chatFlow` 的生成路径）。
- `stores/chatStore` 不得出现 `library.create` / `storyArtifactPromotion` 直引（经 `chatPromotionOrchestration` 薄编排层）；`app/services/chatFlow` 不得新增 promotion 直调。
- M2 facade 保持 frozen：不得新增 `promoteArtifact` procedure。
