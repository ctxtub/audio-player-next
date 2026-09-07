# E2E-03-05 · 断点恢复 remainingAllowedMs=null→有声而 UI 未进入播放态

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-03-05` |
| 所属功能套件 | `03-播放状态与内核一致性` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P0` |
| 自动化类型 | `AUT-BROWSER` |
| 执行调度 | 阶段 4: 播放状态机深度一致性（全局队列第 25 项） |
| 待验证假设 | ⚠️ H-10 |

## 用例规格

- 前置条件/夹具：`{{GUEST_FRESH}}`（cookie 保留）；seed 访客进度行 `remainingAllowedMs=null`、`nextParagraphIndex=2`。
- 步骤：1) 刷新进入 `/chat`；2) 观察浮窗「断点就绪/第 3/4 段」；3) 点击播放；4) 采样播放后 0.5s/2s。
- UI 断言：若音频可闻而浮窗标题显示「待创作」或按钮仍为播放图标，记为声画分歧。
- 音频/浏览器断言：`audio.paused=false`、`currentTime` 递增；段落从第 3 段开始（文本校验 via 卡片高亮/进度徽标）。
- 网络/数据断言：`playback.getProgress` 返回该行；`tts.synthesize` 以第 3 段文本调用（mock 端日志）。
- 清理：清进度行、清 cookie。
- 证据要求：`audio.json`、`ui-resume-null-budget.png`。
- 溯源：`stores/playbackStore.ts:250`（`start()` 对 `remainingMs===null` 早退→`isPlaying` 永不置真）；`stores/playbackProgressStore.ts:249,262`（null 透传）。
