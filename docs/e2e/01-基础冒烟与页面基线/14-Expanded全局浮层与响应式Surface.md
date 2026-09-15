# Expanded 全局浮层与响应式 Surface（M7-01）

功能域：01-基础冒烟与页面基线

## 用户目标

有播放会话时点 Mini 进入全局 Expanded：URL 不变、开关不改变播放；Expanded 打开期间 Mini 隐藏、关闭后恢复；普通导航（`/chat → /library`）后 Expanded 保持打开；会话清空后自动关闭；`ended` 保持并显示完成态；390px 为 Bottom Sheet、900px 为 Right Side Panel，resize 不重置开关；Escape / backdrop / 下滑关闭后播放继续；焦点进入与返回正确；`/player` 物理保留但正常入口不再跳转。

## 前置条件

- M5 PlaybackSessionStore / playbackStore / playbackSessionFlow / AudioControllerHost 四层 ownership 冻结；Expanded 开关为纯 UI state（`nowPlayingUiStore.isExpanded`），绝不存 `workId/sessionId/title/isPlaying/currentTime/sleep`。
- M6 Mini 语义与 768 单一断点冻结；M6 `router.push('/player')` 已替换为 `openExpanded()`。
- `MainChrome = Page + BottomChrome{Mini + TabBar} + NowPlayingLayer{Expanded}` 全局挂载，导航不卸载。

## 操作步骤

1. 建立 Work 播放会话并暂停驻留（真实 `beginSession` + 首段合成 + pause），视口 390×844：Mini 可见，Expanded 关闭，记录 URL 与 `sessionId/status/transport`。
2. 点 Mini 元数据区：Expanded 挂载（`expanded-now-playing`），URL 不变，`sessionId/status/transport` 不变， Mini 隐藏（`mini-now-playing` 计数 0）。
3. 点 Expanded 关闭按钮：Expanded 卸载，Mini 恢复，`sessionId/status/transport` 不变（播放继续）。
4. 再次打开后经 TabBar 切 `/chat → /library`：Expanded 仍挂载，`sessionId` 不变，无新增 `beginSession`。
5. 视口切 390 → 900 → 390：每次 `isExpanded` 仍为 true（CSS 切 Sheet/Panel，JS 不重挂载）。
6. 桌面 900 下断言 Panel 右锚（`expanded-sheet` 右缘贴视口右、宽约 `400px`）；移动 390 下断言 Sheet 底锚（底缘贴视口底、全宽）。
7. Escape 关闭后播放继续（`sessionId` 与暂停态不变）；backdrop 点击同样关闭且播放继续；移动 Handle 向下拖超阈值关闭（Chromium/WebKit 双跑）。
8. 打开后焦点在 Expanded 关闭按钮内；关闭后焦点回 Mini 元数据按钮。
9. `ended`（自然播完或置尾锚）后 Expanded 保持并显示“播放完成”徽标；会话清空（`source null / idle`）后自动关闭。
10. 直接访问 `/player` 仍可渲染（M9 前物理保留），但 Mini 点击不再跳转（URL 无 `/player` 新增）。

## 验收标准

- Mini click → `isExpanded=true`，URL 不变，无 `/player` 跳转。
- open/close 不触发 play/pause/new Session（`sessionId/status/audioUrl` 全程不变，无新增 `tts.synthesize`）。
- Expanded open → Mini suppressed；close → Mini restored（`data-mini-visible` 翻转，`hasNowPlaying` 仍 true）。
- `/chat → /library` 普通导航后 Expanded 仍 open（不属于 route）。
- Session clear（`source null / idle`）→ 自动 close；`pause/ended/error/synthesizing` 均不自动关闭。
- `ended` 显示完成态徽标（`expanded-ended-badge`）。
- 390 Sheet / 900 Panel；resize 时 `isExpanded` 不变。
- Escape/backdrop/swipe 关闭后播放继续。
- focus trap / focus return 正确（打开进关闭按钮，关闭回 Mini trigger）。
- `/player` 文件存在但正常入口不再 push。

## 边界与异常

- 无 session 时点 Mini 不可达（Mini 不渲染，Expanded 不可开）。
- `prefers-reduced-motion` 下无弹簧入场、drag 后立即收起、无 blur scale。
- 内容区滚动 / Speed / Timer popover 不冒泡误关；仅 Handle 发起 drag dismiss。
- 慢沙箱一律确定性轮询（`expect.poll`），无长 sleep；双 project 串行、`retries=0`。

## 实现参考

- `stores/nowPlayingUiStore.ts`
- `components/NowPlaying/NowPlayingLayer.tsx`
- `components/NowPlaying/ExpandedNowPlaying.tsx`
- `components/NowPlaying/ExpandedNowPlaying.module.scss`
- `components/NowPlaying/NowPlayingHeader.tsx`
- `components/NowPlaying/useExpandedNowPlayingViewModel.ts`
- `components/NowPlaying/useNowPlayingEntry.ts`
- `components/MainChrome/index.tsx`
- `components/MainChrome/visibility.ts`
- `components/MainChrome/useMainChromeState.ts`
- `styles/tokens/_sizing.scss`（Sheet/Panel/Handle token）
- `DESIGN_SPEC.md`（3.20 Expanded / 4.1 Global Layer / 5.2 响应式）
