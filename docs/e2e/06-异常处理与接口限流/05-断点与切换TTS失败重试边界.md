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
- 步骤：1) 刷新进入断点就绪；2) 点击播放（本次合成失败）；3) 观察浮窗态；4) 移除注入后再点播放；5) 变体 B：段落切换（`handleParagraphEnded`）路径注入失败（见下）；6) 慢流场景 C：`MOCK_SLOW_TTS_MS` 放大切换窗口（见下）。
- UI 断言：失败后浮窗保持「断点就绪/第 3/4 段」或等价可重试态；移除故障后重试成功且段落正确衔接。
- 音频/浏览器断言：失败时 `audio.paused=true`；重试成功后从第 3 段起播（`currentTime` 递增）。
- 网络/数据断言：`playback.getProgress` 命中 seed 行；重试以同一段文本再次 `tts.synthesize`；失败路径不删除进度行（可恢复性）。
- 清理：清进度行、清 cookie。
- 证据要求：`audio.json`、`ui-resume-tts-fail.png`、`db.txt`。
- 溯源：`stores/playbackProgressStore.ts:350`（`playParagraph` 失败保留 `isRehydratedReady` 可重试）；`stores/playbackProgressStore.ts:383`（`clearRehydratedReady` 仅成功路径调用）；`stores/playbackProgressStore.ts:443-459`（`handleParagraphEnded` 切换路径）；`components/AudioControllerHost/index.tsx:326-363`（段落切换失败面）。

## 变体 B · 段落切换路径 TTS 失败（R3，前置缺陷 #4 已修）

- 背景：主场景覆盖「断点恢复点击」路径；本变体覆盖自然播放至段尾经
  `handleParagraphEnded` 内 `playParagraph(next)` 的切换路径。曾因缺陷 #4
  （播完自动续写循环）被淹没而 UNVERIFIED；缺陷 #4 已修（`a565639`），具备补测条件。
- 前置：不断点 seed，自然播放第 2 段至段尾；`MOCK_FAIL_TTS=1` 在段尾前注入并保持。
- 步骤：1) 播放至段尾自动切换；2) 切换合成失败；3) 观察浮窗与音频态；4) 移除注入后手动重试。
- 断言：浮窗保持可重试态（不跳段、不增殖卡片）；`audio.paused=true`；
  进度行停在切换前索引（未删除、可恢复）；`GlassToast` 终态失败提示恰一次
  （过程 toast 可被替换，见下 Toast 语义）；移除注入后重试衔接下一段。
- 证据追加：`audio.json`、`network.json#tts_fail_switch`。

## 慢流场景 C · TTS 慢速放大切换窗口（R13）

- 背景：用已实现的 `MOCK_SLOW_TTS_MS=…` 把「断点恢复点击 → 合成返回」窗口放大，
  检验延迟窗口内的暂停意图不被覆盖（关联 E2E-03-04 暂停意图口径）。
- 前置：seed 进度行 `nextParagraphIndex=2`；`MOCK_SLOW_TTS_MS=3000`。
- 步骤：1) 刷新进入断点就绪；2) 点击播放；3) 合成返回前（3s 窗口内）点暂停；
  4) 合成返回后观察终态；5) 移除慢流后从断点段正常起播。
- 断言：窗口内暂停后终态保持暂停，不自动续播；合成返回不覆盖暂停意图；
  慢流移除后从第 3 段起播（`currentTime` 递增）。
- 证据追加：计时记录（注入延迟 vs 暂停时刻 vs 合成返回时刻）记入 `network.json`。

## Toast 语义定稿（缺陷 #9，接受现状）
- 段落切换快速失败时，过程性 toast 可被后续终态失败 toast 经 `GlassToast` 单例替换（`components/ui/GlassToast.tsx:119-130`：`show` 清 `hideTimer` 后直接 `root?.render`，单容器、无队列/最短展示/多 toast）；终态失败提示优先。
- 过程提示不构成成功/失败证据；成功/失败仅以本规范逐层断言（浮窗可重试态、`audio.paused`、进度行保留、同段重试）为准，不得以过程 toast 是否可见判分。
- 仅当等待通常超过约 500–800ms 且需要防重复点击/解释等待时，才考虑播放器局部 loading 状态；本缺陷不做该 UI 改造。
- 失败调用点：`stores/playbackProgressStore.ts:370`（`playParagraph` 合成失败终态提示）；`components/AudioControllerHost/index.tsx:358-362`（`handleEnded` 段落切换失败终态提示）。两者竞态时以后一次 `show` 为准。
