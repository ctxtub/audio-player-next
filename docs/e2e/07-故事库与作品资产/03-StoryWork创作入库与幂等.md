# StoryWork 创作入库与 sourceMessageId 幂等

功能域：07-故事库与作品资产

## 用户目标

当前登录用户或具名访客在完成故事生成后，能够将故事安全、权威地落盘为正式作品资产（供 M4 等创作者与作品库统一消费）。服务端单点收敛元数据派生逻辑，杜绝客户端不可信数据篡改；基于来源消息 ID（`sourceMessageId`）与正文内容哈希（`contentHash`）提供强一致的幂等保护，防止网络抖动或前端重复提交生成多份冗余作品；彻底摒弃历史容量裁剪（Count Cap / KEEP_LIMIT / delete-oldest），作品资产永久留存。

## 范围与边界声明

本场景覆盖服务端 StoryWork Create Service 入库与幂等能力（由 L2 集成测试基于隔离数据库严格断言）。
**明确排除以下后续能力**（属 M2-05～M2-09 里程碑，本用例不声称其覆盖）：
- 作品重命名、收藏切换与软删除/恢复等写操作（`rename` / `setFavorite` / `trash` / `restore` mutations，属 M2-05）
- tRPC Router 路由接入与对外 HTTP/RPC 暴露（属 M2-06）
- 历史表与既有 `generationHistory` 服务的全面割接（legacy generationHistory cutover，属 M2-07）
- 访客注册升级向用户资产的批量迁移（registration migration，属 M2-08）
- 30 天访客数据过期清理与 GC 策略（30d GC，属 M2-09）

## 契约验收标准

### 1. 服务端权威派生与客户端数据零信任 (authoritative derivation & zero-trust)
- 调用方传入 `prompt`、`storyText`、可选 `voiceId`、可选 `sourceMessageId`、可选 `title`。
- 服务端强制调用 M2-02 统一算法单点生成派生字段：
  - `title`：按照 explicit title（最高优先级）→ heading title（Markdown/书名号/方括号）→ prompt fallback（<=32 字符）→ fallback title（未命名故事）管线解析；
  - `excerpt`：通过 `buildStoryExcerpt` 规整并截断前 160 字符（超长追加 …）；
  - `contentHash`：通过 `computeStoryContentHash` 基于统一规整文本计算 12 位短哈希。
- **不得信任调用方传入的 `contentHash` 与 `excerpt`**，Schema 层面不将其作为权威输入，任何客户端伪造均被服务端派生值覆盖。
- 音频投影统一下发缺省 `createMissingAudioProjection()`（`status: 'missing'`, `durationMs: null`）。

### 2. 来源消息幂等与冲突防御 (sourceMessageId idempotency & conflict)
- 当 `sourceMessageId` 非 `null` 时：
  - **同 Subject + 同 sourceMessageId + contentHash 一致**：判定为重试或幂等提交，直接返回已有作品（`StoryWorkDetailDTO`），严禁执行 `INSERT`，数据库行数完全不变；
  - **同 Subject + 同 sourceMessageId + contentHash 不一致**：判定为内容漂移冲突，抛出明确 `CONFLICT` 领域异常；**严禁覆盖数据库中的既有正文与哈希**，行数不增；
- 当 `sourceMessageId` 为 `null` 或未传时：
  - 不参与幂等机制，即便是相同正文也允许多次创建独立作品，每次新增一行且生成不同 ID。

### 3. 彻底废除容量裁剪与旧记录删除 (no count-cap & permanent retention)
- **明确删除新 create path 上所有 `KEEP_LIMIT` / `delete-oldest` / `take-100` 的保留裁剪行为**。
- 创建第 101 条、第 150 条及更多作品时，第 1 条作品与中间所有作品必须完好无损地保留在库中；验证时必须按 ID 逐条回查验证，禁止仅断言行数。

### 4. 主体对称与租户隔离 (subject symmetry & tenant isolation)
- 用户主体（`User`）与访客主体（`Guest`）在入库、权威推导、幂等校验、冲突防御及容量保留上保持完全相同的领域语义。
- 数据物理隔离：用户写入 `StoryWork`（`GenerationHistory`），访客写入 `GuestStoryWork`（`GuestGenerationHistory`）。
- 跨主体（如 User A 与 User B、Guest A 与 Guest B、User 与 Guest）拥有相同的 `sourceMessageId` 时互不冲突、互不干扰。

## 关联实现与测试

- 核心服务：`lib/server/storyWork.ts` (`createStoryWorkForSubject`)
- 领域算法：`lib/storyWork/metadata.ts`, `lib/storyWork/contentIdentity.ts`
- 数据契约：`lib/trpc/schemas/library.ts` (`libraryCreateInputSchema`, `storyWorkDetailDtoSchema`)
- 验证套件：`tests/integration/persistence-config/story-work-create.integration.test.ts` (`exec-story-work-create`)
