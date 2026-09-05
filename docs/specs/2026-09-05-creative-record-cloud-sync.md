# 技术方案与架构规范：阶段一 创作记录全量云端同步 (Phase 1 Creative-Record Cloud Sync)

> **文档状态**：IMPLEMENTING (正在实施)  
> **创建日期**：2026-09-05  
> **基线版本**：commit `9f01b55` (main)  
> **分支**：`feat/guest-creative-cloud-sync`  
> **作者**：IMPLEMENTATION Worker  
> **目标范围**：落实阶段一（Phase 1）创作记录全量云端同步：单会话聊天与故事卡片（Chat Messages & Story Cards）、故事作品生成历史（Generation / Works History）、提示词使用历史（Prompt History）。覆盖具名访客 `g_<uuid>` 与登录用户；彻底废弃访客端 `prompt-history-store` 本地存储；落实注册原子级迁移与回滚、30天生命周期与GC、配额上限与多维限流。

---

## 一、架构决策记录 (Architecture Decision Records - ADR)

### ADR-1：采用独立访客表镜像扩展（Isolated Guest Tables）
- **上下文**：当前系统对登录用户采用 `ChatMessage`、`GenerationHistory`、`PromptHistory` 表（外键级联 `User.id`）。为实现具名访客 `g_<uuid>` 创作记录上云，有三套候选架构：
  - 选项 A：独立访客表 `GuestChatMessage`、`GuestGenerationHistory`、`GuestPromptHistory`；
  - 选项 B：核心表支持双主体（`userId` 改为可选，新增 `guestId` 列）；
  - 选项 C：影子虚拟用户（为访客生成虚拟 `User` 行）。
- **裁决**：**采纳选项 A**。
- **决策理由**：
  1. **完全延续配置云端化（`UserConfig` + `GuestConfig`）的成熟范式**；
  2. **物理隔离**：访客高频轻量写入和 GC 清理完全不影响核心用户表，不触碰 `User` 外键级联，无行锁竞争；
  3. **零回退风险**：核心 `User` 关系链完全不动，保持只增（Additive）迁移；
  4. 坚决否决选项 C，因影子用户会击穿限流与成本防线。

### ADR-2：抽象统一主体感知服务层（Subject-Aware Unified Services）
- **上下文**：上层 tRPC Router 和注册迁移逻辑需对登录用户（`{ type: 'user', id: number }`）与具名访客（`{ type: 'guest', id: string }`）进行同构操作。
- **裁决**：定义统一 `Subject` 类型，并在服务端提供统一服务层：
  - `chatConversation`：`getConversationForSubject` / `saveConversationForSubject`；
  - `generationHistory`：`listGenerationHistoryForSubject` / `recordGenerationHistoryForSubject` / `removeGenerationHistoryForSubject`；
  - `promptHistory`：`listPromptHistoryForSubject` / `recordPromptHistoryForSubject` / `removePromptHistoryForSubject`。
  原有纯 `userId` 的函数保留作为代理或用户态底层实现，100% 保持既有语义不变。

### ADR-3：严格坚守“正文与参数持久化，音频按需即时重合成”（No Audio Blob Persistence）
- **上下文**：OpenAI TTS 生成的 MP3 文件约 600 KB ～ 1.2 MB，若存入 SQLite 数据库或服务端磁盘，极易引发容量膨胀与 I/O 枯竭。
- **裁决**：**服务端数据库绝不持久化任何音频 Blob/二进制，亦不持久化本地临时音频文件**。
  1. 快照保存时，强制将 `parts` 内 `storyCard.audioUrl` 剔除置空；
  2. 仅持久化 `storyText`、`voiceId`、`prompt` 及相关上下文元数据；
  3. 客户端回放时，调用既有的 `storyFlow.playStoryText` / `tts.synthesize` 实时动态合成，获取运行时 Blob URL。

### ADR-4：访客配额上限与 30 天生命周期 GC（Quotas & Retention）
- **上下文**：具名访客无需凭据即可创建数据，为防止滥用与存储膨胀，必须设立严密上限。
- **裁决**：
  1. **配额上限（Hard Quotas）**：
     - 单会话聊天消息：截取保留最近 **100 条**（与用户端一致，防止超大消息快照）；
     - 生成历史（作品库）：严格限制保留最近 **100 条**（与用户端 `KEEP_LIMIT = 100` 一致）；
     - 提示词历史：按 30 天滑动过期淘汰，并限制保留最近 **100 条**。
  2. **生命周期（Retention）**：
     - 访客所有记录均包含 `updatedAt` 字段及索引；
     - 超过 **30 天**未更新的访客创作数据（`updatedAt < now - 30d`）视为废弃数据；
     - 采用概率淘汰（2% 触发）或集中 GC 方法 `purgeExpiredGuestData` 进行批量清理。

### ADR-5：仅在注册（REGISTER）时原子级迁移与回滚（Register-Only Migration & Rollback Contract）
- **上下文**：访客在转化成为新用户时，希望保留其访客期间的全部创作成果；但老用户登录（LOGIN）时，不能让临时访客数据污染已有账号的云端资产。
- **裁决**：
  1. **注册（REGISTER）**：原子级迁移。
     - 在创建新用户的事务/业务块中，将当前 `guestId` 的 `GuestConfig`、`GuestChatMessage`、`GuestGenerationHistory`、`GuestPromptHistory` 完整复制至新建用户的数据表中；
     - **回滚契约**：若注册流程因任何原因（密码哈希、Cookie 写入、会话签名异常等）失败，触发已有的 `prisma.user.delete({ where: { id: createdUserId } })`，由于 Prisma 模型配置了 `onDelete: Cascade`，复制给该用户的所有行自动级联删除；
     - **安全保留**：迁移成功后，不立即物理删除访客表中的原记录（避免在失败或审计前丢失数据），保留供回退/审计，最终由 30 天 GC 自然清理。
  2. **登录（LOGIN）**：**绝对不执行迁移**。
     - 用户登录已有账号时，前端清空当前访客本地状态并拉取老用户的云端记录；
     - 访客期间的数据不污染老账号资产。

### ADR-6：客户端存储收敛与彻底清理（Storage Consolidation）
- **上下文**：历史实现中访客的提示词保存在 `localStorage['prompt-history-store']`，且通过 Zustand persist 维持。
- **裁决**：
  1. **彻底移除 `prompt-history-store` 的 Zustand persist 中间件**，提示词统一由服务端云端读写；
  2. 在客户端初始化与 reset 时主动调用 `localStorage.removeItem('prompt-history-store')` 清理历史残留；
  3. **全工程唯一允许保留的浏览器本地存储**：首屏防闪烁主题缓存 `localStorage['theme-mode']`；
  4. 聊天与历史记录不引入任何新的浏览器持久化。

---

## 二、数据库模型与迁移规范 (Prisma & Migration)

### 1. Prisma 模式定义 (`prisma/schema.prisma`)
在模式中新增 3 个访客创作模型，均为纯增量（Additive）：

```prisma
/// 访客聊天会话消息表（单会话快照，以具名访客 guestId 索引）
model GuestChatMessage {
  id        Int      @id @default(autoincrement())
  guestId   String
  position  Int
  messageId String
  role      String
  content   String
  parts     String?
  agentType String?
  createdAt String?
  updatedAt DateTime @updatedAt

  @@index([guestId, position])
  @@index([guestId])
  @@index([updatedAt])
}

/// 访客生成的故事历史，回放时据 storyText 重新合成音频
model GuestGenerationHistory {
  id        Int      @id @default(autoincrement())
  guestId   String
  prompt    String
  storyText String
  voiceId   String   @default("")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([guestId, createdAt])
  @@index([guestId])
  @@index([updatedAt])
}

/// 访客提示词历史
model GuestPromptHistory {
  id        Int      @id @default(autoincrement())
  guestId   String
  prompt    String
  lastUsed  DateTime
  useCount  Int      @default(1)
  updatedAt DateTime @updatedAt

  @@unique([guestId, prompt])
  @@index([guestId, lastUsed])
  @@index([guestId])
  @@index([updatedAt])
}
```

### 2. 数据库迁移
新增迁移目录：`prisma/migrations/20260905091000_add_guest_creative_records/migration.sql`，执行纯增量 DDL。

---

## 三、服务端统一服务层与 tRPC 路由规范 (Server & API Changes)

### 1. 统一主体抽象
在 `lib/server/subject.ts`（或各统一模块中）：
```typescript
export type Subject =
    | { type: 'user'; id: number }
    | { type: 'guest'; id: string };
```

### 2. 路由鉴权与限流规格
将以下三个 Router 从 `authedProcedure` 调整为 `guardedProcedure`：
- `chatConversation.getConversation`：`guardedProcedure`
- `chatConversation.saveConversation`：`guardedProcedure` + `enforceProcedureRateLimit('chat:save', ctx, { guestLimit: 20, authedLimit: 60 })`
- `generationHistory.list`：`guardedProcedure`
- `generationHistory.record`：`guardedProcedure` + `enforceProcedureRateLimit('generationHistory:record', ctx, { guestLimit: 20, authedLimit: 60 })`
- `generationHistory.remove`：`guardedProcedure` + `enforceProcedureRateLimit('generationHistory:remove', ctx, { guestLimit: 20, authedLimit: 60 })`
- `promptHistory.list`：`guardedProcedure`
- `promptHistory.record`：`guardedProcedure` + `enforceProcedureRateLimit('promptHistory:record', ctx, { guestLimit: 30, authedLimit: 60 })`
- `promptHistory.remove`：`guardedProcedure` + `enforceProcedureRateLimit('promptHistory:remove', ctx, { guestLimit: 30, authedLimit: 60 })`

**安全规则**：
- 匿名访问（无会话且无有效访客 Cookie）直接由 `guardedProcedure` 拦截，返回 `401 UNAUTHORIZED`；
- 所有读写严格使用 `where: { guestId: subject.id }` 或 `where: { userId: subject.id }`，绝对禁止跨主体数据泄露；
- 访客限流自动通过 `enforceProcedureRateLimit` 校验 `guestId` 与 `clientIp` 双层维度，有效防御同一 IP 轮换 UUID 攻击。

### 3. 注册迁移与回滚封装 (`lib/server/unifiedMigration.ts`)
在 `authRouter.register` 中集成：
1. 注册成功创建 `User` 后，检查 `ctx.guestId`；
2. 执行 `migrateGuestConfigToUser(ctx.guestId, user.id)`；
3. 执行 `migrateGuestCreativeRecordsToUser(ctx.guestId, user.id)`：
   - 复制 `GuestChatMessage` -> `ChatMessage`
   - 复制 `GuestGenerationHistory` -> `GenerationHistory`
   - 复制 `GuestPromptHistory` -> `PromptHistory`
4. 任何步骤抛错进入 `catch` 块，执行 `prisma.user.delete({ where: { id: createdUserId } })`，级联回滚所有数据，保障数据库零孤儿行。

---

## 四、前端客户端改造规范 (Client Changes)

1. **`stores/chatStore.ts`**：
   - 移除 `syncEnabled` 仅限登录态的假设，初始化时统一调用 `fetchMyConversation` 获得云端快照；
   - 保持防抖 1 秒快照保存，剔除 `storyCard.audioUrl`；
   - 登出或身份切换时清理本地状态，防止数据交叉污染。
2. **`stores/generationHistoryStore.ts`**：
   - 移除 `if (!get().syncEnabled)` 登录态阻断，允许访客触发 `record()` 与 `fetchMyGenerations()`；
   - 登出时调用 `reset()` 清理本地内存。
3. **`app/(main)/player/components/GenerationHistory/index.tsx`**：
   - 移除 `if (!isLogin)` 的空态阻断，登录用户与访客采用完全相同的作品列表渲染与回放交互。
4. **`stores/promptHistoryStore.ts`**：
   - 彻底移除 `persist` 中间件与 `localStorage['prompt-history-store']`；
   - 提供云端拉取与实时同步；
   - 在 `reset()` 与初始化时主动移除 `localStorage.removeItem('prompt-history-store')`。
5. **`stores/accountSync.ts`**：
   - 在 `participants` 列表中为 `chat`、`generationHistory`、`promptHistory` 全部补全 `initForGuest`；
   - 在登录态切换时（`!prevState.isLogin && state.isLogin`）重置本地临时数据，再拉取用户云端数据，确保访客临时数据绝不冲掉老账号云端数据。

---

## 五、验收测试矩阵 (Acceptance Test Matrix)

| 编号 | 测试场景 | 操作步骤 | 预期检验结果 |
| :--- | :--- | :--- | :--- |
| **TC-01** | **具名访客聊天记录云端持久化与刷新恢复** | 访客 `g_1` 保存聊天会话，重新通过服务拉取 | ① 消息完整拉取；② `audioUrl` 强制为空，纯文本保存；③ 不污染其他访客。 |
| **TC-02** | **具名访客生成历史与作品列表回放** | 访客 `g_1` 记录生成历史，在作品库查看并删除 | ① 记录成功入库；② 超过 100 条时自动裁剪保留最新 100 条；③ 删除操作生效。 |
| **TC-03** | **具名访客提示词历史云端同步** | 访客 `g_1` 记录提示词使用，验证计数与时间 | ① 重复提示词计数自增；② 30 天前过期记录被剪除；③ 本地无业务 LocalStorage。 |
| **TC-04** | **匿名无 Cookie 401 拦截** | 匿名上下文调用各 Router 的 query/mutation | 全部返回 `TRPCError(UNAUTHORIZED, 401)`。 |
| **TC-05** | **多主体数据隔离** | 访客 A、访客 B、用户 C 同时操作相同接口 | 彼此完全不可见对方消息与历史，零串扰。 |
| **TC-06** | **注册原子级数据迁移** | 访客创作后注册新用户 | 新用户完整继承配置、聊天、生成历史与提示词；原访客数据保留供 GC。 |
| **TC-07** | **注册失败原子级回滚安全** | 模拟注册流程中发生异常 | 新建用户被完全回滚删除，且访客原有创作数据 100% 完好无损。 |
| **TC-08** | **登录老账号隔离** | 访客存在创作数据，直接登录已有老账号 | 登录后加载老账号自有云端数据，访客临时数据不覆盖老账号。 |
| **TC-09** | **30 天 GC 清理谓词** | 模拟 30 天前过期的访客创作数据 | GC 谓词精准清理 30 天前的数据，未过期数据不受影响。 |
| **TC-10** | **访客双维度写速率限制** | 模拟同一 IP 轮换 UUID 刷写接口 | IP 维度限流触发 429 阻断，防护 DoS。 |
