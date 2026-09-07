# E2E-06-03 · TTS 合成失败→播放停止不僵尸

| 属性 | 设定值 |
| --- | --- |
| 规范 ID | `E2E-06-03` |
| 所属功能套件 | `06-异常处理与接口限流` |
| 规范层级 | 单用例规范（Canonical Test Spec） |
| 优先级 | `P1` |
| 自动化类型 | `AUT-BROWSER` |
| 执行调度 | 阶段 7: 错误注入、断流与限流收口（全局队列第 51 项） |
| 待验证假设 | — |

## 用例规格

- 前置条件/夹具：`{{GUEST_FRESH}}`；mock 注入 `tts.synthesize` 一次 500（`MOCK_FAIL_TTS=1`）。
- 步骤：1) 故事卡点「播放故事」（首次合成即失败）；2) 变体：播放中让下一段合成失败（预载后播放触发点）；3) 各采样 UI 与音频。
- UI 断言：按钮回到可再播；无「正在播放」假态残留；toast「语音生成稍有延迟」或等价提示出现一次。
- 音频/浏览器断言：`audio.paused=true`；`blob:` src 未被赋值为失败响应；浮窗不显示进行中。
- 网络/数据断言：`tts.synthesize` 500 后无重试风暴（单次或既有重试链耗尽）；`playback.saveProgress` 不因失败回写错误段落；快照保存不含失败音频引用。
- 清理：恢复 mock；清进度行。
- 证据要求：`audio.json`、`ui-tts-fail.png`、`network.json`。
- 溯源：`app/services/storyFlow.ts:163-183`（`playStoryText` 合成失败路径）；`stores/playbackStore.ts`（播放失败复位）；mock 注入见 [execution-isolation.md](../execution-isolation.md) §3。
