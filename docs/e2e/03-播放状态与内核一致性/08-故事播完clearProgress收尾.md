# E2E-03-08 · 故事播完→clearProgress 收尾一致

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-03-08` |
| 所属功能套件 | `03-播放状态与内核一致性` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P1` |
| 自动化类型 | `AUT-BROWSER` |
| 执行调度 | 阶段 4: 播放状态机深度一致性（全局队列第 21 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{GUEST_FRESH}}`；seed 进度行 `nextParagraphIndex=3`（最后一段）。
- 步骤：1) 断点就绪→播放最后一段至结束。
- UI 断言：浮窗隐藏；播放页回到空闲；无残留段落徽标。
- 音频/浏览器断言：`audio.paused=true`；无自动从头重播。
- 网络/数据断言：`playback.clearProgress` 调用；DB 进度行删除。
- 清理：无（行已被删）。
- 证据要求：`network.json`、`db.txt`、`ui-finished.png`。
- 溯源：`stores/playbackProgressStore.ts:521-530`；`components/AudioControllerHost/index.tsx:321-356`。
