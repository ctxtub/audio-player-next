# History UI Relocation / Chat-owned History Surface

功能域：08-创作Artifact

## 用户目标

「提示词历史 / 生成历史」浏览入口从过渡期 `/player` surface 搬回创作 Chat：Chat Composer 左侧出现唯一「历史」入口，点击打开 Chat 所有的 History Surface（bounded overlay，不进消息流、不建新路由、不改 URL）；面板内「提示词历史 / 生成历史」双 tab、排序、删除、重新创作与生成回放语义与搬迁前完全一致；提示词「重新创作」经同页唯一 pending consumer exactly-once 开始干净新创作；`/player` 回归纯 playback/compatibility surface。

## 范围与边界声明

本场景限定于 History 的 presentation ownership relocation（M4-07 功能里程碑）：只搬 UI 位置与接线，不迁移任何数据。

**包含的职责**：
- History 实现物理归位 Chat：`HistoryPanel / HistoryRecords / GenerationHistory / HistoryList` 归 `app/(main)/chat/components/` 所有，Player 不再拥有任何 History implementation（不接受双实现）
- `/player` 仅保留 `PlaybackStatusBoard / GenerationPreview / AudioPlayer`；route 本身、M1 compatibility mapping（`/player → library` TabKey）、播放架构一律不动，不 redirect
- Chat 唯一历史入口走 Composer `leftSlot`（「历史」按钮）；Surface 为 bounded overlay：不进 MessageArea、不作为 ChatMessage、不建新一级 route、`/chat` URL 不变、有明确关闭入口、开关不 reset Chat、不触发任何数据写入
- `HistoryPanel` 改为受控展示组件（`onSelectPrompt / onClose`）：只拥有 activeTab 与排序模式 UI；不再拥有 router、跨页导航、pending 编排、generation 编排、Chat reset
- 双 tab 数据源保持不变：`HistoryRecords → usePromptHistoryStore`（frequency/recent 排序、重新创作、删除），`GenerationHistory → useGenerationHistoryStore`（prompt/excerpt/createdAt 展示、现有 `replayGeneration(record)` 回放、删除）
- History UI 只读现有 store：禁止自初始化（`initForUser` / `fetchMyPromptHistory` / `fetchMyGenerations` 直调），账号初始化仍由全局 AccountSync 统一负责
- 提示词「重新创作」同页消费：History 选择只做 `setPendingAutoSend(prompt) + closeHistory()`；`ChatLayout` 显式订阅 `pendingAutoSend` 的唯一 consumer effect 负责 exactly-once 消费（`resetStoryFlow → clear pending → setInputValue → handleSubmit`）；发送中选择沿单 slot 覆盖语义排队，不抢当前 attempt

**显式排除以下能力**（留后续模块，不在本场景声称）：
- 数据 migration：prompt/generation 记录格式、store、服务端 API、数据库 schema 一律不动；History 不得转为 `chatStore.messages / StoryArtifact / StoryWork / /library`（relocation 非 migration 的核心）
- Artifact recovery 改动：`lib/client/chatArtifactHistory.ts`、chatStore `toSnapshot / initForUser / rehydrateServerMessages / serializePartsForHistory` 冻结；History UI 不得 import codec、不读 raw server DTO、不 normalize Artifact、不做 promotion.retry、不 save-back（M4-06 是唯一 History recovery boundary）
- Legacy cutover：不删 `StoryCardPart` / storyCard type / legacy selectors 与 renderer 分支；不把 storyCard 转 StoryArtifact；不给 legacy 补 sourceMessageId；不读 legacy 建 StoryWork；不批量 backfill；不把 GenerationHistory 数据迁 Library；不删旧 records/store/API（归 M4-08 read-compatible + new-write forbidden）
- playback 升级：GenerationHistory 回放保持现有 legacy-compatible `replayGeneration` 行为；不接入 StoryWork / ready Artifact / Canonical Audio Manifest / Playback Session；不给 Modern StoryArtifact 加播放按钮（归 M6/M7）
- 多会话：History panel 不是 conversation switcher；打开/切 tab/排序/删除均不得改变 `StoryArtifact.status / ChatMessage.status / sourceMessageId / storyWorkId / promotion token-epoch`，不得注入 ready Artifact、不得替换 messages
- 终视觉：只做功能 relocation（trigger、overlay/sheet 容器、关闭按钮、必要 viewport/scroll、既有 segmented control 与 HistoryList 样式搬迁、既有 Design Token）；不做新设计语言、主布局 redesign、搜索/筛选、分页、多会话选择器、Library 卡片化、新路由 `/history`、URL query state、动效系统

## 契约验收标准

### 1. Player 不再拥有 History（M4-07-01）
- `/player` 不渲染 `HistoryPanel`，不含「提示词历史 / 生成历史」panel；`PlaybackStatusBoard / GenerationPreview / AudioPlayer` 原主体仍存在；不删除 `/player` compatibility route；`player/components/History*` 实现不存在，`chat/components/History*` 实现存在。

### 2. Chat History trigger 开关数据纯洁（M4-07-02）
- Chat Composer 存在唯一「历史」入口；点击 closed→open，关闭 open→closed；全程 URL 始终 `/chat`，message 数不变，inputValue 不被改写，不触 generation，不触 History 持久化写入。

### 3. 双 tab 对等（M4-07-03）
- 打开后「提示词历史 / 生成历史」两 tab 都存在；默认 prompt tab；切换后对应内容正确，不同时渲染两套列表。

### 4. 提示词历史对等（M4-07-04）
- 真实 `promptHistoryStore` fixtures 下 prompt / lastUsed / useCount 展示、frequency/recent 排序、删除、重新创作回调均有效；排序切换由面板头部承载，列表只读全局排序状态渲染。

### 5. 空闲选择 exactly-once（M4-07-05）
- `isSending = false` 时点击历史提示词 P：History 关闭，pending 被消费，旧 Chat 按既有 clean-creation 语义 reset，P 只提交一次（1 个新 user attempt + 1 个新 assistant attempt，`beginChatStream / generation request = 1`，非 inputValue 断言）。

### 6. 发送中选择排队（M4-07-06，blocking）
- Attempt A sending/draft/promoting 中选择提示词 B：A 仍存在、不 abort、不 reset，B 未发送，`pendingAutoSend === B`；A 正常 terminal 后 B 消费一次、clean creation 开始、`pendingAutoSend === null`；连续选择 A、B 沿单 slot 覆盖（`pendingAutoSend === B`），不做 prompt queue。

### 7. 同页消费回归（M4-07-07）
- 当前已在 `/chat` 时 `setPendingAutoSend(P)` 仍自动触发消费，不依赖 `router.push('/chat')` 再挂载；History 实现内不得 import `useRouter / next/navigation` 用于回到 Chat。

### 8. 生成历史对等（M4-07-08）
- 真实 `generationHistoryStore` fixtures 下 prompt/excerpt/date 展示正确；回放仍只调用现有 `replayGeneration(record)`；删除仍调用现有 remove；不产生 StoryWork / StoryArtifact，不改变 `chatStore.messages`。

### 9. 开关数据纯洁（M4-07-09）
- open / tab switch / close / reopen 不得调用 `fetchMyConversation / saveMyConversation / fetchMyPromptHistory / fetchMyGenerations / initForUser / library.create / promotion.retry / generation request`；首次账号初始化仍由全局 AccountSync 完成。

### 10. M4-06 codec 完整性（M4-07-10，blocking）
- 静态守卫：History UI / Chat relocation 相关文件不得 import `chatArtifactHistory / rehydrateServerMessages / serializePartsForHistory / fetchMyConversation / saveMyConversation`；M4-06 targeted suite 原样通过（promoting→promotion_failed、complete→promotion_failed、draft→interrupted、await-window 本地 attempt untouched）。

### 11. Legacy / ownership 纯度（M4-07-11）
- `storyCard remains storyCard`、`StoryArtifact remains StoryArtifact`、`GenerationHistory record remains GenerationHistory record`、`PromptHistory record remains PromptHistory record`；不存在 `GenerationHistory → StoryArtifact / StoryWork`、`storyCard → StoryArtifact`、`prompt record → ChatMessage`。

### 12. 架构 + 全回归（M4-07-12）
- 静态确认 Player 无 History ownership；Chat History UI 不得 import `libraryClient / chatArtifactHistory / storyArtifactPromotion / chatPromotionOrchestration I/O / raw chatConversation transport / Prisma-server`；HistoryPanel 不得 direct `beginChatStream / resetStoryFlow / router.push('/chat') / handleSubmit`，副作用由 ChatLayout adapter 接管；完整复跑 M4-07 targeted unit、M4-06 History round-trip、M4-05 Artifact UI、M4-04 promotion orchestration、creation-chat unit suite、integration suite、catalog CHECK、tooling、lint、tsc/typecheck、build、`git diff --check`。
