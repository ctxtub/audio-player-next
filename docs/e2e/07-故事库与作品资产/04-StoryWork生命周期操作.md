# StoryWork 生命周期操作

功能域：07-故事库与作品资产

## 用户目标

当前登录用户或具名访客能够对自己的故事作品资产进行完整的生命周期管理（重命名、收藏切换、移入回收站、恢复与永久删除）。写操作严格遵循领域不变性：重命名仅限展示标题且绝不破坏正文内容哈希与摘要；收藏状态由单一时间戳字段收敛；软删除安全留存数据不丢失；永久删除仅限处于回收站的作品并收敛至统一音频清理 Seam；用户与访客两类主体同构对称且物理隔离。

## 范围与边界声明

本场景覆盖服务端 StoryWork 生命周期 5 个核心 Mutation 的 Service 层实现（由 L2 集成测试基于隔离数据库严格断言）。
**明确排除以下后续能力**（属后续里程碑）：
- tRPC Router 路由接入与对外 HTTP/RPC 暴露（属 M2-06）
- 历史表与既有 generationHistory 服务的全面割接（属 M2-07）
- 访客注册升级向用户资产的批量迁移（属 M2-08）
- 30 天回收站过期物理清理 GC 调度器（属 M2-09）
- M8 真实音频资产物理删除与 Tombstone 写入（本期仅提供统一 Seam）

## 契约验收标准

### 1. 标题重命名 (renameStoryWorkForSubject)
- 只更新 `title` 与 `updatedAt`。
- **严禁触碰 `storyText`、`contentHash` 与 `excerpt`**，正文内容身份与摘要绝对不变。
- 标题遵循既有规范化（`resolveStoryTitle` 语义，去除首尾成对引号、压缩空白、截断上限）。
- 非法入参（空字符串、纯空白）以 `BAD_REQUEST` 明确拒绝。
- 对回收站、不存在或属于其他主体的作品调用，统一返回 `NOT_FOUND`。

### 2. 收藏切换 (setStoryWorkFavoriteForSubject)
- 收藏状态的**唯一 truth 为 `favoritedAt`**（`null` 表示未收藏，非 `null` 表示收藏时间戳），严禁引入第二个布尔字段。
- `favorite = true` 写入时间戳（已收藏时保持原时间戳幂等），`favorite = false` 置为 `null`。
- 仅允许活跃作品操作；回收站、不存在或属于其他主体的作品统一返回 `NOT_FOUND`。

### 3. 移入回收站 (trashStoryWorkForSubject)
- 仅写入 `deletedAt = now()` 进行软删除标记，**严禁物理删除**，数据库行必须完好保留。
- 幂等性：已处于回收站的作品重复调用，保留最初 `deletedAt` 时间戳，不刷新 30 天生命周期。
- 不存在或跨主体作品统一返回 `NOT_FOUND`。

### 4. 恢复作品 (restoreStoryWorkForSubject)
- 仅将 `deletedAt` 置为 `null`，作品重新对活跃列表与详情可见。
- **必须严格保留原 `favoritedAt`**（收藏状态在软删除与恢复全流程中不受影响）。
- 对活跃作品（`deletedAt === null`）调用，以明确领域错误 `CONFLICT` 拒绝。
- 不存在或跨主体作品统一返回 `NOT_FOUND`。

### 5. 永久删除 (permanentlyDeleteStoryWorkForSubject)
- **仅允许对处于回收站中的作品（`deletedAt !== null`）执行物理删除**。
- 对活跃作品调用以明确领域错误 `CONFLICT` 拒绝，防止客户端或 UI 绕过回收站保护。
- 物理删除必须收敛于此单一 Service Seam，并预留作为 M8 Audio tombstone 的唯一收敛点（M8 将使用 DB 事务联动 tombstone 并在事务提交后异步清理对象存储，不依赖全局可变 hook）。
- 施加原子条件写（SQL `deletedAt IS NOT NULL` 谓词），杜绝 TOCTOU 并发竞态。
- 执行后数据库行彻底移除。
- 不存在或跨主体作品统一返回 `NOT_FOUND`。

### 6. 主体隔离与对称性 (subject symmetry & isolation)
- 用户主体（`User`，表 `StoryWork`）与访客主体（`Guest`，表 `GuestStoryWork`）领域语义完全一致。
- 物理隔离：跨主体 ID 互不可见，统一返回 `NOT_FOUND`。

## 关联实现与测试

- 核心服务：`lib/server/storyWork.ts` (`renameStoryWorkForSubject`, `setStoryWorkFavoriteForSubject`, `trashStoryWorkForSubject`, `restoreStoryWorkForSubject`, `permanentlyDeleteStoryWorkForSubject`)
- 数据契约：`lib/trpc/schemas/library.ts`
- 验证套件：`tests/integration/persistence-config/story-work-lifecycle.integration.test.ts` (`exec-story-work-lifecycle`)

