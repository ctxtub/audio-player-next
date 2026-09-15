# Expanded 创作动作边界 M7-04-03

功能域：01-基础冒烟与页面基线

## 用户目标

有 Draft 播放会话时打开全局 Expanded，看到「返回创作」（不是「继续创作」）且与「查看正文」同区并存：点击后 Expanded 先关闭再进入 `/chat`，且不自动发送新 Prompt（无 send 调用、无预填即发、无消息追加），播放继续（会话/进度/音频宿主全不变）；有 Work 播放会话时动作区仅有「查看正文」，无「继续创作」（M4 `continueFromStoryWork` 契约未落地前 fail-closed，绝不伪造 continuation）；任何路径不在 M7/Expanded 内拼装 continuation Prompt。

## 前置条件

- M5 PlaybackSessionStore（`source` 为 draft/work，`storyText` 为正文唯一来源）/ playbackStore / AudioControllerHost ownership 冻结；Expanded 开关为纯 UI state（`nowPlayingUiStore.isExpanded`）。
- M7-01 Expanded Surface（普通路由切换不自动关闭，`§44`）、M7-02 P3A（无上一段/下一段，`§40`）、M7-03 P3C、M7-04-01 Work 查看正文导航、M7-04-02 Draft Transcript 只读面冻结。
- M4 `continueFromStoryWork(workId)` 契约在当前仓库不存在（src grep 空）；按 `§36.2` 隐藏 Work 继续创作 CTA。
- 旧 `/player` 物理保留（M9 前不删除），本轮不触达。

## 操作步骤

1. 建立 Draft 播放会话并暂停驻留（L2 经 `setActiveStory` + pause；L3 经 E2E-only `seedDraftTranscript` 本地 seed，不建 server Anchor），记录 `sessionId/source/storyText/chat消息数/audioCount/isPlaying`。
2. 点 Mini 元数据区打开 Expanded：断言 URL 不变，`sessionId` 不变，动作区出现「返回创作」（`expanded-back-to-creation-button`，文案精确）且与「查看正文」（`expanded-view-transcript-button`）同容器并存；`expanded-continue-creation-button` 为 0。
3. 点「返回创作」：断言 Expanded 关闭，URL 变为 `/chat`（精确），`sessionId/source/storyText` 不变，暂停态不变（`isPlaying=false` 不翻转），`audioUrl` 不变，`audio` 计数不变（Host 不重挂），无新增 `beginSession` 与 `tts.synthesize`；chat 消息数/`inputValue`/`pendingAutoSend` 全不变（零自动发送）。
4. 空正文 Draft 会话下打开 Expanded：断言无「查看正文」但仍有「返回创作」（返回创作与正文有无解耦）；点击同样先关后导 `/chat` 且播放同一性不变。
5. 建立 Work 播放会话并暂停驻留：打开 Expanded，断言动作区仅含「查看正文」（`expanded-view-story-button` 单按钮），`expanded-continue-creation-button` 与 `expanded-back-to-creation-button` 均为 0；点击「查看正文」仍先关后导精确 `/library/[workId]`（M7-04-01 回归），不误导 `/chat`。
6. 全程收集导航 URL：断言无 `fake/undefined/null/NaN` 形态；`idle`/空 source 下无任何创作 CTA（fail-closed）。
7. 源码守卫：M7/Expanded 内无 `请继续` 拼接、无 `AUTO_CONTINUE_PROMPT`、无 `continueFromStoryWork(` 真实调用、无 `useChatStore`/`pendingAutoSend`/`dispatch` 发送面。

## 验收标准

- `source.kind === 'draft'` 且有可展示会话（`status !== 'idle'`）即展示「返回创作」（与 `storyText` 有无无关；`idle`/空一律隐藏）。
- 「返回创作」与「查看正文」同 `expanded-actions` 容器并存（两者皆可见时双按钮，各自独立 testid/aria/回调；空正文时仅返回创作单按钮）。
- 点击顺序固定：`closeExpanded()` → `router.push('/chat')`（无同址去重，`§37/§44`）；绝不自动发送（无 send、无预填即发、无消息追加）；播放继续（不 pause，会话/进度/音频宿主全不变）。
- `source.kind === 'work'` 时无「继续创作」CTA（`shouldShowWorkContinueCreation` 恒 false，fail-closed）；亦无「返回创作」（Draft 专属）；动作区仅「查看正文」单按钮。
- Work「继续创作」只允许消费 M4 `continueFromStoryWork(workId)` 契约；契约落地前隐藏，落地后经预留 `onContinueCreation` 缝合即可，不改播放架构（additive-ready）；`§36.3` 不暂停原则（本轮隐藏不涉及，返回创作同样不暂停）。
- M7/Expanded 内禁拼 continuation Prompt（禁 `请继续`/`storyText` 拼接等，静态源码守卫锁定）。
- UI 经既有命令面（受控 Actions + UI store 关闭 + Next 路由）；不直接操作 `<audio>`，不直接改 Session/Chat 字段；不建 Expanded 本地导航状态；不碰 Session/ViewModel 存量字段与 Transcript helper。

## 边界与异常

- 空 source / `idle` → 无任何创作 CTA（fail-closed），点击无（无按钮可点，不抛错、不导航、不改播放）。
- 空/空白 storyText → Transcript 口隐藏但返回创作仍展示（解耦；已打开 transcript 时缺失走空态，不抛错）。
- promotion（source 切 work，sessionId 不变）→ 返回创作消失，动作区切 Work 单按钮（与 Transcript 互斥规则一致）。
- `/chat` 已在当前页仍先关后推（无去重；与 Work 同 Detail 去重不同，`§37` 固定语义）。
- 慢沙箱一律确定性轮询（`expect.poll`），无长 sleep；Chromium/WebKit 双跑，`retries=0`。

## 实现参考

- `components/NowPlaying/creationActions.ts`（`BACK_TO_CREATION_LABEL`/`EXPANDED_BACK_TO_CREATION_BUTTON_TESTID`/`CONTINUE_CREATION_LABEL`/`EXPANDED_CONTINUE_CREATION_BUTTON_TESTID`/`CHAT_ROUTE` + `shouldShowDraftBackToCreation`/`shouldShowWorkContinueCreation`/`resolveBackToCreationTarget`/`decideDraftBackToCreation`/`decideWorkContinueCreation`）
- `components/NowPlaying/NowPlayingActions.tsx`（Draft 双口并存 + Work 继续隐藏 additive-ready；受控组件，不读 store）
- `components/NowPlaying/ExpandedNowPlaying.tsx`（`handleBackToCreation`：先关后导 + 零 send；Work 不传 `onContinueCreation`）
- `components/NowPlaying/ExpandedNowPlaying.module.scss`（新按钮 additive 样式，与既有同口径）
- `components/NowPlaying/index.ts`
- `tests/test-catalog.yaml`（`expanded-creation-actions`）
