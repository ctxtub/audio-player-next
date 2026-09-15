# Story Artifact Promotion Adapter 与幂等消费

功能域：08-创作Artifact

## 用户目标

Chat Artifact 完成（`complete`）后经唯一的薄 promotion 通道正确映射并消费 M2 幂等保障落盘为 StoryWork：生成开始时的 prompt/voice 快照冻结可用、重复提交幂等返回同一作品、冲突原样上抛、非法内容 fail-fast 且绝不绕过冻结门面。

## 范围与边界声明

本场景限定于「CompleteChatArtifact → Promotion Adapter → `libraryClient.create(...)` → StoryWorkDetailDTO」的纯 I/O 映射层（由 L1 单元测试直接断言），严格限定于 promotion 适配层。

**包含的职责**：
- 仅接受 `complete`（初次）与 `promotion_failed`（幂等重试源），构造 frozen `LibraryCreateInput` 后透传 `libraryClient.create`
- 三个输入来源冻结：`prompt`（本次生成开始时的 user prompt snapshot）、`voiceId`（本次生成开始时的 voice snapshot，严禁 promotion 时重读当前 Settings）、`sourceMessageId`（`artifact.sourceMessageId`，即 assistant `message.id`）
- 快照 plumbing：`user.submit` 把本次 `action.content` 写进 draft 的 `prompt`；voice 快照从实际生成请求所用 voice 来源取得并冻结进同一 draft；`retry` 重建新 assistant/sourceMessageId 但新 attempt 携带正确的 prompt 与本次实际 voice 快照
- M2 幂等消费：同源同文返回同一 StoryWork（adapter 不自造 client-side idempotency key）；同源异文 `CONFLICT` 原样上抛
- 非法输入 fail-fast：`draft` / `interrupted` / `ready` / `promoting` / Legacy `StoryCard` 一律拒绝且 `library.create` 调用次数为 0
- 静态纯净：adapter 仅消费冻结的 `libraryClient.create`，不 import server/Prisma/raw trpc

**显式排除以下能力**（留后续模块，不在本场景声称）：
- 自动触发 promotion 与状态机推进（`complete→startPromotion()→adapter→markPromotionSuccess/Failed` 的 orchestration 归 M4-04；本步 adapter 不改 Artifact 状态）
- M2 facade 新增 `promoteArtifact` procedure（M2 facade frozen，严禁新增）
- 音频合成、播放与音频可用性
- 作品库查询、展示与生命周期变更

## 契约验收标准

### 1. 精确映射（frozen input）
- `CompleteChatArtifact` 经 adapter 精确映射为 `library.create({ title, prompt, storyText, voiceId, sourceMessageId })`，五字段一一对应，不增不减，不自造额外字段。

### 2. 快照冻结胜过后改 Settings
- 生成开始时冻结 `voiceId=A`；promotion 时将当前 Settings.voice 改为 `B`，`create` 仍收到 `A`。
- `user.submit` 把本次 `action.content` 写进 draft 的 `prompt`；已冻结 draft 不被后改 Settings 污染。
- `retry` 重建全新 assistant/sourceMessageId，新 attempt 的 `prompt` 与本次实际 `voice` 快照正确进入；缺省回退时 prompt 取配对失败 user 内容。

### 3. 幂等消费（不自造 key）
- 同 `sourceMessageId` + 同 `storyText` 重试（`complete` 与 `promotion_failed` 同源），server/facade 返回同一 StoryWork（同一 id）；adapter 两次 input 完全一致，且源码无 `idempotencyKey`/`idempotency_key` 自造。

### 4. 冲突原样上抛
- 同 `sourceMessageId` + 不同 `storyText` 触发 `CONFLICT` 时，同一错误对象原样向上暴露；不吞错、不包装替换、不自动换 `sourceMessageId` 重试，调用次数为 1。

### 5. 非法输入 fail-fast
- `draft` / `interrupted` / `promoting` / `ready` / Legacy `StoryCardPart` / 非对象输入一律抛错拒绝，且 `library.create` 调用次数为 0。

### 6. 静态架构纯净度守卫
- adapter 必须消费冻结的 `libraryClient.create`（`lib/client/library`）；静态禁止 `lib/db`、`prisma`、`lib/server/*`、`lib/trpc/client`、`@trpc/client` 与 `promoteArtifact`。
- M2 facade 保持 frozen：`lib/trpc/routers/*` 不得新增 `promoteArtifact`。
- `stores/chatStore` 与 `app/services/chatFlow` 本步不得直调 `library.create` 或 `storyArtifactPromotion`（自动 promotion 留 M4-04）；`chatFlow` 必须单次捕获 `frozenVoiceId` 并同时写入 draft 与真实生成请求。
