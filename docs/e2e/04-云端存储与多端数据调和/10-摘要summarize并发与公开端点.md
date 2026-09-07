# E2E-04-10 · 摘要 summarize publicProcedure 并发边界

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
- 步骤：1) AUT-API 直连 `agent.summarize`（无 cookie 也应可达——publicProcedure）；2) 流式生成进行中并发触发 summarize；3) 读取 DB 与 UI 摘要消息位置。
- UI 断言：摘要消息插入于最后一条已归档消息之后；流式进行中的 delta 不被摘要插入错位（不同消息各写各的）。
- 音频/浏览器断言：不适用。
- 网络/数据断言：核心断言——`summarize` 无鉴权可达（publicProcedure 语义刻画）；并发流与摘要写不互相覆盖；快照保存包含摘要行（delivered）。
- 清理：清空会话、清 cookie。
- 证据要求：`network.json`、`db.txt`（消息序）。
- 溯源：`lib/trpc/routers/agent.ts:104-106`（`summarize: publicProcedure`）；`stores/chatStore.ts`（摘要插入与流 delta 目标分离）。
- 备注：无鉴权写路径为**已核对的实现语义**，先刻画再由评审判定是否登记风险；与 E2E-06-06（guardedProcedure 401）形成鉴权矩阵两端。
