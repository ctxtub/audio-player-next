# E2E-06-02 · TTS 限流分层与语音白名单 fallback

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-06-02` |
| 所属功能套件 | `06-异常处理与接口限流` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P2` |
| 自动化类型 | `AUT-API` |
| 执行调度 | 阶段 1: 无状态服务端守卫基石（全局队列第 4 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{GUEST_FRESH}}` 与 `{{E2E_USER_A}}` 两个上下文；AUT-API 直连 `tts.synthesize`。
- 步骤：1) 访客窗口内连调 ×16，观察第 16 次 429；2) 登录态同法连调 ×46（或以窗口边界分段验证 45 上限）；3) 携带白名单外 `voiceId`（如 `nonexistent-voice`）调用一次；4) 携带合法语音再次调用。
- UI 断言：不适用（API 面）；联动 UI：设置页语音下拉仅展示白名单项。
- 音频/浏览器断言：不适用。
- 网络/数据断言：核心断言——访客第 16 次 `TOO_MANY_REQUESTS`、登录态第 46 次（15/45 分层）；白名单外 `voiceId` 被**静默回退**到默认语音（响应 200 且返回默认语音音频），而非报错；两次成功调用的返回内容与 `voiceId` 参数无关（fallback 语义）。
- 清理：清 cookie；删用户行。
- 证据要求：`network.json`（计数与响应体）、`db.txt`（如落语音选择）。
- 溯源：`lib/trpc/routers/tts.ts:19-21`（`guestLimit:15, authedLimit:45`）；`lib/trpc/routers/tts.ts:23-26`（白名单外回退 `config.voiceId`）；`lib/server/openai.ts:43,136,175-183`（`parseVoiceList`、默认语音解析）。
- 备注：与 E2E-02-12/E2E-03-12（试音双声源）互补：本例裁 API 契约，彼例裁浏览器行为。
