# E2E-04-10 · 摘要 summarize guardedProcedure 并发与限流边界

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-04-10` |
| 所属功能套件 | `04-云端存储与多端数据调和` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P1` |
| 自动化类型 | `AUT-API` |
| 执行调度 | 阶段 1: 无状态服务端守卫基石（全局队列第 3 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{GUEST_FRESH}}`；会话含 ≥5 条普通消息（触发摘要阈值）；mock 放慢流。
- 步骤：1) AUT-API 直连 `agent.summarize`：无 cookie 匿名调用应 401（`745de3c` 后为 guardedProcedure，不再无鉴权可达）；具名访客/登录 cookie 放行；2) 流式生成进行中并发触发 summarize；3) 读取 DB 与 UI 摘要消息位置；4) 限流边界：访客同窗口第 7 次 429（guest 6/分钟），登录第 21 次 429（authed 20/分钟）。
- UI 断言：摘要消息插入于最后一条已归档消息之后；流式进行中的 delta 不被摘要插入错位（不同消息各写各的）。
- 音频/浏览器断言：不适用。
- 网络/数据断言：核心断言——匿名 `summarize` 返回 `UNAUTHORIZED`（401）且零 LLM 触达；具名访客/登录放行；限流 guest 6 / authed 20 次/分钟（超限 `TOO_MANY_REQUESTS`）；并发流与摘要写不互相覆盖；快照保存包含摘要行（delivered）。交叠实证 `overlapProven:false`（并发交叠证据仍待补，见备注）。
- 清理：清空会话、清 cookie。
- 证据要求：`network.json`、`db.txt`（消息序）。
- 溯源：`lib/trpc/routers/agent.ts:103-112`（`summarize: guardedProcedure`＋guest 6/authed 20 限流）；`stores/chatStore.ts`（摘要插入与流 delta 目标分离）；回归测试 `tests/test-agent-summarize-guard.ts`（匿名 401 零 LLM/访客登录放行/限流边界）。
- 备注：`745de3c` 前“无鉴权 200 可达”刻画已过期作废；匿名配额敞口已由 guardedProcedure＋限流收敛。`overlapProven:false`——并发交叠（流式 delta 与摘要插入错位互斥）实证仍待补；本例与 E2E-06-06 同属鉴权一致侧，不再构成矩阵两端。W2D 重验（2026-09-09，隔离 `:32231`，见 `.e2e-results/E2E-W2D-04-10/report.md`）：匿名 401＋访客 6 放行/第 7 次 429＋登录 20 放行/第 21 次 429 活体全过；`overlapProven:false` 保持，判 CONDITIONAL-PASS。
