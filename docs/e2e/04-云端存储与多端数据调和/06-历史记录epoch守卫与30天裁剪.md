# E2E-04-06 · 生成/提示词历史 epoch 守卫与 30 天裁剪

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-04-06` |
| 所属功能套件 | `04-云端存储与多端数据调和` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P2` |
| 自动化类型 | `AUT-NODE+AUT-API` |
| 执行调度 | 阶段 6: 云端数据正确性与多端调和（全局队列第 48 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{GUEST_FRESH}}`；mock 放慢流使 epoch 窗口可注入；`{{E2E_USER_A}}`/`{{E2E_USER_B}}` 就绪。
- 步骤：1) 访客生成一次故事（记录 `GenerationHistory` 增量）；2) 触发预载续写（验证 `recordHistory=false` 不入库，联动 E2E-02-03）；3) 流在途时登出→登录 `{{E2E_USER_B}}`（epoch 跃迁）；4) 提示词历史重复使用同一 prompt ×2 → `useCount`；5) seed 一条 `lastUsed` 超过 30 天的 `PromptHistory` 后读取列表。
- UI 断言：历史面板/提示词建议不显示另一身份的条目；30 天旧条目不再出现。
- 音频/浏览器断言：不适用。
- 网络/数据断言：核心断言——预载不入历史库；epoch 跃迁后旧身份的在途写入结果被丢弃（`epoch !== accountEpoch`）；`useCount` 递增；读取时 30 天外行被 `deleteMany` 剪除。
- 清理：删历史行；清 cookie。
- 证据要求：`db.txt`（行集与 useCount）、`console.json`。
- 溯源：`stores/preloadStore.ts:84-150`（`:93` `recordHistory:false`）；`stores/generationHistoryStore.ts:47,60-72`（epoch 捕获/校验）；`stores/promptHistoryStore.ts:115,218-233`（epoch）；`lib/server/promptHistory.ts:10-11,35-38,57-58`（30 天剪除、`useCount` upsert）。
- 备注：删除同步（历史面板删除→DB deleteMany）并入本例步骤 2 后追加一次删除操作。W2D（2026-09-09，隔离 `:32231`，见 `.e2e-results/E2E-W2D-05-09/report.md`＋`.e2e-results/E2E-W2D-CONV/report.md`）：预载不入库（GuestGenerationHistory 4＝故事数）＋epoch 捕获/校验代码确认（四 store＋accountSync，终态隔离活体 R1 565/R2 459/R3 482ms）；30 天裁剪与 useCount 未重跑，沿用既有结论。
