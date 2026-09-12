# M6 — Mini Now Playing 与全局 Layout 集成技术方案

**所属 Phase**：P2
**前置模块**：M1 信息架构、M5 Playback Session
**后续衔接**：M7 Expanded Now Playing
**核心目标**：把当前 `FloatingPlayer` 从“可开关的播放浮窗”重构成真正的 Global Mini Now Playing；移动端固定承载，桌面端根据用户偏好采用 floating / docked 形态，同时严格消费 M5 已定义的 Playback Session / Transport 契约，不重新复制播放状态。

---

# 0. 核心技术决策

| 决策                                 | 推荐                                                          |
| ---------------------------------- | ----------------------------------------------------------- |
| 组件正式名称                             | **MiniNowPlaying**                                          |
| `FloatingPlayer`                   | 重构后退出正式领域命名，必要时短期 re-export 兼容                              |
| Mini 显隐                            | **从 Playback Session 派生，不保存 `isFloatingVisible`**           |
| 当前 title                           | **M5 Session.title**                                        |
| 当前播放状态                             | **M5 PlaybackSessionStore**                                 |
| 当前段时间                              | **M5 playbackStore / Transport**                            |
| `remainingMs`                      | **不在 Mini 展示**                                              |
| 段落进度                               | 保留为 Secondary Metadata；可辅以非交互粗进度条                           |
| 移动端                                | **固定在 TabBar 上方，不允许拖动**                                     |
| 宽屏桌面                               | `desktopFloatingPlayerEnabled=true` → draggable floating    |
| 宽屏关闭 floating                      | **仍显示 docked Mini，不允许彻底隐藏播放入口**                             |
| Desktop drag                       | 保留 `@use-gesture/react useDrag`，增加 resize clamp / edge snap |
| Responsive breakpoint              | **768px**，与现有 DESIGN_SPEC `lg` 对齐                           |
| 键盘打开                               | 移动端临时隐藏 Mini，播放继续                                           |
| Mini z-index                       | `var(--z-floating)`                                         |
| Expanded 入口 P2                     | **暂时 `router.push('/player')`**                             |
| Expanded 入口 P3                     | 同一 facade 改为 M7 `openExpanded()`                            |
| 是否将 expanded state 放 playbackStore | **绝不**                                                      |
| `floatingPlayerEnabled`            | 领域改名为 `desktopFloatingPlayerEnabled`                        |
| DB column                          | 保留旧物理列，通过 Prisma `@map` 重命名逻辑字段                             |
| Desktop position                   | V1 仅当前浏览 session，不持久化                                       |
| Mini progress 是否可 seek             | **不可**，seek 归 M7                                            |

---

# 1. 当前 FloatingPlayer 边界

当前 `FloatingPlayer` 同时负责：

```text
UI presentation
├── glass capsule
├── position
├── drag
└── play / pause

Presentation state
├── isFloatingVisible
└── floatingPlayerEnabled

Playback inference
├── currentAudioUrl
├── isRehydratedReady
├── currentParagraphIndex
└── totalParagraphs

Timer presentation
└── remainingMs
```

其显示条件目前实际为：

```text
floatingPlayerEnabled
&& isFloatingVisible
&& (
  currentAudioUrl !== null
  || isRehydratedReady
)
```

而 `playAudio()`、`resumeAudio()`、`hydrateFromProgress()` 都会主动把 `isFloatingVisible` 写成 `true`。

M5 已经确定：

> `playbackStore` 只负责 Audio Transport，`source/title/session/rehydrate/isOneShot/isFloatingVisible` 等不再属于 Transport。

因此 M6 不能把这套显隐机制原样搬过去。

---

# 2. FloatingPlayer 重构边界

## 2.1 保留

### Liquid Glass 视觉语言

当前已经使用：

```text
background:
color-mix(
  in srgb,
  var(--bg-elevated) 78%,
  transparent
)

backdrop-filter:
var(--glass-blur)

border:
0.5px solid var(--glass-border)

border-radius:
var(--radius-full)

box-shadow:
var(--glass-highlight),
var(--shadow-lg)

z-index:
var(--z-floating)
```

这与 DESIGN_SPEC 3.7 完全一致，应保留。

---

### Desktop `useDrag`

当前已经用：

```ts
useDrag(...)
```

实现：

* drag origin；
* viewport capture；
* panel size；
* pointer movement；
* clamp；
* `filterTaps: true`。

`clampValue()` 和 `shouldSkipPointerDown()` 也已经作为纯工具函数拆出。

这些基础设施继续使用，但只在宽屏 floating mode 生效。

---

### AudioControllerHost

M6 不触碰音频 DOM ownership。

`AudioControllerHost` 继续位于 `(main)` Layout，全局存活。当前 Layout 已经把它和页面 `children` 分离。

---

## 2.2 删除

正式删除以下 Mini 领域概念：

```text
isFloatingVisible

showFloatingPlayer()
hideFloatingPlayer()

useFloatingPlayer().show
useFloatingPlayer().hide
```

M5 实施完毕后它们本身就不应继续存在于 Playback Transport。

Mini 不需要一个：

```text
show/hide
```

命令。

---

## 2.3 显隐改成派生状态

正式规则：

```ts
hasNowPlaying =
  session.source !== null
  && session.status !== 'idle'
```

Mini：

```text
hasNowPlaying
+
presentation 允许展示
=
visible
```

其中 presentation 抑制条件只有：

```text
移动端软键盘打开
M7 Expanded 已打开
```

而不是业务代码主动：

```ts
showMiniPlayer()
```

---

# 3. Mini 的数据结构

建议建立纯 UI ViewModel：

```ts
type MiniNowPlayingViewModel = {
  visible: boolean

  title: string

  status:
    | 'ready'
    | 'synthesizing'
    | 'playing'
    | 'paused'
    | 'ended'
    | 'error'

  secondaryLabel: string | null

  coarseProgress: number | null

  primaryAction:
    | 'play'
    | 'pause'
    | 'restart'
    | 'retry'
    | 'disabled'

  layoutMode:
    | 'compact-docked'
    | 'wide-docked'
    | 'wide-floating'
}
```

ViewModel 只负责 presentation。

不进入：

```text
PlaybackSessionStore
playbackStore
Prisma
```

---

# 4. 数据来源

```text
PlaybackSessionStore (M5)
│
├── source
├── title
├── status
├── lastCompletedParagraphIndex
├── nextParagraphIndex
└── totalParagraphs
         │
         ▼
MiniNowPlaying
         ▲
         │
playbackStore (Transport)
├── isPlaying
├── currentTime
├── duration
└── playbackRate
```

Mini 永远不再读取：

```text
currentAudioUrl
isRehydratedReady
sourceType
sourceId
isOneShot
```

---

# 5. Title

Mini 一级信息必须变成：

```text
Story / Draft title
```

而不是当前：

```text
剩余 23:18
第 4/12 段
断点就绪
待创作
```

当前 Floating title 的确优先展示 `remainingMs`，只有 rehydrated 场景才回退到段落信息。

M6 后：

```text
title = PlaybackSession.title
```

Work：

```text
title = M2 StoryWork.title
```

Draft：

由 M5 Session snapshot 提供。

仅 defensive fallback：

```text
正在播放
```

不允许 Mini 自己：

```text
prompt.slice(...)
```

或读取 M2。

---

# 6. Secondary Label

推荐统一纯函数：

```ts
deriveMiniSecondaryLabel(session)
```

规则：

### synthesizing

```text
正在准备语音
```

### error

```text
播放遇到问题
```

### ended

```text
播放完成
```

### 多段作品

```text
第 4 / 12 段
```

### 单段 playing

```text
正在播放
```

### 单段 paused / ready

```text
已暂停
```

---

# 7. remainingMs

当前 Mini 会把：

```text
remainingMs
```

作为最主要文案。

M6 后：

> **完全移出 Mini。**

原因是该值表示：

```text
Sleep / allowed playback budget
```

而不是：

```text
作品剩余时长
```

继续把它放在 Mini 主视觉会导致用户误解。

正式归属：

```text
M7 Expanded Now Playing
→ 睡眠定时
```

M6 只继续允许 Transport 保存它，不展示。

---

# 8. 段落进度

M6 不删除段落信息，但调整表达层级。

当前：

```text
第 4/12 段
```

可能成为 Floating title。

M6：

```text
Title:
月球上的小狐狸

Secondary:
第 4 / 12 段
```

---

# 8.1 Mini progress rail

为了保持 Mini 具有轻量进度感，可以提供一个：

> **非交互、非 seek 的 coarse progress rail。**

M5 阶段：

```ts
completed =
  lastCompletedParagraphIndex + 1

segmentFraction =
  duration > 0
    ? currentTime / duration
    : 0

coarseProgress =
  clamp(
    (
      completed
      + segmentFraction
    )
    / totalParagraphs,
    0,
    1
  )
```

注意：

这是：

```text
paragraph-weighted approximation
```

不是作品真实 duration progress。

因此：

* UI 不显示 `42.3%`；
* UI 不显示 `03:32 / 18:20`；
* 用户不能拖动；
* accessibility label 使用“故事段落进度”。

M8 完成后，同一 ViewModel 字段可以换成：

```text
duration-weighted story progress
```

Mini JSX 不需要重构。

---

# 9. Mini Component 结构

推荐：

```text
┌─────────────────────────────────┐
│ 月球上的小狐狸             ⏸    │
│ 第 4 / 12 段                    │
│ ━━━━━━━━━━━●━━━━━━━━           │
└─────────────────────────────────┘
```

DOM：

```text
MiniNowPlaying
│
├── MetadataButton
│   ├── Title
│   ├── SecondaryLabel
│   └── ProgressRail
│
└── PlaybackActionButton
```

不要做：

```html
<button>
  ...
  <button />
</button>
```

Metadata 与播放按钮必须是两个独立 interactive target。

---

# 9.1 点击语义

### Metadata 区域

```text
openNowPlayingDetails()
```

### Playback button

只负责：

```text
play
pause
restart
retry
```

不打开 Full Player。

---

# 10. Primary Action

统一：

```ts
deriveMiniPlaybackAction(status)
```

### playing

```text
Pause
```

### ready / paused

```text
Play
```

调用：

```text
M5 resumeCurrentSession()
```

### synthesizing

```text
Loading
```

Button disabled。

Metadata 仍然可打开完整视图。

### ended

```text
Replay
```

调用：

```text
M5 restartCurrentSession()
```

符合 M5-P02：

> Work 完播后保留 ended Now Playing。

### error

```text
Retry
```

调用 M5 playback orchestration 的 retry/resume path。

Mini 不直接调用：

```text
AudioControllerHost
audioController.resume()
```

---

# 11. 不再使用旧 useFloatingPlayer

当前 FloatingPlayer 自己使用：

```text
useFloatingPlayer()

resume()
pause()
show()
hide()
```

同时 rehydrated 场景直接调用：

```text
playbackProgressStore.resumeRehydratedPlayback()
```

造成 UI 组件必须理解不同恢复路径。

M6 后统一：

```text
MiniNowPlaying
↓
M5 PlaybackSessionFlow public actions
```

例如：

```ts
useMiniPlaybackControls()
```

内部：

```text
playing
→ pauseCurrentSession

ready / paused
→ resumeCurrentSession

ended
→ restartCurrentSession

error
→ retryCurrentSession
```

Mini 不再知道：

```text
rehydrated
```

这种技术状态。

---

# 12. Responsive 模型

M6 不做 UA sniffing：

```text
iPhone
Android
Mac
Windows
```

而是根据 viewport：

```text
Compact:
width < lg

Wide:
width >= lg
```

现有 DESIGN_SPEC 已定义：

```text
--breakpoint-lg = 768px
```

但当前又注明只正式适配 375–428px。M6 是第一个明确需要 desktop/compact 双形态的模块，因此必须同步扩展 DESIGN_SPEC 的 Responsive Strategy，而不是组件自行创造断点。

---

# 12.1 Breakpoint implementation

CSS Custom Property 不能直接作为 media query breakpoint 使用，因此推荐新增 compile-time Sass token：

```scss
// styles/tokens/_breakpoints.scss

$breakpoint-lg: 768px;
```

它与 DESIGN_SPEC：

```text
--breakpoint-lg = 768px
```

语义保持一致。

组件中：

```scss
@media (min-width: $breakpoint-lg) {
  ...
}
```

不在各组件里反复出现裸：

```text
768px
```

---

# 13. 三种 Layout Mode

正式定义：

```ts
type MiniNowPlayingLayoutMode =
  | 'compact-docked'
  | 'wide-docked'
  | 'wide-floating'
```

派生：

```text
compact
→ compact-docked

wide
+ desktopFloatingPlayerEnabled = false
→ wide-docked

wide
+ desktopFloatingPlayerEnabled = true
→ wide-floating
```

---

# 14. Compact / 移动端

移动端：

```text
固定
TabBar 上方
不拖动
始终可访问
```

示意：

```text
┌─────────────────────────────┐
│                             │
│        Page Content         │
│                             │
├─────────────────────────────┤
│ 月球上的小狐狸         ⏸    │ ← Mini
│ 第 4 / 12 段                │
│ ━━━━━━━━━━━━━               │
├─────────────────────────────┤
│  创作       故事库      设置 │ ← TabBar
└─────────────────────────────┘
```

---

# 14.1 Mobile position

现有 TabBar：

```text
position: fixed
bottom: 0
padding-bottom:
space-2 + safe-area
```

且：

```text
--tab-bar-safe-bottom:
calc(64px + safe-area-inset-bottom)
```

已经有专门的底部占位 token。

Mini Dock：

```scss
bottom:
calc(
  var(--tab-bar-safe-bottom)
  + var(--space-2)
);
```

Safe Area 不单独再计算一遍。

否则会重复加：

```text
env(safe-area-inset-bottom)
```

---

# 15. Bottom Chrome Reservation

当前 `.content` 只预留：

```scss
padding-bottom:
var(--tab-bar-safe-bottom);
```

Mini 出现后，如果不增加内容占位：

> Library 最后一个 Card、Setting 最后一个 Section、Chat 底部内容都可能被 Mini 遮住。

因此 M6 引入 scoped layout variable：

```scss
.app {
  --bottom-chrome-safe-bottom:
    var(--tab-bar-safe-bottom);
}

.appWithDockedNowPlaying {
  --bottom-chrome-safe-bottom:
    calc(
      var(--tab-bar-safe-bottom)
      + var(--size-mini-now-playing-height)
      + var(--space-2)
    );
}
```

然后：

```scss
.content {
  padding-bottom:
    var(--bottom-chrome-safe-bottom);
}
```

---

# 15.1 Chat Composer

DESIGN_SPEC 当前让 Chat Composer 自己：

```text
padding-bottom:
space-3 + tab-bar-safe-bottom
```

M6 需要同步修改为：

```text
space-3
+
bottom-chrome-safe-bottom
```

这样：

```text
Mini visible
→ Composer 上移

Mini suppressed
→ Composer 自动落回 TabBar 上方
```

不允许 Chat 自己判断：

```text
Playback Session 是否存在
```

---

# 16. 动态 Layout Wrapper

`app/(main)/layout.tsx` 当前是 Server Component，无法直接读取 Zustand Session。

推荐新增 Client wrapper：

```text
components/MainChrome/
└── index.tsx
```

结构：

```tsx
<MainChrome>
  {children}
</MainChrome>

<AudioControllerHost />
```

`MainChrome`：

```text
usePlaybackSessionStore
useConfigStore
responsive mode
keyboard state
```

然后渲染：

```text
.app
├── main content
├── MainTabBar
└── MiniNowPlaying
```

并根据：

```text
hasDockedMini
```

给 `.app` 增加对应 class。

---

# 16.1 为什么 Mini 放进 `.app`

当前 FloatingPlayer 在 `.app` 外部。

M6 建议改为：

```text
.app
└── MiniNowPlaying
```

因为它现在已经成为：

> Global App Chrome

而不是一个与主应用无关的任意 viewport widget。

AudioControllerHost 仍留在外部即可。

---

# 17. 键盘行为

移动端最危险的场景：

```text
Chat Composer focused
+
software keyboard
+
TabBar
+
Mini
```

如果全部堆在 Visual Viewport 底部：

> 输入区会非常拥挤，甚至被遮挡。

推荐：

> **移动端软键盘展开期间临时 suppress Mini。**

播放不暂停。

---

# 17.1 具体规则

```text
compact mode
+
editable element focused
+
VisualViewport 判断 keyboard open
=
Mini hidden
```

关闭键盘：

```text
Mini 自动重新出现
```

不改变：

```text
Session
Playback
Transport
```

---

# 17.2 Keyboard detection

新增：

```text
useSoftKeyboardState()
```

优先监听：

```text
window.visualViewport.resize
window.visualViewport.scroll
focusin
focusout
```

条件综合：

```text
activeElement is:
input
textarea
contenteditable

AND

visual viewport
明显小于 layout viewport
```

对于不支持 `visualViewport` 的浏览器：

> 退化成 compact 模式下 editable focus 时 suppress Mini。

宁可短暂隐藏 Mini，也不要遮挡输入。

---

# 17.3 Library Search

该规则同样适用于：

```text
/library 搜索输入框
```

用户输入搜索时 Mini 临时隐藏；

Blur 后恢复。

这是 Global Chrome 行为，不在 Chat 单独实现。

---

# 18. Desktop / Wide Floating

当：

```text
viewport >= lg
desktopFloatingPlayerEnabled = true
```

Mini：

```text
position: fixed
width: var(--size-mini-now-playing-wide)
z-index: var(--z-floating)
```

使用：

```text
@use-gesture/react useDrag
```

---

# 18.1 Default position

删除当前：

```ts
{ x: 16, y: 360 }
```

以及：

```ts
window.innerHeight - 280
```

这类依赖具体尺寸的初始化。当前代码确实使用这些固定像素。

改成 CSS 初始：

```text
right:
var(--space-4)

bottom:
tab-bar-safe-bottom
+ space-4
```

只有用户第一次开始 Drag 后，才转为：

```text
left / top coordinates
```

---

# 18.2 Drag region

当前整个 Floating panel 绑定 drag，只有命中 button 时通过 `shouldSkipPointerDown()` 排除。

M6 后 Mini metadata 本身还承担：

```text
open expanded
```

因此不应继续让整块 surface 同时既是：

```text
drag target
```

又是：

```text
open target
```

推荐 Desktop Floating 增加一个克制的：

```text
DragGrip
```

只对该区域绑定 `useDrag()`。

Playback Button 和 Metadata Button 均不参与 drag。

---

# 18.3 Edge snap

当前 drag end 只：

```text
clamp
```

不 snap。

M6 增加：

```text
nearest horizontal viewport edge
```

吸附。

即：

```text
left
或
right
```

Vertical position 保留。

好处：

* floating 看起来不会“随便漂在中间”；
* 更接近 dock/floating 语义；
* 避免遮住页面主内容中心。

---

# 18.4 Resize

当前 viewport bounds 只在：

```text
drag first
```

时捕获。

M6 必须监听：

```text
window.resize
visualViewport.resize
```

如果窗口缩小：

```text
re-clamp existing floating position
```

防止 Mini 跑到 viewport 外。

---

# 18.5 Position persistence

V1 不保存：

```text
x
y
dockSide
```

到：

* DB；
* UserConfig；
* localStorage。

原因：

这是低价值 presentation state，而且：

* desktop viewport 经常变化；
* 外接显示器位置不同；
* responsive mode 切换后旧坐标可能非法。

默认：

> 当前浏览 session 内保持。

Reload 后回到默认右下位置。

---

# 19. Wide Docked

当：

```text
desktopFloatingPlayerEnabled = false
```

Mini **不是消失**。

而是：

```text
wide-docked
```

固定在 TabBar 上方，与移动端一致。

这是配置语义迁移的核心。

---

# 19.1 为什么不能彻底隐藏

Global Now Playing 已经替代独立播放器一级 Tab。

如果设置允许：

```text
Floating Off
→ Mini 完全消失
```

那么用户可以出现：

```text
音频正在播放
但全局无控制入口
```

这违反新的产品 IA。

因此配置只能决定：

> **桌面是否自由浮动**

不能决定：

> **是否存在 Now Playing。**

---

# 20. floatingPlayerEnabled 迁移

当前 DB：

```prisma
floatingPlayerEnabled Boolean @default(true)
```

User 和 Guest 都有同名字段。

当前 Config schema/API/Store 也把它定义成：

> 是否启用浮动播放器。

M6 正式重命名领域语义：

```text
desktopFloatingPlayerEnabled
```

---

# 20.1 Prisma

不重命名物理 SQLite column。

推荐：

```prisma
desktopFloatingPlayerEnabled
  Boolean
  @default(true)
  @map("floatingPlayerEnabled")
```

UserConfig / GuestConfig 都一样。

因此：

```text
Domain:
desktopFloatingPlayerEnabled

Physical SQLite:
floatingPlayerEnabled
```

不需要一次 SQLite table rebuild。

---

# 20.2 Config API

新 DTO：

```ts
{
  playDuration,
  voiceId,
  speed,
  desktopFloatingPlayerEnabled,
  themeMode,
}
```

Patch：

```ts
desktopFloatingPlayerEnabled?: boolean
```

---

# 20.3 Compatibility window

考虑部署切换期间旧浏览器 Tab 仍可能运行旧前端 Bundle，推荐 API 暂时兼容：

```text
floatingPlayerEnabled
```

legacy patch。

规范：

```text
如果新字段存在：
  以新字段为准

仅旧字段存在：
  映射到 desktopFloatingPlayerEnabled

两者都存在且不同：
  BAD_REQUEST
```

Response 可以在一个兼容周期内同时返回：

```ts
{
  desktopFloatingPlayerEnabled: true,

  // deprecated
  floatingPlayerEnabled: true,
}
```

新客户端不再读取 legacy 字段。

旧 alias 的最终删除仍属于 M6 migration cleanup，不交给 M9。

---

# 21. configStore

从：

```ts
apiConfig.floatingPlayerEnabled
```

切换为：

```ts
apiConfig.desktopFloatingPlayerEnabled
```

当前 ConfigStore 初始化、merge、patch、rollback 等路径都显式枚举旧字段，因此必须完整替换，不能只改 TypeScript type。

包括：

```text
createEmptyConfig
createDefaultConfig
isValidConfig
mergeConfig
toPatch
rollback fetch
remote init
```

---

# 22. 设置页

当前设置：

```text
播放浮窗

开启后，在其他页面也会展示播放浮窗
```

M6 改为：

```text
桌面悬浮播放

开启后，在宽屏设备上可拖动迷你播放器。
关闭后固定显示在底部导航上方。
移动端始终使用固定迷你播放器。
```

组件：

```text
FloatingPlayerSection
↓
DesktopFloatingPlayerSection
```

---

# 22.1 设置项在手机是否显示

推荐：

> **显示，但明确标注“仅桌面生效”。**

理由：

配置是账号级偏好。

用户可能在手机上配置，稍后桌面端生效。

不要根据当前设备把设置项完全隐藏，否则用户无法理解账号配置。

---

# 23. Mini 与 Expanded 的过渡

这是 M6/M7 的主要职责边界。

Mini 不应该直接：

```ts
router.push('/player')
```

写死。

新增 facade：

```text
components/NowPlaying/
└── useNowPlayingEntry.ts
```

接口：

```ts
type NowPlayingEntryController = {
  openDetails: () => void
}
```

Mini 只调用：

```ts
openDetails()
```

---

# 24. M6 实现

M6 阶段：

```ts
openDetails()
→ router.push('/player')
```

这是 M1 明确允许的 compatibility exception。

用户：

```text
Mini
→ 点击 Metadata
→ Legacy /player
```

得到现有完整播放器能力。

---

# 24.1 `/player` 上的行为

如果当前已经：

```text
/player
```

则：

```text
openDetails()
→ no-op
```

避免重复 push 相同 URL。

M1 已规定：

```text
/player
```

过渡期 TabBar 高亮：

```text
故事库
```

因此这一过渡虽然不是最终形态，但导航语义仍然可解释。

---

# 25. M7 接入

M7 只替换：

```ts
openDetails()
```

的内部实现：

```text
router.push('/player')
↓
NowPlayingUI.openExpanded()
```

Mini Component：

```text
无需修改 props
无需修改 click handler
无需理解 Sheet / Panel
```

---

# 25.1 Expanded UI state

**M6 不新增 `isExpanded` 到 Playback Store。**

原因：

```text
Playback Session
```

和：

```text
Expanded UI 打开/关闭
```

生命周期不同。

M7 最终可以选择：

```text
NowPlayingUI Context
```

或：

```text
nowPlayingUiStore
```

M6 只定义 facade boundary。

---

# 25.2 M7 打开后 Mini

M7 contract：

```text
expanded = true
→ Mini suppressed
```

避免：

```text
Mini z-floating=60
```

压在：

```text
Expanded Modal
```

上。

M7 close：

```text
Mini 自动恢复
```

播放不中断。

---

# 26. Z-Index

当前 DESIGN_SPEC：

```text
TabBar       z-sticky = 20
Overlay      z-overlay = 30
Modal        z-modal = 40
Popover      z-popover = 50
Floating     z-floating = 60
```

M6：

```text
Mini = z-floating
TabBar = z-sticky
```

完全延续现有 token。

M7：

> Expanded 打开时 suppress Mini，因此不用通过继续抬高 z-index 解决层级冲突。

不要新增：

```text
z-index: 9999
```

---

# 27. Touch Target

当前 Floating play button 实际：

```text
32 × 32
```

但 DESIGN_SPEC accessibility 要求：

```text
--size-touch-target = 44px
```

最小触控区域。

M6 改为：

```text
interaction box:
var(--size-touch-target)

icon:
var(--size-icon-sm)
或
var(--size-icon-md)
```

视觉按钮仍可以保持紧凑，但 hit area 不得低于 44。

---

# 28. DESIGN_SPEC 更新

M6 属于产品视觉基础能力变更，必须同步修改 SSOT。

现有 3.7：

> FloatingPlayer — 紧凑胶囊，可拖拽，展示倒计时。

改为：

```text
3.7 Mini Now Playing
```

定义三种模式：

```text
compact-docked
wide-docked
wide-floating
```

---

# 28.1 新增 sizing tokens

建议在：

```text
styles/tokens/_sizing.scss
```

新增：

```text
--size-mini-now-playing-height
--size-mini-now-playing-wide
--size-mini-now-playing-docked-max
```

具体数值统一在 DESIGN_SPEC 中确定。

Component SCSS 只能引用这些 token。

---

# 28.2 Breakpoint token

新增：

```text
styles/tokens/_breakpoints.scss
```

同步：

```text
lg = 768px
```

并更新 DESIGN_SPEC §5：

> 从原来的“仅正式支持 375–428”升级为 Mini Now Playing 在 compact/wide 两种 viewport 下都有定义。

不是本模块顺便全面重做所有页面桌面版。

---

# 29. Layout CSS Contract

最终建立：

```text
--tab-bar-safe-bottom
```

继续表示：

> 仅 TabBar 占用空间。

新增 scoped：

```text
--bottom-chrome-safe-bottom
```

表示：

> 当前页面实际需要避让的全局底部 Chrome 空间。

以后页面应该优先消费：

```text
--bottom-chrome-safe-bottom
```

而不是自己计算：

```text
TabBar + Mini + safe area
```

---

# 30. Mini Visibility

完整规则：

```ts
const hasNowPlaying =
  source !== null
  && status !== 'idle'

const keyboardSuppressed =
  mode === 'compact-docked'
  && isSoftKeyboardOpen

const expandedSuppressed =
  isExpanded // M7 才有

const visible =
  hasNowPlaying
  && !keyboardSuppressed
  && !expandedSuppressed
```

`desktopFloatingPlayerEnabled` **不进入 visible 公式。**

它只决定：

```text
wide-floating
vs
wide-docked
```

---

# 31. Error 状态

如果 M5 Session：

```text
status = error
```

Mini 继续存在。

显示：

```text
title
播放遇到问题
[Retry]
```

不能因为：

```text
currentAudioUrl = null
```

就消失。

这也是从旧 `hasTrack` 推导逻辑迁移出来的重要变化。

---

# 32. Ended 状态

M5-P02 已拍板：

> Work 完播后保留 ended Anchor。

因此 Mini：

```text
月球上的小狐狸
播放完成
[Replay]
```

继续显示。

开始另一个 Source 或用户主动关闭未来 Expanded：

> 再由 M5 Session lifecycle 决定 Anchor 是否切换/清空。

M6 不自行 clear。

---

# 33. Draft / Work 不做视觉分叉

Mini 不显示：

```text
草稿
作品
StoryWork #481
```

Draft / Work 是播放领域 identity。

Mini 的 UI contract 相同：

```text
title
progress
playback action
```

只有 Expanded / Story Detail 才需要更多内容来源信息。

---

# 34. 文件级改动

## 新增

```text
components/NowPlaying/
├── MiniNowPlaying.tsx
├── MiniNowPlaying.module.scss
├── MiniNowPlayingDrag.ts
├── useNowPlayingEntry.ts
├── useNowPlayingLayoutMode.ts
├── useSoftKeyboardState.ts
├── deriveMiniNowPlayingViewModel.ts
└── types.ts
```

---

```text
components/MainChrome/
├── index.tsx
└── index.module.scss
```

负责：

```text
Main App Chrome
Bottom Chrome reservation
Mini render
```

---

```text
styles/tokens/
└── _breakpoints.scss
```

并更新 token aggregation。

---

## 修改

```text
app/(main)/layout.tsx
```

当前：

```text
.app
├── main
├── MainTabBar
AudioControllerHost
FloatingPlayer
```

改成：

```text
MainChrome
├── main
├── MainTabBar
└── MiniNowPlaying

AudioControllerHost
```

当前结构来源：

---

```text
styles/app.module.scss
```

当前：

```text
content padding-bottom =
tab-bar-safe-bottom
```

改为：

```text
bottom-chrome-safe-bottom
```

---

```text
app/(main)/chat/** Composer styles
```

将：

```text
tab-bar-safe-bottom
```

切换为：

```text
bottom-chrome-safe-bottom
```

---

```text
prisma/schema.prisma
```

UserConfig / GuestConfig logical field：

```text
floatingPlayerEnabled
↓
desktopFloatingPlayerEnabled
@map("floatingPlayerEnabled")
```

当前两张 config 表都有原字段。

---

```text
lib/trpc/schemas/config.ts
```

新增正式：

```text
desktopFloatingPlayerEnabled
```

并保留 legacy alias migration contract。

当前 DTO/Patch/Default 都使用旧字段。

---

```text
types/appConfig.ts
stores/configStore.ts
```

完成领域字段重命名。

---

```text
app/(main)/setting/index.tsx
```

切换：

```text
desktopFloatingPlayerEnabled
```

---

```text
app/(main)/setting/components/FloatingPlayerSection.tsx
```

改名：

```text
DesktopFloatingPlayerSection.tsx
```

并更新产品文案。

---

```text
DESIGN_SPEC.md
```

更新：

```text
3.7 Mini Now Playing
5 Responsive Strategy
Bottom Chrome contract
```

---

# 35. 旧 components/FloatingPlayer

推荐迁移后：

```text
components/FloatingPlayer/index.tsx
```

短期只保留：

```ts
export {
  MiniNowPlaying as FloatingPlayer
} from '@/components/NowPlaying/MiniNowPlaying'
```

如果全仓 `rg` 已确认没有旧 import：

> 同一个 M6 Plan 中即可删除 adapter。

不必保留到 M9。

M1 冻结的是：

```text
/player route surface
```

不是旧 `FloatingPlayer` 文件名。

---

# 36. M6 不修改

M6 不修改：

```text
M5 Playback DB schema
M5 Session lifecycle
M5 progress persistence
M2 StoryWork
M8 Audio Manifest

/player 页面业务实现
```

M6 只在：

```text
open details
```

时使用旧 `/player`。

---

# 37. 迁移步骤

推荐内部拆成 6 个 Slice。

## M6-A — Config semantic migration

```text
floatingPlayerEnabled
↓
desktopFloatingPlayerEnabled
```

完成：

* Prisma logical mapping；
* API compatibility；
* type；
* configStore；
* settings copy。

此阶段 UI 仍可继续旧 Floating。

---

## M6-B — Mini ViewModel

基于 M5：

```text
Session
+
Transport
```

建立：

```text
deriveMiniNowPlayingViewModel
```

先 unit test 状态矩阵。

---

## M6-C — Compact Docked Mini

先完成：

```text
mobile fixed above TabBar
safe-area
bottom chrome reservation
keyboard suppression
```

移除：

```text
remainingMs presentation
isFloatingVisible
```

---

## M6-D — Wide Floating

接回：

```text
useDrag
clamp
snap
resize repair
```

配置决定：

```text
floating / docked
```

---

## M6-E — Compatibility Expanded Entry

```text
Metadata click
→ useNowPlayingEntry
→ /player
```

不在 Component 内硬编码 route。

---

## M6-F — DESIGN_SPEC + Legacy cleanup

* 更新 Design SSOT；
* 删除旧 `useFloatingPlayer` UI adapter；
* `rg floatingPlayerEnabled`；
* `rg isFloatingVisible`；
* `rg FloatingPlayer`；
* 确认只剩预期 compatibility。

---

# 38. 验证 — Session 显隐

### idle

```text
source = null
status = idle
```

Mini：

```text
not rendered
```

### ready

```text
source != null
status = ready
```

Mini：

```text
rendered
```

即使：

```text
currentAudioUrl = null
```

也必须显示。

---

# 39. 验证 — Rehydrate

Refresh 后 M5：

```text
Work Anchor
→ session ready
```

Mini：

```text
title 正确
Play button 可用
```

不得依赖：

```text
isRehydratedReady
```

旧字段。

---

# 40. 验证 — Title

Work：

```text
《月球上的小狐狸》
```

Mini 必须读取 M5 Session：

```text
月球上的小狐狸
```

不能显示：

```text
剩余 28:14
作品回放
待创作
```

---

# 41. 验证 — remainingMs

构造：

```text
remainingMs = 15min
```

Mini DOM：

> 不出现 `15:00`。

M7 以后 Expanded 可以出现 Sleep Timer。

---

# 42. 验证 — paragraph progress

```text
lastCompleted = 2
current = 3
total = 12
```

Mini：

```text
第 4 / 12 段
```

Progress rail：

* 非 seek；
* 不出现精确作品时间。

---

# 43. 验证 — Transport actions

### playing

点击：

```text
Pause
```

M5 Session：

```text
paused
```

### ready

点击：

```text
Play
```

调用 M5 resume。

### ended

点击：

```text
Replay
```

产生 M5 restart。

### synthesizing

Button：

```text
disabled / loading
```

---

# 44. 验证 — Session stale

如果 M5：

```text
A → B
```

Mini 必须立即：

```text
title B
actions B
```

不能因为：

```text
A 的 audio element timeupdate
```

晚到而重新显示 A。

M5 已负责 stale Session；M6 selector 只读 current session。

---

# 45. 验证 — Mobile position

375 / 390 / 428 viewport：

```text
Mini
```

必须：

* 在 TabBar 上方；
* 不覆盖 TabBar；
* 不超 viewport；
* 不碰 safe-area；
* 左右间距使用 token；
* play target ≥44px。

---

# 46. 验证 — Safe Area

Mock：

```text
env(safe-area-inset-bottom)
```

有值时：

```text
TabBar 上移
Mini 同步上移
```

不能出现双倍 safe-area。

---

# 47. 验证 — Bottom Content

Library 滚动至最后一个 Card。

Mini visible：

> 最后 Card 完全可以滚到 Mini 之上。

Setting 最后一项同样可见。

Chat Composer 不被 Mini 覆盖。

---

# 48. 验证 — Keyboard

Compact：

```text
Mini visible
↓
focus Chat textarea
↓
soft keyboard detected
```

结果：

```text
Mini suppressed
Playback continues
```

Blur / Keyboard close：

```text
Mini restored
```

Library Search 同样。

---

# 48.1 自动测试边界

Playwright Desktop 无法真实弹手机软件键盘，因此自动测试分两层：

### Unit

Mock：

```text
visualViewport
focus state
resize
```

验证 hook。

### Browser

验证：

```text
focus textarea
```

在 fallback path 下 Mini suppression。

### Device QA

至少实际：

```text
iOS Safari
Android Chrome
```

做一次 soft keyboard 视觉验收。

---

# 49. 验证 — Responsive switch

Viewport：

```text
767
```

→ compact-docked。

Viewport：

```text
768
```

* pref true：

→ wide-floating。

* pref false：

→ wide-docked。

Resize 跨 breakpoint：

```text
floating → compact
```

时旧 floating coordinates 不参与 mobile layout。

Resize 回 wide：

> 可以恢复本 session 内 desktop floating position，或回默认 dock point；实现需固定一种。

推荐：

> 恢复合法位置；若已超界则 re-clamp。

---

# 50. 验证 — Desktop floating

Drag：

* 不能拖出 viewport；
* release 后 horizontal edge snap；
* resize 后仍可见；
* playback button 不触发 drag；
* metadata click 不触发 drag。

---

# 51. 验证 — Desktop setting ON

```text
desktopFloatingPlayerEnabled=true
```

Wide：

```text
draggable
```

Mobile：

```text
docked
```

配置不影响 mobile。

---

# 52. 验证 — Desktop setting OFF

Wide：

```text
Mini 仍然存在
固定 TabBar 上方
不能拖动
```

不能出现：

```text
当前正在播放
+
无全局播放入口
```

---

# 53. 验证 — Config migration

已有 DB：

```text
floatingPlayerEnabled=false
```

升级以后：

```text
desktopFloatingPlayerEnabled=false
```

语义：

```text
wide-docked
```

而不是：

```text
Mini hidden
```

这是一次有意的产品语义升级。

---

# 54. 验证 — Old API compatibility

Legacy client：

```text
PATCH {
  floatingPlayerEnabled: false
}
```

Server：

```text
映射成功
```

新 Client：

```text
PATCH {
  desktopFloatingPlayerEnabled: true
}
```

正常。

同时不同值：

```text
BAD_REQUEST
```

---

# 55. 验证 — Expanded Compatibility

M6：

```text
Mini metadata click
→ /player
```

Browser Back：

```text
→ 原 route
```

例如：

```text
/library
→ /player
→ Back
→ /library
```

播放全程不断。

---

# 56. 验证 — `/player` 本身

处于：

```text
/player
```

Mini：

可以继续展示。

点击 metadata：

```text
no-op
```

不重复写 history。

Play/Pause 正常。

---

# 57. M7 Contract Test

M7 替换 entry implementation 后：

```text
Mini Component snapshot / event contract
```

不需要修改。

唯一改变：

```text
openDetails()
```

从：

```text
route push
```

变成：

```text
Expanded UI open
```

---

# 58. Accessibility

必须覆盖：

```text
Metadata Button
aria-label="展开正在播放：月球上的小狐狸"

Play Button
aria-label="暂停播放"

Ended
aria-label="重新播放"

Error
aria-label="重试播放"
```

Progress：

```text
role="progressbar"
aria-valuemin=0
aria-valuemax=100
aria-valuenow=...
aria-label="故事段落进度"
```

如果 progress 无法可靠确定：

> 不设置 determinate progressbar。

---

# 58.1 Focus

Mini 出现：

> 不抢焦点。

Mini 消失：

如果当前 focus 位于 Mini：

> 只有 Expanded open 等用户主动操作才需要把焦点迁入新 Surface。

因为 Keyboard suppress 是系统行为，不应突然重新 focus 页面其他元素。

---

# 58.2 Reduced Motion

当前 Design Spec 已要求：

```text
prefers-reduced-motion
```

关闭非必要动画。

因此：

* Mini enter；
* edge snap；
* loading pulse；

都必须支持 reduced motion。

---

# 59. E2E / Test Catalog

M10 至少登记：

```text
Mini appears for Ready Anchor

Mini survives:
/chat
→ /library
→ /setting

Mini title follows StoryWork title

Play / Pause

Ended → Replay

Error → Retry

currentAudioUrl=null but Ready session
仍显示 Mini

mobile docked
desktop floating
desktop pref off → docked

safe-area

keyboard suppression

desktop drag clamp
desktop edge snap
desktop resize recovery

Mini → /player compatibility

/player Back restores origin

config migration

account switch 后 Mini 不泄漏上一 Subject playback
```

最后一项依赖 M5/AccountSync：

> User A 的 Session 不能在 User B 页面出现。

---

# 60. 主要风险

| 风险                                       |   严重度 | 处理                                  |
| ---------------------------------------- | ----: | ----------------------------------- |
| 把 `isFloatingVisible` 重新放入新 UI Store     | **高** | Mini visibility 必须派生                |
| config 关闭后全局播放入口消失                       | **高** | OFF = wide-docked，不是 hidden         |
| Mini 继续依赖 `currentAudioUrl` 判断存在         | **高** | 只依赖 M5 Session                      |
| rehydrated Ready 但无 URL 导致 Mini 不见       |     高 | Session-based visibility            |
| remainingMs 被误认作作品剩余时长                   |     中 | 完全移出 Mini                           |
| paragraph rail 被误认成精确时间                  |     中 | nonseek + secondary paragraph label |
| Mini 覆盖 Library / Composer 底部            | **高** | `bottom-chrome-safe-bottom`         |
| Safe Area 加两次                            |     中 | Mini 复用 tab-bar-safe-bottom         |
| 软件键盘遮挡 Mini / Composer                   | **高** | compact keyboard suppression        |
| desktop drag 与 metadata click 冲突         |     中 | 专用 DragGrip                         |
| resize 后 floating 跑出屏幕                   |     中 | resize re-clamp                     |
| 浮窗位置持久化造成跨设备非法坐标                         |     低 | V1 不持久化                             |
| Mini z-floating 压过 M7 Expanded           |     高 | Expanded 时 suppress Mini            |
| Breakpoint 在多处硬编码                        |     中 | centralized Sass breakpoint token   |
| Config logical rename 破坏旧 Browser Bundle |     中 | legacy API alias                    |
| 新 Bottom Chrome 变量只改 content，忘记 Composer |     高 | 统一 layout contract + E2E            |
| M6 直接调用 AudioControllerHost              |     高 | 所有动作走 M5 Session Flow               |
| `/player` compatibility 被提前删除            |     高 | M1 contract + M9 gate               |

---

# 61. 拍板项

## M6-P01 — Desktop 关闭 Floating 后的行为

推荐：

> **不是隐藏 Mini，而是切换成 Wide Docked。**

这样 Global Now Playing 永远存在。

---

## M6-P02 — 移动端软键盘打开时 Mini

推荐：

> **临时隐藏 Mini，音频继续播放。**

优先保证输入空间和 Composer 可用性。

---

## M6-P03 — Desktop Floating Position 是否跨刷新保存

推荐：

> **V1 不保存。**

只在当前浏览 session 内保留，避免引入低价值设备相关配置。

---

## M6-P04 — Mini Progress

推荐：

> **M6 展示段落级粗进度，但不可 seek；M8 后无缝升级为 duration-based story progress。**

不在 M6 提供伪精确整篇时间轴。

---

## M6-P05 — M6 → M7 展开过渡

推荐：

> **M6 通过 facade 暂时进入 `/player`；M7 只替换 facade implementation，不修改 Mini Component。**

这样 M1 Frozen Compatibility 与 M7 最终形态之间有清晰桥梁。

---

# 62. M6 完成后的职责图

```text
                    M5 Playback Session
                  source / title / status
                           │
                           ▼
                Mini ViewModel Selector
                           ▲
                           │
                   Audio Transport
                 currentTime / duration
                           │
                           ▼
                  Mini Now Playing
                           │
          ┌────────────────┴────────────────┐
          │                                 │
          ▼                                 ▼
   Playback Action                  Open Details
          │                                 │
          ▼                                 ▼
 M5 Session Flow                  M6: /player
                                  M7: Expanded
```

Responsive Presentation：

```text
                   has Now Playing
                         │
             ┌───────────┴───────────┐
             │                       │
        compact < 768             wide >= 768
             │                       │
             ▼               ┌───────┴────────┐
        Docked Mini           │                │
                              ▼                ▼
                        pref=true          pref=false
                              │                │
                         Floating           Docked
```

本模块结束后，原来的「播放浮窗」正式变成产品的 **Global Mini Now Playing**：

* 它是否存在由播放 Session 决定；
* 它在哪里由 Responsive / desktop preference 决定；
* 它播放什么由 M5 决定；
* 它不会再拿 `remainingMs` 冒充作品信息；
* 它不会因为用户关闭“浮动模式”而让播放控制入口消失；
* M7 只需要在它后面接上 Expanded Surface，而无需再次改造全局播放入口。
