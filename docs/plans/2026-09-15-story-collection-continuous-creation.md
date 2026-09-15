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
