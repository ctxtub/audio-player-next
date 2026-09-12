# M1 — 信息架构与路由迁移技术方案

**所属 Phase**：P1
**后续依赖**：M2 StoryWork、M3 故事库、M4 创作页、M6 Mini Now Playing、M9 Player 退役
**核心目标**：建立「创作 / 故事库 / 设置」新的一级信息架构，同时把 `/player` 明确定义为有限期 compatibility route，而不是在 P1 直接删除旧播放能力。

---

# 0. 核心技术决策

| 决策                         | 推荐                                |
| -------------------------- | --------------------------------- |
| 一级 Tab key                 | `chat / library / setting`        |
| 一级文案                       | `创作 / 故事库 / 设置`                   |
| Library 一级路由               | `/library`                        |
| Story Detail 路由            | `/library/[id]`                   |
| 根 `/`                      | **继续 server redirect 到 `/chat`**  |
| Library 图标                 | 推荐 Lucide `LibraryBig`，替换 `Disc3` |
| `/player` P1 行为            | **继续完整渲染旧 Player Page**           |
| `/player` 是否继续出现在 TabBar   | **否**                             |
| `/player` 过渡期 Tab 选中态      | **映射为 `library`**                 |
| `/player` 何时 redirect      | **只由 M9 执行**                      |
| 最终 `/player`               | server `redirect('/library')`     |
| 是否把播放恢复和路由绑定               | **否**                             |
| 是否新增“最后访问 Tab”持久化          | **否**                             |
| 是否迁移 `/player` query/hash  | 默认不迁移；只对未来确认过的正式参数做显式映射           |
| M1 是否删除旧 Player components | **绝对不删除**                         |
| M1 是否新增 `/player/[id]`     | **否**                             |

当前 `MainTabBar` 的 key 是 `chat | player | setting`，`player` 对应 `Disc3`、文案“播放器”和 `/player`；active state 完全由 `usePathname()` 推导，没有单独持久化 selected tab。([github.com](https://raw.githubusercontent.com/ctxtub/audio-player-next/main/components/MainTabBar/index.tsx))

---

# 1. 目标路由结构

当前 `(main)` 下实际只有：

```text
app/(main)/
├── chat/
├── player/
├── setting/
└── layout.tsx
```

三者共用 `MainLayout`；`AudioControllerHost` 和 `FloatingPlayer` 位于 page `children` 之外，因此同一 `(main)` layout 内页面切换不会把音频控制层放进具体页面 ownership。

M1 之后：

```text
app/
├── page.tsx
│
└── (main)/
    ├── layout.tsx
    │
    ├── chat/
    │   └── ...
    │
    ├── library/
    │   ├── page.tsx
    │   ├── index.tsx
    │   ├── index.module.scss
    │   │
    │   └── [id]/
    │       ├── page.tsx
    │       ├── index.tsx
    │       └── index.module.scss
    │
    ├── setting/
    │   └── ...
    │
    └── player/           ← compatibility only
        ├── page.tsx
        ├── index.tsx
        ├── index.module.scss
        └── components/
```

目标 IA：

```text
/
└── /chat

一级导航：
/chat
/library
/setting

二级内容：
/library/[id]

兼容入口：
/player
```

`/player` 物理目录在 P1–P3 仍然存在，但从 M1 起不再属于一级信息架构。

---

# 2. TabBar 改造

## 2.1 Key migration

当前：

```ts
type TabConfig = {
  key: 'chat' | 'player' | 'setting'
  ...
}
```

调整为：

```ts
type MainTabKey =
  | 'chat'
  | 'library'
  | 'setting'

type TabConfig = {
  key: MainTabKey
  title: string
  path: string
  icon: React.FC<...>
  isActive: (pathname: string) => boolean
}
```

这是纯 UI/navigation identity migration：

> 当前 Tab key 没有持久化到 localStorage、DB 或 URL，因此不存在数据 migration。

---

# 2.2 Tabs

目标：

```ts
const TABS = [
  {
    key: 'chat',
    title: '创作',
    icon: MessageCircle,
    path: '/chat',
  },
  {
    key: 'library',
    title: '故事库',
    icon: LibraryBig,
    path: '/library',
  },
  {
    key: 'setting',
    title: '设置',
    icon: Settings,
    path: '/setting',
  },
] as const
```

当前 Player 使用 `Disc3`，替换为 Library-oriented icon；Chat 和 Setting 图标保持。([github.com](https://raw.githubusercontent.com/ctxtub/audio-player-next/main/components/MainTabBar/index.tsx))

### 推荐图标

首选：

```text
LibraryBig
```

原因：

* 语义是“内容收藏/资产空间”；
* 不继续暗示唱片播放器；
* 和「故事库」文案一致；
* 比单纯 `History` 更符合长期资产定位。

不推荐：

```text
History
Clock
Disc3
PlayCircle
```

因为这些都继续强化“播放历史”而不是“作品库”。

---

# 2.3 Active route helper

当前逻辑：

```ts
pathname.startsWith('/chat')
pathname === '/player'
pathname.startsWith('/setting')
```

并且匹配失败时：

```ts
return matchedTab?.key ?? 'chat'
```

这意味着如果单纯删除 Player Tab，而没有处理 `/player`：

```text
访问 /player
→ 没有匹配
→ 错误高亮「创作」
```

这是 M1 必须显式解决的 compatibility 问题。([github.com](https://raw.githubusercontent.com/ctxtub/audio-player-next/main/components/MainTabBar/index.tsx))

---

## 2.4 推荐 route-family helper

新增：

```ts
const isRouteFamily = (
  pathname: string,
  basePath: string,
) =>
  pathname === basePath ||
  pathname.startsWith(`${basePath}/`)
```

避免：

```ts
pathname.startsWith('/library')
```

错误匹配：

```text
/library-old
/librarySomething
```

目标 active config：

```ts
chat:
  pathname === '/' ||
  isRouteFamily(pathname, '/chat')

library:
  isRouteFamily(pathname, '/library') ||
  pathname === '/player'

setting:
  isRouteFamily(pathname, '/setting')
```

注意：

```text
/player → library
```

只是 compatibility active alias。

它**不代表**：

```text
/player == /library
```

路由仍是旧 Player Page。

---

# 2.5 为什么 `/player` 过渡期高亮 Library

有三个方案：

```text
A. 高亮 Chat
B. 没有任何 Tab active
C. 高亮 Library
```

推荐 C。

### 不选择 A

语义明显错误。

### 不选择 B

当前 TabBar 使用：

```text
role="tablist"
tabIndex={isActive ? 0 : -1}
```

以及 keyboard roving focus。

如果没有 active item：

```text
findIndex() === -1
```

Arrow / Home / End navigation 的现有行为会失效。当前键盘导航确实依赖 `activeKey` 找 current index。([github.com](https://raw.githubusercontent.com/ctxtub/audio-player-next/main/components/MainTabBar/index.tsx))

### 选择 C

进入旧：

```text
/player
```

用户看到：

```text
故事库 Tab active
```

点击这个 Tab：

```text
target.path = /library
pathname = /player
```

现有：

```ts
if (target.path !== pathname) {
  router.push(target.path)
}
```

仍然会正确离开旧 Player 并进入 `/library`。

这是一个自然的迁移引导。

---

# 2.6 Keyboard / Accessibility

保留当前：

```text
ArrowRight / ArrowDown
ArrowLeft / ArrowUp
Home
End
```

三项顺序变为：

```text
chat
→ library
→ setting
```

保持：

```text
role="tablist"
role="tab"
aria-selected
roving tabindex
```

不在 M1 顺便把 Button navigation 重构成 Link。

这是另一个 accessibility / navigation semantic 议题，不应和 IA migration 混在一起。

---

# 2.7 Prefetch

当前：

```ts
TABS.forEach(tab => router.prefetch(tab.path))
```

因此 M1 自然变成：

```text
/chat
/library
/setting
```

预取。([github.com](https://raw.githubusercontent.com/ctxtub/audio-player-next/main/components/MainTabBar/index.tsx))

明确：

```text
/player
```

不再由 MainTabBar prefetch。

Compatibility URL 只在真正访问时加载。

---

# 2.8 Chat Badge

当前：

```text
hasUnviewedResponse
```

只对：

```text
key === 'chat'
```

展示 Badge。

该逻辑完全保持，不与 Library 改造耦合。

---

# 3. 根路由

当前：

```ts
app/page.tsx
```

直接：

```ts
redirect('/chat')
```

而不是渲染主页。([github.com](https://raw.githubusercontent.com/ctxtub/audio-player-next/main/app/page.tsx))

M1 明确保持：

```text
/ → /chat
```

不调整为：

```text
/ → /library
```

也不做：

```text
/ → lastVisitedTab
```

---

# 3.1 为什么不恢复 last tab

本次信息架构中：

> 创作仍然是产品首页和主要任务入口。

而 Playback 已经由 Global Now Playing 承担，不需要用户打开 App 后自动回 `/player` 或 `/library` 才能恢复播放。

增加：

```text
lastPrimaryRoute
```

只会多引入一份导航持久状态，与 M5 Playback Anchor 无关。

因此 M1 不做。

---

# 4. `/library` App Router

当前 Chat 与 Setting 的路由结构都采用：

```text
page.tsx
   ↓
index.tsx
```

其中 `page.tsx` 是轻量 route entry，真实客户端页面逻辑放在 `index.tsx`。

Library 保持同一项目约定。

---

# 4.1 `/library`

```text
app/(main)/library/page.tsx
```

职责只做：

```tsx
import LibraryPage from './index'

export default function Page() {
  return <LibraryPage />
}
```

真实：

```text
loading
query
list
empty state
filters
```

归 M3 的：

```text
library/index.tsx
```

M1 只定义 route ownership 和目录契约。

---

# 4.2 `/library/[id]`

新增：

```text
app/(main)/library/[id]/page.tsx
```

路由参数 contract：

```text
id = StoryWork.id
```

也就是：

```text
/library/481
```

而不是：

```text
/library?storyId=481
```

---

# 4.3 ID parsing

Route 层只负责结构性校验：

```text
1
42
481
```

合法。

以下：

```text
0
-1
foo
1.2
```

直接进入：

```text
notFound()
```

Story 是否：

* 存在；
* 属于当前 User/Guest；
* 在 Trash；

由 M2/M3 API lifecycle 决定。

Route 本身不直接访问 Prisma。

---

# 4.4 为什么 `[id]` 不用 Modal-only route

M1 确定：

```text
/library/[id]
```

是 canonical URL。

M3 以后即使移动端视觉实现成：

```text
Sheet
```

也不能只有临时 component state：

```ts
selectedStoryId
```

而没有 URL。

这样保证：

* 刷新；
* 浏览器 Back；
* Bookmark；
* 后续分享；
* 后续通知入口；

都有稳定 identity。

---

# 4.5 Not-found boundary

推荐增加：

```text
app/(main)/library/[id]/not-found.tsx
```

或复用项目统一 Not Found 表现。

但 ownership 404 需要注意：

> “不存在”和“无权访问”对客户端应表现一致。

不向浏览器暴露其他用户 StoryWork 是否存在。

M2 的 Subject ownership contract继续作为唯一授权边界。

---

# 5. Library route 与 M3 的边界

M1 只定义：

```text
/library
/library/[id]
```

以及：

```text
Tab activation
Route ownership
Compatibility
```

M1 **不定义**：

* list query；
* StoryCard；
* pagination；
* filters；
* detail data；
* playback progress；
* rename / delete；
* search。

这些分别归：

```text
M2
M3
M5
```

---

# 5.1 实施顺序与上线顺序不是一回事

模块顺序仍然：

```text
M1
↓
M2
↓
M3
```

但生产 exposure 必须满足：

```text
TabBar 出现「故事库」
       ↓
/library 至少已有 M3 可用列表
```

不能上线一个：

```text
故事库 Tab
→ 空白 Placeholder
```

因此推荐：

### 开发 / Merge

M1 可以先落 route skeleton 与 route helper。

### Phase 1 Release

TabBar cutover 与 M3 minimum usable Library 一起进入 release gate。

如果当前部署模型要求每次 merge `main` 都立即交付，则 M1 branch 中应把：

```text
TABS switch
```

作为最后一个 commit，与 M3 合并窗口协调，而不是为了短暂过渡新增长期 feature flag。

不推荐为了这一次迁移永久增加：

```text
LIBRARY_NAV_ENABLED
```

这样的配置面。

---

# 6. `/player` Compatibility Boundary

这是 M1 最核心的 migration contract。

## P1–P3 中间阶段：

```text
/player
```

继续真实存在。

但它的身份从：

```text
Primary Route
```

变成：

```text
Legacy Compatibility Route
```

---

# 6.1 M1 保留什么

当前 Player 页面完整渲染：

```text
PlaybackStatusBoard
GenerationPreview
AudioPlayer
HistoryPanel
```

并且在 Config 无效时：

```text
/player
→ router.push('/setting')
```

M1 全部保留不动。当前 Player 页确实同时包含这四个组件和配置校验跳转。([github.com](https://raw.githubusercontent.com/ctxtub/audio-player-next/main/app/%28main%29/player/index.tsx))

也保留：

```text
app/(main)/player/components/**
```

所有现有实现。

---

# 6.2 M1 隐藏什么

从正式 IA 隐藏：

```text
MainTabBar Player entry
```

即：

```text
不再显示：
Disc3
播放器
```

同时规定：

> M1 后的新产品代码不得新增 `/player` 作为用户正常业务跳转目标。

唯一允许继续引用 `/player` 的地方：

1. compatibility route 自身；
2. compatibility tests；
3. M6 在 Expanded 尚未完成前，如确有必要，可把 Mini Player 的“展开”暂时落到 `/player`；
4. M9 migration code。

不得新建：

```text
“查看详情” → /player
“历史记录” → /player
Story Card → /player
```

---

# 6.3 `/player` 不新增新功能

Compatibility 期间：

> `/player` 是冻结的 Legacy Surface。

可以修 bug。

不允许继续增加：

* Story Library 新交互；
* 新 filters；
* 新 lifecycle；
* 新 Expanded Player 能力；
* Story Detail。

否则 M9 会永远退役不了。

---

# 6.4 `/player` Active Tab

过渡期间：

```text
/player
→ activeKey = library
```

但：

```text
router URL 仍为 /player
```

不做自动 navigation。

---

# 7. 旧 Deep Link / Bookmark

当前 Player route 只有：

```text
/player/page.tsx
/player/index.tsx
/player/components/**
```

没有 `/player/[id]` 这样的作品级动态路由。([github.com](https://github.com/ctxtub/audio-player-next/tree/main/app/%28main%29/player))

因此 Legacy URL contract 很简单：

```text
/player
```

---

# 7.1 M1–M8 阶段

直接访问：

```text
https://app.example.com/player
```

继续：

```text
200
→ Legacy Player
```

用户 Bookmark 不失效。

浏览器 Refresh：

```text
/player
```

继续渲染 Legacy Player。

---

# 7.2 Query parameters

当前 Player Page 自身不建立稳定 query-based navigation contract。

因此：

```text
/player?x=y
```

在 compatibility 阶段由 Next route 正常加载 `/player`，query 保持在浏览器 URL 中，但 M1 不新增对未知 query 的业务语义。

不要把：

```text
?foo=...
```

自动映射到 Story Detail。

---

# 7.3 Hash

同理：

```text
/player#something
```

没有正式产品 contract。

M1 不增加映射逻辑。

---

# 8. Restored Playback State

这是路由迁移必须明确“不做”的事情。

M1 不允许出现：

```ts
if (hasPlaybackProgress) {
  redirect('/player')
}
```

或者：

```ts
if (hasPlaybackProgress) {
  redirect('/library')
}
```

Playback restoration 和 navigation 是两个独立领域。

当前 Global Audio host 已经处于 `(main)` layout 页面内容之外。([github.com](https://raw.githubusercontent.com/ctxtub/audio-player-next/main/app/%28main%29/layout.tsx))

M5 后：

```text
Playback Anchor
→ rehydrate Now Playing

Current Route
→ 保持用户正在访问的 route
```

例如：

```text
用户打开 /chat
+
有 Work 42% progress

结果：
仍然 /chat
+
Now Playing READY
```

而不是：

```text
自动跳去 /player
```

---

# 9. Client-side route switching 与播放连续性

`MainLayout` 当前结构：

```text
AccountSyncProvider
  ├── app
  │   ├── main children
  │   └── MainTabBar
  │
  ├── AudioControllerHost
  └── FloatingPlayer
```

因此：

```text
/chat
→ /library
→ /setting
```

都在同一个 shared layout 下。([github.com](https://raw.githubusercontent.com/ctxtub/audio-player-next/main/app/%28main%29/layout.tsx))

M1 要保证：

> 不为了 Library 新增一个脱离 `(main)` 的 layout。

否则会意外 remount：

```text
AudioControllerHost
```

破坏跨页播放。

---

# 10. M1 的 Library Layout 决策

不要新增：

```text
app/(main)/library/layout.tsx
```

除非 M3 后续确实需要 Library-specific nested layout。

V1：

```text
/library
/library/[id]
```

直接继承：

```text
app/(main)/layout.tsx
```

即可。

---

# 11. `/player` Final Redirect — 只能由 M9 执行

M1 只定义最终行为，不实现最终 redirect。

M9 满足退役条件后：

```tsx
// app/(main)/player/page.tsx

import { redirect } from 'next/navigation'

export default function LegacyPlayerPage() {
  redirect('/library')
}
```

推荐 server redirect。

不要：

```ts
'use client'
useEffect(() => router.replace('/library'))
```

因为 server redirect：

* 不先闪旧 Player；
* 不依赖 hydration；
* direct bookmark 行为稳定；
* browser/history 语义更明确。

---

# 11.1 M9 Redirect Gate

以下全部满足后才能 redirect：

```text
M3:
Library list / detail 已上线

M4:
Prompt History 已离开 Player
Generation / Artifact 状态已回到 Chat

M6:
Mini Now Playing 已上线

M7:
Expanded Now Playing 已覆盖旧 AudioPlayer 核心能力

M5:
Resume / rehydrate 不依赖 /player

测试：
没有正式产品流程要求进入 /player
```

M8 Canonical Audio **不是 `/player` 退役的绝对硬依赖**。

因为 M7 可以先使用 paragraph-level ephemeral playback。

---

# 12. M1 与 M9 职责边界

## M1 负责

```text
定义新 IA
建立 /library routes
Player Tab → Library Tab
隐藏 /player 一级入口
定义 compatibility active mapping
定义 compatibility freeze rule
建立 route tests
记录最终 redirect contract
```

---

## M9 负责

```text
全仓扫描 /player 引用
移除 compatibility fallback
/player → /library
删除旧 Player 页面 UI ownership
清理 player/components
删除 MainTabBar compatibility alias
清理旧 route tests
验证旧 Bookmark redirect
```

---

# 12.1 中间模块禁止做什么

M2/M3/M4/M5/M6/M7/M8 都不得自行：

```text
删除 app/(main)/player
修改 /player 为 redirect
重命名 /player
改变 /player compatibility contract
```

如果某模块需要 `/player`：

> 必须只把它当作 M1 定义的 frozen compatibility surface。

---

# 13. M9 后 MainTabBar 清理

M1 阶段：

```ts
library.isActive =
  isRouteFamily('/library')
  || pathname === '/player'
```

M9：

```ts
library.isActive =
  isRouteFamily(pathname, '/library')
```

删除：

```text
/player compatibility alias
```

这样不会把历史 migration logic 永久留在主导航组件。

---

# 14. 最终 `/player` Bookmark 行为

M9 后：

```text
GET /player
      ↓
redirect
      ↓
/library
```

不自动跳：

```text
/library/[lastPlayingWorkId]
```

理由：

`/player` 原来不是某一作品的 deep link。

擅自根据当前 Playback Anchor 跳 Story Detail 会把：

```text
Legacy route migration
```

和：

```text
current user state
```

混为一体。

用户如果有当前播放：

```text
/library
+
Mini / Expanded Now Playing
```

已经足够表达。

---

# 15. `/library/[id]` 与 Player 的关系

M1 明确：

```text
/library/[id]
```

是：

> Story Detail

不是：

> Fullscreen Player URL

M7 Expanded Now Playing 仍属于 Global Layer，不建立：

```text
/library/[id]/player
```

这样的路由。

因此：

```text
Story identity URL
≠
Playback UI state URL
```

这个边界需要固定，否则以后又会把播放能力塞回页面体系。

---

# 16. 文件级改动

## 新增

```text
app/(main)/library/
├── page.tsx
├── index.tsx
├── index.module.scss
│
└── [id]/
    ├── page.tsx
    ├── index.tsx
    ├── index.module.scss
    └── not-found.tsx   // 推荐
```

M1 可以先建立 route shell；

真正的页面内容由 M3 接管。

---

## 修改

```text
components/MainTabBar/index.tsx
```

修改：

```text
Tab key
Tab title
icon
path
active route matcher
prefetch target
compatibility mapping
```

当前该组件同时负责 Tab config、active resolve、prefetch、keyboard navigation，因此 M1 的导航变更主要集中在这里。([github.com](https://raw.githubusercontent.com/ctxtub/audio-player-next/main/components/MainTabBar/index.tsx))

---

```text
components/MainTabBar/index.module.scss
```

原则上只在：

```text
Library icon rendering
```

确有布局差异时调整。

不在 M1 重做 TabBar 视觉。

继续遵循 `DESIGN_SPEC.md`。

---

```text
app/page.tsx
```

**预计无代码变化。**

增加/更新测试锁定：

```text
/ → /chat
```

即可。

---

```text
app/(main)/player/**
```

M1：

> **不修改业务实现。**

最多更新 comments：

```text
Legacy compatibility route
```

但甚至可以不改，降低 diff。

---

# 17. 推荐新增 Navigation Domain Helper

虽然当前 TABS / resolver 全写在 `MainTabBar/index.tsx`，M1 后路由语义开始包含：

```text
primary route
detail route
legacy alias
```

推荐抽出：

```text
lib/navigation/mainNavigation.ts
```

内容：

```ts
export type MainTabKey = ...

export const MAIN_TABS = ...

export function isRouteFamily(...) ...

export function resolveMainTabKey(...) ...
```

然后：

```text
MainTabBar
tests
```

共用。

---

# 17.1 为什么值得现在抽

它会被直接 unit test：

```text
/chat
/chat/...
/library
/library/12
/player
/setting
/unknown
```

否则为了测 route resolution 必须渲染整个 React TabBar。

不过这个 helper 只负责：

```text
primary navigation
```

不应变成全项目路由注册中心。

---

# 18. Unknown Route 的 active fallback

当前 resolver：

```text
matched ?? 'chat'
```

推荐保留 fallback：

```text
chat
```

但只作为 defensive fallback。

实际：

```text
404
```

页面通常不应依赖 Tab active。

不要为此引入：

```text
MainTabKey | null
```

破坏现有 keyboard model。

`/player` 已经有显式 compatibility mapping，因此不会落 fallback。

---

# 19. 迁移步骤

## M1-A — Navigation helper

新增：

```text
MainTabKey
isRouteFamily
resolveMainTabKey
```

先用当前 route fixture 验证。

---

## M1-B — Library route skeleton

建立：

```text
/library
/library/[id]
```

确保：

* 属于 `(main)`；
* Main Layout 正常；
* Refresh 正常；
* dynamic param 正常。

---

## M1-C — Tab cutover

```text
player
→ library
```

修改：

```text
key
label
icon
path
active matcher
prefetch
```

并加入：

```text
/player → library active alias
```

---

## M1-D — Compatibility lock

加测试确保：

```text
/player remains reachable
```

同时在 Spec / Plan 明确：

```text
Do not remove before M9
```

---

## M1-E — Phase release

只有当 M3 至少提供可用 Library list 后：

```text
新版 MainTabBar
```

才进入正式 Phase 1 release。

---

# 20. Route Contract

M1 完成后稳定契约：

| URL            | 状态                   | Main Tab           | 行为             |
| -------------- | -------------------- | ------------------ | -------------- |
| `/`            | canonical redirect   | -                  | → `/chat`      |
| `/chat`        | primary              | 创作                 | 创作页            |
| `/library`     | primary              | 故事库                | Library        |
| `/library/123` | primary child        | 故事库                | Story Detail   |
| `/setting`     | primary              | 设置                 | 设置页            |
| `/player`      | legacy compatibility | **故事库**            | Legacy Player  |
| unknown        | 404                  | defensive fallback | Next not-found |

---

# 21. Browser History 行为

一级 Tab 继续使用当前：

```ts
router.push()
```

而不是 `replace()`。

因此：

```text
/chat
→ /library
→ /setting
```

Browser Back：

```text
/setting
→ /library
→ /chat
```

保持自然浏览历史。

---

# 21.1 `/player` compatibility 访问

从 Bookmark：

```text
/player
```

再点击：

```text
故事库
```

使用：

```text
router.push('/library')
```

因此 Back 可以返回：

```text
/player
```

这是 transition 阶段预期行为。

M9 server redirect 后，旧 route 才彻底退出。

---

# 22. Config invalid 行为

当前 Player 页面会在：

```text
config loaded
+
!configIsValid
```

时：

```text
router.push('/setting')
```

M1 compatibility 期间保持。([github.com](https://raw.githubusercontent.com/ctxtub/audio-player-next/main/app/%28main%29/player/index.tsx))

Library 本身不应该复制这个 gate。

原因：

> 查看自己已有作品不应该因为当前 TTS Config 无效而完全进不去。

以后只有：

```text
播放
重新生成
```

等动作需要按 M3/M5/M8 的业务 contract 报可用性。

这是新 `/library` 与旧 `/player` 一个重要的路由级差异。

---

# 23. 测试 — Unit

对：

```text
resolveMainTabKey
```

覆盖：

```text
/                  → chat
/chat              → chat
/chat/foo          → chat

/library           → library
/library/1         → library
/library/123/edit  → library   // 即使该 route 当前不存在

/library-old       → fallback，不得误匹配 library

/player            → library

/setting           → setting
/setting/account   → setting
```

---

# 24. 测试 — TabBar Component

验证：

```text
显示：
创作
故事库
设置
```

不得出现：

```text
播放器
```

同时：

```text
library icon render
```

存在。

---

## Keyboard

从 Chat：

```text
ArrowRight
→ Library

ArrowRight
→ Setting

ArrowRight
→ Chat
```

Home：

```text
→ Chat
```

End：

```text
→ Setting
```

---

# 25. 测试 — Root

Browser / route test：

```text
GET /
→ /chat
```

锁死现有行为，防止后续有人因为 Library 新增顺手修改首页。

---

# 26. 测试 — Library Route

验证：

```text
/library
```

200。

```text
/library/123
```

进入 Detail route。

非法：

```text
/library/foo
/library/-1
/library/0
```

表现为 Not Found。

---

# 27. 测试 — Active State

Playwright：

```text
/library
→ 故事库 aria-selected=true

/library/123
→ 故事库 aria-selected=true

/player
→ 故事库 aria-selected=true

/chat
→ 创作 selected

/setting
→ 设置 selected
```

---

# 28. 测试 — Compatibility

P1–P3 测试必须锁定：

```text
direct GET /player
→ Legacy Player 页面仍存在
```

至少验证旧页面的稳定 landmark：

```text
AudioPlayer / History area
```

正常出现。

不是只验证：

```text
status 200
```

防止有人提前把它变 redirect。

---

# 29. 测试 — Cross-page Audio Host

虽然正式 Playback 行为归 M5/M10，但 M1 需要一个最小 routing regression：

```text
start audio / mock active audio
/chat
→ /library
→ /setting
```

确认：

```text
AudioControllerHost
```

没有因 route transition unmount。

这是把 `/library` 放进 `(main)` 的架构验证。

---

# 30. 测试 — Browser Navigation

```text
/chat
→ click Library
→ /library

click Setting
→ /setting

Back
→ /library

Back
→ /chat
```

以及：

```text
/player
→ click active-looking Library
→ /library
```

最后一条很重要，因为 compatibility alias 下 Library Tab 虽然已经 active，仍必须可点击跳出 Legacy Player。

---

# 31. M9 Contract Test

M1 同时在文档/Test Catalog 中登记一个**未来待翻转**行为：

当前：

```text
/player → Legacy Player
```

M9：

```text
/player → /library
```

M9 实施时：

1. 删除旧 compatibility assertion；
2. 新增 redirect assertion；
3. 删除 `/player → library active alias` unit fixture；
4. 全仓扫描不得再存在正常业务 `/player` navigation。

---

# 32. Route Reference Audit

由于 GitHub 公共 Code Search 未登录时无法完整搜索仓库代码，本模块实施时应在本地仓库执行一次：

```bash
rg "['\"\`]\/player" .
```

并分类：

```text
MainTabBar
tests
docs
business navigation
compatibility
```

M1 建立 baseline。

M9 再运行同一个 audit，目标是：

```text
正常业务引用 = 0
```

这一步应进入 Plan，而不是依赖人工记忆。

---

# 33. 主要风险

| 风险                                          |   严重度 | 处理                                         |
| ------------------------------------------- | ----: | ------------------------------------------ |
| 删除 player Tab 后 `/player` fallback 错高亮 Chat |     中 | 显式 `/player → library` compatibility alias |
| `/library/[id]` 没匹配 Library Tab             |     中 | route-family helper                        |
| `startsWith('/library')` 误匹配其他 route        |     低 | exact + `/` boundary helper                |
| M1 提前 redirect `/player` 导致完整播放器能力丢失        | **高** | redirect 权限只归 M9                           |
| 中间模块继续向 `/player` 添加新功能                     |     高 | frozen compatibility contract              |
| Tab cutover 先于 M3 页面完成                      |     中 | Phase release gate                         |
| 新 Library 建独立 layout 导致 Audio Host remount  | **高** | 必须留在 `(main)` shared layout                |
| Playback Resume 自动改变当前 route                |     高 | 明确 route 与 Playback Anchor 解耦              |
| Story Detail 被实现成纯 Modal state，刷新丢失         |     中 | `/library/[id]` canonical route            |
| 最终 redirect 试图猜 last work                   |     中 | 永远 `/player → /library`                    |
| old `/player` query 被误解释为新的 Story identity  |     低 | 不做隐式 query translation                     |
| keyboard roving focus 在 legacy route 失效     |     中 | compatibility 映射到 Library                  |
| MainTabBar 配置持续堆兼容判断                        |     低 | M9 明确删除 alias                              |

---

# 34. 与 M9 的不可变边界

从 M1 技术方案通过之日起，直到 M9：

```text
/player = Frozen Compatibility Surface
```

任何模块如果需要改变这条规则：

> 必须重新进入 M1/M9 边界评审。

不能在某个 UI PR 中顺手：

```text
redirect('/library')
```

也不能在 M6/M7 中：

```text
删除旧 player components
```

---

# 35. 拍板项

本模块基本属于已确认 IA 的技术落地，只剩两个过渡行为值得明确记录。

## M1-P01 — 过渡期访问 `/player` 时哪个 Tab 高亮

推荐：

> **故事库。**

理由是避免错误高亮“创作”，并保持现有 keyboard roving focus；点击故事库仍然可以从 `/player` 导航到 `/library`。

---

## M1-P02 — 最终旧 Bookmark `/player` 去向

推荐：

> **统一 server redirect `/library`。**

不根据 Playback Anchor 猜测：

```text
/library/[currentWorkId]
```

也不尝试恢复旧 Player UI。

---

# 36. M1 完成态

M1 完成、M3 可用以后，用户看到：

```text
┌────────────────────────────┐
│                            │
│        Current Page        │
│                            │
├────────────────────────────┤
│  创作      故事库      设置 │
└────────────────────────────┘
```

路由心智：

```text
创作
/chat

故事资产
/library
/library/[id]

设置
/setting
```

而：

```text
/player
```

从这一刻开始只是一条：

> 为旧 Bookmark、旧内部流程和 P2/P3 过渡保留的技术兼容路径。

它不再拥有新的产品语义，也不再参与任何后续功能扩张。

M9 的工作不是重新决定 `/player` 怎么退役，而只是执行 M1 已经定义好的最后一步：

```text
Legacy Player
      ↓
all capabilities migrated
      ↓
server redirect('/library')
      ↓
delete legacy surface
```

这一模块里最需要锁死的是 **“隐藏不等于删除”**：M1 只把 `/player` 从一级 IA 中拿掉，完整旧页面一直保留到 M9；这能让 M2/M3/M5/M6/M7 各自迁移职责，而不会出现某一阶段因为页面提前消失被迫做大爆炸式上线。
