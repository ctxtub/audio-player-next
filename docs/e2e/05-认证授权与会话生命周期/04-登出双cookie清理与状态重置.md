# E2E-05-04 · 登出→双 cookie 清理与数据清空

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-05-04` |
| 所属功能套件 | `05-认证授权与会话生命周期` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P0` |
| 自动化类型 | `AUT-BROWSER` |
| 执行调度 | 阶段 5: 认证、会话生命周期与用户资产就绪（全局队列第 37 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{E2E_USER_A}}` 登录态；播放中（联动 E2E-03-03 的声音面，本例只裁 cookie/数据面）。
- 步骤：1) `/setting` 点「退出登录」；2) 读取 cookie jar；3) 读取 UI 四块数据；4) 观察落点与回退行为。
- UI 断言：跳转 `/auth`；配置/聊天/历史/进度 UI 全部清空；浏览器后退不得恢复已登出页面数据（客户端路由态重建）。
- 音频/浏览器断言：登出后无声音（时序细节由 E2E-03-03 裁）。
- 网络/数据断言：核心断言——`auth.logout` 响应同时删除 `SESSION` 与 `GUEST` 双 cookie（`:140-141`）；登出后直连受保护页 → middleware 重定向 `/auth?from=…`。
- 清理：清 cookie。
- 证据要求：`network.json`（双 `Set-Cookie: …; Max-Age=0`）、`ui-after-logout.png`。
- 溯源：`lib/trpc/routers/auth.ts:138-144`（`:140-141` 双 cookie 删除）；`stores/authStore.ts:96-108`（`:101` 登出成功→未登录态）；`stores/accountSync.ts:98-102`（`resetAccountData`）。
