# StoryAudio 单 track 与 30 天缓存

功能域：07-故事库与作品资产（M9-C1 T3）

## 用户目标

任一 Work 的任意长度正文，播放时只暴露**一个**授权音频资产（一个总时长、一条时间轴）：长文在服务端内部安全分块合成、校验后拼接封装为一个 canonical 对象并原子发布；暂停/恢复/重播/跨路由/刷新在 30 天内命中同一资产、不再重复 TTS；超过 30 天滑动 TTL 后按原 profile 重建；内部 chunk 不授权、不独立播放、不写进度、不刷新 TTL。

## 前置条件

- `SINGLE_TRACK_AUDIO_ENABLED=1`（或 `NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED=1`）显式开启时才走单轨读路径；生产默认关闭（fail closed）。
- 关闭时完整回退旧 Segment canonical 路径；旧 `StoryAudioSegment` 与对象**暂不物理删除**。
- 旧 Work 无资产时按需 lazy 物化整篇单轨资产（绝不暴露 N 个播放项）。
- 真实 OpenAI 禁止进入自动测试；L2/L3 使用 fake TTS 与本地存储。

## 操作步骤

1. 已入库 Work 首播 → `storyAudio.ensure({ workId, sessionId })` 物化整篇单轨资产，卡片/Mini/Expanded 读取同一 `audioAssetId` 与同一时间轴。
2. 暂停后恢复 / 重播 / 切走再回 → 命中 ready 资产，TTS 调用数不增加。
3. 距上次访问超过 30 天再播放 → 旧资产判过期，按冻结 profile 重建单轨资产。
4. 分块合成中任一 chunk 失败 → 整个 Asset `failed`，临时对象清理，已发布对象不产生。
5. 手机与桌面（chromium + webkit）重复 1–4。

## 验收标准

1. **一 Work 一 Asset**：`storyAudio.getProjection` / `getPlaybackManifest` 在开关开启时只返回一个 `singleTrack`（`assetId`/`durationMs`/`byteLength`/`checksum`/`playbackUrl`/`positionMs`），`segments` 为空；授权 URL 只有 `/api/audio/assets/:assetId` 一个。
2. **总时长 = 拼接整轨时长**：服务端对内部 chunk 逐个校验后拼接，`durationMs` 等于拼接字节的真实 MP3 帧时长；`checksum` 覆盖拼接后字节。
3. **内部 chunk 不可读取**：chunk 为内部临时对象，无授权路由；发布完成后临时对象清空；任一 chunk 失败 → 整个 Asset 失败且无残留临时对象。
4. **暂停恢复不重复 TTS**：同一 identity 在 TTL 内二次 ensure 的 TTS 调用数为 0；并发 ensure 只合成整篇一次（single-flight + lease fencing）。
5. **30 天内复用、过期重建**：`lastAccessedAt` 滑动 TTL=30 天；授权读取限频刷新；超期后重建。
6. **旧请求不抢播**：lease fencing 下过期持有者不得覆盖新结果；身份相同返回同一 Asset。
7. **开关回退**：`SINGLE_TRACK_AUDIO_ENABLED` 关闭时行为与旧 Segment 路径一致（旧 Segment 不物理删除）。

## 边界与异常

- 无授权/跨主体 Work → `WORK_NOT_FOUND`（不泄漏存在性）；Trash Work 仅 Anchor 匹配可 ensure。
- 空正文/无有效 MP3 chunk → `AUDIO_SYNTHESIS_FAILED`，不得标 ready。
- 存储 put 失败 → `AUDIO_STORAGE_FAILED`，lease 释放，可重试。
- 读取越权/对象缺失 → 401/404，与 Segment 路由同口径。
- 进度 positionMs 服务端 clamp 到 `[0, durationMs]`，单调守卫拒绝回退写入。

## 实现参考

- 领域层：`lib/audio/asset.ts`（identity / chunk plan / 校验 / 拼接 / TTL / progress clamp）
- 服务层：`lib/server/storyAudioAsset.ts`（ensure / projection / lease / GC）
- 读取：`lib/server/audioAssetRead.ts`、`app/api/audio/assets/[assetId]/route.ts`
- 开关：`lib/audio/singleTrackFlag.ts`
- 数据模型：`prisma/schema.prisma` `StoryAudioAsset` / `GuestStoryAudioAsset` / `StoryAudioProgress` / `GuestStoryAudioProgress`（expand-only）
- 验证套件：`tests/integration/audio/single-track-asset.integration.test.ts`（`exec-single-track-asset`）、`tests/system/browser/scenarios/story-audio-single-track.spec.ts`（`exec-l3-story-audio-single-track`，chromium + webkit）
