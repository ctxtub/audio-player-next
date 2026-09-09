# E2E-04-07 · onboarding 首访标记与未读徽标跨端一致

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-04-07` |
| 所属功能套件 | `04-云端存储与多端数据调和` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P2` |
| 自动化类型 | `AUT-BROWSER` |
| 执行调度 | 阶段 6: 云端数据正确性与多端调和（全局队列第 44 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{GUEST_FRESH}}`（首访）；同 jar 新 tab 复用同 cookie＋共享 localStorage（模拟回访）。
- 步骤：1) 首次进入 `/chat` 观察 onboarding；2) 关闭后刷新；3) 在同 jar 新 tab 打开；4) 触发一次未读（流式完成时停留在 `/setting`）后返回。
- UI 断言：onboarding 仅首次出现（刷新/同 jar 新 tab/回访不再弹——localStorage 跨 tab 共享，`d8301d9`；旧 sessionStorage 语义下同 jar 新 tab 重弹已作废）；TabBar「聊天」徽标出现于未读时、进入聊天后清除；徽标清除不误清其他身份的未读（切号后不得复用旧标记）。
- 音频/浏览器断言：不适用。
- 网络/数据断言：onboarding 标记存于 localStorage `chat_onboarding_seen_v1`（`utils/chatOnboarding.ts:8`），与刷新/跨 tab 行为一致（同 jar 共享不再弹）；无重复 `config.updateMine`。
- 清理：清 cookie/storage。
- 证据要求：`ui-onboarding.png`、`ui-badge.png`、`network.json`。
- 溯源：`utils/chatOnboarding.ts:8,15-25`（版本化键 `chat_onboarding_seen_v1`＋读写逻辑，`d8301d9`；旧 sessionStorage 键已废弃）；`app/(main)/chat/components/OnboardingModal/index.tsx:49-58`（首访判定＋确认写 v1）；`components/MainTabBar/index.tsx:117-144`（徽标渲染）。
- 备注：与 E2E-02-08（生成中切标签页徽标）互补：本例验证「持久化面」，E2E-02-08 验证「时序面」。
