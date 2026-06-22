# 失效会话完整登出闭环

- 日期：2026-06-22
- 状态：已完成（场景 A 活体 PASS；场景 B 按构造验证；三道门全绿）
- 关联：续接 `2026-06-21-config-session-invalid-gate.md`（卡门修复），收口账号绑定特性遗留跟进项「失效会话完整登出闭环」。

## 1. 背景与问题

`auth` cookie 仍可解码、但其指向的用户在 DB 中已不存在（被删 / 库重置）或会话已过期时，应用停留在「看似登录、实为访客数据」的割裂态：

- `auth.profile`（`lib/trpc/routers/auth.ts`）在 `ctx.session` 存在时**无条件**返回 `isLogin: true`，它查了 `dbUser` 却忽略 `null` 结果。失效信号只在下游 `getOrCreateUserConfig` 建行时以 `UNAUTHORIZED` 暴露。
- 卡门修复（`0e4b01a`）把该 `UNAUTHORIZED` catch 后回落访客 `initialize()` 放行加载门，但**未翻转 `isLogin`**：UI 仍显示已登录、账号下拉仍有用户名，写库静默失败。
- middleware（`middleware.ts:39`）判定「authed」只看 cookie 能否 decode（edge 运行时无 DB），且每次请求**续签** stale cookie —— 失效 cookie 被持续复活，客户端无法靠自然过期摆脱。

## 2. 目标与约束

**目标**：失效会话应「自动登出 + 清服务端会话 cookie + 重定向登录」，复用既有 accountSync 订阅（`isLogin` 下降沿自动清四块数据）完成数据清理，零额外清理接线。

**约束**：
- 不得把「登录失败（密码错）」等 `auth.login` 的 `UNAUTHORIZED` 误判为会话失效。
- 不得引入 `/auth` 反向守卫重定向回环（清 cookie 后才跳转）。
- 不回归正常登录 / 注册 / 访客 / 主动登出路径。
- 遵循三道门（lint / tsc / build）。

## 3. 两类失效场景

- **场景 A（加载时已失效）**：页面加载时 cookie 仍在，middleware 放行进入受保护页，但 `profile` 查不到用户。
- **场景 B（会话中途失效）**：运行中用户被删 / cookie 过期，后续 authed 调用返回 `UNAUTHORIZED`（此时 `profile` 已先返回过 `isLogin:true`，不会自动重查）。

## 4. 方案对比

- **方案 1 · 纯客户端拦截**：在 tRPC 客户端拦截所有 `UNAUTHORIZED` 翻转登录态。
  - ✗ 覆盖不了场景 A —— `profile` 不报错，UI 仍显示登录；stale cookie 不被清，middleware 续签复活。
- **方案 2 · 纯服务端 profile 修真**：`profile` 判定失效 → 返回 `false` + 清 cookie。
  - ✓ 覆盖场景 A。✗ 场景 B `profile` 不会重查，运行中失效仍无人翻转登录态。
- **方案 3 · 服务端修真 + 客户端拦截组合（采用）**：
  - 服务端：`profile` 成为登录态唯一可信源；失效时清 stale cookie 并返回 `sessionInvalidated`。
  - 客户端：`fetchProfile` 见 `sessionInvalidated` → 重定向 `/auth?session=expired`（场景 A）；新增 tRPC session-guard link，在「客户端自认已登录」时捕获**非 `auth.*`** 路径的 `UNAUTHORIZED` → 走统一失效闭环（场景 B）。
  - 数据清理复用 accountSync 订阅，无新增清理接线。

## 5. 设计细节

### 5.1 服务端（`auth.profile`）
`ctx.session` 存在时，若 `prisma.user` 查不到该用户：
1. `cookies().delete(SESSION_COOKIE)` 清 stale cookie（profile 经非流式 `httpBatchLink`，可写 `Set-Cookie`；Route Handler 上下文 cookie 可变，与 `logout` 同源）。
2. 返回 `{ isLogin: false, isGuest, sessionInvalidated: true }`（与未登录分支同形 + 失效标记）。

### 5.2 客户端 · 场景 A（`authStore.fetchProfile`）
解析 profile 后照常 `set` 登录态；若响应带 `sessionInvalidated`，在浏览器环境 `window.location.assign('/auth?session=expired')` 硬跳转（cookie 已被服务端清除，无回环）。

### 5.3 客户端 · 场景 B（`lib/client/sessionGuard.ts` + tRPC link）
- `maybeHandleSessionInvalidation()`：再入守卫；仅当 `authStore.isLogin === true` 时触发（排除访客/未登录的 `UNAUTHORIZED`）。best-effort `logout()` 清 cookie → `setState` 翻转登录态（经订阅清四块数据）→ `window.location.assign('/auth?session=expired')`。
- `sessionGuardLink`（`lib/trpc/client.ts`，置于 `splitLink` 之前包裹全链）：error 回调中，`err.data?.code === 'UNAUTHORIZED' && !op.path.startsWith('auth.')` 时动态 `import` 调用 `maybeHandleSessionInvalidation()`（动态导入避免 `client.ts ↔ authStore` 静态环）。

### 5.4 `/auth` 页面提示（`app/(auth)/auth/index.tsx`）
挂载时若 `searchParams.get('session') === 'expired'`，复用现有 `apiErrorBar` 展示「登录已失效，请重新登录」。

### 5.5 卡门 `.catch` 去留
`configStore.initForUser` 的访客回落 `.catch` **保留**为防御纵深（覆盖瞬时网络错误）；失效用户场景已在 `profile` 源头拦截，不再依赖它翻转登录态。

## 6. 验收标准

1. 库中删除当前登录用户后重载受保护页：不再停留登录态，自动跳 `/auth` 且顶部提示「登录已失效」。
2. `/auth` 无 reverse-guard 回环（cookie 已清）。
3. 运行中令会话失效（删用户后触发一次写库 / authed 调用）：自动登出并跳登录页。
4. 正常登录 / 注册 / 访客 / 主动登出 / 密码错误提示均不回归。
5. 三道门（`yarn lint` / `yarn tsc --noEmit` / `yarn build`）全绿。
