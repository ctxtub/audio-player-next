# Chat Artifact 模块端到端封板与契约冻结

功能域：08-创作Artifact

## 用户目标

证明 M4-01～09 分别建好的能力在组合运行时仍然成立，并把这些契约永久写进测试与文档：完整创作链（生成 → `story_complete` → promotion → ready → persistence → reload）、失败重试链、stale / reset / crash-window 治理、History UI 与 live attempt 共存、Legacy 与 Modern 共存，全部同时成立；最终 Architecture invariant 审计全过后，M4 关闭并不再接受行为改动。

## 范围与边界声明

本场景是 M4 模块的最终封板（M4-10 功能里程碑）：只做跨里程碑组合验证、最终架构审计与文档 / catalog 收口，不设计任何新能力。

**包含的职责**：

- 跨里程碑 E2E contract matrix：把以前分开证明的能力组合起来验证（生成 → `story_complete` → promotion → ready → persistence → reload；失败 → `promotion_failed` → retry → ready → persistence；live attempt → reset / new attempt → stale settlement no-op；crash-window → canonical history state → explicit reconciliation；Legacy history + Modern Artifact 共存）
- 最终 Architecture Contract audit：确认所有冻结边界仍在（Modern lifecycle ownership、Promotion ownership、History ownership、Legacy writer firewall、Legacy compatibility allowlist、Modern playback exclusion、M2 facade freeze）
- 文档 / catalog 当前态收口：把文档从“迁移过程记录”收敛成“现在系统到底是什么”；修正仍标 ACTIVE 但已因 M4 改造失真的 current-state 描述（History ownership 已归 Chat，`/player` 不再拥有 History）
- 最终模块回归与 Evidence：沿用现有 runner / Evidence 体系产生执行证据，不造第二套报告系统

**显式排除以下能力**（封板后宁可不做，也不在本场景声称）：

- 任何生产行为改动：除非综合测试暴露真实 correctness bug，否则生产逻辑 0 行为改动（理想：M4-10 production source diff = 0）；正常不得修改 `types/chatArtifact.ts`、chatArtifactState 转移语义、`storyArtifactPromotion.ts`、`chatPromotionOrchestration.ts`、libraryClient / M2 facade、`chatArtifactHistory.ts` recovery mapping、server provenance 算法、Prisma schema、StoryArtifact playback 面、Canonical Audio / Manifest、Playback Session、Mini Player / Expanded Player
- Legacy 治理动作：不删 Legacy renderer、不删 `StoryCardPart` 类型、不做 Legacy migration / backfill、不把 Legacy History 并入 StoryWork、不重做 History UI、不重做 Library UI、不 opportunistic refactor
- 新 harness：不为“E2E”之名再建浏览器 harness；需要 DB / browser 证明的部分由 M4-08 L2 与现有 L3 cases 承担，最终回归直接复跑
- 自动 recovery：`promotion_failed` 之后只有显式 `promotion.retry` 可以继续，禁止为“体验好”改成自动 retry；禁止 reload 后自动 create / retry

## Frozen Contract Matrix（冻结，M5/M6/M7 判断“能不能改”的基准）

| Contract | 最终真相 |
|---|---|
| Story completion | 仅 `story_complete` 完成正文（`draft → complete`）；`stream.delta` 只追加草稿 |
| Delivery done | 只结束消息 transport（`sending → delivered`），不代表 Artifact complete；`done` 先到不提前 complete，`done` 后到不倒退 promoting / ready |
| Promotion eligibility | 仅完整 Modern Artifact（`complete` 初次 / `promotion_failed` 重试源，且携带非空 prompt 快照）可 promotion；Legacy / draft / interrupted / promoting / ready 一律 fail-fast |
| Promotion write | 只经 frozen library：`complete → startPromotion() → promoteStoryArtifact() → libraryClient.create` 唯一通道；chatStore / chatFlow 不得直调 `library.create` |
| Client.create / M2 facade | `lib/client/library.ts` 只暴露 8 个 canonical procedure + `libraryClient`；不因 M4 扩面；幂等键由 M2 `[sourceMessageId + storyText hash]` 保障，客户端不自造 key |
| Idempotency identity | `sourceMessageId` 恒为产生该 Artifact 的 assistant message id；全链（draft → ready、多次 retry、reload）绝对不变 |
| Async ownership | promotion 归属 = message id + transient token / epoch / inflight slot（调用方瞬态守卫，不进持久领域模型）；token 绝不进入编排持久语义 |
| Retry | `promotion_failed` 只重发 promotion（`promotion_failed → promoting` + 唯一 `library.create`）；不重生成、不换身份；快速双击 ≤ 1 in-flight |
| Modern ready | StoryWork 已创建（正整数 `storyWorkId`），不等于 audio ready；ready 只做 Library handoff（导航到 `/library/${storyWorkId}`，不 fetch / 不播放 / 不 mutation） |
| Modern Chat UI | 六态纯 lifecycle 语义（`draft / complete / promoting / ready / promotion_failed / interrupted`）；正文唯一来源 `artifact.storyText`；`promotion_failed` 唯一动作是重试保存；无实际 playback |
| History stable | `ready / promotion_failed / interrupted` 精确 round-trip（identity / storyText / snapshot / storyWorkId / error / reason 全保留） |
| History transient | `draft → interrupted`；`complete / promoting → promotion_failed`（outcome unknown → 用户显式幂等 retry 收敛） |
| Reload | restore-only：恢复纯读零副作用（零自动 create / retry / generation / promotion / playback / save-back）；await-window 本地 attempt untouched |
| History UI | Chat-owned（Composer `leftSlot` 唯一「历史」入口 + bounded overlay + 双 tab）；同页 `pendingAutoSend` 单 slot exactly-once 消费；开关 / 切 tab / 排序 / 删除不改变 Artifact lifecycle；非 migration |
| Legacy write | 永久禁止新建 / 篡改 / 复制（server provenance guard multiset subset tuple，`audioUrl` 差异不计、`\u0000` 拼接碰撞按 tuple 区分；user / guest 对称） |
| Legacy read | 保留 renderer / history / playback compatibility（`StoryCardPart` 类型、`isStoryCardPart`、`extractTextFromParts`、`decodeLegacyStoryCard`、`StoryCardPartRenderer`、`MessageParts` 分支、`onPlayStory` 透传、selectors 只读识别） |
| Legacy conversion | 禁止自动转 Artifact / StoryWork（rehydrate 透传不转、serialize 透传不转、无 backfill、无 lazy migration） |
| Compatibility boundary | M4-09 allowlist only（见下）；Modern 核心零直接 Legacy wire knowledge |

## 最终 Legacy Allowlist（冻结，repo audit 无其它生产 reader）

生产代码 Legacy schema awareness（`'storyCard'` 字面量 / `StoryCardPart` / `decodeLegacyStoryCard`）仅允许以下 9 处；M4-10 已对 `app / lib / stores / components / types` 全量扫描，确认无第 10 处。

| 路径 | 身份 | 允许理由 |
|---|---|---|
| `types/chat.ts` | 类型定义 | `StoryCardPart` 类型、`isStoryCardPart`、`extractTextFromParts` 的 read type system 本体；删除等于删除只读能力 |
| `lib/client/chatStoryCompatibility.ts` | 唯一 client 边界 | 全部 client Legacy 结构知识的唯一收口（`decodeLegacyStoryCard / hasLegacyStoryCard / hasAnyStoryPart / hasStoryContent / findLegacyPlayableStoryCard` 纯函数只读） |
| `lib/client/chatArtifactHistory.ts` | History codec | `storyCard` clone 透传（save 侧 `audioUrl=''`、load 侧浅 clone 不转 Artifact）；M4-06 冻结语义 |
| `lib/server/chatConversation.ts` | 服务端血缘守卫 | `assertNoNewLegacyStoryCardWrites` provenance firewall + `audioUrl → ''` sanitize；M4-08 冻结算法 |
| `app/(main)/chat/components/MessageParts/index.tsx` | 渲染分发 | `case 'storyCard'` 分支与 `onPlayStory` 透传契约；只分发不构造 |
| `app/(main)/chat/components/MessageParts/StoryCardPart.tsx` | Legacy 渲染器 | 旧卡只读渲染与兼容播放（`playStoryText` / 播放 / 暂停 / 续听）；Modern exclusion 不得删它 |
| `app/(main)/chat/components/ChatLog/MessageBubble/index.tsx` | 卡片视图判定 | 卡片视图 / 实质内容判定需识别历史卡形态；无构造无转换 |
| `app/services/storyFlow.ts` | 旧播放兼容 | `startStoryPlayback` 读历史卡 `storyText` 注册断点活跃故事；`playStoryText` 供旧卡回放；不读 Modern Artifact |
| `stores/playbackProgressStore.ts` | 旧进度兼容 | `resume` 读历史卡 `storyText`；不读 Modern Artifact |

Modern 核心（`stores/chatStore.ts`、`lib/client/chatArtifactState.ts`、promotion adapter、promotion orchestration、`StoryArtifactPart.tsx`、`ChatLayout`、History UI 四件套、Library 全链）零直接 Legacy wire knowledge；对象构造（`type: 'storyCard'`）仅允许 compatibility decoder。

## 契约验收标准

### 1. Fresh creation full-chain（M4-10-01，主 happy-path seal）

- 真实 store 链：`user.submit → draft → stream.intent(Story) → stream.delta → story_complete → promoting → library create success → ready(storyWorkId) → snapshot → reload → ready(storyWorkId)`。
- 全程 `StoryCard write = 0`、`sourceMessageId` 不变、`storyText` 不变、prompt / voice snapshot 不变、`storyWorkId` 精确保留；reload `create = 0`、`generation = 0`。
- 同链封印：`story_complete != delivery done`（`done` 先到不提前 complete）、`ready != audio ready`（ready Artifact 无 `audioUrl`，不断言任何播放）。

### 2. Promotion failure / retry / ready / reload（M4-10-02）

- `story_complete → promotion reject → promotion_failed → snapshot / reload → promotion_failed → promotion.retry → only library.create → ready → reload ready`。
- 全程 `generation transport retry = 0`（不新增 attempt、不换 assistant id / artifact id / sourceMessageId / storyText）；retry 后 `create` exactly once（与首次 input 逐字段一致）。

### 3. Pre-complete interruption closure（M4-10-03）

- `fail before story_complete` 与 `abort before story_complete` 分别验证：最终 `interrupted`、`create = 0`、`reload = interrupted`；中断后迟到的 `story_complete` 不得复活。

### 4. Late terminal after complete（M4-10-04）

- `story_complete → promoting / ready` 后，迟到的 `done / fail / abort` 不得把 `promoting / ready` 倒退为 `interrupted`（含 ready 终态）。

### 5. Cross-attempt stale closure（M4-10-05）

- Attempt A `story_complete → promotion pending`；reset 后 start Attempt B（B draft / complete / promotion → ready）；A resolve / reject late。
- 要求：A settlement = no-op（message id + token + epoch + inflight ownership 四项归属，M4-04 原守卫，不发明新 stale guard）、B Artifact 不受污染、B 独立 ready、A 的 `storyWorkId` 不得写到 B。

### 6. Crash-window reconciliation（M4-10-06）

- 组合验证：`draft → interrupted`、`complete → promotion_failed`、`promoting → promotion_failed`；reload 全部零副作用（`create = 0`、无自动 retry）。
- `promotion_failed` 之后只有 explicit `promotion.retry` 可以继续（retry input 与 crash 前冻结快照一致）。

### 7. History prompt while live attempt（M4-10-07）

- Attempt A sending / draft / promoting 中选择历史 prompt B：A 不 abort / 不 reset、B 不发送（`pendingAutoSend === B`，连续选择单 slot 覆盖）；A terminal 后 B exactly-once 启动（clean creation + 1 次提交）；A 的 settlement 归属正确。
- History panel open / tab switch / close 本身不改变 Artifact lifecycle。

### 8. Modern + Legacy coexistence（M4-10-08）

- 同一恢复 conversation 中同时存在 Legacy StoryCard（old assistant）与 Modern ready Artifact（new assistant）：两者都正确读取；Legacy 不转 Modern；新创作仍 Modern-only。
- 行为 + 服务端对称：已有 Legacy 可续存 / 可减少（删除 PASS）；`new Legacy → reject`、`mutated Legacy → reject`、`duplicated Legacy → reject`、`tuple collision → reject`、`no baseline bypass → reject` 由 M4-08 integration 口径继续证明，本 suite 只做轻量对称抽查，不重写 provenance guard。

### 9. Modern playback exclusion（M4-10-09）

- 最终静态 + UI 断言：`StoryArtifactPart` 不出现 `playStoryText / playbackStore / audioUrl / 播放故事 / 暂停播放 / 继续收听`；ready 仍只意味着 Library handoff（`查看作品 → /library/${storyWorkId}`）。
- Legacy renderer 的旧 playback 不受影响（`StoryCardPart` 仍保留 `playStoryText` 与播放文案，证明 exclusion 是 Modern-only）。

### 10. Frozen architecture audit（M4-10-10，blocking）

- 自动检查：Modern state module 无 Legacy；chatStore 无 Legacy wire 字面量；promotion 只经 frozen adapter / facade；History codec mapping 不变（含 live `ALLOWED_TRANSITIONS` 未为 recovery 开口子）；History UI 无 raw history parsing；Legacy 新构造点仅 decoder；final allowlist 外 Legacy 依赖 = 0；M2 facade surface 不变。

### 11. Catalog / docs consistency（M4-10-11）

- 机械验证：E2E-08-01～10 都存在、都属于 `creation-artifact`、ACTIVE / P0、`spec_path` 存在、executable 存在且 path 落盘、无 dangling case / executable；E2E-08-10 contract matrix 与代码最终 invariant 一致；ACTIVE current-state docs 中不存在已知过时的 Player-owned History 描述。

### 12. Full release-style regression（M4-10-12）

- 最终必须在同一个候选 HEAD 上完整跑：M4-10 targeted、M4-09、M4-08 unit + server integration、M4-07、M4-06、M4-05、M4-04、M4-03、M4-02、M4-01、全部 unit、全部 integration、catalog CHECK、tooling、browser-harness clean-tree（含 history prompt start new creation、generation history replay、main navigation、library lifecycle 与当前默认 browser suite）、lint、tsc / typecheck、build、`git diff --check`。

## M4 模块级 Definition of Done

| 维度 | M4 最终 DoD |
|---|---|
| 模型 | 新故事正文只存在于 Modern StoryArtifact lifecycle |
| 完成语义 | `story_complete` 唯一完成正文；delivery terminal 与其解耦 |
| Promotion | complete Artifact 经唯一 frozen adapter 创建 StoryWork |
| 幂等 | `sourceMessageId` / content identity 稳定；retry 不换身份 |
| 并发 | stale settlement 不污染新 attempt；快速 retry ≤ 1 in-flight |
| Failure | promotion failure 保留完整故事与 frozen snapshot |
| Retry | 只重发 StoryWork write，不重生成故事 |
| 中断 | complete 前 fail / abort → interrupted；complete 后不能倒退 |
| Chat UI | 六态语义正确；ready 只 Library handoff |
| Playback | Modern Artifact 不把 ready 当 audio-ready |
| History save | transient state 在 persistence boundary canonicalize |
| History load | stable round-trip；malformed fail-closed；restore 零副作用 |
| History race | await-window live attempt 不被 server history normalize |
| History UI | Prompt / Generation History 归 Chat ownership；非 migration |
| Legacy writer | 新增、篡改、复制 Legacy 永久由 server 拒绝 |
| Legacy reader | 旧 StoryCard 继续可读、可渲染、可兼容播放 |
| Legacy migration | 不自动转 StoryArtifact / StoryWork |
| Containment | Legacy knowledge 只存在 final allowlist |
| User / Guest | persistence / cutover 规则两种身份一致 |
| M2 | StoryWork public facade 保持冻结，不因 M4 扩面 |
| Documentation | E2E-08-01～10 描述的是当前实现，不是过期迁移态 |
| Regression | 01～10 targeted + unit / integration / browser / tooling / build 全绿 |

## 跨模块冻结边界（M5/M6/M7 必读）

M4 关闭后，后续模块可以消费这些契约，但不能顺手重新解释它们。尤其播放模块后续即使接上 Modern ready Artifact，也必须新增明确的 audio readiness / manifest / playback-session 层，而不能把 ready StoryArtifact 重新定义成 audio ready。

## Definition of Done（一句话）

跨 01～09 的组合链全部贯通且架构审计全绿，文档描述的是当前实现，生产逻辑零行为改动；M4 关闭，Artifact creation / history contract 冻结。
