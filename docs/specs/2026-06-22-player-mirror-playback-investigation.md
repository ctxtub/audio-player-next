# 调查记录 · /player AudioPlayer 是否镜像活跃播放

- 日期：2026-06-22
- 类型：调查 / 结论（无代码改动）
- 关联：账号绑定遗留跟进项「② /player 的 AudioPlayer 不镜像 chat 发起的活跃播放」

## 背景

历史跟进项记载：「PlaybackStatusBoard 倒计时能反映会话，但 player 内嵌 AudioPlayer 显示 0:00/待创作」，并预判需理顺 `AudioControllerHost / FloatingPlayer / playbackStore / player AudioPlayer` 的同步。

## 静态分析

- 全局唯一 `<audio>` 在 `components/AudioControllerHost`（挂于 `(main)` layout），经 `updatePlaybackProgress / handlePlaybackStart / handlePlaybackPause`（`app/services/storyFlow.ts`）回流到**同一个** `playbackStore`。
- `/player` 的 `AudioPlayer`（`app/(main)/player/components/AudioPlayer/index.tsx`）订阅 `playbackStore` 的 `currentTime / duration / isPlaying / playbackRate`；`FloatingPlayer` 订阅同一 store。
- 二者读同一份状态、由同一音频元素驱动，逻辑上无法分叉。「待创作」文案实际来自 `FloatingPlayer`（idle 标题兜底），不在 `AudioPlayer` 内。

## 活体复现（dev 预览，访客态）

1. `/chat` 发送「讲一个关于小狐狸找朋友的短故事」→ 真实生成 + TTS + 播放开始（全局 `<audio>`：`paused=false, duration≈144s`）。
2. 点底部「播放器」tab **客户端导航**至 `/player`（不刷新，保留 playbackStore）。
3. 观测 `AudioPlayer`：进度 `0:53 → 1:34 / 2:23`、播放按钮为「暂停」态、唱片旋转、倍速可用——**完整镜像活跃播放**（截图留证）。

## 结论

**该跟进项所述 gap 已不存在**，应在 player→chat 整合（`f904e5c`）退化 `/player` 为纯播放视图时被顺带修复。客户端导航场景下 `/player` 正确镜像 chat 发起的播放，无需额外接线。

- **例外（不视为缺陷）**：`playbackStore` 为内存态、未持久化；在 `/player` 执行**硬刷新**会丢失播放态（且 blob 音频地址失效无法恢复），表现为 0:00。属内存态固有行为，恢复成本高且收益存疑，不在本次处理。

## 衍生观察（独立小瑕疵，另行跟进）

`AudioPlayer` 的 `trackTitle` 取「最后一条 user 消息」，自动续写会写入「请继续故事」，故标题显示为「请继续故事」而非故事主题。属独立的展示文案问题，不影响镜像能力，建议单独优化（取故事会话首条 user 消息 / 故事标题）。
