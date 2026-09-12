# Audio Player Next — 创作 / 故事库 / Global Now Playing 产品升级方案

**文档性质**：产品方案 / 设计与实施底稿
**方案状态**：方向已确认，进入方案评审
**核心改造**：播放器一级页面退出 → 故事库成为一级业务空间 → 播放能力升级为 Global Now Playing 全局层

---

## 0. 方案摘要

本次升级的核心不是重新设计一个更漂亮的播放器，而是重新定义产品中的三个核心对象：

* **创作**：用户正在生成、修改和延展的内容；
* **作品**：用户已经生成并拥有的故事资产；
* **播放**：跨页面持续存在的消费状态。

当前产品一级导航为「创作 / 播放器 / 设置」，其中 `/player` 同时承担播放状态、生成预览、完整播放器和历史记录。代码自身已经将该页面定义为“纯播放 + 历史视图，故事生成已统一收归创作页”，说明当前结构已经处于过渡态。与此同时，`AudioControllerHost` 与 `FloatingPlayer` 已经挂在 `(main)/layout.tsx` 全局层，播放生命周期实际上已经不依赖 `/player` 页面。

因此本方案确定：

> **一级业务空间调整为「创作 / 故事库 / 设置」；播放器不再是一级页面，而成为 Global Now Playing 全局能力。**

最终产品结构：

```text
┌──────────────────────────────────────┐
│             Product Space            │
│                                      │
│    创作           故事库        设置   │
│   /chat          /library     /setting│
│      │               │                │
│      └───────┬───────┘                │
│              ▼                        │
│        Global Now Playing             │
│        Mini ↔ Expanded                │
└──────────────────────────────────────┘
```

这里的基本原则是：

> **Artifact / 作品是内容资产；Playback / 播放是全局状态。**

这一形态也与当前生成式音频产品的演进一致。Suno 2026 年的 Studio Library 已经采用“可搜索、按日期分组的内容库 + 行内试听 + pinned mini-player”的结构；NotebookLM 则把 Audio Overview 等生成结果作为可保存 Artifact，同时允许用户一边听音频、一边继续浏览其他输出；ElevenLabs Studio 同样围绕“项目/内容 + 已生成音频版本”组织，而不是把播放器本身作为主要内容空间。

---

# 1. 目标与非目标

## 1.1 产品目标

本次升级解决四个问题：

1. 消除「播放器」作为一级导航的错误心智，让一级导航直接对应用户真正的任务。
2. 把生成历史从“日志”提升为用户可持续访问的“内容资产”。
3. 让音频播放跨创作、故事库、设置等页面连续存在，不因导航而被打断。
4. 为后续收藏、搜索、内容整理、分享、离线等能力建立可扩展的数据和交互模型。

## 1.2 本阶段非目标

本方案不把产品升级成 DAW 或专业音频编辑器。

当前不需要进入：

* 多轨编辑；
* 音频剪辑；
* 复杂播放列表体系；
* 社区/公开作品广场；
* 多版本正文编辑；
* 专业音频后期。

作品在现阶段仍以“AI 生成的一篇故事及其对应音频”为基本单位。

---

# 2. 信息架构与导航

## 2.1 一级 Tab 最终定义

当前 `components/MainTabBar/index.tsx` 中一级 Tab 明确定义为：

```text
chat      → 创作     → /chat
player    → 播放器   → /player
setting   → 设置     → /setting
```

目标结构调整为：

| Tab | 路由         | 用户问题         | 核心对象                 |
| --- | ---------- | ------------ | -------------------- |
| 创作  | `/chat`    | 我现在想创作什么？    | Conversation / Draft |
| 故事库 | `/library` | 我已经创作过什么？    | Story Work           |
| 设置  | `/setting` | 产品和生成方式如何配置？ | Preference           |

推荐将内部 Tab key 从 `player` 一并迁移为 `library`，而不是只改显示文案。

原因是这不是视觉重命名，而是一级业务语义变化。继续保留 `player` key 会把旧心智永久带入后续组件和测试。

---

## 2.2 路由迁移

### `/chat`

保持不变。

它继续承担：

* 对话输入；
* Agent 交互；
* 故事生成；
* 生成过程；
* 创作中的试听；
* 从旧作品继续创作。

根路由 `/` 仍可继续落到创作空间。

### `/library`

新增，并成为「故事库」正式路由。

建议支持：

```text
/library
/library/[storyId]
```

其中：

* `/library`：故事列表；
* `/library/[storyId]`：作品详情。

推荐让作品详情具有真正 URL，而不是完全依赖临时 Modal。

理由是作品属于稳定资产，需要支持：

* 刷新恢复；
* 浏览器前进/后退；
* 后续内部分享；
* 从通知/其他页面直接定位。

移动端视觉上仍然可以表现为整页或 Sheet，但 URL 应表达 Story identity。

### `/setting`

保持不变。

### `/player`

最终不再承担正式产品页面职责。

推荐采用两阶段退出：

```text
过渡阶段：
/player 仍保留为隐藏 compatibility route
用于旧 AudioPlayer 完整控制能力兜底

最终：
/player → /library
```

不建议直接把 `/player` 原路径改造成故事库。

`/library` 的语义更正确，也给以后故事之外的音频 Artifact 留有扩展空间。

---

# 3. Global Now Playing 定位

Global Now Playing 是本方案最重要的结构变化。

它不属于某个页面，而属于 `(main)` Layout。

当前 `(main)/layout.tsx` 已经是：

```text
Page Content
MainTabBar

AudioControllerHost
FloatingPlayer
```

也就是说底层结构本身已经满足全局播放层的要求。

目标调整为：

```text
MainLayout
│
├── Page Content
│   ├── /chat
│   ├── /library
│   └── /setting
│
├── MainTabBar
│
├── AudioControllerHost
│
└── NowPlayingLayer
    ├── MiniPlayer
    └── ExpandedNowPlaying
```

用户不再“进入播放器”。

用户只会：

> 播放一个作品 → 出现 Now Playing → 需要更多控制时展开。

---

# 4. 故事库页面设计

## 4.1 页面定位

故事库不是原 `GenerationHistory` 的放大版。

它的定位是：

> **用户已经生成内容的长期资产空间。**

当前 `/player/components/HistoryPanel` 把「提示词历史」与「生成历史」作为两个平级 Tab，并且提示词点击后通过 `setPendingAutoSend()` 跳回 `/chat` 自动重新创作。这个行为说明 Prompt 本质上属于“创作入口”，不是“作品资产”。

因此目标结构调整为：

* **Story / Generation History → 故事库**
* **Prompt History → 创作页“最近创作”**

故事库不再保留“提示词历史 / 生成历史”两个主 Tab。

---

## 4.2 故事库首页

推荐首版采用：

* 顶部标题；
* 搜索；
* 轻量筛选；
* 时间分组；
* Story Card / Row；
* Global Mini Player；
* Bottom TabBar。

移动端示意：

```text
┌───────────────────────────────┐
│ 故事库                        │
│                               │
│ 🔍 搜索故事                    │
│                               │
│ [全部]   [收藏]                │
│                               │
│ 今天                           │
│ ┌───────────────────────────┐ │
│ │ 月球上的小狐狸             │ │
│ │ 一只小狐狸第一次离开地球… │ │
│ │ 小雅 · 8 分钟 · 20:31     │ │
│ │                           │ │
│ │ ━━━━━━━●━━━━━  42%       │ │
│ │ ▶ 继续播放             ⋯ │ │
│ └───────────────────────────┘ │
│                               │
│ 昨天                           │
│ ┌───────────────────────────┐ │
│ │ 深海里的最后一座城市       │ │
│ │                           │ │
│ │ ▶ 播放                 ⋯ │ │
│ └───────────────────────────┘ │
│                               │
├───────────────────────────────┤
│ ▶ 月球上的小狐狸    ━━━  ⏸   │ ← Mini
├───────────────────────────────┤
│   创作       故事库       设置 │
└───────────────────────────────┘
```

### 时间分组

推荐：

* 今天
* 昨天
* 本周
* 更早

不建议一开始做复杂年月树。

目标是增加可扫描性，而不是建立文件管理器。

### 筛选

V1 推荐只保留：

```text
全部 / 收藏
```

搜索应该优先于更多复杂筛选。

Suno 当前 Library 同样采用可搜索、可过滤、按日期组织的内容列表，这种信息架构已经被生成式音频产品验证。

---

# 5. 作品条目 Story Card

## 5.1 信息层级

推荐每个作品条目包含：

**一级信息**

* title；
* 播放 / 继续播放状态。

**二级信息**

* 一行故事摘要；
* 音色；
* 时长；
* 创作时间。

**状态信息**

* 未播放；
* 已播放 X%；
* 已完成；
* 音频准备中；
* 音频暂不可用。

**动作**

主动作：

```text
播放
继续播放
再次播放
```

Secondary / `⋯`：

```text
查看正文
继续创作
用这个设定再创作
收藏
移到回收站
```

不建议一条 Card 上直接铺满所有动作。

---

## 5.2 播放 CTA 规则

定义为：

| 状态                  | CTA  |
| ------------------- | ---- |
| 从未播放                | 播放   |
| 0 < progress < 100% | 继续播放 |
| 已播完                 | 再次播放 |
| 音频准备中               | 准备中  |
| 音频异常                | 重试   |

“从头播放”放入更多菜单，避免和“继续播放”竞争。

---

# 6. 作品详情页

作品详情页负责“这个故事是什么”，而不是承担播放器职责。

移动端示意：

```text
┌─────────────────────────────┐
│ ‹ 故事库                    │
│                             │
│ 月球上的小狐狸              │
│ 昨天 20:31 · 小雅           │
│                             │
│ ┌─────────────────────────┐ │
│ │ ▶ 继续播放              │ │
│ │ 已播放 42%              │ │
│ └─────────────────────────┘ │
│                             │
│ 故事正文                    │
│ ─────────────────────────── │
│ 很久以前，在月球背面……      │
│ ……                          │
│                             │
│ 原始创作                    │
│ “写一个适合睡前听的……”      │
│                             │
│ [继续创作]   [再次创作]      │
│                             │
│                     ⋯       │
└─────────────────────────────┘
```

作品详情页展示：

* title；
* 创作时间；
* voice；
* 作品正文；
* 原始 prompt；
* 播放完成度；
* 主播放 CTA；
* 继续创作；
* 再次创作；
* 收藏；
* 删除。

### 推荐决策：作品正文默认不可直接修改

V1 中已经完成的 Story Work 应作为不可变 Artifact。

“继续创作”“重写”“换个版本”等操作产生新作品，而不是覆盖原作品。

这样可以保证：

* Story identity 稳定；
* 播放进度稳定；
* `contentHash` 稳定；
* 已生成音频不会和正文失配；
* 用户可以回看过去版本。

后续如果需要真正的版本管理，再增加 Work Revision 模型。

---

# 7. Mini Player

## 7.1 定位

现有 `components/FloatingPlayer` 已经具备：

* 全局挂载；
* 播放/暂停；
* 可拖拽；
* `currentAudioUrl` / rehydrated playback 判断；
* 段落状态；
* 播放时长倒计时。

但目前 UI 实际只是一枚紧凑悬浮控件，并且展示信息更偏“剩余时间 / 段落 X/Y”，没有真正建立 Now Playing identity。

本次不重写其底层播放逻辑，而是把它的产品角色升级成：

> **Mini Now Playing**

---

## 7.2 Mini Player 承载范围

Mini Player 只承担四件事：

1. 当前作品身份；
2. 当前播放状态；
3. 快速播放 / 暂停；
4. 进入 Expanded Now Playing。

不要把倍速、睡眠定时、跳转、收藏等都塞进去。

### 移动端

推荐固定在 TabBar 上方，不再允许自由拖动。

```text
┌─────────────────────────────────┐
│ ● 月球上的小狐狸                 │
│   ━━━━━━━━━●━━━━       ⏸       │
└─────────────────────────────────┘
```

整个主体区域可点击展开。

优点：

* 和底部导航形成稳定空间关系；
* 不遮挡正文；
* 不与系统返回手势冲突；
* 不需要用户维护悬浮位置；
* 比 draggable bubble 更符合移动媒体产品习惯。

### 桌面端

桌面保留 Floating 特性。

推荐默认：

```text
右下角 / 左下角 Dock
        ↓
允许拖动
        ↓
靠边吸附
```

示意：

```text
╭──────────────────────────────╮
│ 月球上的小狐狸               │
│ ━━━━━━━●━━━━━━      ⏸       │
╰──────────────────────────────╯
```

可继续复用当前 `useDrag` / position 逻辑。

但应增加：

* title；
* 轻量进度；
* 更明确的点击展开能力。

---

# 8. Expanded Now Playing

## 8.1 定位

Expanded Now Playing 是当前 `AudioPlayer` 的最终去向。

它不是页面，而是全局播放层的完整形态。

### 移动端

推荐：

* Bottom Sheet → 高度较高时近似 Full Screen Sheet；
* 向下滑关闭；
* 关闭只代表 collapse，不代表暂停。

### 桌面端

推荐：

* 右侧 Glass Drawer / Panel；
* Mini Player 继续保留或融入面板；
* 不遮盖整个工作区。

---

## 8.2 完整能力

目标能力包括：

* Story title；
* Voice；
* 当前播放 / 暂停；
* seek；
* 当前时间 / 时长；
* 播放倍速；
* 段落进度；
* 上一段 / 下一段；
* 睡眠定时；
* 查看故事正文；
* 继续创作；
* 从头播放；
* 停止播放。

当前 `AudioPlayer` 已经实际使用 `currentTime`、`duration`、`playbackRate`、`seekAudio`，并支持通过点击进度条或键盘 ±5 秒 seek，因此这些能力应迁移而不是重新发明。

示意：

```text
┌─────────────────────────────────┐
│             ─────               │
│                                 │
│        月球上的小狐狸            │
│        小雅 · 睡前故事           │
│                                 │
│           ◉                     │
│                                 │
│  03:42  ━━━━━●━━━━━━━━  08:16   │
│                                 │
│      ↶15      ⏸      15↷       │
│                                 │
│  [1.0x]    第 4 / 12 段   [☾]  │
│                                 │
│ ──────────────────────────────  │
│ 查看故事正文                    │
│ 继续创作                        │
│ 从头播放                        │
└─────────────────────────────────┘
```

---

# 9. 一个关键限制：seek 必须区分“当前段”和“整个作品”

当前产品的故事播放不是一个稳定的整篇 audio file。

代码中：

* `currentTime / duration / seekAudio` 对应当前音频；
* 另有 `currentParagraphIndex / totalParagraphs`；
* `playbackProgressStore` 按 story paragraphs 管理恢复和继续播放。

历史回放同样是按正文重新合成，再从 paragraph 0 开始播放。

因此现在如果直接设计：

```text
00:00 ━━━━━━━━━━━━━━━ 18:42
```

并宣称可以任意 seek 整个故事，是不准确的。

### 推荐

目标态支持真正的**作品级时轴**，但分两步。

#### 当前兼容态

Expanded Now Playing 显示：

```text
本段进度
01:22 ━━━━━●━━━━ 02:14

全文进度
第 4 / 12 段
```

#### 音频资产化以后

当每段的 canonical audio 与 duration 都可以稳定获得后，构造：

```text
Story Audio Manifest

segment 1 → duration
segment 2 → duration
segment 3 → duration
...
```

再把它组合成真正的 Story-level timeline。

最终才展示统一整篇 seek。

**推荐不要为了 UI 形式提前伪造一个无法可靠定位的全篇进度条。**

---

# 10. 睡眠定时

当前播放状态中已经存在 `remainingMs / totalAllowedMs`，并且 FloatingPlayer 会展示剩余时间。

需要在新产品里明确区分两个概念：

```text
作品时长 ≠ 剩余播放时间
```

推荐 Expanded Now Playing 把它正式表达为：

**睡眠定时**

候选：

```text
关闭
10 分钟
20 分钟
30 分钟
本故事结束后
```

如果现有 `apiConfig.playDuration` 继续承担播放时长上限，可以复用其底层能力，但 UI 语义需要从模糊倒计时改成明确的 Sleep Timer。

不应再把 `remainingMs` 放在 Mini Player 主标题位置，让用户误以为这是作品剩余时长。

---

# 11. 创作页配套调整

当前 `/chat` 是标准的 Chat Layout。

这部分不需要推倒重做，但需要增加“Artifact awareness”。

目标关系：

```text
Conversation
      ↓
Story Generation
      ↓
Story Artifact Card
      ↓
自动进入 Library
```

## 11.1 最近创作

当前 Prompt History 有：

* prompt；
* 使用频率；
* 最近使用时间；

并且已有“选择 → `setPendingAutoSend()` → `/chat`”的完整行为。

推荐从播放器页迁移至创作页空状态或 Composer 上方：

```text
今天想听什么？

[睡前故事] [科幻冒险] [儿童故事]

最近创作
[月球冒险]
[森林里的狐狸]
[恐龙世界]

┌─────────────────────────────┐
│ 描述你想听的故事…           │
└─────────────────────────────┘
```

Prompt History 从“历史管理对象”变成“创作效率工具”。

这是更符合它真实价值的位置。

---

## 11.2 Story Artifact Card

生成完成后的 Assistant 内容应强化为作品 Card，而不只是 Chat Bubble 中的一段结果。

```text
┌──────────────────────────────┐
│ 《月球上的小狐狸》           │
│                              │
│ 一只来自地球的小狐狸意外……  │
│                              │
│ ✓ 故事已完成                 │
│ 正在准备语音…                │
│                              │
│ [▶ 播放]                     │
│                              │
│ 查看全文 · 继续创作 · ⋯     │
└──────────────────────────────┘
```

生成过程中：

```text
故事生成中
    ↓
正文逐步完成
    ↓
语音准备中
    ↓
可播放
    ↓
自动进入故事库
```

### 推荐决策

原 `/player` 中的：

* `GenerationPreview`
* `PlaybackStatusBoard`

不再作为故事库页面组成部分。

生成状态回到 Story Card / 创作上下文；

播放状态进入 Global Now Playing。

这样每种状态只在最合理的位置出现一次。

---

# 12. 作品数据模型

## 12.1 当前 GenerationHistory

当前 Prisma `GenerationHistory` 只有：

```text
id
userId
prompt
storyText
voiceId
createdAt
```

其注释已经明确：回放依赖 `storyText` 重新合成音频。当前 server 每次最多返回最近 50 条，并在新增后自动裁剪到最近 100 条。

这个模型适合“日志”，不适合“用户资产”。

---

## 12.2 目标逻辑对象：StoryWork

推荐产品层正式定义：

```text
StoryWork
```

用户文案继续叫：

**故事 / 作品**

不要求第一期就物理重命名 Prisma table；可以先在现有 `GenerationHistory` 上演进字段和 DTO，待迁移稳定后再决定数据库命名。

推荐目标字段：

| 字段                         | 来源    | 用途                                   |
| -------------------------- | ----- | ------------------------------------ |
| `id`                       | 保留    | Stable identity                      |
| `title`                    | 新增    | Library / Now Playing 唯一标题           |
| `prompt`                   | 保留    | 创作来源、再次创作                            |
| `storyText`                | 保留    | 内容 Source of Truth                   |
| `voiceId`                  | 保留    | 原始作品音色                               |
| `sourceMessageId`          | 新增，可空 | 回溯原 Chat Artifact                    |
| `sourceConversationId`     | 新增，可空 | 继续创作上下文                              |
| `createdAt`                | 保留    | 排序                                   |
| `updatedAt`                | 新增    | 元数据变化                                |
| `favoritedAt`              | 新增，可空 | 收藏                                   |
| `durationMs`               | 新增，可空 | 作品级播放展示                              |
| `contentHash`              | 新增    | 正文与音频一致性                             |
| `audioStatus`              | 新增    | missing / preparing / ready / failed |
| `audioAssetKey` / manifest | 新增，可空 | Canonical Audio                      |
| `audioVersion`             | 新增，可空 | TTS / voice 版本一致性                    |
| `deletedAt`                | 新增，可空 | 回收站                                  |

---

# 13. Title identity 必须升级

这是本次最容易被低估、但非常关键的数据变化。

当前代码中：

Chat Story 播放时：

```text
title: '音频故事'
```

历史回放时：

```text
record.prompt
  ? record.prompt.slice(0, 20)
  : '作品回放'
```

这在单页面播放器中还能工作，但进入：

* Library；
* Mini Player；
* Expanded Player；
* 多端断点恢复；

之后就不够用了。

### 推荐

**title 必须成为 StoryWork 的持久字段。**

原则：

```text
Story title = Asset identity
```

而不是：

```text
播放时临时猜一个 title
```

旧记录迁移时可以：

1. 从 prompt 生成 fallback；
2. 写回数据库；
3. 后续始终使用持久 title。

标题在以下所有地方保持一致：

* Library；
* Story Detail；
* Mini Player；
* Expanded Player；
* Playback progress；
* 恢复态；
* 后续通知与分享。

---

# 14. 播放状态模型

当前 `playbackStore` 已经存在：

```text
sourceType: 'chat' | 'generation'
sourceId
sessionId
title
isOneShot
isRehydratedReady

currentAudioUrl
currentTime
duration
playbackRate

currentParagraphIndex
totalParagraphs
```

这已经比较接近目标模型。

推荐不把 Library 数据直接塞进 Playback Store，而是保持两层：

```text
StoryWork
   ↓
durable content identity

Playback Session
   ↓
当前正在播放什么、播到哪里
```

目标语义上可以逐渐从：

```text
chat
generation
```

演进到：

```text
draft
work
```

但这个字段的物理重命名不是产品 Phase 1 的硬依赖。

关键是：

* `sourceId` 对作品必须指向稳定 StoryWork id；
* `title` 来自 StoryWork；
* 当前作品的播放进度与 Library item 使用同一 identity；
* Draft / Chat 试听仍然允许使用 message id。

---

# 15. isOneShot：继续保留内部语义，不向用户暴露

当前代码里：

```text
isOneShot = true
```

意味着历史回放：

> 播完即止，不触发预加载和“继续故事”。

而创作中的实时播放可能继续进入生成/预加载链路。代码对此有明确防护。

这个机制应该继续保留，但不应成为产品术语。

用户不需要看到：

```text
一次性模式
One Shot
```

用户只看到两种自然行为：

### 创作试听

```text
正在创作中的故事
→ 可以继续生成
```

### 作品播放

```text
已经完成的作品
→ 播完即结束
```

因此：

> `isOneShot` 是播放引擎策略，而不是 UI 状态。

---

# 16. 音频不持久化问题

这是从“生成历史”升级到“故事库”时最关键的产品基础问题。

当前 `storyFlow.ts` 已经明确说明：

> 音频是临时 Blob URL，无法持久化；历史/恢复回放依赖正文重新走 TTS。

`replayGeneration()` 也是读取 `storyText + voiceId` 后重新建立 paragraph playback。

如果故事库仍保持这种模型，用户看到的是：

> “这是我的作品。”

但系统实际行为却是：

> “每次听的时候重新生成一次声音。”

这两种心智并不一致。

---

# 17. 音频处理候选方案

| 方案                              | 存储成本 | 重播 TTS 成本 | 重播等待  | 音色一致性 | 推荐          |
| ------------------------------- | ---: | --------: | ----- | ----- | ----------- |
| A. 每次重新 TTS                     |   最低 |         高 | 高     | 较差    | 仅做 fallback |
| B. 每个 Story 持久化 Canonical Audio |    中 |         低 | 最低    | 最好    | **目标方案**    |
| C. 首次/首次重播生成后缓存                 |   中低 |        中低 | 首次有等待 | 后续较好  | **迁移方案**    |

## 17.1 A：保持现状

优点：

* 无对象存储；
* 数据结构简单。

缺点：

* 每次回放产生 TTS 成本；
* 有网络等待；
* TTS provider、voice 或 model 更新后，同一故事可能听起来不一样；
* provider 下线某个 voice 后，旧作品可能无法恢复原声音；
* 很难建立可靠全篇 duration；
* 很难提供真正瞬时的“继续播放”。

**不建议作为正式 Story Library 的长期方案。**

---

## 17.2 B：持久化 Canonical Audio

作品第一次成功生成语音后，把其音频作为 StoryWork 的正式 Artifact 保存。

优点：

* 重播即时；
* 同一作品声音完全一致；
* 重播不产生重复合成成本；
* 更容易做 duration、seek、下载、分享、离线；
* 即使未来 voice/model 更新，旧作品仍可保持当时声音。

成本：

* Object Storage；
* CDN / 流量；
* 删除与生命周期治理；
* 音频资产版本管理。

### 这是本方案推荐的目标态。

---

## 17.3 C：Lazy / Hybrid Cache

如果一次性切换 B 成本较大，可以：

```text
Story Text
   ↓
没有 canonical audio
   ↓
第一次完整合成
   ↓
缓存生成结果
   ↓
后续直接播放
```

它可以作为迁移桥梁。

---

# 18. 最终音频策略推荐

**目标架构选择 B，实施路径使用 C。**

也就是：

> **作品最终应该拥有 Canonical Audio；上线迁移阶段允许缺失音频时按当前方式重新 TTS，并在成功后沉淀为 Canonical Asset。**

考虑当前系统本来就是 paragraph-based synthesis，不要求第一版就把所有段落拼成一个巨大音频文件。

更合适的概念是：

```text
StoryAudioManifest

StoryWork
│
├── segment 1 → audio asset + duration
├── segment 2 → audio asset + duration
├── segment 3 → audio asset + duration
└── ...
```

这样可以最大化利用现有：

* paragraph segmentation；
* playback progress；
* preload；
* resume；

同时获得稳定的作品级音频。

当所有 segment duration 已知后，也自然可以构造全篇统一 seek。

Canonical identity 至少应绑定：

```text
contentHash
voiceId
TTS model / synthesis version
```

只有真正影响声音生成的参数才进入 audio identity。

普通 UI 播放倍速如果只是播放器变速，不应生成重复音频资产。

---

# 19. 数据生命周期

## 19.1 当前问题

现在服务端明确是：

```text
LIST_LIMIT = 50
KEEP_LIMIT = 100
```

超过 100 条直接删除旧记录。

这对 History Log 合理。

对 Story Library 不合理。

如果产品告诉用户：

> “这是你的故事库。”

就不能在第 101 个作品生成时静默销毁旧作品。

---

## 19.2 推荐生命周期

### 登录用户

**不进行数量型静默删除。**

采用：

```text
分页 / Infinite Scroll
+
用户主动删除
```

以后如果需要配额，应以：

* 存储空间；
* 套餐；
* Archive；

作为明确产品规则，而不是隐藏的“最近 100 条”。

### Guest

Guest 可以继续保持受限生命周期，但必须被定义为：

> 临时内容空间。

建议沿用项目现有 Guest 数据清理基础，而不是承诺永久保存。

如果未来 Guest 数据有 TTL，应在临近风险时清晰提示：

```text
登录以长期保存故事
```

### 删除

故事成为资产以后，不建议继续只有当前 `remove` 的直接 hard delete。

推荐增加：

```text
移到回收站
        ↓
30 天后永久删除
```

永久删除时：

* StoryWork 删除；
* Canonical audio 删除；
* Playback Progress 删除；
* 如果当前正播放该作品，立即停止；
* Now Playing 清空。

“移到回收站”期间如果已经在播放，可以允许当前 session 继续完成，但不再出现在普通 Library。

---

# 20. floatingPlayerEnabled 语义调整

当前 Prisma `UserConfig` / Guest config 中存在：

```text
floatingPlayerEnabled Boolean
```

现有 `FloatingPlayer` 也直接通过该值决定悬浮组件是否显示。

进入 Global Now Playing 模型后，这个语义会产生问题：

> 如果用户关闭 Floating Player，播放还在继续，但找不到控制入口。

因此不能继续让它代表：

> “是否显示全部 Now Playing”。

### 推荐

产品语义改成：

**桌面悬浮播放器**

它只控制桌面端是否使用 floating/dock 表现。

移动端：

> 只要存在 Active Playback，Mini Player 必须存在。

桌面端关闭 Floating 后，也至少保留一个可恢复 Now Playing 的入口，例如 Header / Dock trigger。

物理字段在迁移期可以继续沿用 `floatingPlayerEnabled`，但后续推荐改成更明确的：

```text
desktopFloatingPlayerEnabled
```

---

# 21. 删除、重播与断点恢复的状态定义

必须在产品阶段统一，否则 Library 和 Playback 很容易产生状态冲突。

## 21.1 点击一个从未听过的作品

```text
播放
→ 从 paragraph 0 开始
```

## 21.2 中途离开

Progress 持久化。

Library：

```text
已播放 42%
[继续播放]
```

## 21.3 再次点击

主动作：

```text
继续播放
```

更多菜单：

```text
从头播放
```

## 21.4 播完

记录 Completion。

Library：

```text
已听完
[再次播放]
```

## 21.5 作品正文变化

V1 不允许直接修改完成作品。

因此不存在“同一个 Story id，正文已经变化但旧 progress 还存在”的正常产品路径。

这与当前 `contentHash` / `segmentationVersion` 的恢复保护逻辑方向一致。

## 21.6 移到回收站

* 从 Library 消失；
* 当前播放可以继续当前 session；
* 不允许建立新的播放 session。

## 21.7 永久删除

如果该 Work 正在播放：

```text
立即停止
清理 Now Playing
删除 Progress
删除 Audio Asset
```

---

# 22. 创作态和作品态的边界

这是之后避免逻辑继续混杂的重要原则。

### Draft / 创作态

Identity：

```text
messageId / conversation
```

能力：

* 继续生成；
* Agent 续写；
* preload；
* 动态新增段落；
* 试听。

### StoryWork / 作品态

Identity：

```text
StoryWork.id
```

能力：

* 稳定回放；
* 恢复断点；
* 收藏；
* 内容详情；
* 继续创作出新的作品。

一旦进入 StoryWork：

> 内容语义上视为一个完成 Artifact。

这样可以逐步把目前 `sourceType: chat | generation` 中混杂的行为分离开。

---

# 23. 设计语言

本次升级不另起一套视觉设计体系。

`DESIGN_SPEC.md` 仍然是 UI 唯一 SSOT，并已经明确：

* iOS 26 Liquid Glass；
* immersive audio；
* glass surface；
* Z-axis hierarchy；
* 所有间距、颜色、字号、圆角只能使用 Design Token；
* 禁止硬编码值。

现有 spec 也已经定义 AudioPlayer、TabBar、FloatingPlayer 的 glass、radius、shadow 和 z-index 语言。

因此本次设计原则是：

### Story Card

基于现有：

```text
Elevated Card
Interactive Card
```

扩展。

### Mini Player

继续保持：

```text
Glass + Pill + z-floating
```

但信息结构升级。

### Expanded Now Playing

延续：

```text
Elevated Glass Surface
Large Blur
Large Radius
```

不重新引入“唱片页式播放器”的重视觉焦点。

本轮产品方向更强调：

> Audio is ambient and persistent，而不是必须进入一个“播放器房间”。

---

# 24. 分期落地

---

## Phase 1 — 播放器 Tab → 故事库

### 产品目标

先完成一级信息架构切换。

### 范围

新增：

```text
/library
/library/[id]
```

一级导航：

```text
创作 / 故事库 / 设置
```

把现有：

```text
GenerationHistory
```

迁移为 Library 内容来源。

把：

```text
PromptHistory
```

移至 `/chat` 的“最近创作”。

加入：

* 时间分组；
* Story Card；
* Detail；
* continue playback；
* continue creation。

### 数据依赖

最低要求：

* `title`；
* Pagination；
* 移除 100 条静默裁剪。

首期不强制音频持久化，可继续使用现有 re-TTS fallback。

### `/player`

这一期从 TabBar 移除，但暂保留 compatibility route，以确保旧 `AudioPlayer` 的完整控制能力暂时不丢失。

### 验证点

1. 一级 Tab 已无「播放器」。
2. 旧 GenerationHistory 全部可在故事库访问。
3. Prompt 历史在创作页可以继续复用。
4. Library 播放与旧历史播放结果一致。
5. Refresh 后仍能打开 Story Detail。
6. `/player` 旧入口不影响已有用户路径。
7. Guest/Login 历史行为无回归。

---

## Phase 2 — FloatingPlayer → Mini Now Playing

### 产品目标

让 Global Playback 真正替代“去播放器页看状态”。

### 范围

重构：

```text
components/FloatingPlayer
```

移动：

```text
自由 draggable
        ↓
固定 TabBar 上方
```

桌面：

```text
Floating / Dock
```

增加：

* title；
* 当前进度；
* 播放/暂停；
* tap to expand / transition route。

### 数据依赖

必须先完成：

```text
stable title identity
```

否则 Mini Player 仍然只能显示“音频故事”或 prompt slice。

### 过渡

如果 Expanded Now Playing 尚未完成：

> 点击 Mini Player 暂时可以进入旧 `/player` compatibility view。

### 验证点

1. `/chat → /library → /setting` 导航不中断播放。
2. 播放时 Mini 始终可访问。
3. 暂停、恢复与当前 AudioController 一致。
4. Reload 后 rehydrated playback 可重新进入 Mini。
5. 移动端不遮挡 TabBar / Composer / safe area。
6. 桌面 draggable 不造成 viewport 溢出。
7. 手机软键盘出现时 Mini 不遮挡 Composer。

---

## Phase 3 — AudioPlayer → Expanded Now Playing

### 产品目标

彻底消除独立 Player Page 的必要性。

### 范围

把现有 `AudioPlayer` 的能力迁入：

```text
ExpandedNowPlaying
```

提供：

* play/pause；
* seek；
* speed；
* paragraph progress；
* sleep timer；
* 查看全文；
* 继续创作；
* replay from beginning。

移动：

```text
Sheet / Full-height Sheet
```

桌面：

```text
Side Glass Panel
```

### 同期重点

开始 Canonical Audio / Hybrid Cache。

如果尚未具备作品级 duration：

Phase 3A：

```text
segment seek + paragraph progress
```

音频 Manifest 稳定以后：

Phase 3B：

```text
whole-story timeline + global seek
```

### `/player`

Expanded 正式可用后：

```text
/player → /library
```

删除 Player Page 的产品职责。

原：

```text
PlaybackStatusBoard
GenerationPreview
AudioPlayer
HistoryPanel
```

完成职责迁移：

```text
PlaybackStatusBoard
→ Mini / Expanded

GenerationPreview
→ Chat Story Card

AudioPlayer
→ Expanded Now Playing

GenerationHistory
→ Story Library

PromptHistory
→ Chat / Recent Creation
```

### 验证点

1. 不访问 `/player` 也能完成所有播放行为。
2. Expanded collapse 后音频不断。
3. Expanded 在任何一级页面都可打开。
4. Speed / seek / pause 与现有 playbackStore 一致。
5. Story Detail 与 Expanded 不发生 navigation ownership 冲突。
6. Resume 后 title、paragraph、进度完全匹配。
7. 当前播放作品被永久删除时状态正确清空。

---

# 25. 建议的 Phase 3 后成熟化能力

核心三期结束以后，再进入 Library maturity：

```text
收藏
全文搜索
回收站
排序
更丰富的 Story metadata
下载
分享
离线
```

不建议把这些全部塞进第一版。

先把：

```text
Create → Work → Play
```

这条核心循环建立正确。

---

# 26. 关键模块迁移对应表

| 当前模块                            | 当前职责                    | 目标职责                         |
| ------------------------------- | ----------------------- | ---------------------------- |
| `components/MainTabBar`         | 创作 / 播放器 / 设置           | 创作 / 故事库 / 设置                |
| `app/(main)/player`             | 播放 + 状态 + History       | 退出正式 IA                      |
| `components/FloatingPlayer`     | 悬浮播放按钮                  | Mini Now Playing             |
| `AudioControllerHost`           | 全局音频控制                  | 保持，全局播放内核                    |
| `player/components/AudioPlayer` | 完整播放 UI                 | Expanded Now Playing         |
| `PlaybackStatusBoard`           | 播放状态                    | Mini / Expanded              |
| `GenerationPreview`             | 生成状态                    | Chat Story Card              |
| `HistoryPanel`                  | Prompt + Generation     | 拆分                           |
| `GenerationHistory`             | 生成日志                    | Story Library / StoryWork    |
| `PromptHistoryStore`            | Prompt 历史               | 创作页最近创作                      |
| `playbackStore`                 | 播放 Session              | 保持为 Playback Engine State    |
| `playbackProgressStore`         | 断点 / paragraph progress | 继续承担 Story playback progress |
| Prisma `GenerationHistory`      | 最近生成日志                  | 演进为 StoryWork persistence    |
| Prisma `UserPlaybackProgress`   | 当前播放锚点                  | 绑定 Stable Story identity     |

---

# 27. 与当前工程流程的约束

本次属于：

* 多页面设计变更；
* 跨模块重构；
* 数据模型调整；
* 路由调整；
* 播放状态调整。

按照仓库现有 SDD 约定，属于明确的“非平凡任务”，应正式进入：

```text
docs/specs/YYYY-MM-DD-story-library-now-playing.md

docs/plans/YYYY-MM-DD-story-library-now-playing.md
```

再进入 Implementation 和 Verify。仓库 SDD 已规定此类设计必须先 Spec、再 Plan，并保持 `DESIGN_SPEC.md` 作为横向 UI SSOT。

浏览器可观察行为也应同步进入现有 E2E/Test Catalog，而不是只增加零散组件测试。当前测试体系已经把 `docs/e2e` 作为产品语义权威，并以 test catalog 校验实现覆盖。

本次尤其应该覆盖：

```text
Navigation
Cross-page playback
Mini Player
Expanded Player
Resume / Rehydration
Library replay
Library delete
Guest / Login sync
Soft keyboard / safe area
/player migration
Audio cache fallback
```

---

# 28. 需要固定下来的产品决策

本方案建议评审后直接锁定以下决策，避免进入设计阶段后重新摇摆：

| 决策                      | 推荐                                 |
| ----------------------- | ---------------------------------- |
| 一级 Tab                  | **创作 / 故事库 / 设置**                  |
| 故事库正式路由                 | **`/library`**                     |
| Story Detail            | **`/library/[id]`**                |
| `/player`               | **过渡保留，最终 redirect**               |
| Playback 是否属于页面         | **否，属于 Global Layer**              |
| 移动 Mini 是否 draggable    | **否**                              |
| 桌面 Mini 是否允许 floating   | **是**                              |
| Expanded Mobile         | **Sheet / Full-height Sheet**      |
| Expanded Desktop        | **Side Glass Panel**               |
| Prompt History          | **迁移回创作页**                         |
| Story title             | **持久化 Stable Identity**            |
| Story 正文 V1 是否可直接修改     | **否**                              |
| Library 是否静默只保留 100 条   | **否**                              |
| 音频长期策略                  | **Canonical Audio**                |
| 音频迁移策略                  | **Hybrid cache + re-TTS fallback** |
| 全篇 seek                 | **Audio Manifest 完整后再开放**          |
| `isOneShot`             | **内部状态，不暴露给用户**                    |
| `floatingPlayerEnabled` | **缩窄为桌面 Floating 偏好**              |
| 删除                      | **Story 资产化后采用回收站，再永久删除**          |

---

# 29. 最终目标体验

升级完成后，一次典型用户路径应是：

```text
打开 App
   ↓
创作
   ↓
“给我讲一个关于月球狐狸的睡前故事”
   ↓
Story Card 实时生成
   ↓
▶ 开始播放
   ↓
Mini Now Playing 出现
   ↓
用户切到故事库
   ↓
音频继续
   ↓
找到昨天另一个故事
   ↓
继续播放
   ↓
点 Mini
   ↓
Expanded Now Playing
   ↓
调整倍速 / Sleep Timer / 查看正文
   ↓
“继续创作”
   ↓
回到 Chat，以该作品作为上下文继续
```

产品循环最终形成：

```text
                ┌──────────────┐
                │     创作      │
                └──────┬───────┘
                       │
                    生成作品
                       │
                       ▼
                ┌──────────────┐
                │    故事库     │
                └──────┬───────┘
                       │
                     播放
                       │
                       ▼
              ┌──────────────────┐
              │ Global Now Playing│
              └────────┬─────────┘
                       │
                    继续创作
                       │
                       └────────────→ 创作
```

这次升级完成后，产品的主心智不再是：

> “这里有一个 AI 聊天页，还有一个播放器页。”

而应该变成：

> **“我在这里创作故事，故事成为我的内容资产，而我可以在产品任何地方持续收听。”**

这也是本次方案最重要的产品价值。

这版已经可以作为产品评审底稿。下一步如果进入仓库实施流程，最自然的是把它进一步压成项目现有格式的 **`docs/specs/...` 正式 Spec**：补齐明确的验收条件、in/out scope 和兼容迁移约束，再从 Spec 拆对应 Plan。
