# E2E-05-10 · 注册/登录校验失败与 sessionGuard 豁免

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-05-10` |
| 所属功能套件 | `05-认证授权与会话生命周期` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P1` |
| 自动化类型 | `AUT-BROWSER+AUT-API` |
| 执行调度 | 阶段 5: 认证、会话生命周期与用户资产就绪（全局队列第 32 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{E2E_USER_A}}` 已注册；`{{GUEST_FRESH}}` 上下文。
- 步骤：1) 注册重复用户名；2) 注册密码过短（低于 schema 下限）；3) 注册两次密码不一致；4) 登录错误密码；5) 观察每步 toast 与停留页。
- UI 断言：各失败均有对应 toast/表单错误且停留 `/auth`；不出现「会话已过期」类误报（`auth.*` 的 401/CONFLICT 不触发登出闭环）；前端校验（密码长度/一致性）在提交前拦截。
- 音频/浏览器断言：不适用。
- 网络/数据断言：`auth.register` 返回 CONFLICT、`auth.login` 返回 UNAUTHORIZED；`User` 表无脏行；`sessionGuardLink` 对 `auth.` 前缀路径豁免（不触发 `maybeHandleSessionInvalidation`）。
- 清理：清 cookie。
- 证据要求：`ui-validation-errors.png` ×4、`network.json`。
- 溯源：`lib/trpc/routers/auth.ts:27-33,105-133`（登录失败 UNAUTHORIZED）；`lib/trpc/client.ts:24-36`（`!op.path.startsWith('auth.')` 豁免）；`lib/trpc/schemas`（注册/登录 Zod 校验，前后端复用）。
