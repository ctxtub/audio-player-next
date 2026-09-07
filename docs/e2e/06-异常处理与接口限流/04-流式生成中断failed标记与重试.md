# E2E-06-04 · 流式生成中断→failed 标记与重试上下文

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-06-04` |
| 所属功能套件 | `06-异常处理与接口限流` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P1` |
| 自动化类型 | `AUT-BROWSER` |
| 执行调度 | 阶段 7: 错误注入、断流与限流收口（全局队列第 52 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{GUEST_FRESH}}`；mock 注入流中途断开（`MOCK_ABORT_LLM=1`，断在 50% token 处）。
- 步骤：1) 提交生成；2) 等待断流；3) 观察失败标记；4) 点击重试；5) 检查 DB 快照。
- UI 断言：用户消息标记 failed 且带重试入口；assistant 占位收口为失败态（不残留半截文本为终态）；重试后仅新增一条完整回复。
- 音频/浏览器断言：失败不触发自动播放；重试成功后自动播放（如适用）恰一次。
- 网络/数据断言：核心断言——SSE 连接中止；`chat.saveConversation` 快照含 failed 行或不含半截 assistant 行（与 UI 一致，联动 E2E-02-10 的过滤语义）；重试请求上下文不含 failed 消息。
- 清理：恢复 mock；清空会话。
- 证据要求：`ui-stream-abort.png`、`network.json`（SSE 中止点）、`db.txt`。
- 溯源：`app/services/chatFlow.ts:47-50,155,165,178`（全局中止处理）；`stores/chatStore.ts:233-249,386-403`（failed 标记与重试）；mock 断流注入见 [execution-isolation.md](../execution-isolation.md) §3。
