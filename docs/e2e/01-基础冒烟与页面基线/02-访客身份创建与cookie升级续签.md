# E2E-01-02 · 访客身份创建与 cookie 升级/续签

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-01-02` |
| 所属功能套件 | `01-基础冒烟与页面基线` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P1` |
| 自动化类型 | `AUT-BROWSER+AUT-API` |
| 执行调度 | 阶段 2: 冒烟基线与页面基线 |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{GUEST_FRESH}}`；已停在 `/auth`。
- 步骤：1) 点击「访客进入」；2) 读取 cookie `guest`；3) 二次导航受保护页；4) 再导航一次。
- UI 断言：进入访客态后正常落在来源页（`from` 参数回跳）。
- 音频/浏览器断言：cookie `guest` 为 opaque 签名值（验签还原出 `g_` 开头 gid，不直接以明文 `g_` 存放）；第二次导航后该 cookie 值更新（滑动续签，重签同一 gid）。
- 网络/数据断言：`enterGuestMode` mutation 成功（响应体仅 `{success:true}`，不再返 `guestId`，见 `auth.ts:151,169`）；DB `GuestConfig` 出现对应 `guestId` 行；旧式 `guest=1`/裸 `g_` 明文/伪造签名（若人工预置）一律视为匿名、被 `guardedProcedure` 401 拒绝，不补发 cookie，须重新进入访客模式（见 `context.ts:104-107`）。
- 清理：清 cookie；记录 `guestId`（响应体不返，需验签解码 cookie 或查 DB，供 05-认证与会话生命周期对照）。
- 证据要求：`network.json`（Set-Cookie 证据）、`db.txt`。
- 溯源：`lib/session.ts:151-158,165-202`（签发/验签）；`lib/trpc/routers/auth.ts:151,169`（响应体无 guestId）；`lib/trpc/context.ts:104-107`（旧标识一律匿名→401）；`middleware.ts:13-17,54-72`（访客判定＋同 gid 重签续签）。
