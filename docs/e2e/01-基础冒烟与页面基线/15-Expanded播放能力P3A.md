# Expanded 播放能力 P3A（M7-02）

功能域：01-基础冒烟与页面基线

## 用户目标

有播放会话时打开全局 Expanded，可对当前 Segment 完成播放控制：看到本段时间轴（本段 01:24 / 02:16）与段落 badge（第 4 / 12 段），点击进度条与键盘 ±5s/Home/End 均可 seek 且越界钳制，切换七档倍速即时生效且不改默认配置，从头播放按 Work/Draft 各自语义重开；Mini 与 Expanded 同 Session 下即时同步；全程不出现上一段/下一段与整篇时间轴。

## 前置条件

- M5 PlaybackSessionStore（现在听什么）/ playbackStore（Transport）/ playbackSessionFlow（runtime action）/ AudioControllerHost（唯一 audio owner）ownership 冻结；Expanded 开关为纯 UI state（`nowPlayingUiStore.isExpanded`）。
- M7-01 Expanded Surface（Modal Bottom Sheet / Side Panel、Mini suppress、自动关闭唯一条件、焦点契约）冻结。
- 旧 `/player` AudioPlayer 物理保留（M9 前不删除），正常入口已为 `openExpanded()`。

## 操作步骤

1. 建立 Work 播放会话并暂停驻留（真实 `beginSession` + 首段合成 + pause），记录 `sessionId/source/speed/paragraph` 与 `currentTime/duration`。
2. 点 Mini 元数据区打开 Expanded：断言 URL 不变，`sessionId/source` 不变，Expanded 显示 Session.title、Session.voiceId 对应语音标签、第 X/Y 段 badge、本段时间轴。
3. 在 Expanded 时间轴点击 75% 处：断言 `audio.currentTime` 跳至约 75% duration，`sessionId/source/nextParagraphIndex` 不变，无新增 `beginSession` 与 `tts.synthesize`。
4. 聚焦时间轴按 ArrowRight（+5s）、ArrowLeft（-5s）、Home（段首）、End（段尾）：每次均钳制 [0, duration]；duration=0 时 keyboard/click 均为 no-op 不抛错。
5. 打开倍速菜单选择 1.5x：断言 Transport.playbackRate 与 Session.speed 同为 1.5，Anchor speed 已上报，用户配置默认 speed 仍为旧值，无新增 `tts.synthesize`。
6. 点从头播放（Work）：断言新 `sessionId`（UUID v4）+ position 0 + completedAt 保留（Progress 行保留首完时间），首段重新合成出声；Draft 草稿 restart 则断言同 Session 内回 0 且 `continuationMode=finite`，播到尾段停止不触发 AI continuation。
7. 在 Expanded 操作的同时观察 Mini：标题/状态/段落即时一致；反向在 Mini 暂停后 Expanded 主按钮同步为播放。
8. 断言 Expanded 内无“上一段/下一段”按钮、无整篇 duration 时间轴；时间轴明确标注“本段”；ARIA slider（role/min/max/now/text/disabled/tabIndex）完整。

## 验收标准

- Title / Voice / Play / Pause 全部走 M5 ownership（UI→flow/Transport→Session+Host；UI 不直接 set session 字段或操作 `<audio>`）。
- P3A Timeline 恒为当前 Segment（如 01:24 / 02:16、第 4/12 段），不伪装整篇 duration。
- click seek + keyboard ±5s + Home/End 全 clamp；duration=0/unknown fail-safe；ARIA slider 完整。
- 倍速七档（0.8/0.9/0.95/1.0/1.05/1.1/1.5）：Session.speed + Transport.playbackRate + Anchor 持久化三同步；不写回 UserConfig 默认 speed；不触发新 TTS；无 Expanded-local speed state。
- 段落 badge 正确；明确无上一段/下一段；无 story-level timeline（M8 P3B）。
- Restart：Work → 新 UUID + position 0 + completedAt 保留；Draft → 当前文本从头播放 + finite；Draft restart 到结尾不触发 AI continuation。
- rehydrated ready 无 `isRehydratedReady` 特殊分支。
- 段落 identity（nextParagraphIndex）→ Session；段内 currentTime/duration → Transport；seek 不误写 durable paragraph progress；段落切换不换 UUID（非 restart）。
- Mini 与 Expanded 同时观察同一 Session/Transport，一边操作另一边即时同步。
- UI 不碰 StoryWork/progress identity；不拼 continuation Prompt。

## 边界与异常

- duration 未知/0 时 seek 为 no-op，不抛错不换 session。
- 非法倍速值直接忽略，不写 Transport 不落盘。
- `synthesizing/hydrating` 时主按钮置灰，不触发播放。
- `ended` 时主播放键需经从头播放重开（Play 置灰、Restart 可用）。
- 慢沙箱一律确定性轮询（`expect.poll`），无长 sleep；Chromium/WebKit 双跑，`retries=0`。

## 实现参考

- `components/NowPlaying/PlaybackTimeline.tsx`
- `components/NowPlaying/PlaybackControls.tsx`
- `components/NowPlaying/PlaybackRateControl.tsx`
- `components/NowPlaying/ParagraphStatus.tsx`
- `components/NowPlaying/useExpandedPlaybackControls.ts`
- `components/NowPlaying/useExpandedNowPlayingViewModel.ts`
- `components/NowPlaying/ExpandedNowPlaying.tsx`
- `components/NowPlaying/NowPlayingHeader.tsx`
- `components/NowPlaying/types.ts`
- `stores/playbackSessionStore.ts`（`setSpeed` + Work/Draft restart）
- `stores/playbackStore.ts`（`clampSegmentSeekTarget` + seek fail-safe）
- `app/services/playbackSessionFlow.ts`（`seekCurrentSegment`/`seekRelative`/`setPlaybackRate`/`restartCurrentSession`）
- `tests/test-catalog.yaml`（`expanded-playback-capabilities-p3a`）
