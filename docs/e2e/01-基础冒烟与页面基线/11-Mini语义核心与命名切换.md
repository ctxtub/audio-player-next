# Mini 语义核心与命名切换（M6-02 Semantic Core）

功能域：01-基础冒烟与页面基线

## 用户目标

有可展示播放会话时全局 Mini 出现并显示会话标题与段落/动作；无会话时不渲染；桌面偏好只换形态不换存在性；点击元数据进入 `/player`（M6 兼容）；旧 `FloatingPlayer` 导入仍可编译但实际为 Mini。

## 前置条件

- M5 PlaybackSessionStore + Transport 为唯一播放事实源（M5 冻结）。
- 冻结断点 768 与三态形态由 M6-01 提供。

## 操作步骤

1. 无 current session（source null / idle）→ Mini 不渲染。
2. ready/playing/paused/ended 合法会话 → 按状态展示标题、次级文案与主动作。
3. 标题仅取 Session.title（空回退“正在播放”）。
4. 播放中切暂停（Flow）→ 按钮即时由暂停切播放；恢复后切回。
5. 段落位置（lastCompleted/next/total）取 Session；段时间进度（currentTime/duration）取 Transport；按段落加权公式得粗进度 rail（非 seek）。
6. 构造预算字段有值 → Mini DOM 与 ViewModel 均不出现该值。
7. 切换 `desktopFloatingPlayerEnabled` 真/假 → Mini 存在性不变，仅形态字段变化。
8. 点击元数据 → 精确 `push('/player')`；已在 `/player` → no-op。
9. 检查 Mini 模块 import：不得出现旧进度/历史/卡片播放面。
10. 旧 `import { FloatingPlayer } from '@/components/FloatingPlayer'` 仍可编译且等于 Mini。

## 验收标准

- 无会话不渲染；四态会话按矩阵展示。
- 标题冻结 Session.title；次级文案按 §6；主动作按 §10。
- 粗进度公式 `(completed+fraction)/total` 钳制 0..1，不展示百分比/精确时间。
- 预算字段不进 DOM/ViewModel。
- 配置不决定存在性。
- 入口精确路由且 `/player` 上 no-op。
- 历史播放面零 import；兼容 re-export 无独立实现。
- Mini 无第二套显隐状态；不直写会话持久字段。

## 边界与异常

- hydrating 映射为 synthesizing（Loading/disabled）。
- ended 保留尾锚并提供重播；error 提供重试。
- 单段 playing→正在播放；单段 paused/ready→已暂停；多段→第 X / Y 段。
- Draft / Work 不做视觉分叉。
- App Chrome 位移/键盘抑制/drag/snap 归 M6-03，本项不做。

## 实现参考

- `components/NowPlaying/MiniNowPlaying.tsx`
- `components/NowPlaying/deriveMiniNowPlayingViewModel.ts`
- `components/NowPlaying/useNowPlayingEntry.ts`
- `components/NowPlaying/presentation.tsx`
- `components/NowPlaying/types.ts`
- `components/FloatingPlayer/index.tsx`（兼容 re-export）
- `app/(main)/layout.tsx`（正式命名接入）
