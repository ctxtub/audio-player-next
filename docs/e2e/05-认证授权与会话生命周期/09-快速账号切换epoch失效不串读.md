# E2E-05-09 · 快速账号切换→epoch 失效不渲染旧数据

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-05-09` |
| 所属功能套件 | `05-认证授权与会话生命周期` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P1` |
| 自动化类型 | `AUT-BROWSER` |
| 执行调度 | 阶段 5: 认证、会话生命周期与用户资产就绪（全局队列第 41 项，产出账号 {{E2E_USER_B}}） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{E2E_USER_A}}`/`{{E2E_USER_B}}` 均有可区分数据（不同聊天文本、不同配置值）；mock 放慢 `initForUser` 拉取。
- 步骤：1) 登录 A；2) 在 A 数据在途时登出并立即登录 B（≤500ms）；3) 静置 3s 读取 UI 四块数据；4) 重复 3 轮。
- UI 断言：终态仅显示 B 的数据；A 的在途响应不得晚到覆盖（epoch 校验丢弃）；无 A/B 混合渲染帧。
- 音频/浏览器断言：切换后无 A 的残留音频/浮窗态。
- 网络/数据断言：`initForUser` 各 store 以 `accountEpoch` 捕获/校验（旧代次结果丢弃）；DB 无交叉写入（A 的在途保存不落到 B 主体）。
- 清理：登出；清 cookie。
- 证据要求：`ui-switch-bleed.png`（终态）、`console.json`、`network.json`。
- 溯源：`stores/chatStore.ts:160,527-531`（epoch 捕获/校验）；`stores/configStore.ts:181`；`stores/generationHistoryStore.ts:47,60-72`；`stores/promptHistoryStore.ts:115,218-233`；`stores/accountSync.ts:34-68`（四块参与者）。
