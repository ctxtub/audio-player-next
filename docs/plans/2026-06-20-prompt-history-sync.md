# 提示词历史上云 实施计划

> **For agentic workers:** 配套 spec：[2026-06-20-prompt-history-sync](../specs/2026-06-20-prompt-history-sync.md)。复用第一块基建模式。
> 测试/提交约定同第一块：无测试框架，以 `lint`/`tsc`/`build` + 浏览器验证为准；本块作为一个 coherent commit 收尾。

**Goal:** 提示词使用历史随账号云端同步，服务端 `PromptHistory` 为权威源，访客走本地，复用登录态编排/登出清理。

**Architecture:** 新增 `PromptHistory` 表 + `authedProcedure` 的 `promptHistory.list/record/remove`；promptHistoryStore 加 `syncEnabled/initForUser/reset` 与写穿透；初始化收敛到播放器页。

---

## Task 1: 数据模型 + 迁移

- [ ] schema.prisma 增加 `PromptHistory` 模型与 `User.promptHistory` 反向关系（见 spec 数据模型）。
- [ ] `DATABASE_URL="file:./dev.db" npx prisma migrate dev --name add_prompt_history`，应用到 dev.db。
- [ ] 验证：根 dev.db 出现 `PromptHistory` 表（含 `userId+prompt` 唯一索引）；`yarn tsc --noEmit`。

## Task 2: Zod schema

- [ ] 新建 `lib/trpc/schemas/promptHistory.ts`：
  - `recordInputSchema = z.object({ prompt: z.string().min(1).max(2000) })`
  - `removeInputSchema = z.object({ prompt: z.string().min(1) })`
  - `promptHistoryDtoSchema = z.object({ prompt: z.string(), lastUsed: z.string(), useCount: z.number().int() })`，导出 `PromptHistoryDTO` 类型。
- [ ] 验证 tsc。

## Task 3: 服务端服务

- [ ] 新建 `lib/server/promptHistory.ts`：
  - 常量 `THIRTY_DAYS_MS`。
  - `toDto(row) => { prompt, lastUsed: row.lastUsed.toISOString(), useCount }`。
  - `listPromptHistory(userId)`：先 `deleteMany({ where: { userId, lastUsed: { lt: new Date(Date.now()-THIRTY_DAYS_MS) } } })`，再 `findMany({ where:{userId}, orderBy:{lastUsed:'desc'} })` → DTO[]。
  - `recordPromptHistory(userId, prompt)`：`upsert({ where: { userId_prompt: { userId, prompt } }, update: { useCount: { increment: 1 }, lastUsed: new Date() }, create: { userId, prompt, lastUsed: new Date(), useCount: 1 } })`。
  - `removePromptHistory(userId, prompt)`：`deleteMany({ where: { userId, prompt } })`。
- [ ] 验证 tsc。

## Task 4: tRPC router + 注册

- [ ] 新建 `lib/trpc/routers/promptHistory.ts`：`list`(query)/`record`(mutation,recordInput)/`remove`(mutation,removeInput)，调用服务层，传 `ctx.session.userId`。
- [ ] `lib/trpc/routers/index.ts` 注册 `promptHistory: promptHistoryRouter`。
- [ ] 验证 tsc + build。

## Task 5: 客户端封装

- [ ] 新建 `lib/client/promptHistory.ts`：`fetchMyPromptHistory()`=`trpc.promptHistory.list.query()`；`recordMyPrompt(prompt)`=`...record.mutate({prompt})`；`removeMyPrompt(prompt)`=`...remove.mutate({prompt})`。
- [ ] 验证 tsc。

## Task 6: promptHistoryStore 改造

- [ ] base state 加 `syncEnabled: boolean`（初始 false）。
- [ ] actions 加 `initForUser(): Promise<void>`、`reset(): void`。
- [ ] 闭包内 in-flight 守卫 `userInitPromise`；`initForUser`：若 `syncEnabled` 已 true 则跳过；否则 `fetchMyPromptHistory()` → 构造 recordsMap → `set({ recordsMap, syncEnabled: true, initialized: true })`。
- [ ] `addOrUpdate`：保留乐观本地（移除内部 `if(!initialized) hydrate()` 兜底）；`if (get().syncEnabled) recordMyPrompt(prompt).catch(toast)`。
- [ ] `remove`：保留乐观本地（移除内部 hydrate 兜底）；`if (get().syncEnabled) removeMyPrompt(prompt).catch(toast)`。
- [ ] `reset`：`getSafeLocalStorage().removeItem(PROMPT_HISTORY_STORAGE_KEY)`（try/catch）+ `set({ recordsMap:{}, syncEnabled:false, initialized:false })`。
- [ ] import `GlassToast`、`fetchMyPromptHistory/recordMyPrompt/removeMyPrompt`。
- [ ] 验证 tsc。

## Task 7: 播放器页登录态初始化 + 组件去自管

- [ ] `app/(main)/player/index.tsx`：引入 `useAuthStore`、`usePromptHistoryStore`；effect：`if(!authInitialized) return; isLogin ? initForUser() : hydrate()`，deps `[authInitialized,isLogin,initForUser,hydrateLocal]`。
- [ ] `InputStatusSection`：移除 `hydrateHistory` 的 effect 与 `selectIsInitialized` 相关引用（保留 `addOrUpdate`）。
- [ ] `HistoryRecords`：移除 `hydrateHistory` 的 effect 与 `isHistoryInitialized` 引用（保留 `recordsMap/remove/sortMode`）。
- [ ] 验证 tsc + build。

## Task 8: 登出清理 + 全量回归 + 提交

- [ ] `UserSection.handleLogout`：成功分支追加 `resetPromptHistory()`（新增 `usePromptHistoryStore(state=>state.reset)`），与 `resetConfig()` 并列。
- [ ] 全量 `yarn lint && tsc --noEmit && build`。
- [ ] 浏览器走查 spec 验收 1-5（双账号：写入/计数、删除、登出清空、账号切换不串号、访客走本地）。
- [ ] 清理测试账号，提交（conventional commit）。

---

## 自检：Spec 覆盖

| Spec 要求 | 任务 |
|-----------|------|
| 服务端权威 + 不合并 | Task 6 initForUser（覆盖式） |
| PromptHistory 表 | Task 1 |
| list/record/remove | Task 3/4 |
| 30 天剪除 | Task 3 listPromptHistory |
| store 写穿透 | Task 6 |
| 播放器页单一初始化 | Task 7 |
| 登出清理 | Task 8 |
| 验收 1-5 | Task 8 走查 |
