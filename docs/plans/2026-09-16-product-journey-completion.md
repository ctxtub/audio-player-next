# 创作作品集与连续播放完整交付计划

状态：待实施

目标分支：`plan/product-journey-completion`

基线提交：`950b8f2e95d5008fd22011a1222162520948132a`

产品依据：[`docs/archive/product-decisions.md`](../archive/product-decisions.md)

## 为什么要做这轮

现有代码已经具备会话、作品集、AI 标题、作品持久化、全局播放器、单轨音频后端和连续创作状态机的部分基础，但用户旅程没有闭合。最明显的问题是：创作页完成作品仍不能直接播放，却继续引导用户进入作品库；正式发布镜像没有真正启用单作品单音频；连续创作仍围绕临时音频结果运转，等待下一篇时不能在准备完成后自然续播；页面也缺少让用户理解下一篇进度的内容卡片。

本轮不重复建设底层体系，而是把这些基础收敛成一个用户能够看懂、操作和持续使用的完整产品。

## 当前事实与本轮裁决

### 已有基础，优先复用

- `Conversation` 与 `StoryCollection` 已建立一对一关系。
- 首作晋升、AI 标题和确定性回退已经存在。
- 故事库已按作品集展示，详情可列出作品。
- `PlaybackSessionStore` 与全局 Mini / Expanded 播放器已经存在。
- 单轨 `StoryAudioAsset`、秒级进度、三十天滑动缓存、租约和清理已有服务端基础。
- `startNewCreation()` 已集中处理重置。
- 连续创作默认开启，并能从设置页取得播放预算快照。

### 必须纠正的实现

- `StoryArtifactPart` 不得继续声明“无播放”，不得显示“已保存到作品库 / 查看作品”。
- 新作品正式播放路径必须是一条作品对应一条音频和一条时间轴，不再依赖发布时遗漏的双开关。
- 生产业务代码不得保留 `globalThis` 浏览器测试开关。
- 连续创作的下一项必须使用正式 `StoryWork` 身份，不得用 `{audioUrl, segment, messageId}` 充当曲目。
- `waiting_next` 必须能在下一作品准备完成后转为可播并自动续播。
- 创作流内必须出现下一作品生命周期卡，顶部控制条不能独自承担进度表达。
- `startNewCreation()` 等生产入口不得为了隔离测试而接受替换远端调用的注入参数。
- 用户视角浏览器验证只在第四段执行；前三段只做受影响范围检查、类型检查和构建。

## 总体技术边界

### 唯一身份链

```text
Conversation
  → StoryCollection
    → StoryWork
      → StoryAudioAsset
        → PlaybackSession(source.workId)
```

任何进入用户播放队列的内容都必须已经拥有 `StoryWork.id`。正文流式生成期间可以显示 Draft Artifact，但不能把临时 Blob、段落索引或消息 ID 伪装成正式曲目身份。

### 用户可见状态来源

- 作品卡播放状态从 `PlaybackSessionStore + PlaybackStore` 派生，不在卡片本地复制播放器状态。
- 音频资产状态从正式音频 projection 派生，不通过按钮内部布尔值猜测。
- 连续创作状态从连续创作 store 派生；下一作品身份也存入同一个领域快照。
- Mini Player、Expanded Player、创作卡和作品集详情必须对同一 Work 给出一致状态。

### 小模型实施约束

- 严格按下面四段顺序实施，每段一个独立提交；前一段完成并通过本段验证后再进入下一段。
- 不顺手重写播放器、作品库或聊天架构；只修改每段列出的文件和必要直接依赖。
- 不创建字母数字任务号、用例号或阶段号，提交信息直接描述功能。
- 不新增测试 Probe、Store 直控、浏览器全局开关、源码字符串断言或测试专用业务分支。
- 不删除或重命名已应用 Prisma migration；如数据结构确实需要变化，新增语义化 migration。
- 不修改生产数据，不 push、不部署，除非得到新的明确授权。
- 每段开始前和结束后运行 `git status --short`；只显式暂存本段文件。

---

## 第一段：创作页作品卡成为正式播放入口

### 用户结果

用户在创作页看到一条完整作品后，可以原位播放、暂停、继续播放和重试语音准备；页面明确告诉用户当前作品是在准备、播放、暂停、失败还是需要重新生成缓存。作品卡不再把“去作品库”当成主要动作。

### 实现范围

主要文件：

- `app/(main)/chat/components/MessageParts/StoryArtifactPart.tsx`
- `app/(main)/chat/components/MessageParts/index.module.scss`
- `app/services/playbackSessionFlow.ts`
- `stores/playbackSessionStore.ts`
- `stores/playbackStore.ts`
- 必要时新增一个位于 `MessageParts` 目录内的播放 ViewModel hook

允许复用：

- `playWorkFromHistory(workId)` 的 Work 播放能力，但应增加中性的正式命名，例如 `playStoryWork(workId)`，迁移调用方后删除带有 History 语义的名称。
- 全局播放器现有 pause、resume、restart 和音频 projection。

### 具体改动

1. `StoryArtifactPart` 在 `artifact.status === 'ready'` 且 `storyWorkId` 合法时显示播放主操作。
2. 删除“已保存到作品库”“查看作品”以及 `/library/:workId` 链接。保存成功用弱提示表达，不占据主操作位置。
3. 建立纯派生 ViewModel，至少输出：
   - `idle`：显示“播放”；
   - `preparing`：显示 spinner 和“正在准备语音”，按钮防重复触发；
   - `playing`：卡片高亮，显示“正在播放”和暂停操作；
   - `paused`：显示当前位置、总时长和“继续播放”；
   - `error`：显示“语音准备失败”和重试；
   - `expired`：显示“缓存已过期，将重新准备”；
   - `ended`：显示“重新播放”。
4. 当前卡片判断必须使用 `PlaybackSession.source.workId === artifact.storyWorkId`，不能用“最后一条消息”或标题匹配。
5. 进度直接消费共享 Session/Transport 的秒级进度。未知 duration 时不伪造百分比。
6. Draft、promoting 和 promotion_failed 保留原有生成/保存语义；未形成 Work 的内容不能进入正式 Work 播放路径。
7. 播放失败只在对应卡片显示，不把内部错误码暴露给用户。

### UI 与美观要求

- 主操作与“查看全文”分层：播放按钮是高优先级实心或强调按钮，查看全文是次级文本按钮。
- playing 卡片使用克制的强调边框、背景或声波动效，不做大面积闪烁。
- preparing 状态保持卡片高度稳定，避免按钮切换导致聊天流跳动。
- 进度条和时间文案在移动端不得挤压正文；窄屏可换行但不能溢出。
- 所有动效尊重 `prefers-reduced-motion`。
- 暗色和亮色均使用现有 Design Token，不写孤立颜色和阴影值。

### 本段验收

- 创作页完成作品不出现“查看作品”或作品库 CTA。
- 点击一条 ready 作品后，该卡和全局播放器指向同一个 `workId`。
- 切换另一条作品时，上一张卡立即退出 active 状态。
- 音频准备失败可重试；连续点击不会并发创建多个请求。
- `yarn test:fast`、`yarn build`、`git diff --check` 通过。
- 本段不运行用户浏览器旅程。

---

## 第二段：把单作品单音频变成正式发布路径

### 用户结果

每条作品只有一条完整音频和一条连续时间轴。内部可以分块调用 TTS，但用户不会看到段落切曲、重复归零或多条音频。刷新、跨页面和缓存过期后仍按作品恢复。

### 实现范围

主要文件：

- `lib/audio/singleTrackFlag.ts`
- `lib/server/storyAudioAsset.ts`
- `lib/server/storyAudio.ts`
- `lib/client/storyAudio.ts`
- `stores/playbackSessionStore.ts`
- `app/services/playbackSessionFlow.ts`
- `app/api/audio/assets/[assetId]/route.ts`
- `Dockerfile`
- `docker-compose.yml`
- `.env.sample`
- `.github/workflows/auto-delivery.yml`
- `scripts/push-ghcr.sh`

### 技术裁决

1. 新的 Work 播放默认使用 `StoryAudioAsset`，不再由客户端和服务端双 feature flag 决定。
2. 删除 `globalThis.__SINGLE_TRACK_AUDIO_ENABLED` 和所有测试覆盖入口。
3. 删除正式镜像依赖 `NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED` 的条件分支；单轨能力进入正常构建。
4. 服务端不能再因 `SINGLE_TRACK_AUDIO_ENABLED` 缺失拒绝正式单轨 API。授权只判断 Subject ownership、Work 生命周期和资产状态。
5. 旧 Segment/Manifest 只作为历史兼容数据保留：
   - 不为新 Work 创建新的用户可见分段曲目；
   - 不在本轮物理删表或重命名 migration；
   - 只有无法立即形成 Asset 的既有数据才允许走明确的兼容恢复路径，恢复后仍发布为一个 Asset。
6. 正式播放入口统一为 `playStoryWork(workId)`；Library、Chat 和连续创作都调用它。

### 音频资产完成条件

- 内部分块全部成功后才原子发布单个 `storageKey`。
- 任一分块失败，整个 Asset 为 failed，临时对象清理，不发布部分音频。
- `positionMs`、`durationMs`、`completedAt` 和 `sessionId` 按 Work 记录。
- 播放中每十秒节流保存；暂停、切曲、隐藏页面和结束时强制保存。
- ready 资产使用三十天滑动 TTL；授权读取限频刷新访问时间。
- TTL 到期只删音频对象，不删 Work、Collection 或播放进度；再次播放按原 profile 重建。
- 正在播放、正在生成和有效 lease 的资产不能被清理。

### 发布链要求

- `yarn build` 产物必须天然包含单轨客户端路径，不依赖未配置的 repository variable。
- Docker 构建脚本不再遗漏决定产品行为的 build arg。
- CI 仍只做 lint、类型检查和 build，不添加真实用户模拟。
- `.env.sample` 只保留仍真实影响运行的变量，删除已退役开关说明。

### 本段验收

- 新 Work 第一次播放生成一个正式 Asset，后续复用同一 ready Asset。
- 页面只显示一个 timeline，结束事件只发生一次。
- 刷新后从 Work 的秒级位置恢复，位置不超过 duration。
- 缓存过期后显示重新准备，完成后从合法进度继续。
- 正式 Docker/CI 构建不依赖测试注入或遗漏的单轨 build flag。
- `yarn test:fast`、`yarn build`、`git diff --check` 通过。
- 本段不运行用户浏览器旅程。

---

## 第三段：连续创作围绕正式下一作品完成闭环

### 用户结果

连续创作默认开启后，用户能看到下一篇正在生成、准备语音、已经就绪或等待中的状态。当前作品结束时，如果下一篇已就绪就立即续播；尚未就绪则显示等待，准备完成后自动开始。流程持续到预算耗尽或用户关闭。

### 实现范围

主要文件：

- `app/services/continuousCreationFlow.ts`
- `lib/continuous-creation/stateMachine.ts`
- `stores/continuousCreationStore.ts`
- `app/(main)/chat/components/ContinuousCreationBar/**`
- 新增 `app/(main)/chat/components/ContinuousCreationCard/**`
- `app/(main)/chat/components/ChatLayout/index.tsx`
- `app/services/chatFlow.ts`
- `app/services/playbackSessionFlow.ts`
- 作品晋升和音频 ensure 的现有 client service

### 下一作品正式模型

删除临时结构：

```text
{ audioUrl, segment, messageId }
```

替换为：

```text
PreparedNextWork {
  epoch
  conversationId
  collectionId
  workId
  sourceMessageId
  title
  audioStatus
}
```

正文生成完成后必须经过既有 Artifact 晋升入口创建正式 Work；晋升成功后调用正式单轨音频 ensure。只有拿到 `workId` 且音频 ready，才进入 `next_ready`。

### 状态转换

```text
enabled_idle
  → generating_next
  → saving_next_work
  → preparing_audio
  → next_ready

current ended + next_ready
  → playStoryWork(workId)
  → enabled_idle

current ended + next not ready
  → waiting_next
  → audio ready
  → playStoryWork(workId)
  → enabled_idle

任意在途状态
  → error（可重试）

预算耗尽 / 关闭 / 新建创作 / 切集合 / 登出
  → 取消任务并进入对应终态
```

状态机增加 `saving_next_work`，并允许 `waiting_next` 接收当前 epoch 的 `workSaved`、`audioPreparing` 和 `audioReady`。迟到事件若 epoch、conversationId 或 collectionId 不匹配则完全丢弃。

### 编排规则

1. lookahead 始终为一个正式 Work，不并发准备多篇。
2. 进入调度窗后生成下一篇；用户主动发送内容时，立即取消尚未完成的自动续作，让用户输入优先。
3. 文本生成完成后先晋升 Work，再调用音频 ensure；必须实际派发 `audioPreparing`。
4. 当前音频结束时：
   - `next_ready`：原子取出并调用 `playStoryWork(workId)`；
   - 其他在途状态：进入 `waiting_next`，不扣预算；
   - error：保持当前页面并给出重试或关闭连续创作操作。
5. 音频在 `waiting_next` 期间变 ready，立即续播；不得要求用户再点一次播放。
6. 预算只由音频实际推进信号递减；生成、保存、TTS、网络等待、缓冲和暂停均不扣。
7. 预算归零时停止当前音频、保存进度、取消下一任务，并显示“本次连续创作已结束”。

### UI 与美观要求

- 顶部 `ContinuousCreationBar` 只保留集合标题、开关和剩余预算，保持紧凑。
- `ContinuousCreationCard` 放在聊天内容流末端，靠近它所描述的下一作品，而不是悬浮在页面顶部。
- 卡片阶段文案直接使用：
  - “正在创作下一篇”；
  - “正在保存下一篇”；
  - “正在准备下一篇语音”；
  - “下一篇已准备好”；
  - “当前故事已结束，正在等待下一篇”；
  - “下一篇准备失败”。
- 生成和准备阶段使用一致的轻量进度动效；ready 使用成功图标但不抢占当前播放卡焦点。
- waiting 卡片必须让用户知道预算没有减少。
- error 卡片提供“重试”和“关闭连续创作”，不暴露技术错误。
- 卡片进入和退出要平滑，移动端不能遮挡 Composer 或 Mini Player。

### 本段验收

- 下一篇在状态和数据上都是正式 Work，不存在临时 URL 曲目。
- `audioPreparing` 在真实生产路径发生。
- `waiting_next` 后准备完成会自动播放。
- 预算耗尽后不再生成或播放新作品。
- 用户输入、新建创作、切集合和登出都能取消在途任务，迟到结果不出现。
- `yarn test:fast`、`yarn build`、`git diff --check` 通过。
- 本段不运行用户浏览器旅程。

---

## 第四段：跨页面收口、视觉打磨和真实用户验收

### 用户结果

从创作、播放到故事库形成一致体验；新建创作能彻底回到初始态；桌面和移动端布局都清楚、美观，没有被播放器遮挡的内容。最终验收只使用用户能看到和操作的页面。

### 功能收口范围

1. 新建创作：
   - 确认后立即停声并卸载媒体；
   - 清空当前卡片高亮、音频准备、下一作品卡、错误和重试状态；
   - 中止正文生成、作品晋升、音频 ensure 和连续创作；
   - 迟到响应不能恢复旧卡片、重新起播或写入新集合；
   - 页面回到空对话、“新作品集”、连续创作默认开启和新预算快照。
2. 标题一致性：
   - 创作页头部、故事库卡片、作品集详情、Mini Player 和 Expanded Player 使用同一集合标题；
   - 播放器副标题表达当前作品位置或短标题。
3. 故事库安全区：
   - 无 Mini 时避让 TabBar 和设备 safe area；
   - 有 Mini 时额外避让其真实高度和间距；
   - 最后一张集合卡、加载状态和撤销提示都能完整滚到可见区；
   - Mini 展开、收起和响应式切换不残留固定空白。
4. 兼容清理：
   - 删除已经没有调用方的 History 命名和过渡适配器；
   - 删除 `StartNewCreationOptions.createNew` 及同类生产测试注入，测试不得通过替换生产入口绕过真实调用链；
   - 删除只为旧分段播放服务、且已无生产读取的客户端状态；
   - 不在本段物理删除仍可能存在数据的数据库表。

### 最终浏览器旅程

只在本段、production build 完成后执行。必须通过可见 UI 操作，不得调用 Store、内部函数、状态机、测试 Probe 或功能开关。隔离环境可以通过 fixture 建立登录和本地 mock 等前置条件，但不得通过数据库写入、直接 API 调用或页面脚本预先制造本轮要验收的作品、播放或连续创作状态。

先审计 `tests/system/browser/scenarios` 中会被 `test:delivery-journeys` 执行的现有文件：

- 删除已经过期、重复或偏离本轮用户目标的场景，不为了保留历史覆盖而继续维护；
- 将直接调用业务 API、直接读写数据库、读取 Store/状态机、检查隐藏 DOM 或媒体内部属性作为通过依据的断言，改为用户可见操作与可见结果；
- 如果一个旧场景混合大量无关目标，拆除无关部分并合并到对应完整旅程，不保留庞大的步骤清单；
- 验收通过依据只能来自用户可感知的页面状态、播放行为和跨页面结果；诊断日志可以帮助定位失败，但不能替代产品断言。

完成清理后复用并更新最少数量的现有场景，不机械新增文件，覆盖以下用户目标：

- 创作一篇故事，在作品卡点击播放，观察准备、播放、暂停、继续和进度。
- 同一会话继续创作，故事库只产生一个作品集，集内包含多条作品。
- 连续创作保持默认开启，从当前作品自然续播下一作品直到预算结束。
- 下一篇晚于当前播放结束时，页面显示等待，准备完成后自动播放。
- 播放中点击“新建创作”，声音立即停止，页面回到初始态，旧结果不复活。
- 从故事库作品集详情播放任意作品，Mini / Expanded 与创作页身份一致。
- Mini Player 出现时，故事库最后一张卡完整可见。
- 刷新和跨页面导航后，当前 Work 从合理的秒级进度恢复。

### 视觉验证矩阵

至少检查以下视口：

- 移动端：`375 × 812`；
- 大屏移动端：`430 × 932`；
- 桌面端：`1440 × 900`。

截图用于支持视觉判断，不设数量门槛，也不要求每种状态在每个视口重复留存。采用以下最小代表矩阵，运行产物不提交：

- 三个视口都检查创作页首作 ready，以及故事库带 Mini Player 的列表底部；
- `375 × 812` 补充检查当前作品 preparing、playing，以及连续创作 generating、waiting；
- `1440 × 900` 补充检查 Expanded Player；
- `430 × 932` 只用于确认大屏移动端响应式布局，不重复收集所有状态；
- 某个状态只在特定尺寸暴露问题时，再补充该尺寸的单张证据，不扩展成固定回归矩阵。

视觉检查必须回答：

- 信息层级是否一眼能分辨“当前作品”和“下一作品”；
- 主操作是否突出且没有与“查看全文”争抢；
- 状态切换是否抖动、跳高或遮挡；
- 长标题、长正文、失败文案和窄屏是否溢出；
- 暗色与亮色对比度是否足够；
- Mini Player、Composer、TabBar 和 safe area 是否互相覆盖；
- 整体是否沿用现有 Liquid Glass 与 Design Token，而非拼接出新的视觉体系。

发现视觉问题必须回到对应组件修正后重跑受影响场景，不能只在验收记录里注明。

### 最终完成门

```bash
yarn test:fast
yarn build
git diff --check
yarn test:delivery-journeys
```

运行 `test:delivery-journeys` 前必须确认其收集范围内只剩符合上述规则的末期用户旅程，不能让旧的内部状态测试随目录通配继续进入交付门。浏览器旅程只在本段执行。最终报告必须分别列出：功能结果、视觉结果、未执行项、已知限制和提交列表。没有实际浏览器证据时，不得声称产品旅程已经完成。

## 四段提交建议

提交信息直接描述结果，不使用任务代号：

1. `feat(chat): add playback states to story cards`
2. `feat(audio): make single-track playback the default`
3. `feat(creation): complete continuous creation handoff`
4. `fix(ui): polish cross-page playback journeys`

## 明确非目标

- 不增加作品手动重排、单条作品删除或作品集协作。
- 不重新引入提示词历史、生成历史或独立播放器一级页面。
- 不重写聊天协议、鉴权体系或整个 StoryWork 数据模型。
- 不为了测试方便增加生产探针、测试状态入口或浏览器全局覆盖。
- 不在没有数据迁移与发布授权的情况下删除旧数据库结构或生产对象。
