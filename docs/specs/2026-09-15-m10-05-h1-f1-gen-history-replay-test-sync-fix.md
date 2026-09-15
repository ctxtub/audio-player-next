# M10-05-H1-F1 · 生成历史回放 Anchor 抖动 test 侧同步修复（无诊断）

- 日期：2026-09-15（dated spec，冻结快照；后续不得改写为当前事实）
- change-id：M10-05-H1-F1
- 角色：实现（test-only；不修产品、不改 oracle、不放宽阈值、不新增 retry/skip/wait）
- 工作目录：仓库根（`/Users/tensho/Developments/audio-player-next`）
- 基线 SHA：`edbb526101eba079619c34b1de179205ce627080`（分支 `feat/story-library-upgrade-20260912`，工作树干净）
- 前置：H1 诊断阶段＝ **APPROVE / CLOSED**
  （`docs/specs/2026-09-15-m10-05-h1-gen-history-replay-anchor-diagnosis.md`，冻结证据不改写）
- 正式分类：主＝ `TEST/HARNESS_OBSERVER_EFFECT / SQLITE_LOCK_CONTENTION`；
  次＝ `PRODUCT_RUNTIME_RESILIENCE_GAP / SQLITE_BUSY_HANDLING`（NON-BLOCKING）
- 评审裁决：选 **(2) test 侧同步修复**；**不选 (1) WAL、不选 (3) 产品改动**
- 交付形态：一个原子提交（spec 同步修复 + 诊断代码撤除 + 本结论文档），**不含产品代码**，**不 push**

## 1. 被修同步点

用例：`tests/system/browser/scenarios/story-playback-global-controls-reachable.spec.ts`
「M9-F01 生成历史回放走正式 Work Session 且全局控制同帧可达」。

H1 已证明的机制：`journal_mode=delete` + `PrismaLibSql` 无显式 timeout
（`libsql` 默认 `timeout=0.0`）下，test 进程通过 `sqlite3` CLI **旁路直读**活动 DB
（既有 oracle `safeAnchorKind()` 轮询）与产品
`playback.beginSession → guestPlaybackAnchor.upsert()` 的写提交窗口对撞
→ `SQLITE_BUSY` → Prisma `P1008` → HTTP 500 → Work Anchor 从未落库、停在 draft。

本项只把该次「直读起点」推后到产品写请求 settle 之后：

1. 点击「回放此故事」**之前**，先 `page.waitForResponse(...)` arm 本次 Work 回放
   对应的 `playback.beginSession` 响应等待（promise 先武装，再与 click 组成同一动作）；
2. **等该次 `beginSession` settle 之后**，才开始现有 `safeAnchorKind()` 直读轮询；
3. **不新增任何 response 状态 oracle**：不要求「必须 200」。若产品自身仍 500，
   settle 后 Anchor 仍为 `draft`，现有 `expect.poll(...).toBe("work")` 原样失败。

即：只消除 test 侧观测读与产品写窗口的重叠，不触碰 oracle、断言、超时与产品行为。

## 2. 诊断代码撤除（回到 ACTIVE spec 的净形态）

- 移除 spec 内全部 H1 诊断插入：`createH1Diagnostics` / `H1Diagnostics` import、
  `h1DiagnosticsByPage` WeakMap、`test.afterEach` finalize、`h1.setPrompt(...)`、
  各处 `await h1.mark(...)`、以及结尾 `recorder.step("H1 诊断计数", h1.summary())`。
- 删除 test-only helper：`tests/system/browser/scenarios/helpers/h1-diagnostics.ts`
  （卷面上唯一使用方即为本 spec；删除后无任何 tracked 引用，H1 结论文档中的历史
  引用按「已发布历史文档不改写」保留）。
- 未新增任何产品 runtime probe；未改产品代码；未动 catalog / executable / 分母。

## 3. 明确不做（评审裁定与边界）

- 不启用 WAL，不改 harness DB 并发语义；
- 不改产品运行时代码（`lib/` / `app/` / `components/` / `stores/` 等一律不动），
  不接受「产品侧 busy timeout / 有限重试 / 启动设 WAL」备选；
- 不引入 retry / skip / fixme / timeout 膨胀 / 新增 sleep；
- 不改 Anchor work oracle、不改 catalog lifecycle / executable 绑定 / 分母；
- 不实现 FIX2–FIX4、quiescence / max-id / fingerprint 逻辑。

## 4. 送审 / 推送状态（如实记录）

- H1 诊断 commit `edbb526101eba079619c34b1de179205ce627080` 的结论文档原文写有
  「未 push」；**实际该 commit 已由监督方推送到 `origin/feat/story-library-upgrade-20260912`**
  （远端 ref 已指向 `edbb526`）。按「不为一句话重写既有诊断证据」原则，
  H1 文档原文保留；实际推送状态以本节为准。
- 本 F1 提交：按交付契约**只提交、不 push**；由监督方独立复验后再决定推送。
  本提交 SHA / parent / 变更文件清单与 5 轮 full-suite 证据见 M10-05-H1-F1 交付报告。

## 5. 验收契约（本项口径）

- 静态门（同一最终 SHA，工作树干净）：
  `yarn test:catalog` · `npx tsc --noEmit --incremental false` · `yarn lint` ·
  `yarn test:unit` · `yarn test:integration` · `yarn build` · `git diff --check`。
- targeted 双引擎 `retries=0 --repeat-each=3` 仅记 **smoke**，不作为根因闭合证据。
- 完整 full-suite 固定 5 轮（同 SHA、chromium + webkit、分母 62、`retries=0`）：
  H1 目标（`story-playback-global-controls-reachable` / WebKit / `Anchor work←draft`）
  须 **0/5 复现**；无关 failure 逐条分类，除非同源证据否则不推翻 F1。
- M10-05 最终仍需**连续两轮完整 62/62**，可包含在上述 5 轮内。
- 依 `docs/specs/2026-09-15-m10-browser-debt-closure.md` §6.1/§7「提交先于
  full-browser、两轮跑在完全相同的最终 SHA 上」：本结论文档随修复一并先提交，
  5 轮运行数值由交付报告承载，落盘于 `.e2e-results/`（gitignore）。

## 6. 保留的历史证据与后续

- H1 诊断结论、artifact 路径与哈希、时间线（§4）作为历史证据原样保留，不改写。
- 产品侧韧性缺口（`SQLITE_BUSY` 无重试，分类 `PRODUCT_RUNTIME_RESILIENCE_GAP`）
  维持 **NON-BLOCKING**，不在本项处理。
- 若后续评审另案采纳产品侧 busy timeout / WAL，应独立立项并重新取 5 轮基线复现率。
