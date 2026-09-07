# E2E-05-06 · 会话失效→sessionInvalidated 闭环

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-05-06` |
| 所属功能套件 | `05-认证授权与会话生命周期` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P1` |
| 自动化类型 | `AUT-BROWSER+AUT-API` |
| 执行调度 | 阶段 5: 认证、会话生命周期与用户资产就绪（全局队列第 40 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{E2E_USER_A}}` 登录态；AUT-API 在服务端删除该用户行（模拟管理员删号/库回档）。
- 步骤：1) 删除后在应用内触发任意受保护调用（如刷新 `/chat`）；2) 观察登出闭环与落点；3) 变体：篡改 `SESSION` cookie 签名后刷新。
- UI 断言：出现会话失效路径的登出闭环并落 `/auth`（`session=expired` 标记或等价提示）；无「半登录」幽灵态（UI 仍显示账号数据但请求全 401）。
- 音频/浏览器断言：失效闭环触发 `resetAccountData`，播放停止、浮窗消失。
- 网络/数据断言：核心断言——非 `auth.*` 的 401 被 `sessionGuardLink` 捕获并走统一登出闭环；`auth.profile` 的 `sessionInvalidated` 分支清 stale cookie；再入受保护页仍被 middleware 拦回。
- 清理：重建 A 账号或删残留；清 cookie。
- 证据要求：`network.json`（401→logout→redirect 链）、`ui-session-expired.png`。
- 溯源：`lib/trpc/client.ts:21-36`（`sessionGuardLink` 捕获非 `auth.*` UNAUTHORIZED）；`lib/client/sessionGuard.ts:5,13,18-24`（再入守卫；访客/匿名 401 不触发）；`lib/trpc/routers/auth.ts:184-214`（`:191-195` stale cookie 清理、`:200` `sessionInvalidated`）；`stores/authStore.ts:59-61`（失效→`/auth?session=expired`）。
