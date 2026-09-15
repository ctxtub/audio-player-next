# Expanded 查看正文 Work 导航（M7-04-01）

功能域：01-基础冒烟与页面基线

## 用户目标

有 Work 播放会话时打开全局 Expanded，看到「查看正文」：点击后 Expanded 先关闭再进入该作品的 `/library/[workId]` 详情，且播放继续（会话/进度/音频宿主全不变）；已在同一作品详情时只关闭不重复导航；在其它作品详情时正常回到当前播放作品；Draft 会话下不出现该按钮、不产生任何 Library 导航；动作区始终只有播放伴随的内容导航，不出现故事管理操作。

## 前置条件

- M5 PlaybackSessionStore（`source.workId` 为 Work 唯一合法 identity）/ playbackStore / AudioControllerHost ownership 冻结；Expanded 开关为纯 UI state（`nowPlayingUiStore.isExpanded`）。
- M7-01 Expanded Surface（普通路由切换不自动关闭，`§44`）、M7-02 P3A（无上一段/下一段，`§40`）、M7-03 P3C 冻结。
- M7-04 范围切分：本轮只解决 Work→Story Detail 导航；Draft Transcript（M7-04-02）、继续创作边界（M7-04-03）、`/player` 清账（M7-04-04）均不在本轮。
- 旧 `/player` 物理保留（M9 前不删除），本轮不触达。

## 操作步骤

1. 建立 Work A 播放会话并暂停驻留（真实 `beginSession` + 首段合成 + pause），记录 `sessionId/source/audioUrl/audioCount/isPlaying`。
2. 点 Mini 元数据区打开 Expanded：断言 URL 不变，`sessionId` 不变，动作区出现「查看正文」（`expanded-view-story-button`，文案精确）。
3. 点「查看正文」：断言 Expanded 关闭，URL 变为 `/library/[A 精确 id]`（与创建返回 id 逐字相等），`sessionId/source` 不变，暂停态不变（`isPlaying=false` 不翻转），`audioUrl` 不变，`audio` 计数不变（Host 不重挂），无新增 `beginSession` 与 `tts.synthesize`。
4. 在 `/library/[A]` 上再次打开 Expanded 并点「查看正文」：断言只关闭（`pushState` 计数 0），URL 仍为 `/library/[A]`，`sessionId` 不变，无新增 `beginSession`。
5. 进入 `/library/[B]`（B 为另一真实作品，会话仍为 A）：打开 Expanded 点「查看正文」：断言回到 `/library/[A]`，`sessionId` 仍为 A，无新增 `beginSession` 与 `tts.synthesize`。
6. 全程收集 Library 目标 URL：断言无 `fake/undefined/null/NaN` 形态（Draft 隐藏面由 L1/L2 覆盖：Draft 会话下按钮与动作区均不渲染）。
7. 断言动作区仅含一个按钮（查看正文）；Expanded 内无上一段/下一段、无 Transcript、无创作入口、无 `/player` 跳转。

## 验收标准

- `source.kind === 'work'` 即展示「查看正文」；目标恒为 `/library/${workId}`（`workId` 直接消费 `PlaybackSourceRef.workId`，不经标题/哈希/消息 id 猜）。
- 点击顺序固定：`closeExpanded()` → 按需 `router.push(target)`；播放继续（不 pause，会话/进度/音频宿主全不变）。
- 已在同一 `/library/[workId]`：只 `closeExpanded()`，不重复 push。
- 在 `/library/[其它 id]`：正常 push 当前 Work id。
- Draft 不生成 `/library/fake-id`（Draft 下不出现按钮与动作区占位 → 无 Library 导航）。
- Actions 不包含 Library 元数据管理（重命名/收藏/回收站/删除等继续归 Library Detail 面）。
- UI 经既有命令面（UI store 关闭 + Next 路由）；不直接操作 `<audio>`，不直接改 Session 字段；不建 Expanded 本地导航状态。

## 边界与异常

- 非法 `workId`（0/负数/小数/非整数）→ 无目标、无按钮（fail-closed，不拼凑）。
- 空 source / `idle` → 无按钮。
- 目标缺失时点击为 no-op（不抛错、不导航、不改播放）。
- 尾斜杠路径归一后比较（`/library/481/` 视为同一 Detail）。
- 慢沙箱一律确定性轮询（`expect.poll`），无长 sleep；Chromium/WebKit 双跑，`retries=0`。

## 实现参考

- `components/NowPlaying/workViewStoryNavigation.ts`（`resolveWorkLibraryTarget`/`isSameLibraryDetail`/`decideWorkViewStoryNavigation` + 常量）
- `components/NowPlaying/NowPlayingActions.tsx`
- `components/NowPlaying/useExpandedNowPlayingViewModel.ts`（`canViewStory`/`viewStoryTarget` + `deriveExpandedCanViewStory`/`deriveWorkLibraryTarget`）
- `components/NowPlaying/ExpandedNowPlaying.tsx`（`handleViewStory`：先关后导 + 同 Detail 去重）
- `components/NowPlaying/ExpandedNowPlaying.module.scss`（动作区 additive 样式）
- `components/NowPlaying/index.ts`
- `tests/test-catalog.yaml`（`expanded-work-view-story`）
