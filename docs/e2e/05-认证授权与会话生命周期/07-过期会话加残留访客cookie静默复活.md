# E2E-05-07 · 过期会话+残留访客 cookie→访客态复活

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-05-07` |
| 所属功能套件 | `05-认证授权与会话生命周期` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P1` |
| 自动化类型 | `AUT-BROWSER` |
| 执行调度 | 阶段 5: 认证、会话生命周期与用户资产就绪（全局队列第 39 项） |
| 待验证假设 | ⚠️ H-18 |

## 用例规格

- 前置条件/夹具：`{{E2E_USER_A}}` 登录且持有活跃访客 cookie（访客期数据非空）；使 `SESSION` 过期（等待 `SESSION_MAX_AGE` 或 seed 过期签名 cookie）。
- 步骤：1) 会话过期后直接导航 `/chat`（不经 `/auth`）；2) 观察落点与身份；3) 读取 UI 数据归属。
- UI 断言：核心刻画——middleware 对过期会话不续签、但访客 cookie 有效时是否**静默放行成访客**并展示旧访客数据（用户视角「我还在登录态」的错觉）。
- 音频/浏览器断言：若复活为访客态，断点就绪徽标按访客进度呈现（与账号进度不混用）。
- 网络/数据断言：`auth.profile` 走 guest 主体；`SESSION` cookie 未被此路径清理（仅 profile 查询路径清 stale cookie）；写路径落 `Guest*` 表。
- 清理：清双 cookie。
- 证据要求：`network.json`（cookie 流转）、`ui-guest-resurrect.png`、`db.txt`。
- 溯源：`middleware.ts:43-68`（仅续签有效会话；过期会话+有效访客 cookie 按访客放行）；`lib/trpc/routers/auth.ts:184-214`（stale cookie 清理仅在 profile 路径）。**待验证假设 H-18**：过期会话可被残留访客 cookie 静默「复活」为访客身份。
