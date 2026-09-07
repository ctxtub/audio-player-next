# E2E-05-08 · /auth 反向守卫与 from 回跳的切换安全

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-05-08` |
| 所属功能套件 | `05-认证授权与会话生命周期` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P2` |
| 自动化类型 | `AUT-BROWSER` |
| 执行调度 | 阶段 5: 认证、会话生命周期与用户资产就绪（全局队列第 35 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{E2E_USER_A}}` 登录态；`{{GUEST_FRESH}}` 各一上下文。
- 步骤：1) 登录态直访 `/auth`；2) 登录态直访 `/auth?from=/setting`；3) 未登录访问 `/setting` → 登录后观察回跳；4) 构造 `from=//evil.example.com` 与 `from=https://evil.example.com` 各访问一次。
- UI 断言：已登录访问 `/auth` → 弹回 `/chat`（反向守卫）；`from` 合法站内路径登录后回跳原路径；外部域/协议相对 `//` 一律不落外站（安全断言，失败即 P0 级缺陷上报）。
- 音频/浏览器断言：不适用。
- 网络/数据断言：重定向链仅发生在 middleware 层（`32-38` 带 `from`、`27-29` 反向守卫）。
- 清理：清 cookie。
- 证据要求：`network.json`（redirect 链）。
- 溯源：`middleware.ts:27-29`（authed→`/chat`）、`:32-38`（protected→`/auth?from=`）；`lib/trpc/routers/auth.ts:27-33`（`setAuthCookie` 后落点）。
- 备注：与 E2E-01-06 矩阵互补——E2E-01-06 裁「三身份×三页」广度，本例裁「会话切换时序 + from 安全」深度；开放重定向失败时本例升级为 P0。
