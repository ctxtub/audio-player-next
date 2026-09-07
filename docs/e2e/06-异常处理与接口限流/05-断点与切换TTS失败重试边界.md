# E2E-06-05 · 断点恢复/段落切换中 TTS 失败→可重试边界

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-06-05` |
| 所属功能套件 | `06-异常处理与接口限流` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P2` |
| 自动化类型 | `AUT-BROWSER` |
| 执行调度 | 阶段 7: 错误注入、断流与限流收口（全局队列第 53 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{GUEST_FRESH}}`（cookie 保留）；seed 进度行 `nextParagraphIndex=2`；mock 注入下一次 TTS 失败。
- 步骤：1) 刷新进入断点就绪；2) 点击播放（本次合成失败）；3) 观察浮窗态；4) 移除注入后再点播放；5) 变体：段落切换（`handleParagraphEnded`）路径注入失败。
- UI 断言：失败后浮窗保持「断点就绪/第 3/4 段」或等价可重试态；移除故障后重试成功且段落正确衔接。
- 音频/浏览器断言：失败时 `audio.paused=true`；重试成功后从第 3 段起播（`currentTime` 递增）。
- 网络/数据断言：`playback.getProgress` 命中 seed 行；重试以同一段文本再次 `tts.synthesize`；失败路径不删除进度行（可恢复性）。
- 清理：清进度行、清 cookie。
- 证据要求：`audio.json`、`ui-resume-tts-fail.png`、`db.txt`。
- 溯源：`stores/playbackProgressStore.ts:325-336`（`playParagraph` 失败保留 `isRehydratedReady` 可重试）；`stores/playbackProgressStore.ts:361`（`clearRehydratedReady` 仅成功路径调用）；`components/AudioControllerHost/index.tsx:321-356`（段落切换失败面）。
