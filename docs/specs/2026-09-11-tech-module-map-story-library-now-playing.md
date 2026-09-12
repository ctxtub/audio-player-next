# Audio Player Next 升级 — 技术模块拆分总表

## 1. 拆分原则

本次技术拆分遵循以下原则：

1. **模块有稳定边界**
   每个模块应有明确输入/输出契约，可以独立完成技术评审、Spec/Plan、实现与验证。

2. **以领域职责拆分，而非按文件类型拆分**
   不单独设“前端模块”“后端模块”“数据库模块”，而围绕 Story Library、Playback Session、Now Playing 等完整领域能力组织；一个模块可以同时包含 UI、状态、接口与持久化改动。

3. **数据模型与状态机优先定义契约**
   StoryWork 数据模型、Playback Session 状态模型属于后续多个 UI 模块的基础，不允许各页面自行推导 title、progress、source identity。

4. **迁移能力与目标能力分离**
   `/player` 兼容、旧 GenerationHistory 数据迁移、旧播放状态恢复等不能散落在 UI 实现中；由指定模块负责兼容边界。

5. **播放 UI 与播放内核解耦**
   Mini Player、Expanded Now Playing 只消费统一 Playback Session / Controller 契约，不直接重新实现播放生命周期。

6. **音频资产化独立成模块**
   Canonical Audio / Audio Manifest 对存储、TTS、播放状态、成本影响较大，不与 Expanded Player UI 强绑定，允许 Expanded 先基于现有 paragraph playback 上线。

7. **测试作为横切模块统一治理**
   各业务模块负责自己的测试实现，但 E2E 场景、test catalog、迁移回归矩阵和 Phase gate 统一由测试治理模块负责，避免测试标准分散。

---

# 2. 总体依赖关系

```text
P1
┌─────────────────────────────┐
│ M1 信息架构与路由迁移       │
└──────────────┬──────────────┘
               │
       ┌───────▼────────┐
       │ M2 StoryWork   │
       │ 数据模型与 API │
       └───────┬────────┘
               │
       ┌───────▼─────────┐
       │ M3 故事库 UI     │
       └──────────────────┘

       ┌──────────────────┐
       │ M4 创作页整合     │
       └──────────────────┘

P2
       ┌──────────────────────┐
       │ M5 Playback Session  │
       │ 与 Identity 状态模型 │
       └──────────┬───────────┘
                  │
          ┌───────▼──────────┐
          │ M6 Mini Now      │
          │ Playing          │
          └──────────────────┘

P3
       ┌──────────────────────┐
       │ M7 Expanded Now     │
       │ Playing            │
       └──────────┬───────────┘
                  │
       ┌──────────▼───────────┐
       │ M8 Canonical Audio  │
       │ 与 Audio Manifest   │
       └──────────┬───────────┘
                  │
       ┌──────────▼───────────┐
       │ M9 /player 退役与   │
       │ 最终兼容收口         │
       └──────────────────────┘

横切：
M10 测试契约、迁移回归与 Phase Gate
```

M4 与 M2 有数据契约依赖，但可以和 M3 部分并行。

M8 不阻塞 M7 第一版；M7 可先使用当前 paragraph-level playback，上线后再接入 M8 的作品级音频能力。

---

# 3. Phase 1 — 建立「故事库」业务空间

| 顺序     | 模块                                    | 产品方案范围                                       | 技术范围                                                                                                                                                                            | 前置依赖                                  |
| ------ | ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **M1** | **信息架构与路由迁移**                         | §2 信息架构；Phase 1「播放器 Tab → 故事库」               | `components/MainTabBar`；新增 `/library`、`/library/[id]`；`/chat`、`/setting` 保持；定义 `/player` compatibility route；导航选中态、旧链接兼容；路由相关 E2E                                               | 无                                     |
| **M2** | **StoryWork 数据模型与 Library API**       | §12–19 作品对象、Title Identity、生命周期；Phase 1 数据底座 | Prisma `GenerationHistory` 演进；`lib/server/generationHistory.ts`；generation-history tRPC router/schema；title、pagination、favorite/delete/lifecycle 等 DTO；旧数据兼容与迁移；移除 50/100 条日志语义 | M1 只需确定 `/library` identity；模型实现基本可并行 |
| **M3** | **故事库列表与作品详情**                        | §4–6 故事库、Story Card、Detail；Phase 1 主 UI      | `/library`、`/library/[id]`；列表查询、时间分组、搜索/轻筛选；Story Card；详情页；播放/继续播放/再次播放入口；删除/收藏入口；与 playback service 的调用边界；Library 页面 E2E                                                       | **M2**                                |
| **M4** | **创作页 Artifact 化与 Prompt History 回迁** | §11 创作页调整；§22 Draft / StoryWork 边界；Phase 1   | `/chat`；现有 Chat Story Card / assistant rendering；`PromptHistoryStore`；`setPendingAutoSend()` 链路；最近创作；`GenerationPreview` / 生成状态迁移；生成完成后 StoryWork identity 建立                   | **M2**；可与 M3 并行                       |

### Phase 1 完成标志

```text
创作 / 故事库 / 设置

GenerationHistory
    ↓
StoryWork / Library

PromptHistory
    ↓
创作页最近创作

/player
    ↓
仅兼容存在，不再是一级入口
```

---

# 4. Phase 2 — 建立 Global Mini Now Playing

| 顺序     | 模块                                     | 产品方案范围                                               | 技术范围                                                                                                                                                                                                          | 前置依赖   |
| ------ | -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **M5** | **Playback Session 与播放 Identity 状态模型** | §13–15、§21–22；Global Now Playing 的状态基础               | `stores/playbackStore.ts`；`playbackProgressStore`；`AudioControllerHost`；`sourceType/sourceId/sessionId/title/isOneShot`；StoryWork 与 Draft identity；resume / rehydrate；删除、重播、完成态语义；统一 Playback DTO / selectors | **M2** |
| **M6** | **Mini Now Playing 与全局 Layout 集成**     | §3、§7、§20；Phase 2「FloatingPlayer → Mini Now Playing」 | 重构 `components/FloatingPlayer`；`app/(main)/layout.tsx`；移动端 TabBar 上方固定 Mini；桌面 Floating/Dock；播放/暂停、title、progress、展开入口；safe-area、keyboard、z-index；`floatingPlayerEnabled` 新语义                                 | **M5** |

### Phase 2 完成标志

```text
/chat
/library
/setting

任意页面
   │
   └── Active Playback
            ↓
       Mini Now Playing
```

此时用户已经不需要进入 `/player` 才能知道“正在播放什么”。

---

# 5. Phase 3 — 完整 Global Now Playing 与音频资产化

| 顺序     | 模块                                         | 产品方案范围                                | 技术范围                                                                                                                                                                                                    | 前置依赖                            |
| ------ | ------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **M7** | **Expanded Now Playing**                   | §8–10；Phase 3「AudioPlayer → Expanded」 | 从 `app/(main)/player/components/AudioPlayer` 抽离能力；NowPlayingLayer；移动 Sheet / Full-height Sheet；桌面 Side Panel；play/pause、当前段 seek、speed、paragraph progress、sleep timer、查看正文、继续创作、从头播放；Mini ↔ Expanded 状态 | **M5、M6**                       |
| **M8** | **Canonical Audio 与 Story Audio Manifest** | §9、§16–18；目标音频模型                      | Prisma 音频资产/manifest 模型；TTS service；story flow；缓存与重新合成策略；segment asset、duration、contentHash、voice/model version；对象存储接口；audioStatus；旧作品 lazy migration；作品级 timeline / seek 的数据基础                         | **M2、M5**；不阻塞 M7 基础版            |
| **M9** | **旧 Player 退役与兼容收口**                       | §24 Phase 3 收尾；完整 IA 迁移               | `/player → /library` redirect；移除旧 Player page ownership；`PlaybackStatusBoard`、`GenerationPreview`、`HistoryPanel`、旧 `AudioPlayer` 清理或迁移；旧 deep link / restored state / bookmark 兼容；废弃字段和死代码清理            | **M3、M4、M6、M7**；全篇 seek 部分依赖 M8 |

### Phase 3 完成标志

```text
/player
   ↓
退出正式产品结构

播放 UI：
Mini Now Playing
      ↕
Expanded Now Playing

播放数据：
StoryWork
   ↓
Canonical Audio / Manifest
```

---

# 6. 横切模块

| 模块                            | Phase          | 覆盖范围                      | 技术范围                                                                                                                                                                                                      | 前置依赖                |
| ----------------------------- | -------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **M10 测试契约、迁移回归与 Phase Gate** | **P1 → P3 全程** | 产品方案 §27 工程约束；所有 Phase 验收 | `docs/e2e/**`；`tests/test-catalog.yaml`；unit / integration / browser；路由迁移矩阵；Guest/Login；cross-page playback；rehydration；删除/恢复；keyboard/safe-area；旧 `/player` 兼容；Audio cache fallback；每 Phase release gate | 消费各模块公开契约，不作为业务实现前置 |

M10 不承担业务代码实现。

它负责定义“什么行为必须持续成立”，每个业务模块则负责给这些行为提供测试实现。

---

# 7. 横切关注点归属

避免后续技术方案出现“这个问题到底在哪个模块解决”的情况，建议提前固定主责：

| 横切问题                           | 主责模块                 | 其他模块关系              |
| ------------------------------ | -------------------- | ------------------- |
| Story / Work identity          | **M2**               | M3/M4/M5 消费         |
| Story title identity           | **M2**               | M5/M6/M7 只读取        |
| Library pagination / lifecycle | **M2**               | M3 展示               |
| Prompt History                 | **M4**               | 不进入 M3              |
| Draft ↔ Work 边界                | **M4 + M5**          | M4 负责创作语义，M5 负责播放语义 |
| Playback Session 状态机           | **M5**               | M6/M7 不自行维护播放状态     |
| Resume / rehydrate             | **M5**               | M3/M6/M7 消费         |
| `isOneShot`                    | **M5**               | UI 不暴露              |
| Mini Player responsive 行为      | **M6**               | M7 不负责              |
| `floatingPlayerEnabled` 迁移     | **M6**               | 设置页仅提供入口            |
| Expanded UI                    | **M7**               | 不负责持久化音频            |
| Sleep Timer UI / 播放策略          | **M7**               | 底层 timer 能力可由 M5 提供 |
| Canonical Audio                | **M8**               | M7 通过统一播放接口消费       |
| Story-level timeline           | **M8**               | M7 负责展示             |
| `/player` 兼容生命周期               | **M1 定义、M9 收口**      | 中间 Phase 禁止其他模块自行删除 |
| 数据库历史数据迁移                      | **M2 / M8 各自负责所属数据** | M10 验证              |
| E2E/Test Catalog               | **M10**              | 所有模块必须接入            |

---

# 8. 建议实际实施顺序

推荐主链：

```text
M1
↓
M2
├──→ M3
└──→ M4

M2
↓
M5
↓
M6
↓
M7

M2 + M5
↓
M8

M3 + M4 + M6 + M7
↓
M9
```

`M10` 从 M1 开始同步存在，并贯穿每一个模块。

如果考虑并行开发，可以形成三条工作流：

```text
数据 / Domain：
M2 → M5 → M8

产品 UI：
M1 → M3 / M4 → M6 → M7

迁移与质量：
M10 ─────────────────→ M9
```

---

# 9. 最终模块清单

```text
P1

M1  信息架构与路由迁移
M2  StoryWork 数据模型与 Library API
M3  故事库列表与作品详情
M4  创作页 Artifact 化与 Prompt History 回迁

P2

M5  Playback Session 与播放 Identity 状态模型
M6  Mini Now Playing 与全局 Layout 集成

P3

M7  Expanded Now Playing
M8  Canonical Audio 与 Story Audio Manifest
M9  旧 Player 退役与兼容收口

P1 → P3 横切

M10 测试契约、迁移回归与 Phase Gate
```

这套拆分里，我建议后续**优先深入 M2，而不是 M1**：M1 的路由和导航相对确定；真正会决定 M3、M4、M5 甚至 M8 上层契约的是 **StoryWork 数据模型与 Library API**。不过实施顺序仍然保持 M1 → M2，因为 M1 可以非常薄地先把目标 IA 和兼容边界固定下来。

我认为这个粒度比较适合逐模块讨论：其中 **M2、M5、M8** 是三个最需要认真设计的技术核心，分别对应「内容资产模型」「播放状态机」「音频资产模型」；其余模块主要围绕这三份契约展开。
