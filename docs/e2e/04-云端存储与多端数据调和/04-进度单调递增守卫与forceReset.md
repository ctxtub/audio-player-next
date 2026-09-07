# E2E-04-04 · 进度单调守卫 vs forceReset 例外

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-04-04` |
| 所属功能套件 | `04-云端存储与多端数据调和` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P1` |
| 自动化类型 | `AUT-NODE+AUT-API` |
| 执行调度 | 阶段 1: 无状态服务端守卫基石（全局队列第 2 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{E2E_DB_URL}}` 中 seed 用户/访客进度行（`nextParagraphIndex=3`，指向 `{{E2E_STORY_4P}}`）；AUT-NODE 经 `createCaller` 直连 `playback.saveProgress`。
- 步骤：1) 以**无** `forceReset` 保存 `nextParagraphIndex=1`（旧端低索引）；2) 以 `forceReset=true` 保存 `nextParagraphIndex=0`；3) 再以无 `forceReset` 保存 `nextParagraphIndex=1`；4) 双设备次序变体（A 高索引在途、B forceReset 后 A 的低/高索引到达）。
- UI 断言：不适用（服务端语义）。
- 音频/浏览器断言：不适用。
- 网络/数据断言：核心断言——步骤 1 返回**旧行**（低索引被拒，DTO 为既有值不落库）；步骤 2 接受 0（forceReset 例外放行）；步骤 3 从 0 起正常推进；`remainingAllowedMs`、`sourceId` 不被步骤 1 污染。
- 清理：删进度行。
- 证据要求：`db.txt`（三次调用后行值）、caller 返回值记录（`db.txt` 附录）。
- 溯源：`lib/server/playbackProgress.ts:76-80,114-118`（`!input.forceReset && nextParagraphIndex < existing.nextParagraphIndex` → 返回旧行）；`stores/playbackProgressStore.ts:455-462`（`replayFromStart` 携带 `forceReset` 的客户端来源）。
- 备注：服务端行为已核对为确定性守卫，本例为守卫语义的回归锚点（非假设）。
