# M7 — Expanded Now Playing 技术方案

**所属 Phase**：P3
**前置模块**：M5 Playback Session、M6 Mini Now Playing
**增强依赖**：M8 Canonical Audio / Story Audio Manifest
**后续收口**：M9 `/player` 退役
**核心目标**：

1. 把旧 `/player` 中 `AudioPlayer` 的完整播放控制迁移到 Global Now Playing；
2. 建立移动 Bottom Sheet / 桌面 Side Panel 两种 Expanded Surface；
3. 把现有“播放时长限制”正式升级为 Sleep Timer；
4. P3A 保持现有 paragraph/current-segment 播放能力，P3B 接入 M8 后升级为真正 Story-level timeline；
5. Expanded 只拥有“播放控制”，不重新侵占 Story Detail 的内容管理职责。

---

# 0. 核心技术决策

| 决策                 | 推荐                                         |
| ------------------ | ------------------------------------------ |
| Expanded 是否是 Route | **否**                                      |
| UI state           | 独立 `nowPlayingUiStore`                     |
| 是否进入 playbackStore | **绝不**                                     |
| 移动端                | Modal Bottom Sheet                         |
| 桌面端                | Modal Side Panel                           |
| 打开 Expanded        | 不改变播放状态                                    |
| 关闭 / Escape / 下滑   | **不暂停播放**                                  |
| Session 被清空        | Expanded 自动关闭                              |
| Mini               | Expanded 打开期间 suppress                     |
| P3A timeline       | **当前 Segment seek**                        |
| P3B timeline       | **M8 Story-level timeline**                |
| 当前 Segment 键盘      | 保留 ±5 秒、Home / End                         |
| 点击进度条 seek         | 保留                                         |
| 倍速                 | 保留旧选项，当前 Session 级                         |
| 大型唱片动画             | **不作为迁移要求**                                |
| Sleep Timer        | 正式取代“播放倒计时/播放时长”产品语义                       |
| Timer 底座           | 复用 `remainingAllowedMs / totalAllowedMs`   |
| Timer 倒计时          | 只在实际播放时减少                                  |
| Timer 到期           | Pause + 保存断点 + Timer 自动关闭                  |
| “本故事结束后”           | 仅 Work 提供                                  |
| 查看正文 Work          | → `/library/[id]`                          |
| 查看正文 Draft         | Expanded 内只读正文                             |
| 从头播放               | M5 restart，产生新 Session                     |
| 继续创作               | 委托 M4 continuation contract，不在 M7 拼 Prompt |
| `/player`          | M7 完成后不再有正常业务入口；M9 执行 redirect/删除          |

---

# 1. 旧 AudioPlayer 能力盘点

当前 `AudioPlayer` 已有：

* title / voice subtitle；
* 当前段 `currentTime / duration`；
* 点击进度条 seek；
* progress slider keyboard：

  * ← / ↓：-5 秒；
  * → / ↑：+5 秒；
  * Home：段首；
  * End：段尾；
* playback rate；
* play / pause；
* 从头重播；
* paragraph badge；
* rehydrated ready 播放。

其 seek 最终直接调用 `AudioControllerHost`：

```text id="zd92ae"
seekAudio(time)
→ audioController.seek(time)
→ audio.currentTime = time
```

所以它当前明确是**当前音频 Segment 的 seek**，并不是整个故事时间轴。

---

# 2. 能力迁移矩阵

| 当前 AudioPlayer            | M7 目标                       |
| ------------------------- | --------------------------- |
| 临时推导 title                | M5 Session.title            |
| 当前 config voice           | M5 Session.voiceId 对应 label |
| currentTime / duration    | P3A 当前 Segment              |
| Progress click            | 保留                          |
| Keyboard ±5s              | 保留                          |
| Home / End                | 保留                          |
| Speed menu                | 保留                          |
| Play / Pause              | M5 Session Flow             |
| Replay from start         | M5 restartCurrentSession    |
| Paragraph badge           | 保留                          |
| rehydrated special branch | 消失，由 M5 Ready Session 统一    |
| `useFloatingPlayer()`     | 删除依赖                        |
| 直接读 progressStore         | 删除依赖                        |
| 大型 spinning disc          | 不迁移为功能要求                    |

当前组件仍然需要自己判断 `isRehydratedReady` 并调用不同恢复函数，这是 M5 收敛后应消失的技术分支。

---

# 3. Expanded 不再复制旧 AudioPlayer

不建议：

```text id="1wsmvz"
复制 AudioPlayer/index.tsx
↓
改 CSS
↓
塞进 Sheet
```

目标应是拆成：

```text id="xdz5v2"
ExpandedNowPlaying
│
├── NowPlayingHeader
├── PlaybackTimeline
├── PlaybackControls
├── PlaybackRateControl
├── ParagraphStatus
├── SleepTimerControl
└── NowPlayingActions
```

所有组件消费统一 ViewModel / Control facade。

---

# 4. UI 状态

新增：

```text id="ei9rvr"
stores/nowPlayingUiStore.ts
```

只包含：

```ts id="qol89q"
type NowPlayingUiStore = {
  isExpanded: boolean

  openExpanded(): void
  closeExpanded(): void
}
```

可以额外存：

```text id="kqwtgq"
returnFocusTarget
```

但绝不存：

```text id="aekmke"
workId
sessionId
title
isPlaying
currentTime
sleep timer
```

这些全部来自 M5。

---

# 4.1 为什么选择独立 Zustand UI Store

Expanded 可以从：

* Mini；
* Story Card；
* 未来系统快捷入口；

打开。

一个全局但极小的 UI Store 比把状态提升进 Playback Domain 更合适。

原则：

```text id="5i29pl"
isExpanded
=
UI state

isPlaying
=
Playback state
```

两者生命周期彻底独立。

---

# 5. Global Layer

M6 后 Main Chrome：

```text id="fq1ekq"
MainChrome
├── Page
├── TabBar
└── MiniNowPlaying

AudioControllerHost
```

M7：

```text id="lp80m3"
MainChrome
├── Page
├── TabBar
├── MiniNowPlaying
└── NowPlayingLayer
    └── ExpandedNowPlaying

AudioControllerHost
```

Expanded 仍属于 `(main)` Global Layer。

页面导航不会卸载它，也不会卸载 Audio Host。

---

# 6. Mini → Expanded

M6 已经固定：

```text id="48a2pz"
Mini
→ useNowPlayingEntry().openDetails()
```

M6 临时实现：

```text id="nznakr"
router.push('/player')
```

M7 正式替换为：

```ts id="ej3lvb"
openDetails() {
  useNowPlayingUiStore
    .getState()
    .openExpanded()
}
```

Mini Component 本身零改动。

---

# 6.1 `/player` 不再作为 Expanded fallback

M7 完成后：

```text id="5uhrd3"
正常产品流程
→ 不再 navigate('/player')
```

但根据 M1：

```text id="gs47pd"
/player
```

仍然物理保留。

真正 redirect 和物理删除由 M9 完成。

---

# 7. Mini suppress

M6 已定义：

```text id="ga6adw"
Expanded open
→ Mini suppress
```

M7 提供正式：

```text id="x8cvd3"
isExpanded
```

给 M6 selector。

Suppress 只改变：

```text id="nipn0m"
Mini presentation
```

不改变：

```text id="jr2z3u"
Playback Session
Audio Transport
```

Expanded 关闭：

```text id="c7cdzl"
Mini 自动重新出现
```

---

# 8. Expanded 自动关闭条件

只有下面情况自动关闭：

```text id="fctceh"
M5 source == null
或
session.status == idle
```

典型：

* logout；
* account switch；
* permanent delete 当前 Work；
* 用户明确 clear Now Playing。

以下都**不自动关闭**：

```text id="l10sow"
pause
ended
error
synthesizing
route change
```

尤其 M5-P02 已确认：

> Work ended 后仍保留 Now Playing。

所以 Expanded 也应继续停留在：

```text id="u5zs0n"
播放完成
[再次播放]
```

状态。

---

# 9. 打开 / 关闭与播放的关系

固定：

```text id="tfczx2"
open Expanded
≠ play

close Expanded
≠ pause
```

以下行为全部只关闭 UI：

* 点击关闭；
* backdrop；
* Escape；
* Mobile 下滑收起。

音频继续。

---

# 9.1 为什么关闭不能 Pause

否则用户会得到：

```text id="ku0106"
查看详细控制
↓
关闭面板回去看故事库
↓
声音突然停止
```

违背 Global Playback 的基本心智。

Pause 只能来自：

* 显式 Pause；
* Sleep Timer 到期；
* Work 完播；
* Session invalidation。

---

# 10. 移动端 Surface

`< 768px`：

```text id="wiwmb0"
Modal Bottom Sheet
```

示意：

```text id="hmqjsn"
┌─────────────────────────────┐
│      underlying page        │
│                             │
├─────────────────────────────┤
│             ───             │
│                             │
│ 月球上的小狐狸          ×   │
│ 小雅 · 第 4 / 12 段         │
│                             │
│ 01:24 ━━━━━●━━━━━━ 02:16   │
│                             │
│        ⏮5  ⏸  5⏭          │
│                             │
│ 1.0x              睡眠定时  │
│                             │
│ 查看正文                    │
│ 继续创作                    │
│ 从头播放                    │
└─────────────────────────────┘
```

具体视觉继续服从 DESIGN_SPEC。

---

# 10.1 实现基础

项目已经依赖：

```text id="snkpda"
react-aria-components
```

推荐使用：

```text id="85pfp3"
ModalOverlay
Modal
Dialog
```

获得：

* Focus containment；
* Escape；
* accessible dialog role；
* focus lifecycle；
* overlay semantics。

而不是自己实现一套 focus trap。

---

# 10.2 Bottom Sheet drag

移动端允许：

```text id="qewi2e"
Drag Handle
↓
向下拖动
↓
collapse
```

推荐继续利用项目已有：

```text id="tt8yej"
@use-gesture/react
```

但：

> 只允许从顶部 Drag Handle 启动。

不允许整个内容区都捕获 vertical drag，否则会和：

```text id="w8cic2"
正文滚动
Speed list
Sleep Timer list
```

冲突。

---

# 10.3 Reduced Motion

```text id="sgz5hh"
prefers-reduced-motion
```

下：

* Sheet 不做弹簧入场；
* Drag dismiss 后立即收起；
* 不做复杂 blur scale transition。

延续 DESIGN_SPEC motion policy。

---

# 11. 桌面 Surface

`>= 768px`：

```text id="y4251v"
Right Side Panel
```

推荐仍使用：

```text id="kybmb0"
Modal semantics
```

而不是可与页面同时交互的 persistent split pane。

---

# 11.1 原因

V1 Expanded 是：

> 临时完整播放控制界面。

不是：

> 桌面工作台的永久第二栏。

Modal Side Panel 可以天然提供：

* focus management；
* Escape；
* backdrop；
* clear ownership；
* 更低实现复杂度。

以后如果产品真的需要：

```text id="8ykjni"
一边长期编辑 Story
一边固定 Player Panel
```

再独立升级成 non-modal workspace panel。

---

# 11.2 Desktop layout

```text id="o045i1"
┌───────────────────────────┬───────────────┐
│                           │ Expanded      │
│       Current Page        │ Now Playing   │
│        (dimmed)           │               │
│                           │               │
└───────────────────────────┴───────────────┘
```

Side Panel：

* right anchored；
* full available height；
* glass elevated surface；
* left-side large radius；
* tokenized width；
* body scrollable。

---

# 12. DESIGN_SPEC 扩展

当前 DESIGN_SPEC 有：

* AudioPlayer；
* 通用 80vh Bottom Modal；
* z-modal；
* glass surface。

M7 更新为：

```text id="wm7ypr"
3.x Expanded Now Playing
```

新增 token：

```text id="88dqfr"
--size-now-playing-sheet-max-height
--size-now-playing-panel-width
--size-now-playing-handle
```

以及 Responsive：

```text id="2y23yd"
compact → bottom sheet
wide    → side panel
```

旧：

```text id="ogxod9"
3.5 AudioPlayer
```

由“页面播放器规格”调整为：

> Expanded Now Playing 内播放控制规格。

---

# 13. 不保留大型唱片作为兼容义务

当前 AudioPlayer 很大一部分 CSS 是：

```text id="nzgvxf"
176px spinning disc
glow
vinyl gradients
```

这属于旧独立 Player Page 的视觉表达，并非播放能力。

M7 推荐：

> 不把大型 Disc 原样搬进 Expanded。

可以使用：

* 小型 ambient visual；
* waveform；
* glow；
* 或纯 typography。

但不让它挤压真正的：

```text id="lkt36e"
timeline
controls
sleep timer
actions
```

---

# 14. Expanded ViewModel

推荐：

```ts id="lx0jl6"
type ExpandedNowPlayingViewModel = {
  title: string
  voiceLabel: string

  sessionStatus: PlaybackSessionStatus
  source: PlaybackSourceRef

  paragraph: {
    current: number
    total: number
  }

  timeline: PlaybackTimelineViewModel

  playbackRate: number

  sleepTimer: SleepTimerViewModel

  canViewStory: boolean
  canContinueCreation: boolean
  canRestart: boolean
}
```

不复制 Store。

---

# 15. Voice Label

旧 AudioPlayer：

```text id="f7fbvx"
current Config voiceId
→ voice label
```

这对 Work 已经不正确：

> 用户全局 Voice 改了，不代表当前老 Work 的 Voice 改了。

M7：

```text id="w8h39u"
M5 Session.voiceId
↓
config voiceOptions lookup
```

找不到：

```text id="86k7g4"
直接显示 voiceId
```

再 fallback：

```text id="s5f8n1"
AI 语音
```

Work authoritative voice 来自 M2/M5。

---

# 16. Playback Controls Facade

新增：

```text id="eg67kd"
components/NowPlaying/
└── useExpandedPlaybackControls.ts
```

暴露：

```ts id="v53p1u"
{
  play()
  pause()
  restart()

  seekCurrentSegment(seconds)
  seekRelative(seconds)

  setPlaybackRate(rate)

  setSleepTimer(...)
}
```

P3B 再增加：

```ts id="nqp6cl"
seekStoryPosition(ms)
```

UI 不直接调用：

```text id="1hnysi"
audioController
playbackStore.audioController
M8.ensureSegment
```

---

# 17. Phase 3A Timeline

M8 尚未 ready 时：

```text id="l6qmsf"
timeline.mode = 'segment'
```

数据：

```text id="9ntvvf"
currentTime
duration
```

来自 M5 Transport。

UI 必须明确：

```text id="0qf938"
本段
第 4 / 12 段
```

而不是伪装成：

```text id="7dq4k2"
整篇 03:42 / 18:20
```

---

# 17.1 P3A 点击 Seek

保留旧逻辑：

```text id="pz8wmz"
pointer position
÷
track width
×
current segment duration
```

→

```text id="unntb7"
seekCurrentSegment()
```

旧 AudioPlayer 本身就是这一行为。

---

# 17.2 Keyboard

Slider 保持：

```text id="5abaz6"
ArrowLeft / Down
→ -5s

ArrowRight / Up
→ +5s

Home
→ segment start

End
→ segment end
```

保持 ARIA：

```text id="31rsek"
role=slider
aria-valuemin
aria-valuemax
aria-valuenow
aria-valuetext
```

---

# 17.3 Seek clamp

所有 seek：

```ts id="i7xdl8"
clamp(
  target,
  0,
  duration
)
```

Transport 不允许非法时间。

---

# 18. Phase 3B Story Timeline

M8 Manifest：

```text id="2jgrcw"
segments[]
├── durationMs
├── index
└── playback URL
```

全部 ready 后：

```text id="tv3v9h"
timeline.mode = 'story'
```

---

# 18.1 时间映射

Story current position：

```text id="ahtedj"
sum(
  duration of segments < currentIndex
)
+
current segment currentTime
```

Story duration：

```text id="bdxgbl"
sum(all segment duration)
```

---

# 18.2 Story seek

不要让 M7：

```text id="hvqa3y"
binary search
→ M8.ensureSegment
→ M5 switch track
→ audio.seek
```

这些跨领域操作散在 UI。

新增 M5/M8 integration action：

```ts id="7uyrki"
seekCurrentWorkToStoryTime(
  targetMs
)
```

内部：

1. 校验 current Session；
2. 加载 Manifest；
3. 找 target Segment；
4. 确保 Segment ready；
5. 切换该 Segment；
6. `audio.currentTime = offset`；
7. 更新 Session paragraph index；
8. 保存 checkpoint；
9. Session stale guard。

M7 只调用：

```text id="ga4tei"
seekStoryPosition(targetMs)
```

---

# 18.3 P3B UI 切换

当 Manifest：

```text id="efqcg3"
status == ready
```

显示：

```text id="8aj68d"
03:42 ━━━━━━━━━●━━━━━ 18:20
第 4 / 12 段
```

否则继续：

```text id="xwt7pt"
本段
01:24 ━━━●━━━━ 02:16
第 4 / 12 段
```

不展示半可信的 Partial Story duration。

---

# 19. Timeline upgrade 不改变 Session

P3A：

```text id="8mh9em"
work(481)
session UUID A
```

M8 在后台完成 Manifest。

Timeline：

```text id="drqjhq"
segment
→ story
```

Session：

```text id="j9ud2g"
仍然 UUID A
```

不重新开始播放，不改变 Work progress identity。

---

# 20. Playback Rate

保留当前选项：

```text id="9bsrpa"
0.8
0.9
0.95
1.0
1.05
1.1
1.5
```

先不趁迁移顺手改用户行为。当前旧 AudioPlayer 正是这组值。

---

# 20.1 当前 Session 级

Expanded 改倍速：

```text id="ublccb"
M5 Session.speed
+
Transport playbackRate
```

并保存至 Anchor。

不自动更新：

```text id="fvu5uy"
UserConfig default speed
```

Settings 中的：

```text id="zv4atx"
speed
```

继续定义：

> 新 Session 默认倍速。

Expanded 定义：

> 当前 Session 倍速。

---

# 20.2 M8

M8 已拍板：

```text id="fuz5xl"
Canonical TTS speed = 1.0
```

所以 Expanded 任何倍速变化：

> 都不得创建新 Audio Asset。

只通过 `<audio>.playbackRate`。`AudioControllerHost` 当前已经具备该能力。

---

# 21. Sleep Timer — 新领域语义

当前系统中的：

```text id="160ma9"
playDurationMinutes
remainingMs
totalAllowedMs
```

实际上已经实现：

> 播放到 N 分钟以后暂停。

当前倒计时归零会同步暂停 `<audio>`。

只是产品 UI 叫：

```text id="24medb"
播放时长
播放倒计时
```

M7 正式重命名：

> **睡眠定时**

---

# 22. Sleep Timer 状态

正式：

```ts id="e91jzj"
type SleepTimerMode =
  | 'off'
  | 'minutes'
  | 'story_end'
```

对应：

### off

```text id="0z0fb8"
不限制
```

### minutes

```text id="abovdg"
播放 N 分钟后暂停
```

### story_end

```text id="5d0m4q"
当前 Work 播放完成后停止
```

---

# 22.1 `story_end` 只适用于 Work

Work 在 M5 中：

```text id="kzmc4w"
continuationMode = finite
```

所以：

```text id="74vbyw"
story_end
```

有明确含义。

Draft 可能：

```text id="yvozuu"
extendable
```

如果把“故事结束后”暴露给 Draft，就会变成：

> 当前已有文本结束，还是 AI 继续生成后的结束？

语义模糊。

因此 Draft 不显示此选项。

---

# 23. M5 Anchor 的 M7 增补

M5 已经有：

```text id="he2fch"
remainingAllowedMs
totalAllowedMs
```

M7 增补：

```text id="17m3wc"
sleepTimerMode
```

User / Guest Anchor：

```prisma id="37yjfg"
sleepTimerMode String @default("minutes")
```

---

# 23.1 Legacy migration

新增列后：

```text id="etbld2"
remainingAllowedMs != null
→ minutes

remainingAllowedMs == null
→ off
```

不要只依赖 schema default。

---

# 24. Timer API

M5 playback router 增补：

```text id="7upmuh"
playback.setSleepTimer
```

Input：

```ts id="6s7v66"
{
  sessionId: string

  mode:
    | 'off'
    | 'minutes'
    | 'story_end'

  minutes?: number
}
```

规则：

### off

```text id="37h1wy"
remaining = null
total = null
```

### minutes

```text id="3xi2ai"
remaining =
minutes × 60_000

total =
minutes × 60_000
```

### story_end

```text id="ugdsas"
only work
remaining = null
total = null
```

---

# 24.1 Session Guard

同 M5：

```text id="8e08vw"
input.sessionId
!=
current Anchor.sessionId
```

→

```text id="sop5ri"
STALE_SESSION
```

旧 Expanded 操作不能修改新 Session timer。

---

# 25. Timer Runtime

Transport 继续复用当前：

```text id="csdi28"
remainingMs
totalAllowedMs
tick interval
```

但只有：

```text id="f507va"
sleepTimerMode == minutes
```

才启动 countdown。

---

# 25.1 Countdown semantics

推荐保持现有底座：

> **只在音频真实播放时减少。**

以下不扣时间：

```text id="w7zn1r"
paused
synthesizing
network wait
ready
```

理由：

用户设置的是：

> “再听 30 分钟”

而不是：

> “从现在起 30 分钟整”。

并且最大程度兼容现有实现。

---

# 26. Timer 到期

当前代码到 0 会：

```text id="lxixfh"
pause audio
remainingMs = 0
```

并且之后 `resumeAudio()` 会因为：

```text id="5774jz"
remainingMs <= 0
```

永久拒绝恢复。

这不适合正式 Sleep Timer。

---

## M7 新规则

Timer 到期：

```text id="wx1i4m"
pause
↓
save checkpoint
↓
sleepTimerMode = off
remainingMs = null
totalAllowedMs = null
↓
Toast:
睡眠定时已结束
```

Session 本身保留：

```text id="s6ztqg"
paused
```

用户醒来后手动：

```text id="3qpby8"
Play
```

可以继续。

不需要先去设置重新开启。

---

# 27. Work 完播

如果：

```text id="uch64j"
Work ends
```

无论 timer：

```text id="jpp0yf"
minutes
story_end
off
```

都执行 M5：

```text id="2aw49n"
completeSession()
```

同时 Timer reset：

```text id="4twx02"
off
```

如果用户点击：

```text id="702e9i"
再次播放
```

新 Session 使用新的默认 Sleep Timer 配置。

---

# 28. Session 切换

Sleep Timer 不跨 Work 继承。

```text id="bjk3hk"
Work A:
10 min remaining

↓ 用户播放 Work B

Work B:
使用 User Config default
```

避免出现：

> 新故事只剩旧故事遗留的 2 分钟 Timer。

---

# 29. 默认 Sleep Timer 配置

当前 Prisma：

```text id="4o6soq"
playDurationMinutes Int @default(30)
```

User / Guest 都有。

M7 推荐逻辑重命名：

```prisma id="zyoq2l"
defaultSleepTimerMinutes
  Int
  @default(30)
  @map("playDurationMinutes")

defaultSleepTimerEnabled
  Boolean
  @default(true)
```

---

# 29.1 为什么增加 Enabled

仅一个 Int 无法表达：

```text id="dqyogp"
关闭 Sleep Timer
```

而把：

```text id="9cbhpc"
0
```

塞进现有 10–120 约束会污染字段语义。

因此：

```text id="zqynt2"
enabled + minutes
```

最清楚。

---

# 29.2 Existing User migration

新列：

```text id="1su6bj"
defaultSleepTimerEnabled = true
```

因此已有用户升级后：

> 行为保持当前逻辑。

默认仍为：

```text id="ucbjkq"
30 分钟
```

不会突然变成无限播放。

---

# 30. Config DTO

正式字段：

```ts id="taouiv"
{
  defaultSleepTimerEnabled: boolean
  defaultSleepTimerMinutes: number

  ...
}
```

旧：

```text id="k8zp9h"
playDuration
```

作为 compatibility alias 一个发布周期保留。

与 M6 Config migration 策略一致。

---

# 31. Settings 迁移

当前设置页：

```text id="ky7z8p"
播放时长
10–60 分钟
```

而 server Zod 实际允许：

```text id="fkhfh5"
10–120
```

存在范围不一致。

M7 一起收口：

```text id="ms2qau"
默认睡眠定时

[开关]

10 ───────── 120 分钟
```

推荐统一：

```text id="952a44"
min 10
max 120
step 10
```

---

# 31.1 Expanded 快捷 Timer

展开页：

```text id="njse7c"
关闭
10 分钟
20 分钟
30 分钟
60 分钟
自定义
本故事结束后（Work）
```

“自定义”允许 10–120。

这些是：

> 当前 Session Timer。

不自动改 Settings 默认值。

---

# 32. Sleep Timer UI

显示：

### Off

```text id="ffw2b3"
睡眠定时
关闭
```

### Minutes

```text id="tibx1y"
睡眠定时
18:42 后暂停
```

### Story End

```text id="k0trxb"
睡眠定时
本故事结束后
```

与旧 `remainingMs` 最大区别：

> 它终于被明确标识成 Timer，而不是作品剩余时长。

---

# 33. Story Detail 与 Expanded ownership

必须锁死：

```text id="001luw"
/library/[id]
=
Content / Asset Detail

Expanded
=
Playback Controls
```

Expanded 不提供：

* rename；
* favorite；
* trash；
* delete；
* Prompt 管理；
* Story metadata 编辑。

这些继续属于 Story Detail。

---

# 34. Work — 查看正文

当前 Source：

```text id="xg0gov"
work(481)
```

点击：

```text id="si1ud9"
查看正文
```

行为：

```text id="36w3i0"
closeExpanded()
↓
router.push('/library/481')
```

播放：

```text id="njdd8r"
继续
```

---

# 34.1 已经在 Detail

如果当前：

```text id="2zmos2"
/library/481
```

点击：

```text id="a59iw0"
查看正文
```

只：

```text id="pqql1l"
closeExpanded()
```

不重复 push。

---

# 35. Draft — 查看正文

Draft 没有：

```text id="wauxlc"
StoryWork.id
```

因此禁止生成：

```text id="ttf5mi"
/library/[fake-id]
```

推荐 Expanded 内打开只读：

```text id="e9k9zc"
TranscriptView
```

数据来自：

```text id="uwk8ta"
M5 Session.storyText
```

这是 Expanded 内部局部 view state：

```text id="g9cs4d"
controls
↔
transcript
```

不进入 global UI Store。

---

# 35.1 Promotion

如果用户正在看 Draft Transcript，同时 M4：

```text id="c0cwo7"
promoteDraftToWork
```

成功：

> 不强制关闭 Transcript。

之后再点击“打开作品详情”即可进入：

```text id="n5xwpb"
/library/[workId]
```

---

# 36. “继续创作”

M7 不在播放器组件里：

```text id="hj2vbr"
storyText + "请继续"
```

自己拼 Prompt。

这会把 Agent context contract 泄漏进 Player UI。

---

# 36.1 Target contract

正式依赖 M4：

```ts id="0l6sw5"
continueFromStoryWork(
  workId: number
): Promise<void>
```

行为归 M4：

1. resolve StoryWork；
2. 建立正确创作上下文；
3. 回 `/chat`；
4. 启动继续创作流程。

M7：

```text id="x2o0xb"
close Expanded
→ call/navigate continuation flow
```

---

# 36.2 M7 落地时 contract 尚未实现

遵循 M3-P05：

> **隐藏该 CTA，而不是伪造 continuation。**

一旦 M4 additive contract 完成：

> 直接开启，不修改播放架构。

---

# 36.3 Continue 是否暂停当前播放

推荐：

> **不暂停。**

用户可以：

```text id="hhzycd"
边听原故事
边进入创作页继续创作
```

Global Playback 正是为此存在。

如果新创作过程中用户主动播放新的 Story，M5 自然切 Session。

---

# 37. Draft 的创作动作

Draft 本身属于 Chat。

Expanded 显示：

```text id="phvj5c"
返回创作
```

而不是：

```text id="x4fd6s"
继续创作
```

点击：

```text id="cmzvzs"
closeExpanded()
router.push('/chat')
```

不自动发送新 Prompt。

---

# 38. 从头播放

Work：

```text id="2ap7ye"
M5.restartCurrentSession()
```

语义沿用 M5：

* 新 UUID；
* Progress reset 0；
* `completedAt` 历史保留；
* title / identity 不变。

---

# 38.1 Draft restart

推荐：

> 重播当前已经存在的文本，从 paragraph 0 开始，并强制此次 restart 为 `finite`。

理由：

“从头播放”是消费操作。

不能因为重播到最后一段而意外：

```text id="1oz7bu"
自动请求 AI 继续生成
```

继续创作必须走单独 CTA。

---

# 39. Paragraph Status

Expanded 明确显示：

```text id="gnhvc1"
第 4 / 12 段
```

P3A：

> 这是 timeline 上最重要的作品级定位。

P3B：

> 即使有全篇时间轴，仍保留 paragraph indicator，方便理解 Story segment。

---

# 40. 是否加入“上一段 / 下一段”

M7 V1 推荐：

> **不新增。**

当前旧 AudioPlayer 没有这个用户行为，M5 也没有 approved manual paragraph-skip contract。

先完成：

```text id="9upugq"
current segment seek
+
restart
+
P3B story-level seek
```

以后 Story-level seek 已足够覆盖多数跳转需求。

---

# 41. Expanded keyboard

除了 Slider 自身：

```text id="zhj11l"
±5 / Home / End
```

整个 Modal 不增加：

```text id="0g1826"
Space = Play/Pause
Left = Seek
```

这样的全局键盘监听。

原因：

* 会与按钮、Slider、Dialog 本身冲突；
* 当前产品没有这种契约；
* 移动优先应用收益有限。

保留 Progress Slider 自身的明确 keyboard semantics 即可。

---

# 42. Focus

打开：

```text id="pa9v9i"
focus → Expanded close button
```

或标题后的第一个可操作控制。

不自动 focus Progress Slider。

关闭：

```text id="jix20w"
focus → Mini Metadata trigger
```

如果 Expanded 是从其他入口打开：

> 返回实际 trigger。

---

# 43. Backdrop

点击 Backdrop：

```text id="uqr0no"
closeExpanded()
```

播放继续。

对于正在拖动 Slider、Speed popover、Timer popover：

> 不允许事件冒泡误关闭面板。

---

# 44. Route change

Expanded 不属于 Route。

因此普通 route change：

```text id="2xyuyx"
/chat
→ /library
```

不自动关闭 Expanded。

但 M7 自己执行：

```text id="ewevwj"
查看正文
返回创作
继续创作
```

时：

> 先 close Expanded，再导航。

这样明确区分：

```text id="0xgbtv"
Global Surface
vs
Action-driven navigation
```

---

# 45. 文件级新增

```text id="16p6rv"
stores/
└── nowPlayingUiStore.ts
```

---

```text id="78lf1d"
components/NowPlaying/
├── NowPlayingLayer.tsx
├── ExpandedNowPlaying.tsx
├── ExpandedNowPlaying.module.scss
│
├── NowPlayingHeader.tsx
├── PlaybackTimeline.tsx
├── PlaybackControls.tsx
├── PlaybackRateControl.tsx
├── ParagraphStatus.tsx
├── SleepTimerControl.tsx
├── NowPlayingActions.tsx
├── TranscriptView.tsx
│
├── useExpandedPlaybackControls.ts
├── useExpandedNowPlayingViewModel.ts
└── storyTimeline.ts
```

---

# 46. 修改 M6

```text id="dlk0b9"
components/NowPlaying/
└── useNowPlayingEntry.ts
```

从：

```text id="w95t8i"
router.push('/player')
```

改：

```text id="e0pv7b"
openExpanded()
```

---

```text id="uuv3s5"
components/MainChrome/index.tsx
```

加入：

```text id="5tlbjx"
NowPlayingLayer
```

并：

```text id="afktuq"
isExpanded
→ suppress Mini
```

---

# 47. 修改 M5

M7 对 M5 的正式 additive contract：

```text id="ut3a2x"
sleepTimerMode
playback.setSleepTimer

restartCurrentSession
seekCurrentSegment
```

其中后两个如果 M5 内部已有等价 public action，只统一命名，不新增重复状态。

---

# 48. 修改 Config

```text id="opb38b"
prisma/schema.prisma
```

User / Guest Config：

```text id="62wbvx"
defaultSleepTimerMinutes
  @map("playDurationMinutes")

defaultSleepTimerEnabled
```

---

```text id="viwe56"
lib/trpc/schemas/config.ts
stores/configStore.ts
types/appConfig.ts
```

正式迁移新语义，保留：

```text id="921ryk"
playDuration
```

legacy alias 一个发布周期。

---

```text id="9fwrp3"
app/(main)/setting/components/BasicConfigSection.tsx
```

改：

```text id="ou8roy"
DefaultSleepTimerSection
```

并统一 10–120 range。

---

# 49. 修改 DESIGN_SPEC

更新：

```text id="uz2yq4"
AudioPlayer
Modal
Responsive Surface
Now Playing Layer
Sleep Timer
```

删除旧架构图里：

```text id="pmd7u3"
/player
→ AudioPlayer 为页面视觉焦点
```

这种 current-state 表述。

当前 DESIGN_SPEC 仍然把独立 AudioPlayer 放在 Player 页核心，需要同步成新 SSOT。

---

# 50. M7 不删除

仍然不删除：

```text id="4yfwm8"
app/(main)/player/**
```

尽管正常入口已经不再使用。

删除和 redirect：

> M9。

---

# 51. 实施步骤

推荐内部拆成：

```text id="cayild"
M7-A UI Store + Global Surface
↓
M7-B Current AudioPlayer capabilities migration
↓
M7-C Sleep Timer semantic migration
↓
M7-D Content/Creation actions
↓
M7-E P3A production cutover
↓
M7-F M8 Story Timeline integration (P3B)
```

---

# 52. Phase 3A 完成条件

无需等待 M8 完全完成。

P3A 必须具备：

```text id="eu6jnn"
Mobile Bottom Sheet
Desktop Side Panel

Title / Voice
Play / Pause
Current Segment timeline
Click seek
Keyboard ±5
Home / End
Playback rate
Paragraph progress
Sleep Timer
View story
Restart

Mini → Expanded
Close → Mini
```

---

# 53. Phase 3B 完成条件

M8：

```text id="p5ygu0"
Manifest ready
all Segment duration available
```

后增加：

```text id="et1fej"
Story-level timeline
Story-level currentTime
Story-level duration
Story-level seek
```

但：

```text id="rw1w5l"
Session
Mini
Sleep Timer
Actions
```

均不改。

---

# 54. 验证 — Open / Close

当前：

```text id="xvlxy4"
Work A playing
```

点击 Mini：

```text id="gxlwh4"
Expanded open
Mini suppressed
Audio continues
```

关闭：

```text id="j9dwlu"
Expanded closed
Mini restored
Audio continues
```

不得触发：

```text id="bv2l34"
pause()
resume()
new session
```

---

# 55. 验证 — Pause while Expanded

Expanded：

```text id="mmalfl"
Pause
```

结果：

```text id="0sk64t"
M5 paused
Mini hidden because Expanded
```

关闭：

```text id="kcg6cv"
Mini restored
状态仍 paused
```

---

# 56. 验证 — Ended

播放结束：

```text id="cqbnez"
Expanded remains open
```

显示：

```text id="9adq55"
播放完成
[再次播放]
```

关闭后：

```text id="2ru8ba"
Mini ended
```

符合 M5-P02。

---

# 57. 验证 — Session cleared

Expanded open。

随后：

```text id="nkjb0p"
logout
或
permanent delete current Work
```

M5：

```text id="xz6lv5"
source=null
```

Expanded：

```text id="rtsj8a"
auto close
```

不得保留上一用户 title/body。

---

# 58. 验证 — Segment Click Seek

当前段：

```text id="624kwp"
duration 100s
```

点击 50%：

```text id="rfovpy"
audio.currentTime ≈ 50
```

Session identity 不变。

---

# 59. 验证 — Keyboard

Progress Slider：

```text id="2vmu4x"
current=20
ArrowRight
→ 25

ArrowLeft
→ 20

Home
→ 0

End
→ duration
```

边界 clamp。

旧行为完整迁移。

---

# 60. 验证 — Playback Rate

当前：

```text id="ph7fhd"
1x
```

切：

```text id="a7s2na"
1.5x
```

必须同时：

```text id="5oumr1"
Transport.playbackRate=1.5
HTMLAudioElement.playbackRate=1.5
M5 Anchor speed=1.5
```

M8：

```text id="t306ze"
TTS count unchanged
```

---

# 61. 验证 — Rehydrate

Anchor：

```text id="39qk8k"
paused
speed=1.1
paragraph=4
```

Reload：

Expanded 打开后：

```text id="773kjm"
1.1x
第 4/12 段
Ready / Play
```

不需要：

```text id="tm1820"
isRehydratedReady
```

特殊 UI。

---

# 62. 验证 — Default Sleep Timer

旧用户：

```text id="80gx8a"
playDurationMinutes=30
```

migration 后：

```text id="1zrkyu"
enabled=true
minutes=30
```

新 Session：

```text id="4s5s69"
mode=minutes
remaining=30min
```

行为与升级前一致。

---

# 63. 验证 — Timer Off

Expanded：

```text id="ktmmel"
睡眠定时 → 关闭
```

结果：

```text id="qqk33i"
mode=off
remaining=null
total=null
```

播放不暂停。

Refresh：

```text id="4m9hwe"
仍然 off
```

---

# 64. 验证 — Timer Minutes

设置：

```text id="v77eyj"
10min
```

只在：

```text id="9qv7sg"
isPlaying
```

时减少。

Pause 60 秒：

```text id="b4eehu"
remaining 不减少
```

Resume 后继续。

---

# 65. 验证 — Timer Expiry

剩余：

```text id="pk0wis"
1s
```

播放到 0：

```text id="bik4i4"
audio paused
checkpoint saved
mode → off
remaining → null
```

用户点击 Play：

```text id="rzpojh"
正常继续
```

不得被旧：

```text id="059izt"
remainingMs <= 0
```

守卫永久锁死。

---

# 66. 验证 — Story End

Work：

```text id="0y3bph"
sleepTimerMode=story_end
```

播放完：

```text id="dgtq3n"
M5 ended
Timer reset off
```

Draft：

> 不展示该选项。

---

# 67. 验证 — Session Switch

A：

```text id="osbt71"
10min timer
3min remaining
```

切 B：

B 必须读取：

```text id="ou7x47"
User default
```

不能继承 3min。

---

# 68. 验证 — P3A Timeline

Manifest 不 ready：

```text id="2s0c23"
timeline mode=segment
```

UI 明确：

```text id="qeaq98"
本段 01:20 / 02:00
第 3/10 段
```

不得显示：

```text id="x3kw78"
假整篇 duration
```

---

# 69. 验证 — P3B Upgrade

同 Session 播放过程中，M8 Manifest 完整。

Expanded：

```text id="oztrpo"
timeline
segment → story
```

音频：

```text id="pp9qje"
不中断
```

SessionId：

```text id="nm4r99"
不变
```

---

# 70. 验证 — Story Seek

Manifest：

```text id="6q364s"
segment 0 = 60s
segment 1 = 90s
segment 2 = 50s
```

Seek：

```text id="8kvl34"
100s
```

应：

```text id="ps64u3"
segment 1
offset 40s
```

M5 Session paragraph → 1。

---

# 71. 验证 — View Story

Work：

```text id="zb6y3s"
Expanded
→ 查看正文
```

结果：

```text id="4mofiw"
/library/[id]
Expanded closed
Playback continues
```

如果已经处于该 Detail：

```text id="z10f5c"
only close
```

---

# 72. 验证 — Draft Transcript

Draft：

```text id="mux02e"
查看正文
```

不导航 Library。

Expanded 内：

```text id="ja2fkg"
Controls
↔ Transcript
```

返回控制不改变 Session。

---

# 73. 验证 — Restart Work

已 completed：

```text id="6ha1vg"
completedAt=T1
```

点击：

```text id="wdij44"
从头播放
```

结果：

```text id="p3pdmb"
new session UUID
position=0
completedAt=T1
```

符合 M5-P01。

---

# 74. 验证 — Restart Draft

Draft：

```text id="ldoatg"
从头播放
```

只播放当前已有正文。

到结尾：

```text id="wsmtfb"
停止
```

不得触发自动 AI continuation。

---

# 75. 验证 — Continue Creation

在 M4 continuation contract 开启后：

```text id="kjb447"
Work 481
→ 继续创作
```

期望：

```text id="0s9lii"
Expanded close
/chat
正确 StoryWork context
```

原 Work：

```text id="ux1jh9"
播放继续
```

---

# 76. 验证 — Responsive

Expanded open：

### 390px

```text id="ybisyc"
Bottom Sheet
```

### resize 到 900px

```text id="y5j6gx"
Side Panel
```

Session / UI open state不变。

不关闭再重新打开。

---

# 77. 验证 — Focus

Mini Metadata：

```text id="5vqyyd"
focus
→ Enter
→ Expanded
```

Expanded：

* focus 进入 Dialog；
* Tab 不逃出；
* Escape close；
* Mini 恢复后 focus 返回 Mini。

---

# 78. 验证 — Swipe Down

Mobile Drag Handle：

超过 dismiss threshold：

```text id="i0l576"
close
```

不足：

```text id="07fm1h"
spring / reset
```

正文滚动手势：

> 不触发 dismiss。

---

# 79. Browser / E2E

M10 至少登记：

```text id="3py1zc"
Mini → Expanded

open/close 不影响播放

mobile sheet
desktop side panel

play/pause
segment click seek
keyboard ±5
Home/End
speed
restart

paragraph status

sleep timer:
off
minutes
expiry
story end
rehydrate

Work 查看正文
Draft transcript

session clear auto close

P3A segment timeline

M8 ready → P3B story timeline

story-level seek across segments

route navigation while playback continues
```

---

# 80. 主要风险

| 风险                                       |   严重度 | 处理                                     |
| ---------------------------------------- | ----: | -------------------------------------- |
| Expanded open state 被塞回 playbackStore    | **高** | 专用 UI Store                            |
| Close Sheet 意外 Pause                     |     高 | close 与 playback action 完全解耦           |
| 旧 AudioPlayer rehydrated 分支被复制           |     高 | M5 Session 统一状态                        |
| P3A 当前段进度被误画成整篇时间轴                       | **高** | 明确 `timeline.mode`                     |
| M8 部分 ready 时展示错误总时长                     |     高 | Manifest fully ready 才启 Story timeline |
| Story seek 在 UI 层直接操纵 Segment/TTS        |     高 | M5/M8 integration action               |
| Sleep Timer 到期后旧 0 budget 永久锁死播放         | **高** | expiry 自动转 off/null                    |
| Sleep Timer 被误解为作品剩余时间                   |     高 | 独立语义/标签                                |
| `story_end` 暴露给 extendable Draft         |     中 | 仅 Work                                 |
| 新 Session 继承旧 Session Timer              |     高 | Timer session-scoped                   |
| Expanded 重复实现 Story Detail 管理能力          |     高 | 只 View Story / Continue / Restart      |
| “继续创作”直接拼 Prompt                         | **高** | 必须委托 M4 contract                       |
| Desktop Side Panel 非 modal 导致 focus/交互复杂 |     中 | V1 使用 modal semantics                  |
| Sheet drag 与内容滚动冲突                       |     中 | 只 Drag Handle                          |
| Mini z-index 高于 Modal                    |     高 | Expanded 时 suppress Mini               |
| Voice label 错读当前全局 Config                |     中 | 使用 Session.voiceId                     |
| 倍速写回全局设置导致意外改变未来 Session                 |     中 | Expanded 仅当前 Session                   |
| `/player` 在 M7 被提前删除                     |     高 | M9 独占退役职责                              |

---

# 81. 拍板项

## M7-P01 — Expanded 收起是否暂停

推荐：

> **不暂停。**

收起只是 UI 行为。

---

## M7-P02 — Desktop Side Panel 是否允许同时操作背景页面

推荐：

> **V1 使用 Modal Side Panel。**

背景不可交互；关闭后继续页面工作。

以后如果需要真正桌面工作台，再升级 non-modal persistent panel。

---

## M7-P03 — Sleep Timer 倒计时语义

推荐：

> **按实际播放时间扣减，而不是墙钟时间。**

Pause / buffering / synthesis 不消耗 Timer。

---

## M7-P04 — 原有用户默认 Sleep Timer

推荐：

> **迁移后保持 Enabled + 原 playDurationMinutes。**

即现有默认 30 分钟行为保持；用户可以在新设置中关闭默认 Timer。

---

## M7-P05 — “本故事结束后”

推荐：

> **仅 StoryWork 提供，不对 Draft 暴露。**

避免和 AI 自动续写语义冲突。

---

## M7-P06 — 大型 Disc 视觉是否继续

推荐：

> **不作为 Expanded 的迁移要求。**

迁移所有功能能力，但把“独立播放器页的大唱片视觉”退出核心界面，使用更克制的 Liquid Glass / ambient presentation。

---

## M7-P07 — Continue Creation

推荐：

> **M7 只消费 M4 的 `continueFromStoryWork(workId)` 契约；契约未实现前隐藏 CTA。**

绝不在播放器内部拼装 Story Prompt / Agent context。

---

# 82. M7 完成后的最终边界

```text id="lyga6c"
                          StoryWork
                              │
                              ▼
                       M5 Playback Session
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
       M6 Mini Now Playing             M7 Expanded
      quick status/actions           full controls
              │                               │
              │                               ├── Segment seek (3A)
              │                               ├── Story seek (3B/M8)
              │                               ├── Speed
              │                               ├── Sleep Timer
              │                               ├── Paragraph
              │                               ├── View Story
              │                               └── Restart / Continue
              │
              └────────── 同一 Session ────────┘
```

页面 ownership：

```text id="fbqb56"
/library/[id]
    =
Story 内容 / 元数据 / 生命周期

Expanded Now Playing
    =
当前播放行为 / 播放控制

/chat
    =
创作 / 继续创作
```

最终用户不再需要理解：

```text id="bq8ihk"
“我要去播放器页面”
```

而只会理解：

```text id="dmv7ol"
“我正在听一个故事”
↓
Mini
↓
需要更多控制
↓
Expanded
```

M7 完成后，旧 `/player` 已经不再拥有任何独占的产品能力；这也是 M9 可以安全执行最终 redirect 和删除的技术前提。
