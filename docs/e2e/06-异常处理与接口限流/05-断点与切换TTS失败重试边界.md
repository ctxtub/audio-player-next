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

## Toast 语义定稿（缺陷 #9，接受现状）
- 段落切换快速失败时，过程性 toast 可被后续终态失败 toast 经 `GlassToast` 单例替换（`components/ui/GlassToast.tsx:119-130`：`show` 清 `hideTimer` 后直接 `root?.render`，单容器、无队列/最短展示/多 toast）；终态失败提示优先。
- 过程提示不构成成功/失败证据；成功/失败仅以本规范逐层断言（浮窗可重试态、`audio.paused`、进度行保留、同段重试）为准，不得以过程 toast 是否可见判分。
- 仅当等待通常超过约 500–800ms 且需要防重复点击/解释等待时，才考虑播放器局部 loading 状态；本缺陷不做该 UI 改造。
- 失败调用点：`stores/playbackProgressStore.ts:370`（`playParagraph` 合成失败终态提示）；`components/AudioControllerHost/index.tsx:358-362`（`handleEnded` 段落切换失败终态提示）。两者竞态时以后一次 `show` 为准。
