# Chat Artifact 领域契约与生命周期状态机

功能域：08-创作Artifact

## 用户目标

Chat 故事内容生命周期与消息投递状态解耦，仅完整现代 Artifact 可进入作品 promotion 流程，中断与 Legacy 内容不得获得新写能力。

## 范围与边界声明

本场景定义并约束 Chat 创作会话中故事作品从草稿到入库的纯内存域模型契约与状态机流转（由 L1 单元测试直接断言），严格限定于领域逻辑层。

**包含的职责**：
- 消息传输状态（ChatMessageDeliveryStatus）与 Artifact 生命周期解耦
- 六态纯状态机转移与非法跃迁拦截矩阵
- 严格不变量校验（draft/interrupted 严禁持有 `storyWorkId`，ready 必须持有合法正整数 `storyWorkId`）
- Modern Artifact 彻底剥离 `audioUrl`，使作品内容与音频播放生命周期解耦
- `sourceMessageId` 规则冻结（绑定生成该作品的 assistant message id，支撑 M2 幂等入库）
- Legacy `StoryCardPart` 只读解码兼容与不可 promotion 铁律约束（绝不因历史会话回迁产生新作品写入）

**显式排除以下能力**（由后续模块或其他子系统负责）：
- 真实网络 tRPC 调用与 HTTP 传输
- 数据库 SQLite/Prisma 持久化与事务执行
- UI 组件渲染与 React Hook 状态绑定
- TTS 语音合成流式传输与 AudioGenerator 调度
- 播放内核管理与音频 Blob 播放控制（归属 M5/M8）

## 契约验收标准

### 1. 传输层与内容资产生命周期彻底解耦
- 消息投递状态 `ChatMessageDeliveryStatus`（`sending | delivered | failed`）专用于网络连接与上行/下行消息投递状态反馈。
- 作品状态机 `ChatArtifactStatus`（`draft | complete | promoting | ready | promotion_failed | interrupted`）专用于表达故事正文创作及向 StoryWork 演进的生命周期。
- 两者状态独立演进，消息投递成功并不等于作品入库；消息重新投递或连接波动不污染 Artifact 内部状态。
- `StoryArtifactPart` 作为现代消息片段联合类型 `MessagePart` 的一等公民，`extractTextFromParts` 正确解析并提取其正文。

### 2. 六态纯状态机转移与转移矩阵
- 仅允许以下确定性状态跃迁：
  - `draft` -> `complete`：故事正文流式生成完毕，等待发起作品入库；
  - `draft` -> `interrupted`：生成中途被用户取消或发生致命异常；
  - `complete` -> `promoting`：调用 `library.create` 发起入库流程；
  - `promoting` -> `ready`：入库成功，绑定合法作品资产 ID；
  - `promoting` -> `promotion_failed`：入库失败（如超时或冲突），记录错误并保持内容；
  - `promotion_failed` -> `promoting`：由用户或编排层发起幂等重试。
- 拒绝任何非法跨越或逆向跃迁（如 `draft -> ready`、`complete -> ready`、`ready -> complete` 等），非法转移必须显式抛出异常。
- `ready` 与 `interrupted` 为终态（terminal），不可逆转。

### 3. 严格不变量校验与断言
- **draft / interrupted**：严禁持有 `storyWorkId`（必须为 `undefined`）。
- **complete / promoting / promotion_failed**：资产尚未成功创建，`storyWorkId` 必须为 `undefined`。
- **ready**：必须包含合法的正整数 `storyWorkId`（`Number.isInteger(id) && id > 0`），非正整数、浮点数、NaN、null 或未定义一律判定违规。
- **promotion_failed**：必须完整保留原始 `storyText`、`sourceMessageId`、`title`、`prompt` 与 `voiceId`，确保后续幂等重试无需重新生成正文。

### 4. Modern Artifact 绝无 audioUrl（B1 契约隔离）
- 现代 `BaseChatArtifact` 及其所有衍生状态类型中绝不得包含 `audioUrl`。
- 现代状态机函数（`createDraftArtifact`、`appendDraftChunk`、`completeArtifact`、`startPromotion`、`markPromotionSuccess`、`markPromotionFailed`、`interruptArtifact`）不得接受、传播或注入 `audioUrl`。
- 故事正文生成与资产落库（M4）与音频准备/播放（M8）严格物理隔离。

### 5. sourceMessageId 规则冻结与 M2 幂等对齐
- `sourceMessageId` 恒为产生该 Artifact 的 assistant 消息 ID（`msg.id`），且非空。
- 在状态机从 `draft` 到 `ready` 及多次 `retryPromotion` 的全流程中，`sourceMessageId` 保持绝对不变。
- 确保在网络重试或响应丢失场景下，重复调用 `library.create` 携带相同的 `[sourceMessageId, storyText]`，由 M2 幂等契约安全返回同一个 `StoryWork`。

### 6. Legacy StoryCardPart 只读兼容与不可 Promotion 铁律（B2 契约防线）
- 历史故事卡片 `StoryCardPart`（包含 `storyText` 与 `audioUrl`）保留用于向后兼容解码与只读历史展示。
- 提供 `decodeLegacyStoryCard` 规范化只读解析；**绝不提供将 Legacy 卡片转为可 Promotion 的现代 Artifact 转换器**。
- `StoryCardPart` 绝非 `ChatArtifact`，`canPromote(legacy)` 恒为 `false`；严禁将其传入 `startPromotion`。
- 彻底杜绝历史会话恢复时自动化编排层误将历史 Legacy 内容二次触发 `library.create` 写入作品库。

### 7. 静态架构纯净度守卫
- 领域定义文件 `types/chatArtifact.ts` 与状态机文件 `lib/client/chatArtifactState.ts` 保持纯函数与纯类型设计。
- 静态禁止依赖底层数据库（`lib/db`、`prisma`）、客户端网络（`fetch`、`@trpc` client）以及视图框架（`react`、`next/`）。
