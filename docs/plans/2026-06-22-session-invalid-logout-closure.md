# 实施计划 · 失效会话完整登出闭环

配套 spec：`docs/specs/2026-06-22-session-invalid-logout-closure.md`

## 步骤

### 1. 服务端 · `auth.profile` 修真
- 文件：`lib/trpc/routers/auth.ts`
- `ctx.session` 存在时新增 `dbUser === null` 分支：`cookies().delete(SESSION_COOKIE)`，返回 `{ isLogin: false, isGuest, sessionInvalidated: true }`。
- 验证：`yarn tsc --noEmit` 通过（profile 返回类型扩成判别联合）。

### 2. 客户端 · 会话失效统一闭环模块
- 新建：`lib/client/sessionGuard.ts`
- 导出 `maybeHandleSessionInvalidation()`：再入守卫 + `isLogin` 前置判定 + best-effort `logout()` + `setState` 翻转登录态 + 重定向 `/auth?session=expired`。

### 3. 客户端 · tRPC session-guard link
- 文件：`lib/trpc/client.ts`
- 新增 `sessionGuardLink`（`observable` 包裹），置于 `links` 数组首位；error 回调按 `UNAUTHORIZED && !auth.*` 动态导入触发步骤 2。

### 4. 客户端 · 场景 A 重定向
- 文件：`stores/authStore.ts`
- `fetchProfile` 解析后若 `sessionInvalidated`，`window.location.assign('/auth?session=expired')`。

### 5. `/auth` 失效提示
- 文件：`app/(auth)/auth/index.tsx`
- 读 `searchParams.get('session') === 'expired'`，经 `apiError` 展示「登录已失效，请重新登录」。

### 6. 三道门 + 落档
- `yarn lint` / `yarn tsc --noEmit` / `yarn build`，结果回填本计划与 spec 状态。
- 提交：`fix: 失效会话补完整登出闭环（profile 修真 + 401 拦截 + 重定向登录）`。

## 验证记录

- 三道门：`yarn tsc --noEmit` ✓、`yarn lint` ✓（仅剩既有无关告警 `summary.ts` 未用 `AIMessage`）、`yarn build` ✓。
- **场景 A 活体（dev 预览）PASS**：伪造指向不存在用户（userId 999999）的 `auth` cookie 访问 `/chat` →
  - `auth.profile` 单测返回 `{isLogin:false,isGuest:false,sessionInvalidated:true}` 且响应清除 `auth` cookie；
  - 完整流程：自动跳转 `http://localhost:3000/auth?session=expired`，`auth` cookie 已清，顶部错误条显示「登录已失效，请重新登录」（截图留证）。
  - 注：首次冷启动首编译曾观察到落 `/auth?from=/chat`（middleware 弹回），属编译时序 artifact；服务器热身后稳定落 `?session=expired`。
- **访客 happy path 无回归**：点「以访客身份继续使用」→ `guest=1`、落 `/chat`、无失效提示。
- **场景 B（运行中失效）按构造验证**：活体复现需先以密码登录方能触发真实 authed 调用的 `UNAUTHORIZED`（项目约定助手不代输密码，E2E 走访客态）。其链路 = `sessionGuardLink` 拦截（tsc/build 已校验）+ `maybeHandleSessionInvalidation`（复用场景 A 已验证的同一重定向机制）。
