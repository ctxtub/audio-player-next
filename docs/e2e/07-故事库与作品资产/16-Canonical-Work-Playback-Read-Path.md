# Canonical Work 播放读路径与 Lazy 物化

功能域：07-故事库与作品资产（M8-04）

## 用户目标

已入库作品（Work）的播放从「每次重新 TTS + 临时 Blob」切换为「workId + segmentIndex + sessionId → storyAudio.ensureSegment → /api/audio/segments/:segmentId」canonical 路径：首播某段时 lazy 物化该段并可显示 preparation，随后重播/暂停恢复/跨路由/刷新恢复一律命中已就绪资产不再重新 TTS；Draft 仍走旧 ephemeral TTS；Draft 晋升时当前 Blob 不被打断。

## 前置条件

- M8-01/02/03 已冻结（schema/identity、storage 抽象+授权读取、canonical write+ensureSegment+lease fencing）。
- `CANONICAL_AUDIO_ENABLED=1`（或 `NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED=1`）显式开启时才走 canonical；生产默认关闭。
- 老 Work 可能无 Manifest；新请求按需 lazy 建 manifest + 物化被请求段，绝不首播全篇。

## 验收范围（oracle）

1. **Provider 选择**：Work + 开启 → ensureSegment；Draft 恒旧 tts.synthesize；关闭时 Work 亦旧路径。
2. **Segmentation SSOT**：Manifest 已存在 → 段落文本 SSOT = Manifest.segments[].text，不重跑未来版本切分；audio index == playback/progress index。
3. **Lazy**：lookahead 仍=1（当前 N 快结束 ensure N+1）；首播不生成整篇。
4. **复用**：同 segment 重播 TTS 不增加；pause/resume、路由导航、刷新水合均无额外 TTS；speed 1.5 合成仍 1.0。
5. **Stale**：A ensure 慢切到 B，A 结果 session 失配绝不播放（复用 M5 guard），A 资产可保留。
6. **Promotion**：播放中 Draft Blob 不打断；后续/重播 Work 段才走 canonical。
7. **Library 投影**：list/get 始终返回 {status, durationMs}（无 Manifest → missing/null；ready 才有 duration）。

## 禁项

- 不实现 storyStart offsets / binary-search durations / Story seek / M7 timeline / 改 M5 identity / speed 进资产身份 / 持久化 Draft / 生产默认开 / P3B。

## 关联实现与测试

- 读路径：`stores/playbackSessionStore.ts`、`lib/client/storyAudio.ts`、`lib/audio/canonicalFlag.ts`
- 投影：`lib/server/storyWork.ts`
- 验证套件：`tests/unit/audio/audio-work-playback-read.unit.test.ts` (`exec-audio-work-playback-read`)、`tests/integration/audio/audio-work-playback-read.integration.test.ts` (`exec-audio-work-playback-read-integration`)、`tests/system/browser/scenarios/canonical-work-playback.spec.ts` (`exec-l3-canonical-work-playback`)
