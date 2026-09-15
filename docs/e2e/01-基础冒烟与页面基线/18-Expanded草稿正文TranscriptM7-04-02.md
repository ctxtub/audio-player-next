# Expanded 草稿正文 Transcript（M7-04-02）

功能域：01-基础冒烟与页面基线

## 用户目标

有 Draft 播放会话时打开全局 Expanded，看到「查看正文」：点击后在 Expanded 内打开只读 TranscriptView（路由不变，内容逐字等于 M5 Session.storyText，无编辑面）；点「返回控制」回到控制面，且会话/进度/音频宿主全不变；promotion 成功（source 切 work，sessionId 不变）不强制关闭 transcript，之后经「打开作品详情」进入该作品的 `/library/[workId]` 详情；任何路径不产生 `/library/fake-id`；开合不写 global UI Store；Work 查看正文导航（M7-04-01）回归不变。

## 前置条件

- M5 PlaybackSessionStore（`source` 为 draft/work，`storyText` 为正文唯一来源）/ playbackStore / AudioControllerHost ownership 冻结；Expanded 开关为纯 UI state（`nowPlayingUiStore.isExpanded`，无 transcript 字段）。
- M7-01 Expanded Surface（普通路由切换不自动关闭，`§44`）、M7-02 P3A（无上一段/下一段，`§40`）、M7-03 P3C、M7-04-01 Work 查看正文导航冻结。
- M7-04 范围切分：本轮只解决 Draft 查看正文只读面；继续创作边界（M7-04-03）、`/player` 清账（M7-04-04）均不在本轮。
- 旧 `/player` 物理保留（M9 前不删除），本轮不触达。

## 操作步骤

1. 建立 Draft 播放会话并暂停驻留（L2 经 `setActiveStory` + pause；L3 经 E2E-only `seedDraftTranscript` 本地 seed，不建 server Anchor），记录 `sessionId/source/storyText/audioCount/isPlaying`。
2. 点 Mini 元数据区打开 Expanded：断言 URL 不变，`sessionId` 不变，动作区出现「查看正文」（`expanded-view-transcript-button`，文案精确；`expanded-view-story-button` 为 0）。
3. 点「查看正文」：断言 Expanded 保持打开（`isExpanded` 全程 true，`data-view=transcript`），URL 不变，`expanded-transcript` 可见，正文逐字等于 Session.storyText，无 textarea/input/contenteditable，`sessionId/source` 不变，无新增导航与合成。
4. 点「返回控制」：断言 transcript 收起（`data-view=controls`），Expanded 保持打开，URL 不变，`sessionId/source/status/isPlaying/audioUrl/audioCount` 全不变（不 pause、Host 不 remount）。
5. 再次打开 transcript 后模拟 promotion（L2 经同 sessionId 切 source；L3 经 E2E-only `simulateDraftPromotedToWork`，复刻 server promotion 本地 effect）：断言 transcript 保持打开，仍展示同一 storyText，出现「打开作品详情」（`expanded-open-work-detail-button`）；promotion 前该入口 absent（不越界进 M4 流程）。
6. 点「打开作品详情」：断言 Expanded 关闭，URL 变为 `/library/[精确 workId]`（复用 Work 先关后导同一路由出口），`sessionId` 不变，无新增 `beginSession` 与 `tts.synthesize`。
7. 全程收集 Library 目标 URL：断言无 `fake/undefined/null/NaN` 形态；空 storyText / idle 下无入口（fail-closed）。
8. 断言 Work 会话回归：Work 展示 `expanded-view-story-button` 精确导航，无 transcript 口（M7-04-01 冻结）。

## 验收标准

- `source.kind === 'draft'` 且有可用 `storyText`（非空、非 idle）即展示「查看正文」（Actions 内同文案、独立 testid）；点击只切 Expanded 内部局部 view（`controls ↔ transcript`），不导航、不拼凑 `/library/[fake-id]`、不写 global UI Store。
- TranscriptView 内容恒为 Session.storyText 原文（只读；无编辑面；无正文时空态「暂无正文」，不伪造）。
- 返回控制只切回 controls，不改变 Session/Transport/Audio（sessionId 不变、不 pause、Host 不 remount），URL 不变。
- promotion 成功（sessionId 不变）不强制关闭 transcript；promotion 后 transcript 内展示「打开作品详情」，复用 Work 先关后导同一路由出口（`router.push` 唯一调用点）。
- 空 source / `idle` / 空白正文 → 无入口（fail-closed）；Work 面行为回归不变。
- UI 经既有命令面（局部 useState + UI store 关闭 + Next 路由）；不直接操作 `<audio>`，不直接改 Session 字段；不建 Expanded 本地导航状态。

## 边界与异常

- 空/空白/非字符串 storyText → 无入口；已打开时 storyText 缺失 → 空态（不抛错、不导航、不改播放）。
- `idle` / 空 source → 无入口。
- promotion 前 transcript 内无「打开作品详情」（不越界进 M4 真实 promotion 触发面；真实 M4 continuation 触发归 M4，M7 只保证不强制关闭 + 入口复用）。
- 新 Session（sessionId 变化）或 Expanded 关闭 → 局部 view 回落 controls；promotion（同 sessionId）→ 保持 transcript。
- 尾斜杠/大小写等路由归一仍归 Work 口（本轮不重复覆盖）。
- 慢沙箱一律确定性轮询（`expect.poll`），无长 sleep；Chromium/WebKit 双跑，`retries=0`。

## 实现参考

- `components/NowPlaying/draftTranscript.ts`（`resolveDraftTranscriptText`/`resolveTranscriptDisplayText`/`shouldShowDraftTranscript`/`decideDraftTranscript` + 常量）
- `components/NowPlaying/TranscriptView.tsx`（只读面 + 空态 + 返回控制 + promotion 入口插槽）
- `components/NowPlaying/NowPlayingActions.tsx`（Draft 口 additive；Work 口冻结优先）
- `components/NowPlaying/useExpandedNowPlayingViewModel.ts`（`canViewTranscript`/`transcriptText`/`sessionId` additive）
- `components/NowPlaying/ExpandedNowPlaying.tsx`（`ExpandedLocalView` 局部 view + `handleViewTranscript`/`handleBackToControls` + promotion 复用 `handleViewStory`）
- `components/NowPlaying/ExpandedNowPlaying.module.scss`（transcript additive 样式）
- `components/NowPlaying/index.ts`
- `components/PlaybackSessionProbe/index.tsx`（E2E-only `seedDraftTranscript`/`simulateDraftPromotedToWork` + `storyText` 透传）
- `tests/test-catalog.yaml`（`expanded-draft-transcript`）
