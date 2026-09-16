# StoryCollection、连续创作与单音频播放实施计划

**状态**：READY
**日期**：2026-09-15
**change-id**：`2026-09-15-story-collection-continuous-creation`
**角色**：Planner
**工作目录**：`/Users/tensho/Developments/audio-player-next`
**规划目标 SHA**：`007157cb3c26234c56208a9a5f2e6496c583b0b1`（2026-09-15 实施开工前按仓库现状重记；原规划 SHA 为 `e6def28`）
**技术方案**：`docs/specs/2026-09-15-story-collection-continuous-creation-technical-design.md`
**授权边界**：不含 push、merge、deploy、Actions 或生产数据操作

## 1. 落地顺序

拆为 4 个纵向任务段，每段同时包含代码、测试、e2e 与 Catalog，不把测试推迟到最后：

```text
T1 身份与数据底座
  ↓
T2 创作页与连续创作
  ↓
T3 单音频与播放内核
  ↓
T4 故事库 UI 与全链收口
```

默认串行。若后续明确授权多写者，T2/T3 只在 API 冻结且声明不相交路径后并行；共享 store、schema、Catalog 和重套件仍串行。

命令约定：`scripts/run-tests.mjs` 只接受 `--list` / `--group <unit|integration|tooling>` / `--suite <精确 suite id>`，没有名称匹配参数；新增套件登记进 runner 注册表后再用 `--suite` 单跑。L3 场景文件名以仓库现状为准。

## 2. Task 1 — Conversation / Collection 数据底座

### 交付目标

建立 Conversation、StoryCollection、Work membership 和 AI 集合标题；完成 expand/backfill 与新 API。

**范围重排（2026-09-15 M9-C1 T1 closeout，独立评审方裁定）**：T1 只保证**新 Conversation/Collection/promotion 路径存在结构性零 History 写入**（由 `collection-domain` L1 静态守卫与 `lib/storyCollection/rollout.ts` 回退开关锁定）。**legacy History 停写（阻断 Prompt/Generation 新写）、Prompt History 停止迁移、以及 History 前后端（UI/store/router/client）整体退役，全部转入 T2**；T1 不改写/不删除 legacy History 写入路径，也不做 contract migration。

### 代码工作

- 修改 `prisma/schema.prisma`，新增 User/Guest 对称表、FK、索引与 migration。
- 扩展 `chatConversation`、`storyWork` 服务，新增 collection domain/server/router/client。
- 实现首作事务建集、AI title 短超时与 fallback、sourceMessageId 幂等、集合 position。
- 实现 collection list/get/rename/favorite/delete/restore/forever-delete。
- 更新 Guest GC、注册迁移与 ownership。
- 新路径零 History 写入（legacy 停写与前后端退役见上方范围重排，整体转入 T2）。
- 编写可重复 backfill：现有 Chat 快照建 legacy Conversation；旧 Work 默认一 Work 一 Collection，不按时间猜测合并。

### 测试流程

1. 先新增 `docs/e2e`：首作建集、同会话追加、跨会话/主体隔离、迁移守恒；Catalog 登记 PLANNED。
2. L1 RED：title fallback、DTO/cursor、position、幂等冲突。
3. L2 RED：User/Guest 首作并发、事务回滚、backfill 重跑、无孤儿。
4. 实现 GREEN；executable 落盘后改 ACTIVE。
5. 运行：

```bash
yarn test:catalog
node scripts/run-tests.mjs --group unit
node scripts/run-tests.mjs --group integration
node scripts/run-tests.mjs --suite <新增套件的精确 id>
yarn test:tooling
npx prisma validate
git diff --check
```

### 完成门

同一 Conversation 三个 Artifact 只有一个 Collection；不同 Conversation 不串集；标题失败不阻断；backfill 重跑不重复；输出脱敏的迁移前后数量/孤儿/冲突证据。此时不 contract 旧表，可回退 read flag。

## 3. Task 2 — 创作页、新建创作与连续创作

### 交付目标

创作页围绕当前集合运行；连续创作默认开并继承设置时长；“新建创作”强重置；Prompt/Generation History 前后端代码退役。

### 代码工作

- 修改 `app/(main)/chat/**`、`chatStore`、`generationStore` 和 `chatFlow`。
- 新增 continuous creation store/orchestrator，替换旧 `preloadStore` / `AUTO_CONTINUE_PROMPT` 链。
- 实现 work lookahead=1、30–120 秒调度窗、audio-active 预算扣减和 waiting_next。
- 实现唯一 `startNewCreation()`：确认 → epoch++ → abort → unload/clear → createNew → 初始态。
- Artifact 卡接共享播放状态；增加连续创作状态卡、开关、剩余预算。
- 删除 History UI/store/client/router 引用、自动发送桥和本地缓存 key。

### 测试流程

1. 新增 e2e：History 消失、新建创作强重置、默认预算、状态卡、停止矩阵；登记 Catalog。
2. L1 RED：状态机、预算、窗口、lookahead、epoch/token stale guard。
3. L2 RED：用户输入抢占、预算耗尽、关闭/暂停/切集合、新会话 expected-old guard。
4. L3 RED：默认开启 → 自动下一 Work → 预算耗尽；新建创作停声且旧响应不复活。
5. 实现 GREEN 并运行：

```bash
yarn test:catalog
node scripts/run-tests.mjs --group unit
node scripts/run-tests.mjs --group integration
node scripts/run-tests.mjs --suite <新增套件的精确 id>
npx playwright test --config tests/system/browser/playwright.config.ts tests/system/browser/scenarios/continuous-creation.spec.ts
npx playwright test --config tests/system/browser/playwright.config.ts tests/system/browser/scenarios/new-creation-reset.spec.ts
yarn lint
yarn tsc --noEmit --incremental false
git diff --check
```

### 完成门

新会话预算等于设置快照；生成/TTS/缓冲/暂停不扣预算；最多一个 next job；预算耗尽停声；新建创作使 Chat 与 Now Playing idle，旧集合仍可回访。回滚只关闭新 orchestrator，不恢复 History。

## 4. Task 3 — StoryAudio 单 track 与 30 天缓存

### 交付目标

一 Work 一条 canonical track；长文本内部合成并合并；统一时间轴和秒级进度；30 天滑动 GC。

### 代码工作

- 新增 AudioAsset expand migration。
- 改造 `storyAudio` server/client、storage、TTS、读取路由、cleanup/outbox。
- 改造 `playbackSessionStore`、`playbackStore`、`AudioControllerHost`、Now Playing。
- 删除客户端 segment provider、paragraph advance/prefetch 与 segment progress。
- 实现内部 chunk 格式校验、拼接/封装、原子发布、single-flight/lease fencing。
- 实现 positionMs 节流落库、恢复、TTL last-access 限频与过期重建。

### 测试流程

1. 新增 e2e：一 Work 一 timeline、长文、缓存复用/过期、进度恢复、切换竞态；登记 Catalog。
2. L1 RED：asset identity、chunk plan/校验、TTL、progress clamp/节流。
3. L2 RED：多 chunk 只发布一个 Asset、失败清理、lease/stale、GC/outbox。
4. L3 RED：卡片/Mini/Expanded 同一 timeline，整 track ended 才切下一 Work。
5. 实现 GREEN 并运行：

```bash
yarn test:catalog
node scripts/run-tests.mjs --group unit
node scripts/run-tests.mjs --group integration
node scripts/run-tests.mjs --suite <新增套件的精确 id>
npx playwright test --config tests/system/browser/playwright.config.ts tests/system/browser/scenarios/story-audio-single-track.spec.ts
yarn test:tooling
yarn lint
yarn tsc --noEmit --incremental false
git diff --check
```

### 完成门

任意正文只暴露一个授权 Asset/总时长/时间轴；内部 chunk 不可读取；暂停恢复不重复 TTS；30 天内复用、过期重建；旧请求不抢播。观察期用 AudioAsset feature flag 回退，旧 Segment 暂不物理删除。

## 5. Task 4 — Collection Library、Mini 安全区与收口

### 交付目标

故事库完成集合级列表/详情/生命周期；修复 Mini 遮挡；清除全部 legacy 表面；完成全量回归。

### 代码工作

- 改造 `app/(main)/library/**`、`components/Library/**` 为 Collection → Work 两层。
- 接入集合重命名、收藏、删除、恢复、Undo 与逐 Work 播放。
- MainChrome 输出 TabBar/Mini/gap 占位变量，Library scroll container 动态消费 safe-area。
- 清除 legacy router/store/component/static allowlist 残留，更新 README、e2e、Catalog。
- 生成 contract migration 并验证，但不执行生产数据删除。

### 测试流程

1. L1/L3 RED：集合聚合、成员顺序、生命周期、搜索、Mini 有/无底部安全区。
2. 实现 Collection UI 与响应式布局。
3. 跑移动/桌面 L3：末卡、加载更多和 Undo 均能滚到 Mini 上方。
4. 跑全链旅程：同会话三 Work 一 Collection、连续创作、单 track、新建创作、集合删除无孤儿。
5. 执行全完成门：

```bash
yarn test:catalog
yarn lint
yarn tsc --noEmit --incremental false
yarn test:unit
yarn test:integration
yarn test:tooling
yarn test:browser
yarn build
git diff --check
git status --short
```

### 完成门

Catalog/runner/磁盘三方一致；ACTIVE case 都有 executable；无旧 History 与 segment 客户端入口；不提交运行产物。输出 READY 交由独立 Reviewer，生产 contract/push/deploy 仍需另行授权。

## 6. 每段交接格式

```text
change-id、目标完整 SHA、实际 commit（若获授权）
修改文件与 case/executable ids
实际命令、exit code、NOT_RUN/BLOCKED
迁移计数证据位置、feature flag、回滚方法
git status --short
```

Implementer 只能报告 READY，不得自称最终 APPROVE；Reviewer 从同一 SHA 独立复核范围、测试、进程/端口、数据库隔离和秘密边界。

## 7. Task 3 交接记录（Implementer 自证，待独立 Reviewer）

```text
change-id: 2026-09-15-story-collection-continuous-creation
目标完整 SHA: 9d15b2987c4ea87f6de79c7f9f04c4a5f3cfb495
实际 commit: 见本段提交（本地，未 push）
修改文件:
  lib/audio/singleTrackFlag.ts（新）
  lib/audio/asset.ts（新）
  lib/server/storyAudioAsset.ts（新）
  lib/server/audioAssetRead.ts（新）
  app/api/audio/assets/[assetId]/route.ts（新）
  lib/server/storyAudio.ts（flag 分支 + DTO 增补，旧路径保留）
  lib/trpc/schemas/storyAudio.ts / lib/trpc/routers/storyAudio.ts（新契约）
  lib/client/storyAudio.ts / stores/playbackSessionStore.ts（单轨 provider）
  prisma/schema.prisma + prisma/migrations/20260915140000_m9_c1_t3_story_audio_asset/
  tests/unit/audio/story-audio-asset-domain.unit.test.ts（新）
  tests/integration/audio/single-track-asset.integration.test.ts（新）
  tests/system/browser/scenarios/story-audio-single-track.spec.ts（新）
  docs/e2e/07-故事库与作品资产/17-StoryAudio单track与30天缓存.md（新）
  tests/test-catalog.yaml / scripts/run-tests.mjs（注册）
  tests/unit/playback/storycard-session-resume.unit.test.ts、
  tests/integration/{audio/audio-work-playback-reuse,creation-chat/clear-during-generate-no-orphan-audio,playback/storycard-session-flow}.integration.test.ts（stub 补齐）
case/executable ids:
  case story-audio-single-track
  exec-single-track-asset (L2)
  exec-story-audio-asset-domain (L1)
  exec-l3-story-audio-single-track (L3)
实际命令与 exit code: 见 .e2e-results/…/T3/post/GATES.log 与 RED/GREEN 日志
迁移计数证据: 新增 4 表，0 回填、0 旧表删除（expand-only）
feature flag: SINGLE_TRACK_AUDIO_ENABLED / NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED（严格 '1'，默认关）
回滚方法: 关闭上述 flag → 旧 Segment 读/写路径即时恢复
git status --short: 见 .e2e-results/…/T3/post/git-status.txt
限制: 见 T3/post/CLOSEOUT-T3.md §5（客户端 positionMs seek、AudioControllerHost/Now Playing 改造、GC playing 信号等为后续）
```

### 7.1 Task 3 r1 修复记录（Reviewer CHANGES REQUESTED 收口，Implementer 自证）

```text
change-id: 2026-09-15-story-collection-continuous-creation
角色: Implementer（自跑门；不自批、未 push/merge/deploy/Actions）
目标基线完整 SHA: 9d15b2987c4ea87f6de79c7f9f04c4a5f3cfb495（T2 修复轮 3）
上一实现 commit: 29ab12d27c8284ea7042c81b234624d5c244f4d3（T3 原始实现）
r1 RED commit: ae582223558d7b92c4e742495f1d9ce4b834fb14（仅测试先行，clean tracked tree）
r1 实现 commit: 42444aae84b8ea2c38a0717bdb14fea2607eeb48（本地提交，未 push）
修改文件（r1）:
  tests/integration/audio/single-track-asset.integration.test.ts（9a–9e flag 门禁零流量、10a ensureSegment 不暴露 asset、11a/11b GC 空闲清理 + 播放保留）
  tests/integration/audio/audio-lifecycle-delete-integration.integration.test.ts（3b Asset 对象 tombstone）
  tests/unit/playback/storycard-session-resume.unit.test.ts（case I positionMs→seek + 暂停落库）
  tests/system/browser/scenarios/story-audio-single-track.spec.ts（整轨 ended 前不切、ended 后切下一 Work；flag 关闭对照；卡片/Mini/Expanded 同一条时间轴）
  tests/system/browser/harness/app-server.mjs（browser 套件内 SINGLE_TRACK_AUDIO_ENABLED=1）
  tests/unit/audio/audio-cleanup-triggers.unit.test.ts（case 8：单轨 GC 触发 + isPlaying + 双 flag plumbing 静态）
  app/services/playbackSessionFlow.ts（handleEnded 单轨 atTail 恒真；reportProgress 应用恢复位/机会落库）
  stores/playbackSessionStore.ts（pendingResumePositionMs + applyPendingSingleTrackResume + persistSingleTrackProgress）
  lib/server/storyAudioAsset.ts（flag 门禁 + GC sweep/节流/isPlaying/startup + ensure 机会式触发）
  lib/server/storyAudio.ts（移除 ensureSegment 单轨劫持；删除 ensureSingleTrackSegmentResult）
  lib/server/audioAssetRead.ts（flag off → 404）
  lib/server/storyWork.ts（User/Guest + retention 内联分支 Asset 对象 tombstone）
  lib/server/audioStorageStartup.ts + instrumentation.ts（startup 单轨 GC 触发）
  lib/audio/singleTrackFlag.ts + .env.sample + Dockerfile + docker-compose.yml（最终双 flag 契约与生产登记）
必收项 1（L3 ended 切轨）: 见 CLOSEOUT-T3.md §1/§2；RED l3-ended.red.log（2 failed/4 passed）→ GREEN 6 passed
必收项 2（§5 四项缺口）: 2.1 positionMs（unit I）、2.2 GC 触发+isPlaying（L2 11a/11b + case 8）、2.3 Asset tombstone（L2 3b）、2.4 flag 去耦（L2 9a–9e/10a + 双 flag 文档/plumbing）
完成门（tree 42444aa, clean）: catalog EXIT=0；unit 70/70；integration 59/59；tooling 10/10；tsc EXIT=0；lint EXIT=0；prisma validate valid；build EXIT=0；yarn test:browser 74 passed EXIT=0（run1/run2 webkit 时序 flake 已如实登记于 CLOSEOUT §3.1）
限制: 见 T3/post/CLOSEOUT-T3.md §5（r1 收口后仅保留有意的旧路径保留、L1 无独立 RED、双 flag 需同置等诚实声明）
```

### 7.2 Task 3 r2 修复记录（Reviewer CHANGES REQUESTED 仅两项 ①④，Implementer 自证）

```text
change-id: 2026-09-15-story-collection-continuous-creation
角色: Implementer（自跑门；不自批、未 push/merge/deploy/Actions）
r1 最终基线: 97ff78d（clean）
r2 commit 链: 2e74b15（RED 纯测试）→ 5d51483（实现）→ 6c36075（RED2 纯测试）→ 54161a1（实现2，代码最终树，clean；本文档提交仅在其上追加 §7.2，不含代码改动，完成门证据对应代码树 54161a1）
必收 ①（positionMs 落库缺口）:
  切曲前旧作品 force 落库: stores/playbackSessionStore.ts:684（hydrateFromAnchor 真实 seam，beginPlayback/restart 经此）+ :821（setActiveStory probe seam 防御）
  页面隐藏/离开 force 落库: components/AudioControllerHost/index.tsx:266-272（visibilitychange+hidden 门 / pagehide / beforeunload → persistSingleTrackProgress({force:true})）
  force 只绕过客户端 10s 节流；服务端 clamp/单调/节流二次保证未动
  测试: L1 storycard-session-resume case J（真实 hydrate seam，RED2 positionms-hydrate-seam.red.log → unit 全绿）；L3 story-audio-single-track 新增 test 4（真机 DOM 事件 → saveProgress 计数，l3-pagehide.red.log 2 failed/6 passed → l3-pagehide.green.log 8 passed）
必收 ④（server flag 真去耦）:
  lib/audio/singleTrackFlag.ts:49 新增 isSingleTrackServerEnabled（只认运行时 SINGLE_TRACK_AUDIO_ENABLED）；:70 isSingleTrackAudioEnabled 收窄为 client 语义（只认 NEXT_PUBLIC_* / globalThis E2E 覆盖）
  服务端入口改用 server 判定: lib/server/storyAudioAsset.ts:390/689/761/913、lib/server/audioAssetRead.ts:67、lib/server/storyAudio.ts:1474；client 侧（store/flow/lib/client）不变
  仅置公开变量 ⇒ ensure/投影/进度 DISABLED + 读路由 404 + 零资产行，由 L2 9f–9j 锁定（single-track-flag-decouple.red.log failures=5 → integration 59/59）
  文档四处同义: singleTrackFlag.ts 顶部契约、.env.sample、Dockerfile、docker-compose.yml
完成门（tree 54161a1, clean）: catalog EXIT=0；unit 70/70（套件级，suites=70）；integration 59/59（套件级）；tooling 10/10（套件级）；tsc EXIT=0；lint EXIT=0；prisma validate valid；build EXIT=0；yarn test:browser 76 passed EXIT=0（run1–run3 webkit 加载超时 flake 留档 runN-flaky，三轮失败集零重叠且隔离全转绿，未改产品代码迁就；详见 CLOSEOUT-T3.md r2-4）
限制: 见 T3/post/CLOSEOUT-T3.md r2-5（沿用 r1 §4/§5；增补后台 kill 极端丢心跳说明）
```

## 8. Task 4 交接记录（Implementer 自证，待独立 Reviewer）

```text
change-id: 2026-09-15-story-collection-continuous-creation（T4）
目标完整 SHA: 125a08e4f00be49a1c8fe63c8b14507fdb3ac138（代码冻结；全部完成门均跑在此树 dirty=0；
  本交接段 plan 提交为纯文档追加，不碰代码/测试/迁移）
实际 commit（本地，未 push）:
  aa7ae96 test(T4): RED 集合两层列表/生命周期/安全区与 PromptHistory contract
  c4bf8d1 feat(M9-C1-T4): GREEN 集合两层列表/生命周期/安全区与 PromptHistory contract
  2ba95ce fix(M9-C1-T4): L3 首轮反馈（docked 视口/404 白名单/单轨卡片门迁移）
  20a6a11 fix(M9-C1-T4): 安全区断言改取已求值几何
  125a08e fix(M9-C1-T4): 安全区几何容差 4px（WebKit 亚像素舍入）
修改文件:
  app/(main)/library/index.tsx（重写：顶层恒为 Collection）/ index.module.scss /
  components/CollectionCard.tsx（新）/ components/index.ts / layout.tsx（+CollectionUndoProvider）/
  collections/[id]/index.tsx + page.tsx（新：集合详情）
  lib/client/collectionViewModel.ts + collectionQueries.ts + collectionMutations.ts + bottomInset.ts（新）/
  components/Library/CollectionUndoProvider.tsx（新）
  styles/app.module.scss（三占位变量单源输出）
  prisma/schema.prisma + prisma/migrations/20260916090000_m9_c1_t4_prompt_history_contract/（DROP TABLE PromptHistory）
  scripts/run-tests.mjs（EXPECTED_TABLES 去 PromptHistory；注册 collection-library-viewmodel）
  tests/unit/story-collection/collection-library-viewmodel.unit.test.ts（新 L1）
  tests/system/browser/scenarios/library-collection.spec.ts（RED + 精度修正 + docked/几何断言）
  tests/system/browser/scenarios/library-lifecycle-journey.spec.ts（重写为集合级 17 步）
  tests/system/browser/scenarios/story-audio-single-track.spec.ts（卡片门迁移，oracle 未动）
  tests/integration/{identity-session/login-existing-no-leak,
    persistence-config/guest-creative-sync,
    persistence-config/guest-multisubject-lifecycle,
    persistence-config/history-stop-migrate}.integration.test.ts（contract 跟随）
  docs/e2e/07-故事库与作品资产/{15,18（RED）,19}.md / tests/test-catalog.yaml / README.md
case/executable ids:
  case collection-library-ui（exec-l3-collection-library + exec-collection-library-viewmodel）
  case library-mini-safe-area（exec-l3-collection-library）
  case prompt-history-contract（exec-prompt-history-contract）
  case library-lifecycle-journey（exec-l3-library-lifecycle-journey，集合级重写）
实际命令与 exit code: 见 .e2e-results/2026-09-15-story-collection-continuous-creation/T4/post/（*.green.log 均带 # tree 头与 EXIT=）
  RED: T4/red/prompt-history-contract.red.log（L2，EXIT=1）/
       T4/red/library-collection.red.log（L3，4 failed，EXIT=1）
  首轮 L3 全量 71 passed/9 failed（4 真问题 + 单轨卡片门 + 3 webkit flake + 1 webkit 舍入；红跑留档）
  隔离重跑: targeted 12 passed（journey/单轨双浏览器转绿）/
            webkit test1 隔离转绿 / webkit trio 3 passed
完成门（tree 125a08e, dirty=0）: catalog EXIT=0；unit 71/71；integration 60/60；
  tooling 10/10；tsc EXIT=0；lint EXIT=0；prisma validate valid；build EXIT=0；
  yarn test:browser 80 passed EXIT=0（4.7m，一轮全绿）
迁移计数证据: T4/post/contract-deploy.green.log —— 隔离库 migrate deploy 全链通过，
  28 表；PromptHistory 缺席；GuestPromptHistory / StoryWorkMigration /
  GenerationHistory / GuestGenerationHistory / StoryAudioSegment / StoryAudioManifest / StoryCollection 齐在
feature flag: 无新增（T1 rollout 开关未动；T3 双 flag 未动）
回滚方法: 本 T4 不执行生产数据删除；代码回滚即 revert 本段 5 提交（contract 迁移未上生产，无需 DB 回滚）
git status --short: 干净（本段提交后）
git worktree list: 仅主树；git stash list: 空
限制: 详见 T4/post/CLOSEOUT-T4.md §5（L1 无独立 RED；早期无效 RED 已 rm；legacy 清除结论；
  视觉验收由 supervisor 做；生产事项一律未动）
视觉验收（supervisor）: `yarn test:browser` 自带隔离服务（31120-31150 空闲端口 + per-run 库 + mock OpenAI）；
  路由 /library、/library/collections/{id}、/library/{workId}、/chat、/setting
报告: READY（Implementer 自证；最终 APPROVE 由独立 Reviewer 给出，push 由 supervisor 执行）
```

## 8b. Task 4 修复轮 1 交接记录（T4R1，Implementer 自证，待独立 Reviewer）

```text
change-id: 2026-09-15-story-collection-continuous-creation（T4R1）
起点: b25b2f1（dirty=0；worktree 仅主树；stash 空）
目标完整 SHA: 本段收口提交（= 运行全部完成门的树；40 位 SHA 见 T4/post/CLOSEOUT-T4.md §7 与 READY 报告；
  为避免"文档提交晚于门禁树"导致 green 证据树漂移，收口提交后不再追加任何提交）
实际 commit（本地，未 push）:
  14dd334 fix(M9-C1-T4R1): W39 P3B扫描排除gitignore生成物＋自证；W36 404双条件；
          W35单轨两层可达；W38成员可播oracle
  beacffc fix(M9-C1-T4R1): W38可播断言去单轨前缀；W36关窗待重试尾巴落定
  b764ccd fix(M9-C1-T4R1): W41 404期望窗绑定真实触发点（软删后重取）＋诊断收敛为逐行完整输出
          （收口前 squash：bebb87c/5ec1795/7b6c822/c55a6ca/d5df847/19315e4/994c8f6 七个施工期
           诊断提交 → 本提交；W39/W35/W36/W38 内容未被回退）
本轮必收项与证据:
  W39（unit 假红根因）: tests/unit/navigation/m9-player-retirement-closure.unit.test.ts
    审计集改为 walk − `git check-ignore --stdin` 命中子集（排除 gitignore 生成物，非用 ls-files
    白名单以免漏扫未提交手写文件）；新增 M9-04-10b 自证：被排除者须全被 ignore 命中、
    lib/generated/prisma/internal/class.ts 须在被排除集、对排除集复跑 P3B 命中仅允许来自
    lib/generated/（其余即掩盖，fail-closed）。重跑 unit 71/71 EXIT=0。
  W36（404 收回双条件）: journey 恢复默认拒绝——仅刻意探测窗内放行 console 404，
    窗口外一律计入 consoleErrors；末端保留 unexpected404（非 /api/trpc/collection.get）复核。
  W41（journey 残留 1 红）: 根因=详情页软删除的 invalidateCollection 对已删集合重取详情 →
    fail-closed 404，落在原两窗之外的静默区。处置=新增 step9 窗口（删除点击前开启），
    Undo 恢复并入同窗口块（避开 6s 浮条寿命），settle 待重试尾巴落定后关窗。
    选择"绑窗+披露"而非"改产品行为"（窄修）；缺口如实登记。诊断改为仅失败时逐行打印
    窗口与最近 40 条 collection.* 往返（不再对整串 JSON slice）。
  W35（T3 oracle 门迁移）: single-track test-1 种子改真实 conversation.createNew +
    collection.promoteArtifact（与旧 library.create 同构，promote 不触 TTS），新增两层路径
    成员可达观测（collection-link → member-work{data-position=0} → member-play 可见，
    二次导航后 source.workId/audioUrl 不变）；核心同源 oracle 零削减。
  W38（成员播放可播性）: library-collection test-1 增 hasAudioUrl + status≠error + 非空 URL
    可播 oracle（不再只断言 source.workId）；并如实记录本 spec 未开单轨 flag 时
    isCanonicalAssetUrl=false（ephemeral 音源，符合设计）。
  W31（零引用遗留组件）: StoryWorkCard.tsx / LibraryTimeGroup.tsx 产品面零引用但被两套
    已接受 L1 直接依赖（含 fs.existsSync 存在性断言）⇒ 保留并定位为"产品面已退役、仅作 L1
    fixture 存活"；CLOSEOUT §5.3 原"无可删残留"结论已修正。
  W27/W30（披露）: journey 改写对照（含逐条覆盖映射与**消失的 L3 work 详情生命周期覆盖**）
    与 2 处 user 提示词断言移除的覆盖面收窄说明，写入 T4/post/CLOSEOUT-T4.md §8。
  W32（名 green 实红日志）: l3-targeted-r1 / l3-targeted-r1-run2 等改名 *.red.log；
    全部非最终树 green 改 *.pre-final.log；收口机械自检每份 .green.log 的 # tree == 最终树。
  W28（最终树证据）: unit/tooling/build/定向 L3/全量 yarn test:browser 均在最终树 dirty=0 重出。
完成门（最终树, dirty=0）: 见 T4/post/ 最终树 *.green.log（catalog/lint/tsc/unit/integration/
  tooling/prisma validate/build/定向L3/全量 browser），每份带 # tree 头与 EXIT=。
feature flag: 无新增；回滚：revert 本段 3 提交。
限制（不隐瞒）:
  1) W41 已知缺口：详情页软删后多发一次注定 404 的 collection.get（产品面次生瑕疵；本轮不修，
     建议后续在 moveToTrash/deleteForever 后跳过 detail(id) 失效）。
  2) W27 覆盖缺口：/library/{workId} Work 详情的 rename/favorite/trash 端到端 L3 覆盖随
     journey 重写消失（仅剩 L1 library-detail-* + main-navigation-route-journey 标题断言）；
     建议后续补场景或显式标记 L1-only。
  3) L1 无独立 RED（沿用 T3 口径）；W31 遗留组件保留属有意取舍。
  4) 生产事项一律未动：无 push/merge/deploy、无生产数据删除；contract 迁移仅生成+本地验证。
视觉验收（supervisor）: `yarn test:browser` 自带隔离服务（31120-31150 空闲端口 + per-run 库 +
  mock OpenAI）；路由 /library、/library/collections/{id}、/library/{workId}、/chat、/setting
报告: READY（Implementer 自证；最终 APPROVE 由独立 Reviewer 给出，push 由 supervisor 执行）
```

