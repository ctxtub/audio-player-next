# /player 兼容重定向与会话契约（M9-01）

功能域：09-旧播放器退役与兼容收口

## 用户目标

旧书签 / 直接地址栏 / 刷新 / restored pathname=`/player` 全部落到 `/library`；旧 Player UI 不再可达；应用内从活跃会话命中 `/player` 兼容入口时会话（`sessionId`/`source`/`nextParagraphIndex`/progress/audio transport）不被 redirect 主动改写；cold bookmark/refresh 经 `/library` + AccountSync/M5 hydrate 从冻结 Anchor 恢复 Session；无播放态时呈空态且不伪造 Session。`/player` 的 query/hash 不作为 playback identity 与 progress source，不翻译成 M5 Session。

## 前置条件

- `app/(main)/player/page.tsx` 为最薄 server redirect（`redirect('/library')`），不渲染任何旧 Player UI。
- 旧实现物理保留但不可达：`app/(main)/player/index.tsx`、`index.module.scss`、`components/**`（含 `PlaybackStatusBoard`/`GenerationPreview`/`AudioPlayer`）。
- M5 PlaybackSessionStore / Anchor / PlaybackSessionFlow 冻结语义不变；恢复播放只走 Anchor + PlaybackSessionStore。
- 身份与 hydrate 由 AccountSync 全局接管；M5 schema/identity 不改。

## 操作步骤

1. 直接导航 `/player`（可带任意 query/hash，如 `/player?legacy=1#frag`）：断言 pathname=`/library`，`library-page` 可见，旧 Player 地标（`播放进度` slider / `播放速度` / `从头重播`）计数为 0，全程 URL 不含 `/player`。
2. 活跃 Work 会话下命中兼容入口：注册用户建两段 Work，经探针 `beginWork(resume)` + 首段合成 + pause 驻留，记录 `sessionId/source/nextParagraphIndex/audioUrl/status`；随后 `goto /player?from=active#keep`：断言 redirect 至 `/library` 后 `sessionId`/`source`/`next` 不变、`status` 仍 paused、`audioUrl` 不变、Mini（`mini-now-playing`）可见；点 Mini 元数据可开 Expanded（`expanded-now-playing` 可见，URL 仍为 `/library`），关闭后 Mini 恢复；全程无新增 `beginSession`/`tts.synthesize`，audio 单 owner。
3. Cold bookmark/refresh：同 2 建会话并 `saveCheckpointNow` 落 Anchor，记录 `sessionId/canonicalNext`；`goto /player` → `/library` 后执行 `reload`：断言 hydrate 后 `sessionId` 对齐、`source` 对齐、`nextParagraphIndex` 为 canonical、`status=ready`、transport 空闲（`hasAudioUrl=false`/`audioUrl=null`/`currentTime=0`/`isPlaying=false`），`library-page` 可见且旧 UI 不出现。
4. 无播放态空态：全新访客（无 Session）直访 `/player`：断言落到 `/library`，探针 `sessionId=null`、`source=null`，Mini（`mini-now-playing`）计数 0，Expanded 计数 0，transport 空闲，不新建 Session。

## 验收标准

- 旧 bookmark / 直接地址栏 / refresh / restored `/player` → 全部 `/library`，无旧 Player UI 闪现。
- `/player` 的 query/hash 不改变 identity 与 progress；不得把旧 query 翻译成 M5 Session；恢复只走 Anchor + PlaybackSessionStore。
- 应用内活跃会话命中兼容入口：`sessionId` 不变、`source` 不变、progress（`nextParagraphIndex`）不变、audio transport 不因 redirect 主动 clear；Mini 可见且 Expanded 可 open。
- Cold 路径：`/player` → `/library` → AccountSync/M5 hydrate → 从冻结 Anchor 恢复 Session（不复活旧 Player 页面）。
- 空态：无 playback state 时不伪造 Session（`sessionId=null`，Mini 不渲染）。
- 产品路径静态守卫：`components/**` + `app/(main)/**` + `lib/client/**` + `stores/**` 除 compat route/tests 外不得新增 `router.push/href/navigation('/player')`。
- Chromium + WebKit 双跑；确定性轮询，无长 sleep（否定性短窗除外），`retries=0`。

## 边界与异常

- `redirect('/library')` 为 server 侧，不先闪旧 Player，不依赖 hydration；direct bookmark 行为稳定。
- 不自动跳 `/library/[lastPlayingWorkId]`：`/player` 不是作品 deep link；当前播放由 `/library` + Mini/Expanded 表达。
- `app/(main)/player/**` 与 deprecated 兼容符号（`NOW_PLAYING_COMPAT_ROUTE` 等）保留至 M9-02，本项不删。
- M5 schema/identity、FloatingPlayer/playbackProgressStore、canonical audio、P3B 均不在本项。

## 实现参考

- `app/(main)/player/page.tsx`（M9-01 兼容 redirect）
- `app/(main)/player/index.tsx` + `components/**`（M9-02 前物理保留，不可达）
- `lib/navigation/mainNavigation.ts`（过渡期 `/player → library` alias，本项不动）
- `components/MainTabBar/index.tsx`（本项不动）
- `stores/playbackSessionStore.ts` + `app/services/playbackSessionFlow.ts`（冻结恢复链）
- `components/AccountSyncProvider/index.tsx`（hydrate 编排）
- `tests/test-catalog.yaml`（`player-compat-redirect`）
