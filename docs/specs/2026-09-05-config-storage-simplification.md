# 技术方案：客户端配置存储简化与全量云端化规范

> **文档状态**：PROPOSAL (待评审)  
> **创建日期**：2026-09-05  
> **基线版本**：commit `d87adac` (main)  
> **作者**：RESEARCH Worker  
> **目标范围**：重构配置存储架构，废弃未登录/访客的客户端 `localStorage/sessionStorage` 配置存储，统一全量配置至服务端云端；规范化主题色无闪烁（FOUC-Free）方案。

---

## 摘要 (Executive Summary)

当前线上版本（`d87adac`）中，登录用户个性化配置通过 `UserConfig` 表与 `config.getMine / config.updateMine` 实现了云端同步，但未登录与访客用户依然重度依赖浏览器的 `localStorage`（如 `config-store`、`prompt-history-store`、`theme-mode`）及 `sessionStorage`（如新手引导）。这导致同浏览器多标签页不同步、本地 Seed 污染新账号、老账号静默吞并访客设置、登出状态残留以及多套存储机制维护负担沉重。

本提案响应产品负责人的核心目标：
1. **未登录用户（匿名与访客）不再使用浏览器 session/local storage 保存任何业务个性化配置，所有配置统一上云**；
2. **唯一例外：主题模式（theme mode）保留 `localStorage` + `<head>` 同步脚本作为首屏渲染缓存，确保 0ms 绝对无闪烁（Zero-FOUC）**。

本提案通过引入 **具名访客标识（`guest_id` Cookie）** 与服务端轻量 **`GuestConfig` 表**，将 `configRouter` 扩展为统一的 `guardedProcedure`，彻底精简客户端代码（移除 Zustand persist、移除 seed 迁移算法、移除双轨分发），实现零数据割裂、零跨标签页撕裂的高可靠配置架构。

---

## 一、现状盘点：客户端配置项全貌与存储证据矩阵

通过对全局代码的深度检索（grep `localStorage` / `sessionStorage` / `cookies` / `persist` / `state`），系统内全部配置项、存储介质、读写链路与 `config router` 的关系盘点如下：

### 1. 配置项证据矩阵 (Evidence Table)

| 配置项 | 数据类型与取值范围 | 当前存储介质 | 核心代码读写位置 (file:line) | 与 config router 的关系 |
| :--- | :--- | :--- | :--- | :--- |
| **主题模式 (`themeMode`)** | `'dark' \| 'light' \| 'system'` | ① `localStorage['theme-mode']`<br>② `localStorage['config-store']`<br>③ DB `UserConfig.themeMode`<br>④ Window 全局变量 | **读**：[themeConfig.ts:72](file:///root/Developments/audio-player-next/components/ThemeProvider/themeConfig.ts#L72), [ThemeProvider/index.tsx:57](file:///root/Developments/audio-player-next/components/ThemeProvider/index.tsx#L57), [configStore.ts:366](file:///root/Developments/audio-player-next/stores/configStore.ts#L366)<br>**写**：[ThemeProvider/index.tsx:97](file:///root/Developments/audio-player-next/components/ThemeProvider/index.tsx#L97), [setting/index.tsx:128](file:///root/Developments/audio-player-next/app/%28main%29/setting/index.tsx#L128), [userConfig.ts:103](file:///root/Developments/audio-player-next/lib/server/userConfig.ts#L103) | **双重割裂**：登录态经 `ThemeConfigBridge` 同步至 DB；访客态纯本地；存在三处异构存储源。 |
| **允许播放时长 (`playDuration`)** | `number` (分钟，10-120，默认 30) | ① `localStorage['config-store']`<br>② DB `UserConfig.playDurationMinutes`<br>③ In-memory `configStore` | **读**：[configStore.ts:208](file:///root/Developments/audio-player-next/stores/configStore.ts#L208), [setting/index.tsx:59](file:///root/Developments/audio-player-next/app/%28main%29/setting/index.tsx#L59), [PlaybackStatusBoard:33](file:///root/Developments/audio-player-next/app/%28main%29/player/components/PlaybackStatusBoard/index.tsx#L33)<br>**写**：[setting/index.tsx:77](file:///root/Developments/audio-player-next/app/%28main%29/setting/index.tsx#L77), [configStore.ts:318](file:///root/Developments/audio-player-next/stores/configStore.ts#L318), [configStore.ts:289](file:///root/Developments/audio-player-next/stores/configStore.ts#L289) | 登录态防抖同步至 `config.updateMine`；访客态仅写 `localStorage`，不触碰 router。 |
| **TTS 音色 (`voiceId`)** | `string` (合法音色或 `""` 默认) | ① `localStorage['config-store']`<br>② DB `UserConfig.voiceId`<br>③ 系统默认（来自 env） | **读**：[setting/index.tsx:34](file:///root/Developments/audio-player-next/app/%28main%29/setting/index.tsx#L34), [chatFlow.ts:75](file:///root/Developments/audio-player-next/app/services/chatFlow.ts#L75), [storyFlow.ts:119](file:///root/Developments/audio-player-next/app/services/storyFlow.ts#L119)<br>**写**：[setting/index.tsx:41,96](file:///root/Developments/audio-player-next/app/%28main%29/setting/index.tsx#L41), [configStore.ts:121](file:///root/Developments/audio-player-next/stores/configStore.ts#L121) | 系统音色列表由 `config.get` 提供；用户选定音色通过 `config.updateMine` 存云端；访客态纯本地。 |
| **TTS 生成语速 (`speed`)** | `number` (0.25 - 4.0，默认 1.0) | ① `localStorage['config-store']`<br>② DB `UserConfig.speed`<br>③ In-memory `configStore` | **读**：[setting/index.tsx:104](file:///root/Developments/audio-player-next/app/%28main%29/setting/index.tsx#L104), [chatFlow.ts:75](file:///root/Developments/audio-player-next/app/services/chatFlow.ts#L75), [storyFlow.ts:109](file:///root/Developments/audio-player-next/app/services/storyFlow.ts#L109)<br>**写**：[setting/index.tsx:105](file:///root/Developments/audio-player-next/app/%28main%29/setting/index.tsx#L105), [configStore.ts:131](file:///root/Developments/audio-player-next/stores/configStore.ts#L131) | 登录态防抖同步至 `config.updateMine`；访客态仅写 `localStorage`。注意：此为服务端 TTS 合成速率，非播放器瞬时倍速。 |
| **浮动播放器开关 (`floatingPlayerEnabled`)** | `boolean` (默认 true) | ① `localStorage['config-store']`<br>② DB `UserConfig.floatingPlayerEnabled`<br>③ In-memory `configStore` | **读**：[FloatingPlayer:37](file:///root/Developments/audio-player-next/components/FloatingPlayer/index.tsx#L37), [setting/index.tsx:64](file:///root/Developments/audio-player-next/app/%28main%29/setting/index.tsx#L64)<br>**写**：[setting/index.tsx:117](file:///root/Developments/audio-player-next/app/%28main%29/setting/index.tsx#L117), [configStore.ts:136](file:///root/Developments/audio-player-next/stores/configStore.ts#L136) | 登录态防抖同步至 `config.updateMine`；访客态仅写 `localStorage`。 |
| **播放器瞬时倍速 (`playbackRate`)** | `number` (0.75, 1, 1.25, 1.5, 2) | In-memory `playbackStore` (无 persist) | **读**：[playbackStore.ts:18](file:///root/Developments/audio-player-next/stores/playbackStore.ts#L18), [AudioPlayer:33](file:///root/Developments/audio-player-next/app/%28main%29/player/components/AudioPlayer/index.tsx#L33)<br>**写**：[AudioPlayer:134](file:///root/Developments/audio-player-next/app/%28main%29/player/components/AudioPlayer/index.tsx#L134), [playbackStore.ts:232](file:///root/Developments/audio-player-next/stores/playbackStore.ts#L232) | **无关系**：仅影响当前 Audio 元素的 DOM playbackRate，刷新即重置，不属于持久配置。 |
| **播放器音量 (`volume`)** | `number` (0.0 - 1.0) | 浏览器 Audio 元素原生控制 (无本地/云端存储) | **读/写**：[AudioControllerHost:86-107](file:///root/Developments/audio-player-next/components/AudioControllerHost/index.tsx#L86-L107)（仅用于 iOS 播放解锁静音恢复） | **无关系**：当前产品无自定义音量配置面板。 |
| **提示词历史排序偏好 (`sortMode`)** | `'frequency' \| 'recent'` | `localStorage['prompt-history-store']` | **读**：[HistoryPanel:33](file:///root/Developments/audio-player-next/app/%28main%29/player/components/HistoryPanel/index.tsx#L33), [promptHistoryStore.ts:230](file:///root/Developments/audio-player-next/stores/promptHistoryStore.ts#L230)<br>**写**：[HistoryPanel:39](file:///root/Developments/audio-player-next/app/%28main%29/player/components/HistoryPanel/index.tsx#L39), [promptHistoryStore.ts:229](file:///root/Developments/audio-player-next/stores/promptHistoryStore.ts#L229) | **无关系**：`promptHistory` router 仅管提示词词条，排序模式由客户端 localStorage 孤立承载。 |
| **聊天新手引导已读 (`chat_onboarding_seen`)** | `'true'` 字符串 | 浏览器 `sessionStorage` | **读**：[OnboardingModal:48](file:///root/Developments/audio-player-next/app/%28main%29/chat/components/OnboardingModal/index.tsx#L48)<br>**写**：[OnboardingModal:56](file:///root/Developments/audio-player-next/app/%28main%29/chat/components/OnboardingModal/index.tsx#L56) | **无关系**：单标签页 Session 隔离，导致开新标签页重复弹窗。 |
| **访客身份 Cookie (`guest`)** | 固定值 `'1'` (无 maxAge, session cookie) | HTTP Cookie (`document.cookie`) | **写**：[routers/auth.ts:138](file:///root/Developments/audio-player-next/lib/trpc/routers/auth.ts#L138)<br>**读**：[middleware.ts:12](file:///root/Developments/audio-player-next/middleware.ts#L12), [trpc/context.ts:77](file:///root/Developments/audio-player-next/lib/trpc/context.ts#L77) | 用于 `guardedProcedure` 准入鉴权，但**无唯一访客 ID**，无法作为服务端配置的主体索引。 |
| **登录会话 Cookie (`auth`)** | HMAC-SHA256 签名串 (`userId.nickname.exp`) | HTTP Cookie (`httpOnly`, 24h) | **写**：[lib/session.ts:136](file:///root/Developments/audio-player-next/lib/session.ts#L136), [middleware.ts:40](file:///root/Developments/audio-player-next/middleware.ts#L40)<br>**读**：[lib/session.ts:149](file:///root/Developments/audio-player-next/lib/session.ts#L149), [trpc/context.ts:91](file:///root/Developments/audio-player-next/lib/trpc/context.ts#L91) | 用于 `authedProcedure`，对应 DB 中的 `User.id`。 |

---

## 二、config router 现状与前端降级链路

### 1. `lib/trpc/routers/config.ts` 当前架构与 Schema

```typescript
// 当前实现片段：lib/trpc/routers/config.ts
export const configRouter = router({
    get: publicProcedure.query(() => {
        const { voicesList, voiceId } = getTtsConfig();
        return { voicesList, voiceId };
    }),

    getMine: authedProcedure
        .input(z.object({ seed: userConfigSeedSchema.optional() }).optional())
        .query(async ({ ctx, input }) => {
            return getOrCreateUserConfig(ctx.session.userId, input?.seed);
        }),

    updateMine: authedProcedure
        .input(userConfigPatchSchema)
        .mutation(async ({ ctx, input }) => {
            return updateUserConfig(ctx.session.userId, input);
        }),
});
```

- **数据形状契约**：
  - `userConfigDtoSchema` ([lib/trpc/schemas/config.ts:39-45](file:///root/Developments/audio-player-next/lib/trpc/schemas/config.ts#L39-L45))：
    ```typescript
    {
      playDuration: number,          // 播放时长（分）
      voiceId: string,               // TTS 音色
      speed: number,                 // 语速 0.25 - 4.0
      floatingPlayerEnabled: boolean,// 浮动播放器
      themeMode: 'dark' | 'light' | 'system'
    }
    ```
  - `userConfigPatchSchema`：全可选字段，范围校验（时长 10-120、语速 0.25-4.0、音色 max 64）。
  - `userConfigSeedSchema`：与 patch 同形，仅作为首次绑定建行时的初值输入。

- **调用方与调用时机**：
  - `get`：由 `stores/configStore.ts:202` 的 `loadRemoteConfig` 调用，每次初始化必查系统音色。
  - `getMine`：由 `lib/client/userConfig.ts:18` 封装，仅在 `stores/configStore.ts:345` 的 `initForUser` 中被调用。
  - `updateMine`：由 `lib/client/userConfig.ts:26` 封装，仅在 `stores/configStore.ts:289` 的 `scheduleSave` 防抖 500ms 触发，且前置受到 `get().syncEnabled === true` 的严格守卫 ([configStore.ts:324](file:///root/Developments/audio-player-next/stores/configStore.ts#L324))。

### 2. 未登录/访客的前端降级执行逻辑

当用户未登录（`isLogin: false`）时：
1. **调度分发**：[AccountSyncProvider/index.tsx:45](file:///root/Developments/audio-player-next/components/AccountSyncProvider/index.tsx#L45) 检测到 `!isLogin`，调用 [accountSync.ts:71](file:///root/Developments/audio-player-next/stores/accountSync.ts#L71) 的 `initAccountForGuest()`。
2. **本地水合**：执行 `configStore.getState().initialize()`：
   - 尝试从 `localStorage.getItem('config-store')` 中恢复历史状态 ([configStore.ts:178-196](file:///root/Developments/audio-player-next/stores/configStore.ts#L178-L196))。
   - 调用公共接口 `config.get` 获取系统默认音色，将本地缓存与系统默认合并，放行 `isLoaded: true` 渲染门。
   - **关键分支**：此时 `syncEnabled` 保持 `false` ([configStore.ts:301](file:///root/Developments/audio-player-next/stores/configStore.ts#L301))。
3. **写入降级**：用户在 `/setting` 页面调节滑块或开关：
   - 调用 `configStore.update(partial)` ([configStore.ts:318](file:///root/Developments/audio-player-next/stores/configStore.ts#L318))。
   - Zustand 内存状态更新，并被 `persist` 中间件同步序列化写入浏览器的 `localStorage['config-store']`。
   - 由于 `syncEnabled === false`，[configStore.ts:325](file:///root/Developments/audio-player-next/stores/configStore.ts#L325) 判定不成立，**完全不发起网络请求**，服务端对此一无所知。

---

## 三、冲突场景与根本原因分析

当前架构的根本矛盾在于：**“一套业务数据，两种存储主体”**。登录用户属于 DB 用户体系，而访客被降级为浏览器物理设备存储体系。

### 1. 核心根因分析 (Root Causes)

- **根因 A（存储双源与权威性缺失）**：客户端 `localStorage` 既充当访客的“主存储”，又充当登录用户的“离线缓存”，同时还向服务端上传“迁移 Seed”，导致状态权威源在客户端与服务端之间反复摆动。
- **根因 B（访客 Cookie `guest=1` 是无状态字面量）**：`enterGuestMode` 签发的 Cookie 是静态字符串 `'1'` ([routers/auth.ts:140](file:///root/Developments/audio-player-next/lib/trpc/routers/auth.ts#L140))，不带任何随机 UUID 或设备标识。服务端无法在数据表中以“某一个访客”为主键建立行，逼迫前端只能退回 `localStorage`。
- **根因 C（生命周期严重错位）**：`guest=1` 是没有 `maxAge` 的 Session Cookie（浏览器关闭即清），而 `localStorage` 具有永久持久性。当用户关闭浏览器重开并再次进入访客模式时，Cookie 是“新的”，但 `localStorage` 唤醒了“几天前的旧配置”。

### 2. 典型冲突与故障场景深度剖析

#### 场景 1：登录时的本地 Seed 丢失与毒化冲突 (The Seed Dilemma)
- **代码路径**：`stores/configStore.ts:341` (`fetchMyConfig(seed)`) ↔ `lib/server/userConfig.ts:73-84`。
- **冲突表现 1（配置被静默吞掉）**：用户作为访客精心调节了语速 1.5x、时长 60 分钟。随后登录已有账号，服务端检测到该用户已存在 `UserConfig` 行（`if (existing) return toDto(existing)`），**直接无视并丢弃前端传入的 seed**。访客精心配置的参数瞬间还原为老账号的默认值，没有任何确认提示。
- **冲突表现 2（公共设备毒化新账号）**：在公用电脑上，前人作为访客将语速调为 0.25x。后人注册新账号，由于新账号在服务端无 `UserConfig` 行，服务端执行 `create(buildCreateData(userId, seed))`，导致新账号被强制注入了前一个陌生人的偏好，造成账号污染。

#### 场景 2：登出后的状态清理竞态与半残留
- **代码路径**：`stores/accountSync.ts:104` ↔ `stores/configStore.ts:389` (`reset()`) ↔ `components/ThemeProvider/index.tsx:97`。
- **冲突表现**：
  - 用户点击登出，`authStore.subscribe` 捕获 `isLogin` 下降沿，执行 `resetAccountData()`，调用 `configStore.reset()` 清除了 `localStorage['config-store']`。
  - 然而，`THEME_MODE_STORAGE_KEY`（`'theme-mode'`）是独立受控的，未在 `reset()` 中被清除！上一个用户的暗色/浅色偏好完整残留在物理浏览器中。
  - 紧接着 `AccountSyncProvider` 响应式触发 `initAccountForGuest()`。若此时网络略有延迟，重新拉取默认配置与本地残留渲染发生竞态，页面出现闪烁或半初始化状态。

#### 场景 3：同浏览器多标签页数据撕裂 (Multi-Tab Desynchronization)
- **代码路径**：`stores/configStore.ts:318` (`update()`)。
- **冲突表现**：
  - 访客在 **标签页 A** 将播放时长改为 45 分钟。`configStore` 写入标签页 A 内存及 `localStorage`。
  - 处于开启状态的 **标签页 B** 没有任何 `window.addEventListener('storage')` 广播监听机制，其内存中的 `apiConfig.playDuration` 依然为 30 分钟。
  - 随后用户在 **标签页 B** 调节了语速为 1.25x。标签页 B 触发 `update({ speed: 1.25 })`，执行全量对象合并（`mergeConfig`），使用标签页 B 内存中陈旧的 `playDuration: 30` 覆盖了标签页 A 刚保存的 `playDuration: 45`！
  - 若其中一个标签页执行了登录，而另一个标签页尚未刷新，两标签页分别运行在“云端回写态”与“本地离线态”，产生严重的数据不一致。

#### 场景 4：`sessionStorage` 隔离引发的新手引导骚扰
- **代码路径**：`app/(main)/chat/components/OnboardingModal/index.tsx:48-56`。
- **冲突表现**：引导弹窗状态依赖 `sessionStorage.getItem('chat_onboarding_seen')`。浏览器 `sessionStorage` 仅在当前单个 Tab 内有效，用户每次在新标签页打开创作页（如从播放器页跳转、或中键新开链接），都会被强制阻断并重新弹窗要求确认，严重影响操作流畅度。

---

## 四、方案对比与评估 (Architecture Options Evaluation)

针对将未登录与访客配置全部收敛上云的目标，评估三种技术演进路线：

### 候选方案横向对比表

| 评估维度 | 方案一：具名访客标识 + 独立 `GuestConfig` 表 (推荐) | 方案二：影子临时账号 (Shadow / Ephemeral User) | 方案三：签名配置 Cookie (Stateless Client Cookie) |
| :--- | :--- | :--- | :--- |
| **存储架构** | 服务端新增 `GuestConfig` 表，Cookie 存储 `guest = g_<uuid>` | 数据库 `User` 表为访客自动生成虚拟行，复用既有 `UserConfig` | 服务端无表，Cookie 内直接存储加密/签名的配置 JSON |
| **一致性保障** | ★★★★★<br>多标签页、多会话均以服务端唯一 `guest_id` 记录为准 | ★★★★★<br>天然全量一致，完全等同于注册用户 | ★★★☆☆<br>单机标签页依赖 Cookie 同步，且无真正云端记录 |
| **符合产品目标** | **完全符合**<br>彻底移除 client storage，配置全量上云 | **符合**<br>配置在云端，但概念模型过重 | **不符合**<br>本质依然是客户端存配置，违背老板要求 |
| **数据库影响** | **低风险**<br>隔离独立表，完全不侵入核心 `User` 表及其外键关联 | **高危**<br>`User` 表被瞬间激增的游离访客膨胀，外键级联清理压力大 | **零影响**<br>无数据库改动 |
| **客户端复杂度** | **极简**<br>删减掉 persist、seed 迁移、双轨调度，前端单通道 | **极简**<br>前端直接认为“永远处于登录态” | **中等**<br>需要处理 Cookie 容量上限与编解码 |
| **安全与限流防刷** | **高度兼容既有架构**<br>基于 `clientIp` + `guest_id` 限流，防止 DoS | **破坏现有安全模型**<br>访客获得 `userId`，直接绕过 IP 限流机制 | **良好**<br>Cookie 签名防篡改 |
| **清理机制** | 简单：按 `updatedAt < 30 days` 定期批量硬删除 | 复杂：级联清理 `ChatMessage`、`GenerationHistory` 等多张表 | 无需清理 |

---

### 深入方案剖析与取舍裁决

#### 1. 方案二（影子临时账号）否决原因
- **数据库爆炸**：互联网环境下存在大量爬虫或无意识访问，若每次“进入访客模式”均在 `User` 表新建一行，会导致自增主键飞速耗尽，并产生海量孤儿用户。
- **安全防线击穿**：当前 [rateLimit.ts:160-164](file:///root/Developments/audio-player-next/lib/server/rateLimit.ts#L160-L164) 严格基于 `ctx.clientIp` 对访客限流，对登录用户基于 `userId` 放宽限流。若访客化身为影子用户，攻击者只需轮换 Cookie 即可无限突破配额限制。

#### 2. 方案三（纯客户端签名 Cookie）否决原因
- 产品负责人的明确指令是：*“未登录用户（匿名+访客）不再用 session/storage 记录他们的配置；所有配置统一存云端（服务端）”*。Cookie 属于客户端承载介质，且受限于 4KB 长度限制，未来增加扩展项（如 extras）受限，因此否决。

#### 3. 为什么**方案一**是最优解？
- **主体清晰**：认证用户挂在 `UserConfig(userId)`，未登录/访客挂在 `GuestConfig(guestId)`。
- **零破坏性**：不改变任何现有 `User` 表结构与外键约束；迁移与回滚成本极低。
- **代码极致精简**：前端 `configStore` 将彻底摆脱维护了数百行的“本地-远端冲突消解”、“首次登录 Seed 迁移”、“版本持久化 migrate”等历史包袱代码。

---

## 五、推荐方案详细设计 (Detailed Technical Specification)

### 1. 数据模型层设计 (Prisma Schema)

在 [prisma/schema.prisma](file:///root/Developments/audio-player-next/prisma/schema.prisma) 中保留既有 `UserConfig`，新增 `GuestConfig` 表：

```prisma
/// 访客个性化配置表，以具名访客标识 guestId 为唯一索引。
model GuestConfig {
  id                    Int      @id @default(autoincrement())
  /// 具名访客标识符（格式如 g_1234567890abcdef...）
  guestId               String   @unique
  /// 允许播放时长，单位：分钟，范围 10-120
  playDurationMinutes   Int      @default(30)
  /// TTS 音色 ID，空字符串表示使用系统默认
  voiceId               String   @default()
  /// 播放速率，范围 0.25-4.0，默认 1.0
  speed                 Float    @default(1.0)
  /// 是否启用浮动播放器
  floatingPlayerEnabled Boolean  @default(true)
  /// 主题模式：dark | light | system
  themeMode             String   @default(system)
  /// 预留扩展字段，存储 JSON 格式的配置项
  extras                String?
  /// 最后更新时间，用于清理策略索引
  updatedAt             DateTime @updatedAt
  /// 创建时间
  createdAt             DateTime @default(now())

  @@index([guestId])
  @@index([updatedAt])
}
```

### 2. 身份标识与 Cookie 流转规范

- **升级 Cookie 契约**：
  - 废弃原本静态无害但无用的 `guest=1`。
  - 新 Cookie 格式：`guest=g_<uuid>`（使用标准 `crypto.randomUUID()` 保证高强度唯一性）。
  - Cookie 属性：
    - `name`: `guest`
    - `httpOnly`: `true`（禁止前端 JS 脚本篡改，增强安全性）
    - `secure`: `process.env.NODE_ENV === 'production'`
    - `sameSite`: `'lax'`
    - `path`: `'/'`
    - `maxAge`: `30 * 24 * 60 * 60`（30 天有效期，由 middleware 在活跃时滑动续签）
- **中间件与 Context 升级**：
  - 在 [middleware.ts](file:///root/Developments/audio-player-next/middleware.ts) 中：
    - `isGuest(request)` 判定逻辑由 `value === '1'` 改造为 `value?.startsWith('g_')`。
    - 若用户访问受保护路径未登录且 Cookie 为旧版 `guest=1`，自动就地重签为新版 `g_<uuid>`。
  - 在 [lib/trpc/context.ts](file:///root/Developments/audio-player-next/lib/trpc/context.ts) 中：
    - Context 扩展字段：`guestId: string | null`。
    - `isGuest = typeof guestId === 'string' && guestId.length > 0;`。

### 3. API 变更与 tRPC Router 重构

#### 服务端统一抽象层 (`lib/server/unifiedConfig.ts`)

将 `userConfig.ts` 扩展为支持多主体的统一配置服务层：

```typescript
export type ConfigSubject =
  | { type: 'user'; id: number }
  | { type: 'guest'; id: string };

/** 获取统一配置：主体不存在时以系统默认建行 */
export async function getOrCreateConfig(subject: ConfigSubject): Promise<UserConfigDTO> {
  if (subject.type === 'user') {
    // 复用现有 UserConfig 逻辑（移除 seed 参数）
    return getOrCreateUserConfig(subject.id);
  } else {
    const existing = await prisma.guestConfig.findUnique({ where: { guestId: subject.id } });
    if (existing) return toDto(existing);
    const created = await prisma.guestConfig.create({
      data: { guestId: subject.id, ...DEFAULT_CONFIG_FIELDS },
    });
    return toDto(created);
  }
}

/** 增量更新配置：统一 upsert */
export async function updateConfig(
  subject: ConfigSubject,
  patch: UserConfigPatch
): Promise<UserConfigDTO> {
  if (subject.type === 'user') {
    return updateUserConfig(subject.id, patch);
  } else {
    const updateData = mapPatchToDbFields(patch);
    const row = await prisma.guestConfig.upsert({
      where: { guestId: subject.id },
      create: { guestId: subject.id, ...updateData },
      update: updateData,
    });
    return toDto(row);
  }
}
```

#### tRPC Router 重构 (`lib/trpc/routers/config.ts`)

- 将 `config.getMine` 与 `config.updateMine` 的鉴权中间件从 `authedProcedure` 调整为 **`guardedProcedure`**。
- **废除输入 `seed`**：配置已经随时存在云端，登录注册无需任何 Seed 上载。
- 提取统一主体解析助手：

```typescript
const resolveSubject = (ctx: Context): ConfigSubject => {
  if (ctx.session) return { type: 'user', id: ctx.session.userId };
  if (ctx.guestId) return { type: 'guest', id: ctx.guestId };
  throw new TRPCError({ code: 'UNAUTHORIZED', message: '未授权的配置访问' });
};

export const configRouter = router({
  get: publicProcedure.query(() => {
    const { voicesList, voiceId } = getTtsConfig();
    return { voicesList, voiceId };
  }),

  getMine: guardedProcedure.query(async ({ ctx }) => {
    return getOrCreateConfig(resolveSubject(ctx));
  }),

  updateMine: guardedProcedure
    .input(userConfigPatchSchema)
    .mutation(async ({ ctx, input }) => {
      enforceProcedureRateLimit('config:update', ctx, {
        guestLimit: 30,
        authedLimit: 60,
      });
      return updateConfig(resolveSubject(ctx), input);
    }),
});
```

### 4. 前端配置层变革与代码瘦身 (Frontend Simplification)

彻底改造 [stores/configStore.ts](file:///root/Developments/audio-player-next/stores/configStore.ts)：

1. **废弃 Zustand `persist` 中间件**：
   - 彻底移除 `persist(configStoreCreator, ...)`。
   - 彻底移除 `localStorage['config-store']`。
   - 彻底移除 `hydrateLocalConfig()`、`migrate()` 及 `skipHydration: true`。
2. **消灭 `syncEnabled` 状态分支**：
   - 任何进入应用的访客或登录用户，**均天然处于可同步状态**。
   - `update(partial)` 动作无需再做 `if (get().syncEnabled)` 检查，统一乐观更新内存并进入防抖 500ms 服务端回写队列。
3. **初始化单一通道化**：
   - 废除 `initialize()` 与 `initForUser()` 的双方法机制，收敛为一个幂等的 `initialize()`：
     - 并行拉取 `fetchAppConfig()`（音色列表）与 `fetchMyConfig()`（个人/访客配置）。
     - 音色校正并写入内存状态，置 `isLoaded: true`。
4. **账号切换与登出 (`reset`)**：
   - 用户点击登出，`reset()` 仅清空当前内存数据，作废正在途的 Promise，将状态置空；
   - 随后 `authStore` 切换为未登录态，页面根据需要重新进入访客模式，拉取全新的服务端 `GuestConfig`，**内存与本地绝不残留旧账号数据**。
5. **统一调度组件简化**：
   - 在 [components/AccountSyncProvider/index.tsx](file:///root/Developments/audio-player-next/components/AccountSyncProvider/index.tsx) 中，无论 `isLogin` 为真或假，配置部分仅需触发单点的 `useConfigStore.getState().initialize()`，移除冗余的分发逻辑。

### 5. 主题色无闪烁（FOUC-Free）权威方案

产品负责人明确指出：*“唯一例外：主题色（theme color）为了避免加载时颜色闪烁(FOUC/flash of wrong theme)，可以继续存 localStorage，或用其他无闪烁方案——调研并给出建议。”*

#### 深入调研结果与对比

- **方案 A（现状优化：`<head>` 同步阻塞脚本 + `localStorage['theme-mode']`）**：
  - **原理**：在 [app/layout.tsx:61](file:///root/Developments/audio-player-next/app/layout.tsx#L61) 的 `<head>` 中注入微型内联同步脚本 `INITIAL_THEME_SCRIPT`。该脚本在浏览器渲染引擎构建 DOM 树前立即执行，0ms 读取 `localStorage['theme-mode']` 与 `window.matchMedia`，直接修改 `document.documentElement.setAttribute('data-theme', resolvedTheme)`。
  - **效果**：首帧上屏即带正确的 CSS 变量主题，**理论物理级 0 毫秒无闪烁**。
- **方案 B（纯 Cookie + SSR 注入）**：
  - **原理**：前端切换主题写 Cookie，Next.js 服务端 `RootLayout` 读 Cookie 输出 `<html data-theme=...>`。
  - **缺陷**：**无法处理 `themeMode: 'system'`**！HTTP 协议头无法感知客户端操作系统的暗色/浅色偏好（除非极其前沿且 Safari 支持度差的 `Sec-CH-Prefers-Color-Scheme` Client Hints）。若服务端盲猜兜底，系统主题用户必定遭遇严重的二次色彩反转闪烁。
- **方案 C（引入社区库如 `next-themes`）**：
  - **结论**：`next-themes` 内部原理与当前项目的方案 A 源码完全 100% 同构，引入外部依赖徒增包体积与维护成本。

#### 权威实施建议
1. **保留方案 A 作为唯一合法的客户端本地存储例外**。
2. **职责边界收敛**：
   - `localStorage['theme-mode']` 降级定义为：**“首屏渲染防闪烁高速缓存”**，而非业务核心配置项。
   - 彻底删除 `stores/configStore.ts` 对 `themeMode` 的额外持久化。
   - 当用户（无论是访客还是登录用户）修改主题时：
     1. [ThemeProvider/index.tsx](file:///root/Developments/audio-player-next/components/ThemeProvider/index.tsx) 立即写入 `localStorage['theme-mode']` 保证刷新不闪烁；
     2. 同时由 `useConfigStore.getState().update({ themeMode })` 同步回写至服务端的 `GuestConfig` 或 `UserConfig`，保证云端备份与跨会话一致性。
   - 登出（Logout）时：**不清除 `localStorage['theme-mode']`**。理由：设备的暗色/浅色属于该物理屏幕的物理偏好，登出账号强行将屏幕刺眼地切为白色属于极其恶劣的用户体验。

### 6. 数据迁移、隐私保护与服务端清理策略 (Retention & Purge Strategy)

1. **老旧本地数据清理**：
   - 新架构上线后，前端在首次启动时，执行一次性防御式清理：
     ```typescript
     try {
       window.localStorage.removeItem('config-store');
     } catch {}
     ```
   - 彻底消除老版本滞留在用户设备上的历史脏数据。
2. **隐私与免责规范**：
   - `GuestConfig` 表中仅保存非敏感的配置参数（音色、倍速、时长、主题），不关联任何 IP、昵称、密码或个人可识别信息（PII）。
   - Cookie 仅含伪匿名随机 UUID，符合 GDPR/CCPA 对必要功能性 Cookie 的豁免规范。
3. **存储滥用防御与垃圾清理策略 (Garbage Collection)**：
   - **单 IP 限频**：`enterGuestMode` 及 `config.updateMine` 受滑动窗口限流保护（单 IP 每分钟最多创建/更新 30 次）。
   - **自动过期淘汰策略**：
     - `GuestConfig` 表添加 `@@index([updatedAt])`。
     - **轻量淘汰算法**：无需依赖常驻 Cron。在每次调用 `enterGuestMode` 时，以 2% 的概率（概率淘汰）异步触发一次轻量修剪：
       ```typescript
       if (Math.random() < 0.02) {
         const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
         prisma.guestConfig.deleteMany({
           where: { updatedAt: { lt: thirtyDaysAgo } },
         }).catch(err => console.warn('[GC] GuestConfig purge failed', err));
       }
       ```
     - 确保生产 SQLite 数据库容量始终稳定有界。

---

## 六、验收标准 (Acceptance Criteria)

实施完成后，须满足以下全部验证指标：

1. **未登录存储指标**：
   - 访客或匿名用户在 `/setting` 调整播放时长、音色、生成语速、浮动播放器后，检查浏览器 Storage：
     - `localStorage` 中**绝不出现** `config-store` 键；
     - `sessionStorage` 中**绝不出现**任何配置或偏好数据。
   - 唯一允许存在的键为 `localStorage['theme-mode']`。
2. **多标签页一致性**：
   - 同浏览器打开两个标签页 A 和 B（访客身份）；
   - 在标签页 A 调整语速为 1.5x；
   - 刷新标签页 B，语速自动变为 1.5x（数据从云端 `GuestConfig` 读取，彻底解决多标签页割裂）。
3. **跨设备与登录场景**：
   - 访客完成参数配置后登录老账号：老账号加载其原有的云端 `UserConfig`，绝不会发生老配置被访客本地配置错误覆盖的问题；
   - 注册全新账号：由服务端按初始规范建行，不受物理设备前序使用痕迹影响。
4. **登出隔离验证**：
   - 登录用户登出后，配置立即回落至独立的新访客配置，不泄漏上一个账号的私有设置。
5. **主题无闪烁（Zero-FOUC）验证**：
   - 无论是暗色或浅色主题，强刷（Ctrl+F5 / Cmd+Shift+R）页面，在 4x CPU Throttle 及 Fast 3G 弱网模拟下，首屏背景色与文字**无任何瞬时反白或色彩跳变**。
6. **自动化回归与构建测试**：
   - 更新 [tests/test-auth-guest-matrix.ts](file:///root/Developments/audio-player-next/tests/test-auth-guest-matrix.ts) 测试矩阵，确保 `config.getMine` 与 `config.updateMine` 在 `guardedProcedure` 模式下（访客可访问、匿名 401、已登录可访问）100% 通过；
   - `npm run lint` 与 `next build` 零类型报错、零警告。

---

## 七、风险识别与回滚预案 (Risks & Rollback Plan)

### 1. 识别风险与应对方案

| 风险项 | 影响分析 | 防御与应对措施 |
| :--- | :--- | :--- |
| **风险 1：旧测试断言失败** | [test-auth-guest-matrix.ts:164](file:///root/Developments/audio-player-next/tests/test-auth-guest-matrix.ts#L164) 静态审计硬编码检查了 `config.getMine: authedProcedure`，改动会导致 CI 阻断。 | 在实施分支中，同步更新测试用例断言，明确将 `configRouter` 移出“纯个人隐私路由”，列入 `guardedProcedure` 准入清单并验证矩阵。 |
| **风险 2：Cookie 升级兼容性** | 存量用户浏览器携带旧版 `guest=1`，若新接口直接校验 `startsWith('g_')` 会导致存量访客报错 401。 | 在 `context.ts` 与 `middleware.ts` 增加**向上平滑兼容**：若发现 `guest === '1'`，自动分配 `g_<uuid>` 并在响应头中 `Set-Cookie` 补发，业务调用不中断。 |
| **风险 3：并发写入数据库竞争** | SQLite 单文件在多个异步请求同时 upsert `GuestConfig` 时可能发生短暂忙等待。 | 前端严格维持 500ms 防抖提交机制；服务端采用 Prisma 幂等 `upsert`，避免并发写冲突。 |

### 2. 回滚预案 (Rollback Plan)

- **数据库向后兼容性**：新增的 `GuestConfig` 表完全独立，若发生意外需要代码回滚至 `d87adac`，旧代码完全不感知该表的存在，无需回滚数据库 Schema 亦可安全平稳降级。
- **降级开关保障**：前端 `stores/configStore.ts` 重构过程中，如出现服务端通讯异常，保留网络失败时的内存级乐观值兜底，避免渲染门（PageLoading）因网络瞬断发生锁死。
