# 失效会话不再卡死加载门 实施计划

> 配套 spec：[docs/specs/2026-06-21-config-session-invalid-gate.md](../specs/2026-06-21-config-session-invalid-gate.md)。

**Goal:** 修复「会话指向已删除用户」时 `config.getMine` 500 + `config.initForUser` 无兜底导致加载门永久卡死。

**Architecture:** 服务端在建 UserConfig 行前校验用户存在、缺失抛 `UNAUTHORIZED`；客户端 `config.initForUser` 加 `.catch` 回落访客初始化放行加载门。2 文件改动。

---

### Task 1: 服务端 `getOrCreateUserConfig` 建行前校验用户存在

**Files:**
- Modify: `lib/server/userConfig.ts`（import `TRPCError`；`getOrCreateUserConfig` create 前校验）

- [x] **Step 1**：顶部加 `import { TRPCError } from '@trpc/server';`
- [x] **Step 2**：`getOrCreateUserConfig` 在 `findUnique` 无行后、`create` 前插入用户存在性校验：缺失则 `throw new TRPCError({ code: 'UNAUTHORIZED', message: 'SESSION_USER_NOT_FOUND' })`。
- [x] **Step 3**：`yarn tsc --noEmit` 通过。

### Task 2: 客户端 `configStore.initForUser` 失败回落访客初始化

**Files:**
- Modify: `stores/configStore.ts`（`initForUser` 终态 `.finally` 前插入 `.catch`）

- [x] **Step 1**：把 `})().finally(…)` 改为 `})().catch(async (error) => { … 回落 get().initialize() … }).finally(…)`，并保持 epoch 守卫（`epoch !== accountEpoch || get().isLoaded` 时不回落）。
- [x] **Step 2**：`yarn tsc --noEmit` 通过。

### Task 3: 验证

- [x] **三道门**：`yarn lint && yarn tsc --noEmit && yarn build` 全绿。
- [x] **活体**：dev 预览复现残留失效会话；改后首屏正常渲染聊天页，不再卡「配置加载中…」。

---

## 自审

**Spec 覆盖**：目标 1（Task 1 抛 UNAUTHORIZED）✓；目标 2（Task 2 访客回落）✓；目标 3 正常路径不回退（仅在 create 缺用户 / fetch 失败时触发，正常路径不进新分支）✓。
**占位符扫描**：无 TBD/TODO。
**类型一致**：`TRPCError` 由 `@trpc/server` 导入；`prisma.user.findUnique({ select: { id: true } })` 与 schema `model User { id Int @id }` 一致。
</content>
