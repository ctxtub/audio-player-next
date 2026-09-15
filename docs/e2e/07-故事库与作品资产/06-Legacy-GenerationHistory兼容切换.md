# Legacy GenerationHistory 兼容切换

功能域：07-故事库与作品资产

## 用户目标

/player 既有生成历史接口在底层切换到 StoryWork 后保持原 DTO 与交互兼容，同时取消 100 条数据裁剪，旧删除行为映射为可恢复的软删除。

## 范围与边界声明

本场景覆盖 /player 的旧版 generationHistory 接口向 StoryWork 数据体系平滑兼容割接（由 L2 集成测试基于隔离数据库严格断言）。
**明确排除以下后续能力**（属后续里程碑，本用例不声称其覆盖）：
- 访客注册升级向用户资产的批量迁移（registration migration，属 M2-08）
- 30 天访客数据过期清理与 GC 策略（30d GC，属 M2-09）

## 契约验收标准

1. **展示兼容窗口 (Read Window vs Retention)**：
   - `generationHistory.list` 仅展示当前主体 active（`deletedAt === null`）且按 `createdAt DESC, id DESC` 排序的最近 50 条记录；
   - 50 条上限纯属展示兼容语义（read window），严禁承担数据保留职责或参与底层数据裁剪。
2. **底层写入委托与权威派生 (Canonical Create Path)**：
   - `generationHistory.record` 统一委托 `createStoryWorkForSubject(subject, { ..., sourceMessageId: null })`；
   - `sourceMessageId` 显式置为 `null`，不参与来源消息幂等，允许完全相同内容重复创建独立作品；
   - 服务端权威派生 `title`、`excerpt` 与 `contentHash` 元数据。
3. **彻底废除容量裁剪 (No Cap / 150 Records Retention)**：
   - 彻底废除生产写链上的 `KEEP_LIMIT = 100` 与 `delete-oldest` 淘汰逻辑；
   - 连续写入 150 条记录后，第 1 条数据库记录逐 ID 与核心字段严格断言完好留存，主库总记录数严格等于 150 条。
4. **软删除映射与行留存 (Soft Trash on Remove)**：
   - `generationHistory.remove` 从底层物理 `deleteMany` 切换为 `moveToTrash` 软删除语义；
   - 写入 `deletedAt = now()`，数据行在库中完整保留（总行数不减少）；已软删除记录从 legacy list 中隐匿；
   - 针对已处于回收站记录再次调用具备幂等性（不刷新原 `deletedAt`）。
5. **防越权与缺失防御 (Safe No-op on Foreign / Missing)**：
   - 尝试删除不存在的记录或跨主体（删除其他用户的作品）时，吸收 `NOT_FOUND` 并保持旧版安全的静默 no-op 兼容语义，不抛出未处理异常，绝不篡改他人资产。
6. **User 与 Guest 同构对称 (Subject Symmetry)**：
   - 登录用户与具名访客在 list、record、remove 的兼容语义上完全对称一致。
7. **Legacy DTO 契约不变性 (DTO Contract Preserved)**：
   - 生成历史 DTO 保持原有结构 `{ id, prompt, storyText, voiceId, createdAt }`，/player 页面既有组件与 Store 契约不被破坏。

## 关联实现与测试

- 服务实现：`lib/server/generationHistory.ts`
- 路由定义：`lib/trpc/routers/generationHistory.ts`
- 客户端与状态：`lib/client/generationHistory.ts`、`stores/generationHistoryStore.ts`
- 数据契约：`lib/trpc/schemas/generationHistory.ts`
- 验证套件：`tests/integration/persistence-config/legacy-generation-history-cutover.integration.test.ts` (`exec-legacy-generation-history-cutover`)
