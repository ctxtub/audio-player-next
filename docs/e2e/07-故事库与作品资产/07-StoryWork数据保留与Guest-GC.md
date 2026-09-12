# StoryWork 数据保留与 Guest GC

功能域：07-故事库与作品资产

## 用户目标

用户活跃作品永久保留，回收站作品仅在删除满 30 天后物理清理；访客临时数据继续遵循既有 30 天过期规则，任何清理都不得使用数量上限淘汰作品。

## 范围与边界声明

本场景覆盖服务端 StoryWork 数据保留（Retention）与访客数据 30 天过期 GC 清理服务（由 L2 集成测试基于隔离数据库严格断言）。
- 用户活跃作品：永久在库留存，不触发任何形式的自动物理清理；
- 用户回收站：仅对 `deletedAt` 早于 30 天 cutoff / 超过 30 天的作品进行过期物理清理；
- 访客数据：严格遵循既有按行（per-row）30 天过期规则（各表按自身 `updatedAt < 30d` 清理），不引入账号级关联延期；
- 物理删除收敛：User 回收站作品过期清理与 manual 永久删除共用底层唯一物理删除 primitive（作为 M8 音频清理的唯一 Service Seam 挂载点）；
- 容量保证：彻底废除任何容量上限淘汰策略（不设数量截断，批量 >100/150+ 记录全部安全留存）。

## 契约验收标准

1. **User Active 作品永久保留**：
   - 无论作品创建时间多早（如 60 天前），只要 `deletedAt === null`，自动清理任务绝对不删除。
2. **User Trash 30 天窗口物理清理**：
   - 移入回收站未满 30 天（如 29 天）的作品完好保留；
   - 移入回收站超过 30 天（如 31 天）的作品被物理清理，行从数据库彻底移除。
3. **物理删除唯一 Service Seam**：
   - 过期回收站清理与主动永久删除共用内部物理删除 primitive `executeStoryWorkPhysicalDelete`，为后续 M8 Audio tombstone 统一收敛执行点；
   - 杜绝 N+1 循环调用，以批量条件写（`deletedAt IS NOT NULL AND deletedAt < threshold`）安全执行。
4. **并发竞态安全 (TOCTOU 防御)**：
   - 过期清理执行原子 delete 瞬间与用户恢复（restore）发生竞态时，因严格施加 `deletedAt IS NOT NULL` 条件，已恢复的作品绝对不被误删。
5. **Guest 数据遵循既有 Per-row 30 天过期规则**：
   - Guest 作品及其他访客数据表（Chat, Prompt, Config, Playback）按各表行记录的 30 天过期规则（`updatedAt < 30d`）物理清理；
   - 29 天内的未过期访客作品严格保留，31 天前的过期访客作品被清理；
   - 登录用户数据绝对不受任何访客清理影响。
6. **彻底废除容量上限 (No Cap / Bulk Retention)**：
   - 批量 100/150+ 作品场景下，任何清理逻辑绝不触发容量裁剪或淘汰旧作。

## 关联实现与测试

- 数据保留服务：`lib/server/retention.ts` (`purgeExpiredUserTrash`)
- 访客清理服务：`lib/server/guestGc.ts` (`purgeExpiredGuestData`)
- 物理删除基底：`lib/server/storyWork.ts` (`executeStoryWorkPhysicalDelete`)
- 验证套件：`tests/integration/persistence-config/story-work-retention.integration.test.ts` (`exec-story-work-retention`)
