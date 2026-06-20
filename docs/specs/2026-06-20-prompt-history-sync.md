# 账号体系对接（二）：提示词历史上云

> 范围：账号数据绑定大任务的**第二块**。把"提示词使用历史"从设备本地 localStorage 迁移到账号级服务端存储。
> 原则：复用第一块（[2026-06-20-account-config-sync](2026-06-20-account-config-sync.md)）确立的跨域基建——登录态编排 / 登出清理 / 服务端为权威源。

---

## 背景与目标

现状：[promptHistoryStore](../../stores/promptHistoryStore.ts) 把提示词历史（`recordsMap`: prompt → {prompt, lastUsed, useCount}）持久化到 localStorage `prompt-history-store`，30 天过期清理。仅在**播放器页**使用：
- [InputStatusSection](../../app/(main)/player/components/InputStatusSection/index.tsx) 提交提示词时调 `addOrUpdate`。
- [HistoryRecords](../../app/(main)/player/components/HistoryRecords/index.tsx) 弹窗展示/排序/删除/回放。

问题同第一块：设备本地、换设备丢失、同设备换账号串号。

目标：登录用户的提示词历史随账号云端同步；访客/未登录维持本地；复用第一块基建。

---

## 关键决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 同步模型 | **服务端为权威源** | 与第一块一致。登录后以服务端 `PromptHistory` 为准。 |
| 登录时本地↔服务端 | **服务端为准，不合并** | 访客期历史登录后丢弃，符合"访客模式·数据不会保存"既有语义；避免多条记录合并的复杂度。 |
| 写入时机 | **每次用提示词即时写库**（无防抖） | 提示词使用为低频用户动作，无需防抖；删除同理。区别于配置块的高频滑块。 |
| 30 天窗口 | **保留，服务端读时剪除** | 沿用现有 UX，约束服务端数据增长。 |
| sortMode（排序偏好） | **不上云，保持本地 UI 偏好** | YAGNI。 |
| 登录编排位置 | **收敛到播放器页单一权威** | 历史读写都在播放器页；避免组件各自惰性 hydrate 与服务端加载抢初始化。 |

---

## 数据模型层（需迁移）

新增 `PromptHistory` 表：

```prisma
model PromptHistory {
  id        Int      @id @default(autoincrement())
  userId    Int
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  prompt    String
  lastUsed  DateTime
  useCount  Int      @default(1)

  @@unique([userId, prompt])
}
```

`User` 增加反向关系 `promptHistory PromptHistory[]`。需新增 prisma 迁移并应用到 dev.db（生产经 `migrate deploy`）。

DTO（返回前端，与现有 `HistoryRecord` 同形）：`{ prompt: string; lastUsed: string /* ISO */; useCount: number }`。DB `DateTime` → DTO ISO 字符串，保持 store 类型不变。

---

## 接口设计（tRPC）

新增 `promptHistory` router（全部 `authedProcedure`），并在 `routers/index.ts` 注册：

| Procedure | 类型 | 说明 |
|-----------|------|------|
| `list` | query | 返回当前用户历史；读取时 `deleteMany` 剪除 `lastUsed < now-30d`，再 `findMany` 返回 DTO[]。 |
| `record` | mutation, input `{ prompt }` | 按 `(userId, prompt)` upsert：存在则 `useCount+1`、`lastUsed=now`；否则建行。 |
| `remove` | mutation, input `{ prompt }` | 按 `(userId, prompt)` `deleteMany`（不存在不报错）。 |

服务逻辑抽到 `lib/server/promptHistory.ts`（prisma 细节与 DB↔DTO 映射），router 瘦身。Zod schema 置于 `lib/trpc/schemas/promptHistory.ts`。客户端封装 `lib/client/promptHistory.ts`。

---

## 状态管理层（promptHistoryStore 改造）

与配置块同构：
- 新增 `syncEnabled`、`initForUser()`（拉服务端 list → 覆盖 `recordsMap`，`syncEnabled=true`；in-flight 去重）、`reset()`（清空 + 清 localStorage + `syncEnabled=false`）。
- `addOrUpdate`：乐观本地 + 登录态下调 `record`（失败 toast，保留乐观值）。移除原"未初始化则本地 hydrate"兜底（改由播放器页统一初始化保证）。
- `remove`：乐观本地 + 登录态下调 `remove`。
- 访客/未登录：维持现有 `hydrate()`（本地）路径不变。

---

## 编排（复用基建）

- **播放器页**（`app/(main)/player/index.tsx`）新增登录态感知初始化：`authStore` 就绪后，登录走 `initForUser()`，否则 `hydrate()`。作为单一初始化权威。
- 移除 `InputStatusSection` / `HistoryRecords` 内各自的惰性 `hydrate()` effect（改为消费 store 数据）。
- 登出 `reset()` 挂到第一块已有的登出清理点（[UserSection](../../app/(main)/setting/components/UserSection/index.tsx) `handleLogout`），与 `configStore.reset()` 并列。

---

## 验收标准

1. 登录用户在 A 设备产生的提示词历史，B 设备登录同账号可见。
2. 用提示词 → 服务端 `PromptHistory` 出现/计数+1；删除 → 服务端删除。
3. 同设备：用户 A 历史 → 登出 → 用户 B 登录，看不到 A 的历史。
4. 访客调提示词走本地，全程不触发 protected 接口。
5. 超过 30 天的记录在 list 时被剪除。
6. `yarn lint` / `tsc --noEmit` / `build` 全通过。

---

## 影响范围 / 文件清单

| 文件 | 改动 |
|------|------|
| `prisma/schema.prisma` + 新迁移 | 新增 `PromptHistory` 模型 + User 反向关系 |
| `lib/trpc/schemas/promptHistory.ts` | 新增：input/DTO schema |
| `lib/server/promptHistory.ts` | 新增：list/record/remove 服务 + DB↔DTO |
| `lib/trpc/routers/promptHistory.ts` | 新增 router |
| `lib/trpc/routers/index.ts` | 注册 `promptHistory` |
| `lib/client/promptHistory.ts` | 新增客户端封装 |
| `stores/promptHistoryStore.ts` | 加 `syncEnabled`/`initForUser`/`reset` + 写穿透 |
| `app/(main)/player/index.tsx` | 登录态感知初始化 |
| `app/(main)/player/components/InputStatusSection/index.tsx` | 移除自带 hydrate |
| `app/(main)/player/components/HistoryRecords/index.tsx` | 移除自带 hydrate |
| `app/(main)/setting/components/UserSection/index.tsx` | 登出追加 promptHistory.reset() |
