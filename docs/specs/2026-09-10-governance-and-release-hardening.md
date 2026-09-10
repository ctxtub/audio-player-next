# 技术规范：治理与发布硬化（Governance and Release Hardening）

> **文档状态**：`PROPOSAL`（待评审，未实施）
> **创建日期**：`2026-09-10`
> **change-id**：`governance-hardening-20260910`
> **角色/运行时**：`Planner/local`
> **工作目录**：`<repo-root>`
> **分支/基线**：`chore/test-architecture-rebuild @ d7b5c5c18b796c535787f06cc7f185c098c89c5b`
> **授权路径**：`docs/specs/2026-09-10-governance-and-release-hardening.md`；`docs/plans/2026-09-10-governance-and-release-hardening.md`
> **证据位置**：`.agent-runs/governance-hardening-20260910/planner`（本地私有，不入库）
> **产品行为**：不变。本规范只改治理、门禁、证据与发布链路，不改任何用户可见行为、API 契约、鉴权语义与状态机。

---

## 0. 摘要与非目标

### 0.1 为什么做

基线（`d7b5c5c`）已建立 L1/L2/L3/Tooling/Static 分层与 catalog 双向追踪，但发布与治理链路存在 8 类可绕过/可误证风险：普通分支可产镜像、双发布者竞态、`latest` 自动浮动、同 SHA 门禁不完整、候选必测缺口不阻断、L3 脏树快照失真、Node/浏览器证据不可 join、普通失败 fail-fast 掩盖全貌、执行文档仍含前 harness 时代 DSH 政策、本地 skill 职责与仓库文档重叠。

本规范用恰好 8 个工作流（workstream）一次性收口上述风险。实施后：普通分支只做检查不产镜像；只有 tag 与显式 dispatch 可产不可变镜像；`latest` 仅显式晋升；单一串行发布者；同 SHA 下 quality + tier + browser 全绿才可发布；CANDIDATE/RELEASE 的 P0/P1 缺口默认阻断；L3 脏树/ SHA 漂移拒绝快照；Node/浏览器共用版本化证据 schema；普通 runner 失败聚合汇报；执行文档与 harness 一致且仓库内无 DSH 政策；本地 skill 瘦身到 Hermes/DSH/恢复/生产本地事实。

### 0.2 非目标（明确不做）

1. 不改任何产品代码行为、路由、鉴权、播放、同步语义；`docs/e2e/**` 语义权威不动。
2. 不填任何产品测试缺口：29 个 PLANNED/BLOCKED 缺口保持原状，只加阻断门，不新增产品 executable（见 WS3）。
3. 不做远端写入：不 push、不 merge、不 deploy、不触发 Actions、不改分支保护、不改 GHCR 状态；workflow 入库不等于远端 required checks 已启用。
4. 用户已授权本变更同时做仓库治理与本地 skill 优化（`audio-player-next-release-ops`，见 WS8）。Planner 的路径限制不把 WS8 判为外部/BLOCKED：plan 在 C1–C8 仓库 commits 落盘之后实现 skill、验证 skill，并把 skill 纳入最终 acceptance；skill 文件常驻仓库之外的本地 skill 路径，永不进入 Git commits。
5. 不引入新三方依赖；校验器/门禁只用 Node 内置 + 现有 `jiti` loader 口径。
6. 不重写已发布历史文档；只更新 current-state authority（`docs/testing/**`、`docs/engineering/**`），历史材料进 `docs/archive/**`（如需迁移）。

### 0.3 基线事实（复现口径）

| 资产 | 基线观测（`d7b5c5c`） | 复现 |
|---|---|---|
| catalog | 原子 case 62（`ACTIVE 30 / PLANNED 29 / BLOCKED 2 / MANUAL 1`）；`ci_tier`: `CANDIDATE 28 / NIGHTLY 6 / NONE 28`；优先级 `P0 17 / P1 26 / P2 18 / P3 1` | `grep -c ci_tier tests/test-catalog.yaml`；`yarn test:static` |
| workflows | `candidate-quality.yml`（124 行）、`docker-push.yml`（154 行）、`browser.yml`（95 行）、`nightly-browser.yml`（117 行） | 直接读文件 |
| 发布脚本 | `scripts/push-ghcr.sh`（133 行）：恒发 `latest` + `sha-<short>` + 主 tag | 读文件第 75–84 行 |
| runner | `scripts/run-tests.mjs`（576 行）：首个普通 FAIL 即 `process.exit(1)` | 读文件第 505–509、564–569 行 |
| checker | `scripts/check-test-catalog.mjs`（681 行）：报缺口但不按 tier/优先级阻断 | 读文件第 528–546 行 |
| L3 harness | `tests/system/browser/harness/app-server.mjs`（377 行）：`git archive HEAD` 前无脏树/`EXPECTED_TARGET_SHA` 检查 | 读文件第 125–162 行 |
| Node 证据 | `run-tests.mjs:writeResultsLine` 行格式 `{run_id, suite_id, group, verdict, exit_code, duration_ms, evidence_path}` | 读文件第 425–442 行 |
| 浏览器证据 | `harness/jsonl-reporter.ts` 行格式 `{run_id, case_id, verdict, duration_ms, evidence_path}`；`harness/evidence-recorder.mjs` manifest 含 `case_id/spec_path/run_id/commit/browser/verdict/assertions/hashes` | 读两文件 |
| 执行文档 | `isolation.md` §§3.2/9 含 DSH Worker、`9301`/`mock.pid`/`31111`/`10800s`/`503-429` 政策；`maintenance.md` 仍用 `E2E-XX-YY` 编号、`59/62` 手工计数、`01→06` 串行调度 | 直接读文件 |
| 协作文档 | `agent-collaboration.md:3` 已声明 “Hermes/DSH 调用、恢复和监督技巧放在本地 skill，不在仓库复制” | 读文件 |

---

## WS1. 普通分支 checks-only，不产镜像

### 现状证据

- `candidate-quality.yml:5-14`：`push` 触发含 `main`、`candidate/**`、`release/**`、`chore/**`、`feat/**`、`fix/**`，另有 `pull_request` 与 `workflow_dispatch`。
- `candidate-quality.yml:92-124`：`image` job 以 `needs: quality`、`if: github.event_name != 'pull_request'` 运行，在**普通分支 push**（如 `chore/**`、`feat/**`、`fix/**`）同样构建并执行 `./scripts/push-ghcr.sh "latest"`，附 `packages: write` 权限。
- 结论：普通分支 push 即产镜像（至少打 `latest` + `sha-<short>`），与“普通分支只做检查”相悖；且镜像触发面过宽，增大误发与竞态窗口。

### 决策

1. 普通分支（含 `main` 除外的一切非 tag push、一切 `pull_request`）一律 **checks-only**：只运行 quality（structural static：static/lint/typecheck/L1/L2/contract-过渡/build + tooling path-filter）+ P0 browser 硬门引用，不运行任何含 `packages: write` / `docker buildx build --push` 的 job/step。普通检查**不跑** WS3 完整性 tier 门（见 WS3：Dev/PR 只跑 structural static）。
2. `candidate-quality.yml` 的 `image` job 删除（发布权唯一收归 WS2 的单一发布者，避免双发布者并存过渡态）。
3. 普通分支 workflow 保留 `pull_request` 触发 + 有限 `push` 触发（仅为给分支内 quality 信号），但**无镜像 job**；`workflow_dispatch` 不再是普通检查入口的默认发布手段（见 WS2 显式发布）。
4. 权限：checks-only workflow 顶层 `permissions: {}`，job 仅 `contents: read`；不得出现 `packages: write`。

### 验收标准

- [ ] 在 `chore/**`、`feat/**`、`fix/**` 的 push 与任何 `pull_request` 事件下，工作流图中不存在可达的镜像发布 job（静态断言：无 `packages: write`、无 `push-ghcr.sh`、无 `docker buildx build --push`）。
- [ ] `candidate-quality.yml`（或其后继普通检查 workflow）保留 static/lint/typecheck/L1/L2/contract-过渡/build + tooling path-filter + P0 browser 硬门引用；普通检查不断言 WS3 完整性门（Tooling 正例：普通检查 workflow 内无 tier 完整性 gate step/job）。
- [ ] 现有 Tooling 测试按 TDD 更新，先 RED（断言“普通分支无发布”失败）后 GREEN。

---

## WS2. Tag/显式 dispatch 不可变镜像；latest 仅显式晋升；单一串行发布者；同 SHA quality+tier+browser

### 现状证据

- `push-ghcr.sh:75-84`：恒发三类 tag——主 tag + `latest` + `sha-<shortSHA>`（`add_tag "latest"` 无条件）。后果：`v1.2.3` 发布自动浮动 `latest`，无显式晋升概念。
- 双发布者：`candidate-quality.yml:image`（`needs: quality`）与 `docker-push.yml:docker-push`（`needs: quality`）各自可发布；两者无互斥 `concurrency`，同 SHA/异 SHA 可并发 `docker buildx build --push`，`latest` 指向不定。
- 同 SHA 门禁不完整：`docker-push.yml:quality` 只有 static/lint/tsc/L1/L2/contract/build，无 tier 门（WS3）、无 browser 烟雾（P0 Chromium+WebKit `retries=0`）；`candidate-quality.yml:quality` 的 P0 browser 烟雾仅在 `main/candidate/release/dispatch` 条件运行（第 86 行），tag push（`v*`）路径未经 browser 硬门即可进 `image`。
- `docker-push.yml:5-10` 触发：`main` push + `v*` tag + dispatch。`main` push 直发 `latest` 语义与不可变发布相悖。

### 决策

1. 唯一可发布事件：`v*` tag push 与**显式发布 dispatch**（`workflow_dispatch` 带 `source_digest`（或等价 `source_ref`）+ `promote_latest: boolean` 输入，`promote_latest` 缺省 `false`）。`main`/普通分支 push 永不发布。
2. Tag 语义（D1 已决：单一发布者固定收归 `docker-push.yml` 的 `docker-push` job，删除 `candidate-quality.yml:image`；不新建 workflow，不用 `workflow_run` 串接）：
   - release 构建只发不可变 tag：规范化 ref tag（即 `github.ref_name`，如 `v1.2.3`）+ `sha-<shortSHA>`（7 位，与现行一致）+ OCI `revision` label（full SHA）。tag 事件、默认 dispatch、`main` push 一律不发 `latest`；`push-ghcr.sh` 删除无条件 `add_tag "latest"`，且不接受“同构建顺带打 `latest`”的任何开关——`latest` 只能经第 3 条晋升路径产生。
   - 构建必须启用 SBOM + provenance（`--sbom=true --provenance=true`，或经验证的等价替代：替代方案须在 plan 定稿并经 Tooling 断言锁定，默认即启用原生开关）。
3. `latest` 晋升 = 对**已验证不可变 digest 的无重构建 retag**（`docker buildx imagetools create --tag <image>:latest <image>@<digest>` 或等价 registry 侧复制；禁止为晋升重跑 `buildx build`）：
   - 双显式输入缺一不可：`source_digest`（或 `source_ref`，必须精确指向本次已过三门（见第 5 条）的不可变产物 digest/ref）+ `promote_latest == true`。任一缺失/模糊（如“最新 main”“模糊 tag”）即拒绝晋升。
   - 晋升后做 registry digest/OCI 回读：`docker buildx imagetools inspect <image>:latest`（或等价）确认 digest == 源 digest，且 OCI `revision`/`source` label 与源一致；回读失配即 FAIL 并在证据中记录。
4. 单串行写入路径：全仓恰两个写入能力 job（`docker-push.yml:docker-push` 构建推送 + `docker-push.yml:promote-latest` retag 晋升），共享同一 `concurrency: group: image-publisher-global / cancel-in-progress: false`，且 `promote-latest needs docker-push`；禁止第三个 `packages:write`，杜绝并发 `latest`/tag 竞写。
5. 同 SHA 三门 fan-in（同一 workflow 内汇聚，跨 workflow `needs` 不生效故必须同文件，三门同在 `docker-push.yml`）：
   `quality`（static/lint/tsc/L1/L2/contract/build + tooling path-filter + secret 扫描门，见第 6 条）先行（廉价筛）；`tier-gate`（WS3 完整性门，发布路径以 `--select=RELEASE` 运行）与 `browser-smoke`（P0 Chromium + WebKit，`retries=0`，`yarn test:browser:smoke`）可并行；发布者 `docker-push needs: [quality, tier-gate, browser-smoke]`，任一失败即不发布。`timing-observe`（nightly `--repeat-each=3 webkit`）保持纯信息、`continue-on-error` 仅限其 job 且不参与发布门。
6. 发布链路供应链硬化（与 8-WS 结构并存，不新增 WS）：
   - Action 全 pin 到 full SHA：全部 4 个 workflow 的 `uses:` 改为 `<owner>/<repo>@<full-SHA> # <tag> <date> <reason>` 口径（如 `actions/checkout@<sha> # v4 …`），禁止浮动 tag-only 引用；新增 Tooling 断言锁定（无 `uses:.*@v\d+(\s|$)` 残留）。
   - Secret 扫描门：`quality` 首个 step 跑有界 secret 扫描（只查 tracked 文件，见 plan §7），命中即 FAIL 阻断发布链。
   - 脱敏工件上传 + 留存：发布 workflow 仅上传白名单工件（`results.jsonl`、`manifest.json`、汇总日志、P0 烟雾截图、digest 回读记录；pathname-only、无 query、无 body 载荷、无 `.env*`/DB/secret），并设显式 `retention-days: 30`；黑名单（`.env*`、DB、secret）永不上传。
7. `workflow_dispatch` 发布必须绑定显式 SHA（`github.sha` 即 dispatch 所在 commit）并在 job 日志/证据中记录 `sha/promote_latest/source_digest/ref` 四元组；禁止“浮动到最新 main”语义。分支保护 required checks 配置是远端动作，在本变更记 `NOT_RUN` 移交（见 §11），workflow 入库不等于远端已启用。

### 验收标准

- [ ] 非 tag、非显式 dispatch 事件下无可达发布 job（静态断言）。
- [ ] `push-ghcr.sh` 无参/默认行为只含 ref tag + `sha-<short>`，永不含 `latest`；文件内无 `add_tag "latest"` 及等价同构建打 `latest` 路径；tag 输入去重保持。
- [ ] `latest` 只能由显式晋升 step 产生：Tooling 断言晋升 step 含 `imagetools create`（或等价）且其运行条件同时要求 `source_digest`（或 `source_ref`）非空与 `promote_latest == true`；缺任一输入即跳过/拒绝（负例断言覆盖）。
- [ ] 晋升后 registry digest/OCI 回读断言存在（`imagetools inspect` 或等价 + digest/label 比对），回读失配即 FAIL。
- [ ] 全仓恰两个写入能力 job（`docker-push.yml:docker-push` 构建推送 + `docker-push.yml:promote-latest` retag 晋升）+ 共享串行组 `image-publisher-global / cancel-in-progress: false` + 集合锁定断言（禁止第三个 `packages:write`）；全部 `uses:` 为 full-SHA pin（无 tag-only 残留）；SBOM/provenance 启用（或已验证替代）；发布 workflow 有脱敏工件上传 + 显式 `retention-days` + secret 扫描门。
- [ ] 发布 job 的 `needs` 链含 quality + tier + browser（同文件），tag SHA 下任一门失败即不发布（Tooling 负例断言）。
- [ ] `release-pipeline.tooling.test.ts` 与 `candidate-quality-workflow.tooling.test.ts` 按新语义更新并通过。

---

## WS3. Tier 门：CANDIDATE/RELEASE P0/P1 非 ACTIVE 或缺 executable 即阻断；tracked 可过期 waiver 除外；不填产品缺口

### 现状证据

- `check-test-catalog.mjs:528-546`：PLANNED/BLOCKED 缺 executable 仅记 `gaps[]` 并打印，不按 `ci_tier`/`priority` 阻断；ACTIVE 缺 executable 才 `exit 1`。
- 基线缺口 29（`PLANNED 27 无 executable + BLOCKED 2`；另 2 PLANNED 仅部分静态/单元证据仍计缺口）。`CANDIDATE 28` 中含 P0/P1 缺口（如 `guest-cold-start-first-screen` P0 PLANNED 无 executable、`first-story-stream-autoplay` P1 PLANNED 等），当前仍可进候选/发布链。
- 约束：任务明确“do not fill product test gaps”——不得为过门而新增产品 executable 或把 PLANNED/BLOCKED 伪装为 ACTIVE/PASS。

### 决策

1. 门的运行位置（完整性门只在发布路径跑）：
   - 普通开发/PR 检查（`pull_request`、普通分支 push，见 WS1）**只跑 structural static**（现行 `check-test-catalog.mjs` 口径：ACTIVE 缺 executable 即 `exit 1`，其余缺口只报告不阻断），**不跑本完整性门**。
   - 完整性门只跑在候选/发布路径：`docker-push.yml` 的 `tier-gate` job 取 `tier_select` 输入（`CANDIDATE|RELEASE`）；`v*` tag push 固定 `RELEASE`，`workflow_dispatch` 以 `tier_select` 输入显式指定（缺省 `RELEASE`）。普通检查 workflow 不设 `tier-gate` job。
   - 新增完整性门 `scripts/check-tier-gate.mjs`（`yarn test:tier` 或并入 `test:static` 调用链，但**普通检查调用链不得默认启用完整性语义**；CI 只在发布路径的 `tier-gate` job 运行，失败即阻断发布链）。
2. 选择语义（D2 已决：waiver 文件固定为 `tests/tier-waivers.yaml`；不设 docs 备选）：
   - `--select=CANDIDATE`：选中 `ci_tier == CANDIDATE` 且 `priority in {P0, P1}` 的 case。
   - `--select=RELEASE`：选中 `ci_tier in {CANDIDATE, NIGHTLY, RELEASE}` 且 `priority in {P0, P1}` 的 case。
   - 选中 case 任一满足以下即阻断（`exit 1` + 逐条原因）：`lifecycle_status != ACTIVE`；`executable_ids` 为空；任一 `executable_id` 在 `executables` 缺失或其 `path` 不落盘（复用 checker 口径）。
   - 空选集即阻断（`exit 1`，原因 `empty-selection`）：防止 tier/优先级改名或 catalog 清空导致门恒绿。
   - `PATH_FILTERED/NONE/P2/P3` 永不参与本门（由各自 tier 调度约束）。
3. 本工作流不新增/不修改任何产品 executable，不改 `lifecycle_status`，不改 `required_assertions`；缺口数字必须保持诚实（checker 缺口数不变或仅因 waiver 显式标记而分流统计）。

### 验收标准

- [ ] 无 waiver 时，基线 catalog 的完整性门在两种选择下均为 RED（`--select=CANDIDATE` 与 `--select=RELEASE` 各列出其 P0/P1 缺口清单），证明门真实生效而非恒绿。
- [ ] 受控 fixture 正负例：全 ACTIVE 通过；PLANNED/BLOCKED/MANUAL/缺 executable/坏 path 均阻断；空选集阻断（`empty-selection`）；合法未过期 waiver 放行并标记；过期/缺字段 waiver 阻断；`--select` 非法值 `exit 2`。
- [ ] 普通检查路径（`pull_request` 事件、普通分支 workflow）无完整性 gate step/job（静态断言）；`check-test-catalog.mjs` 原 structural 语义不变。
- [ ] 产品 executable 零新增（`git diff --stat` 无 `tests/unit/**`、`tests/integration/**`、`tests/system/browser/scenarios/**` 新增）。

---

## WS4. L3 快照前拒绝脏 tracked 树与 EXPECTED_TARGET_SHA 失配

### 现状证据

- `app-server.mjs:ensureSnapshot`（第 125–162 行）：命中缓存（`.snapshot-ready`）即返回；否则 `git archive HEAD` → `tar -x` →  symlink `node_modules` → `prisma generate` → 构建期隔离库 migrate → `next build`。全程无脏树检查、无目标 SHA 绑定。
- `currentShortSha()`（第 74–80 行）：`git rev-parse --short HEAD`，失败回退 `'unknown'`；快照键为短 SHA，碰撞/未知键可误命中缓存。
- 后果：tracked 脏修改被静默忽略（archive 取 HEAD 而非工作区），脏树 PASS 实为对旧 HEAD 的证明；`globalSetup` 跨进程拉起时无“期望 SHA”锚定，调度漂移不可检出。

### 决策

1. 快照前置守卫（`ensureSnapshot` 内、取锁后、archive 前；缓存命中路径同样先验守卫，禁止脏树复用旧快照）：
   - 脏 tracked 树拒绝：`git status --porcelain=v1 --untracked-files=no` 非空即抛 `BLOCKED`（信息含前 N 行脏文件，不打印 secrets）；untracked（`??`）不阻断（archive 天然排除 `.env*/.db/.next/node_modules`）。
   - `EXPECTED_TARGET_SHA` 绑定：若环境变量非空，则 `git rev-parse HEAD`（full）必须与其相等（允许短 SHA 前缀等价匹配，但规范要求 full；失配即抛，信息含 `expected/actual` 短 SHA，不泄露 secrets）。
2. 快照键改 full SHA（目录名兼容 short 或 full，但 manifest 记录 full SHA；`unknown` 禁止构建——直接抛而非回退缓存）。
3. 错误语义：守卫失败归 `BLOCKED`（环境/供给不可证），不得记 FAIL/FLAKY；`globalSetup` 透出后 Playwright 整轮不跑业务断言；Tooling 自测覆盖脏树/失配/干净三种情形（用临时 git 仓 fixture，不碰真工作区）。
4. 并发：保留现有目录锁；守卫在锁内复判（防 TOCTOU：锁外快照命中检查仅为 fast-path，锁内必须重验守卫 + ready marker）。

### 验收标准

- [ ] 脏 tracked 树（`M`/`A`/`D`/`R` 任一）下 `startAppServer`/`ensureSnapshot` 在 archive 前抛 BLOCKED，且未产生/覆盖快照。
- [ ] `EXPECTED_TARGET_SHA` 失配即抛；匹配（含短前缀等价）放行；未设置不阻断。
- [ ] 缓存命中路径同样受守卫约束（脏树即使快照已就绪也拒绝复用）。
- [ ] 现有 `browser-harness.tooling.test.ts` 扩展覆盖且通过；正常干净路径启停/端口释放语义不变（端口仍 `31120-31150`）。

---

## WS5. 版本化证据 schema：case/executable/assertion/surface/verdict/path 的 Node+浏览器统一 join

### 现状证据

- Node：`run-tests.mjs:425-442` 每 suite 一行 `{run_id, suite_id, group, verdict, exit_code, duration_ms, evidence_path}`；无 `case_id/executable_id/assertion_id/surface`，无法 join catalog。
- 浏览器：`jsonl-reporter.ts:147-158` 每用例一行 `{run_id, case_id, verdict, duration_ms, evidence_path}`（`case_id` 为 `titlePath` 归一化标题，非 catalog `case_id`）；`evidence-recorder.mjs:149-178` manifest 有 `case_id/spec_path/commit/browser/assertions/hashes`，但 `assertions` 仅占位 `playwright-expectations`，无 `executable_id/assertion_id/surface` 绑定。
- 后果：跨层无法回答“某 catalog case 的某 assertion 在某 surface 由某 executable 何 verdict 证明、证据在何 path”；历史 PASS 复用无法绑定 code/fixture/env/oracle/runner hash（`evidence.md:3` 已要求指纹绑定但无机读 schema 落点）。

### 决策

1. 新增版本化 schema（建议 `docs/testing/execution/evidence-schema.v1.json` 为 JSON Schema + `scripts/evidence-schema.mjs` 为零依赖校验器，Node/浏览器/CI 共用）：
   - 必填：`schema_version(=1)`、`run_id`、`case_id`（catalog `case_id` kebab-case）、`executable_id`（catalog `executable_id`；浏览器 L3 为 `tests/system/browser/**` 登记项）、`assertion_id`（catalog `required_assertions[].assertion_id`）、`surface`（`ui|audio|network|db|…`，与 catalog assertion `surface` 一致）、`verdict`（`PASS|FAIL|BLOCKED|SKIPPED|FLAKY`）、`evidence_path`（相对仓库根）。
   - 建议：`commit(full SHA)`、`duration_ms`、`browser/project`（L3）、`spec_path`、`hashes{code,fixture,env,oracle,runner}`、`expires_on_reuse` 语义标记。
   - 行协议（D3 已决：每 assertion 一行；不设数组内嵌备选）：Node `results.jsonl` 与浏览器 `results.jsonl` 均升级为**每 assertion 一行**（每行一 claim：`case_id × executable_id × assertion_id × surface × verdict × evidence_path`）；suite/case 级汇总行保留但标记 `kind: summary` 以示区别（或迁入 `manifest.json`，由 schema 版本说明）。
2. Join 规则：`case_id → catalog.cases[].case_id`；`executable_id → catalog.executables[].executable_id` 且必须出现在该 case 的 `executable_ids`（双向一致复用 checker 口径）；`assertion_id → 该 case 的 required_assertions[].assertion_id`；`surface` 必须与 catalog 中该 assertion 的 `surface` 一致（L3 executable 的 `evidence_surfaces` 须覆盖它）。
3. 校验：Node runner 写行前校验（非法即 BOOTSTRAP `exit 3`？或记 BLOCKED？本规范定为**写行非法即 BLOCKED + `exit 3`**，因属供给/契约损坏而非产品断言失败）；浏览器 reporter/recorder 同口径；新增 Tooling 测试做 schema 正负例 + Node/浏览器样例行互验。
4. 兼容：旧字段（`suite_id/group/exit_code`）在 v1 中保留为可选透传，不得删除以免断现有 Tooling 断言；`run_verdict` 永不写回 catalog（维持现有禁令）。

### 验收标准

- [ ] 同一校验器对 Node 行与浏览器行做 join 断言：伪造 `case/executable/assertion` 错配、`surface` 不一致、非法 verdict、缺 `evidence_path` 全部被拒。
- [ ] 真实一次 Node 跑 + 一次浏览器烟雾跑产出的 `results.jsonl` 均通过 v1 校验，且任一 `case_id` 可 join 到 catalog 的 executable 与 assertion。
- [ ] `evidence.md` 更新到 v1（字段表 + 复用绑定规则 + 脱敏规则），旧 manifest 字段映射表齐全。

---

## WS6. 普通 runner 失败聚合；安全/bootstrap/timeout 保持立即停止与退出码类

### 现状证据

- `run-tests.mjs:505-509`（unit/needs_db=false 路径）与 `:564-569`（建库路径）：任一 suite `code !== 0` 即 `cleanupCurrentRun(); process.exit(1)`——首个普通 FAIL 即整组终止，后续隔离 suite 未跑，`results.jsonl` 缺行，全貌缺失。
- 已有正确分类：`verdicts.md:18-24` 定义 `0=PASS / 1=FAIL·FLAKY（继续跑互相隔离 suite 并汇总）/ 2=参数·空集·catalog 非法 / 3=安全·隔离·bootstrap（立即停组）/ 4=timeout·crash`；`test-database-path-safety.mjs:13-18` 定义 `BOOTSTRAP=3 / FAIL=1 / TIMEOUT=4`。Runner 现实与文档语义相悖（FAIL 未汇总）。
- 必须保留的立即停止类：`unit import lib/db` 扫描命中（`exit 3`）、路径越界/migrate 失败/schema probe 缺表/run 目录异常（`exit 3`）、单 suite 超时 180s（`exit 4`，先 `SIGTERM→SIGKILL` 再清该 suite DB）、信号（`SIGINT/SIGTERM` 先杀子再清本 run）。

### 决策

1. 普通失败聚合：`FAIL`（含 suite 进程非零退出且非 3/4）与 `FLAKY`（仅显式 repeat 口径，runner 默认仍记 FAIL，FLAKY 由上层显式观察产生）**继续执行后续互相隔离的 suite**，逐行写 `results.jsonl`，终态按最重 verdict 汇总退出码（任一 FAIL/FLAKY → `exit 1`，全 PASS → `exit 0`）。
2. 保持立即停止：
   - `exit 2`：未知参数、非法 `--group/--suite`、空选集（执行前，不建库不写行）。
   - `exit 3`：安全/隔离/bootstrap（路径越界、symlink 祖先、`lib/db` 扫描命中、migrate/schema-probe 失败、run 目录复用/权限异常、证据 schema 写行非法（WS5））——立即全组停止，已产生行保留，未跑 suite **记 `SKIPPED` 行并注明 `blocked_by`（D4 已决，保证行数可审计；不设备选语义）**。
   - `exit 4`：单 suite 超时/crash——清理该 suite DB（含 wal/shm）+ 写该 suite `BLOCKED` 行 + 立即停止整组（超时可能意味宿主/隔离损坏，继续跑会误证）。
3. 输出：终态汇总表（`total/passed/failed/blocked/skipped/flaky`，与 `verdicts.md` 五态一致）+ 非零退出码 + `results.jsonl` 行数 == 已调度 suite 数（普通聚合路径）。

### 验收标准

- [ ] 受控多 suite fixture：A FAIL + B PASS → B 仍执行、两行齐全、终态 `exit 1`（RED 先行证明现行 fail-fast 不满足）。
- [ ] 安全/timeout 负例仍立即停止：`lib/db` 扫描命中 `exit 3` 且后续 suite 未执行；超时 `exit 4` 且 DB 已清理。
- [ ] `verdicts.md` 与 runner 行为一致（文档或实现按本规范对齐，冲突以本文为准并在 plan 中显式列出文档补丁）。

---

## WS7. 执行/夹具/维护文档对齐 harness；仓库去 DSH 政策；任务/结项 schema + 脱敏 CI 工件

### 现状证据

- `isolation.md`：§3.2 “原子 DSH Worker 托管 Mock 生命周期”（`ss -ltn :9301`、`mock.pid`、`STARTED_MOCK`）、§9 “DSH 调度治理铁律”（单一 E2E Worker、`--timeout 10800`、`503/429` 退避 60s×3、31111 常驻）——均为前 harness 时代政策，与现行 harness（`31120-31150` 随机空闲端口、detached 常驻 mock + `mock-port-<run>.json`、`app-handle-<run>.json` 指针、`globalSetup/Teardown` 跨进程回收、production 快照构建）直接矛盾。
- `fixtures.md`：含 `isolated-db.ts` 真相（`prisma/test-<suite>.db`、`setupIsolatedDb`）与已过时的“canonical loader jiti / `TRPCError` 从 `lib/trpc/init` 取 / `next/headers` mock 范式”等实现细节，后者应归代码注释/Tooling 测试而非执行规范。
- `maintenance.md`：`E2E-XX-YY` 编号禁令自相矛盾（通篇仍用旧编号）、`59 父 / 62 原子` 手工计数、`01→06` 串行套件顺序，均已被 catalog（kebab-case `case_id`、`journey_id` 9 旅程）与 checker 权威取代。
- 缺失：任务交接 manifest schema（`.agent-runs/<change-id>/manifest.yaml` 字段）、`docs/changes/` 结项 schema、CI 可上传工件清单与脱敏规则（当前仅 `evidence.md:4` 符号标识符 + `network.json` pathname-only 的片段规则）。

### 决策

1. `isolation.md` 重写为 harness 真相：删除 §§3.2/9 的 DSH/`9301`/`mock.pid`/`31111`/`10800s`/`503-429` 政策（整段删除，不留“曾用”描述，历史进 archive）；写入 production 快照（`git archive HEAD` + WS4 守卫）、端口范围、指针文件、mock/app 所有权（谁拉起谁回收，`ownedMock`）、隔离库 per-run 独占、DB 只读观测的允许语句、`git status` 自检边界。
2. `fixtures.md` 收敛为 tracked 合成资产索引：保留 `isolated-db/subjects/story-seeds/ui-stubs` 清单与“写库必经 `setupIsolatedDb`”铁律；删除 loader/`TRPCError`/`next/headers` 范式段（移入对应测试文件注释或删除，已有 Tooling 测试覆盖的不重复）。
3. `maintenance.md` 改为 catalog 驱动：编号以 kebab-case `case_id` 为唯一身份（`legacy_aliases` 仅回查）；数量以 `yarn test:static` 为准，文档内禁手工总数；调度以 `lifecycle_status/executable_ids/ci_tier` 为准，`MANUAL` 不进自动队列；链接有效性 + 工作区整洁性保留。
4. 新增（D5 已决：落点固定为 `evidence.md` 作规范正文 + `artifacts-and-retention.md` 作索引，不设二选一；校验器形态固定为专用 Tooling 校验测试，不并入 `check-test-catalog.mjs`）：
   - 任务 manifest schema：`change_id/role/workspace/branch/base_sha/target_sha/authorized_paths/forbidden_actions/required_reads/evidence_dir(run-id 真实路径)/handover(SHA、changed files、命令与退出码、未执行项、PID/端口/DB 所有权、恢复锚点)`。
   - 结项 schema：`docs/changes/YYYY-MM-DD-<topic>.md` 必填（状态/基准 SHA/结果/入口/已知非阻断项/结论边界：技术 APPROVE ≠ 发布授权）。
   - CI 工件白名单 + 脱敏：允许上传 `results.jsonl`、`manifest.json`、汇总日志、P0 烟雾截图（pathname-only、无 query、无 body 载荷、无 `.env*`/DB/secret）；`prisma/dev.db`、`/app/data/app.db`、`.e2e-runtime/.env.e2e` 永不上传；日志上传前跑脱敏检查（`file:` URL、`DATABASE_URL=` 值已由 runner `sanitizeError` 处理，CI 侧复核）。
5. DSH 政策去仓：仓库内不得出现 DSH Worker 调度、超时、退避、PID 文件约定；仅保留一句指向本地 skill 的路由（`agent-collaboration.md` 现有表述保留并强化，见 WS8）。

### 验收标准

- [ ] `grep -ri "DSH\|STARTED_MOCK\|mock.pid\|9301\|10800\|503/429" docs/testing/ docs/engineering/` 零命中（除本规范自身的变更说明与 archive 索引及 `docs/engineering/agent-collaboration.md` 的 WS8 路由句精确行例外）。
- [ ] 执行文档中端口/路径/所有权描述与 harness 代码一致（抽查：`31120-31150`、`active.json`、`app-handle-<run>.json`、`ownedMock`）。
- [ ] 任务 manifest + 结项 schema 样例通过专用 Tooling 校验测试（D5 落点，不并入 checker）。
- [ ] CI 工件清单含明确黑名单（`.env*`、DB、secret）与脱敏规则引用。

---

## WS8. 本地项目运维 skill 瘦身：仅 Hermes/DSH/恢复/生产本地事实；长任务监督显式路由

### 现状证据

- `agent-collaboration.md:3` 已定原则：“Hermes/DSH 的调用、恢复和监督技巧放在本地 skill，不在仓库复制。”但仓库 `isolation.md` 仍复制了 DSH 调度细节（见 WS7），形成双源头；且本地 skill 侧无瘦身目标定义，长任务监督（long-task-supervision）无显式路由。
- 授权：用户已授权本变更同时做仓库治理与本地 skill 优化；Planner 的路径限制不把 WS8 判为外部/BLOCKED。WS8 在 C1–C8 仓库 commits 落盘之后执行 skill 优化、验证 skill，并纳入最终 acceptance；skill 文件永不进入 Git commits（见 §9.2 工作区条目）。

### 决策

1. 仓库侧（C8）：`agent-collaboration.md` 强化路由句——明确三条路由：Hermes 调用/恢复 → 本地 Hermes skill；DSH 调用/恢复/监督 → 本地 DSH skill；长任务监督（超时、中断恢复、重叠写者防范）→ `long-task-supervision` skill（显式点名）。仓库内禁 DSH/Hermes 操作细节（与 WS7 的去仓 grep 门共同保证）。
2. Skill 侧（C8 落盘之后、本变更内执行并验证）：
   - 仅保留四类事实：Hermes 调用/恢复、DSH 调用/恢复、进程·端口·DB 恢复（自有 PID/端口/`active.json`/`app-handle` 所有权、禁止 broad kill/rm）、生产本地事实（生产端口 `38080`、生产库 `/app/data/app.db`、共享开发库 `prisma/dev.db` 碰不得；隔离端口/库以 `docs/testing/execution/isolation.md` 为准，skill 内不复述数值只引用）。
   - 删除一切与 `docs/testing/**` 重复的调度、证据、verdict、发布语义；skill 内对仓库规范只给指针链接，不抄正文。
   - `long-task-supervision` 为独立路由目标，不得合并进通用运维 skill。
3. Skill 实施边界：只改本地 skill 路径文件；前后 `git status --porcelain` 必须干净（skill 路径在仓库外，无任何仓库 diff）；验证结论记入本变更最终 acceptance，skill 优化失败即本变更 acceptance 记 `CONCERN`（非外部 `BLOCKED`）。

### 验收标准

- [ ] `agent-collaboration.md` 含 Hermes / DSH / `long-task-supervision` 三条显式路由。
- [ ] 仓库 `docs/**`（除本规范与 archive）无 DSH/Hermes 操作步骤（与 WS7 grep 门复用）。
- [ ] skill 本体已按 §WS8.2 落改：人工复核确认四类事实齐全、无仓库规范正文复制、`long-task-supervision` 独立路由；复核结论（PASS/CONCERN）记入本变更最终 acceptance。
- [ ] skill 实施前后 `git status --porcelain` 均干净：skill 改动零进入 Git commits（`git diff --stat` 无仓库 diff 残留）。

---

## 9. 横切需求

### 9.1 测试策略（TDD 刚性顺序）

每个 WS 按“RED（Tooling/静态断言先失败）→ GREEN（最小实现）→ 文档对齐 → 独立 review”垂直切片；禁止先实现后补测试。Tooling 测试落在 `tests/tooling/**` 并登记进 `scripts/run-tests.mjs` 注册表（`needs_db=false` 叶子，遵守元测试非递归规则）；workflow 断言沿用现有 `candidate-quality-workflow` / `release-pipeline` 模式（子串/正则 + mock docker fixture）。

### 9.2 安全与隔离（每 WS 必查）

- Secret：禁读/禁记 `.env*`、token、cookie、连接串；日志经 `sanitizeError` 口径；CI 工件执行脱敏复核。
- DB：禁碰 `38080`、`/app/data/app.db`、`prisma/dev.db`；前后只读记录 `prisma/dev.db` 的存在/mtime/size/SHA（如存在），必须相同且绝不为验证而创建它。
- 进程/端口：前后用跨平台 Node 内置 TCP 短超时探针自查（口径见 plan §7；不用 `ss`/`lsof` 等平台相关命令），自有 `31120-31150`/mock 随机端口必须释放；禁 broad kill/rm；L3 跑前 `git status` 干净检查（WS4 守卫除外，其本身即为该检查的产品化）。
- 工作区：`git status --porcelain` 前后对比；不得暂存/提交 `.e2e-runtime/`、`.e2e-results/`、`.agent-runs/`、`test-results/`、`playwright-report/`；只显式暂存授权文件，禁 `git add -A`。

### 9.3 兼容与回滚

- 所有 workflow/script 变更保持本地可复算（mock docker、临时 git 仓 fixture）；CI 语义变更先由 Tooling 测试锁定，再改 workflow。
- 回滚点：每 WS 独立 commit（见 plan），任一 WS 可单独 revert；发布链路变更 revert 即恢复基线双发布者语义（需在 revert 说明中显式声明过渡风险）。

### 9.4 术语表

- 普通分支：非 `v*` tag 的一切分支 push（含 `chore/feat/fix/candidate/release/main` 的日常 push）与 `pull_request`。
- 显式发布：`v*` tag push 或带 `promote_latest` 输入的 `workflow_dispatch`。
- Tier：catalog `ci_tier`（`CANDIDATE/NIGHTLY/RELEASE/PATH_FILTERED/NONE`）。
- 脏 tracked 树：`git status --porcelain=v1 --untracked-files=no` 非空。
- 证据 join：`results.jsonl` 行经 `case_id/executable_id/assertion_id/surface` 与 catalog 双向引用对齐。

---

## 10. 已裁决决策（D1–D5，plan-fixup-01 定稿；实现直接执行，不设决策门）

1. **D1**：单一发布者固定收归 `docker-push.yml` 的 `docker-push` job，并删除 `candidate-quality.yml:image`。不新建 `release-publish.yml`，不用 `workflow_run` 串接。
2. **D2**：tier waiver 文件固定为 `tests/tier-waivers.yaml`。不设 docs 备选。
3. **D3**：证据 v1 粒度固定为每 assertion 一行。不设数组内嵌备选。
4. **D4**：`exit 3` 路径的未跑 suite 固定记 `SKIPPED` 行并注明 `blocked_by`。不设备选语义。
5. **D5**：任务 manifest/结项 schema 的校验器形态固定为专用 Tooling 校验测试（落点见 WS7.4）。不并入 `check-test-catalog.mjs`。

---

## 11. 验收总门（技术 APPROVE 条件，非发布授权）

- [ ] 8 个 WS 的验收标准全部满足，且 Tooling RED→GREEN 证据链完整。
- [ ] 完成门全绿：`yarn test:static / lint / tsc --noEmit --incremental false / test:unit / test:integration / test:tooling / build / git diff --check`，浏览器可观察行为加跑 `yarn test:browser:smoke`（Chromium + WebKit，`retries=0`）。
- [ ] Secret/`dev.db`/进程/端口四项检查前后一致（见 plan §7）。
- [ ] 独立 review（不同会话）复核 diff、亲复命令与安全终态；实现者未自批；验收者未顺手修实现。
- [ ] 本规范 §10 的 D1–D5 按已裁决项执行（实现不再等裁决，不设决策门）。
- [ ] 最终 acceptance 含 WS8 skill 优化结论（四类事实 + 去重 + 独立路由 + `git status` 干净）；skill 失败即 acceptance 记 `CONCERN`。
- [ ] 分支保护 required checks 配置记 `NOT_RUN` 移交（远端动作，本变更不做）。
