# 实施计划：治理与发布硬化（Governance and Release Hardening）

> **文档状态**：`PROPOSAL`（待评审，未实施）
> **创建日期**：`2026-09-10`
> **对应规范**：`docs/specs/2026-09-10-governance-and-release-hardening.md`
> **change-id**：`governance-hardening-20260910`
> **角色/运行时**：`Planner/local`
> **工作目录**：`<repo-root>`
> **分支/基线**：`chore/test-architecture-rebuild @ d7b5c5c18b796c535787f06cc7f185c098c89c5b`
> **授权路径**：仅本文件 + 对应 spec；实现阶段授权由后续任务书签发，本计划不预授实现写权限
> **证据位置**：`.agent-runs/governance-hardening-20260910/planner`（本地私有，不入库）
> **远端动作**：无。本计划禁止 push/merge/deploy/Actions dispatch/分支保护修改；验证全部本地完成 + workflow 静态断言。

---

## 0. 执行原则（全计划刚性约束）

1. **垂直 TDD**：每 WS 按 `RED（新增 Tooling/静态断言先跑红）→ GREEN（最小实现）→ 文档对齐 → 自查门 → 独立 review → fixup（如需）` 切片；禁止跨 WS 混 commit。
2. **单写者**：同一工作区同一时刻仅一个写 Agent；review/fixup/acceptance 必须不同会话；实现者不得自批，验收者不得顺手修实现。
3. **一 commit 一工程目标**（Conventional Commits）：`§4` 的 C1–C8 即 commit 边界；每个 commit 内含“测试 + 实现 + 文档”完整垂直增量；禁 `git add -A`，只显式暂存授权文件。
4. **产品行为不变**：任何 commit 不得改 `app/**`、`lib/**`、`components/**`、`stores/**`、`middleware.ts` 产品语义；`docs/e2e/**` 不动；产品 executable 零新增（WS3 铁律）。
5. **全程四项检查**：每个 WS 开始前与结束后执行 `§7` 的 secret / `dev.db` / 进程 / 端口检查并记入 handover。
6. **本地验证优先**：workflow 发布语义用 Tooling 静态断言 + mock docker/临时 git 仓 fixture 证明；绝不为验证而真发镜像、真触 Actions。

---

## 1. 基线与前置（P0）

### 输入

- 基线 SHA `d7b5c5c18b796c535787f06cc7f185c098c89c5b`；`git status --porcelain` 为空（规划时已确认）。
- 必读：`AGENTS.md`、`docs/engineering/*.md`、`docs/testing/README.md`、`docs/testing/execution/{isolation,fixtures,evidence,verdicts,maintenance}.md`、4 个 workflow、`app-server.mjs`、`check-test-catalog.mjs`、`run-tests.mjs`、`push-ghcr.sh`。

### 前置命令（只读，不改工作区）

```bash
git rev-parse HEAD && git status --porcelain
yarn test:static
node scripts/run-tests.mjs --list | sed -n '1,20p'
ls -la prisma/dev.db 2>&1 || echo "dev.db absent (expected: do NOT create)"
node -e "const net=require('net');const ps=[38080,31111,31120,31121,9301];(async()=>{for(const p of ps){await new Promise((r)=>{const s=net.connect(p,'127.0.0.1');s.setTimeout(300);s.on('connect',()=>{console.log('PORT-OPEN '+p);s.end();r()});s.on('timeout',()=>{s.destroy();r()});s.on('error',()=>r())})}})().then(()=>console.log('port probe done'))"
```

### 产出

- 本 spec + 本 plan 两文件入库（即当前 Planner 任务的全部交付；实现未开始）。
- spec §10 的 D1–D5 已在本 fixup 中裁决完毕（见 spec §10），实现直接按裁决执行，不设决策门、不追认。

---

## 2. 工作流一览（恰好 8 个，无增删）

| WS | 目标 | 主碰文件（实现阶段） | 验证主命令 |
|---|---|---|---|
| WS1 | 普通分支 checks-only，无镜像 | `.github/workflows/candidate-quality.yml`、`tests/tooling/ci/candidate-quality-workflow.tooling.test.ts` | `yarn test:tooling`（目标 suite） |
| WS2 | tag/显式 dispatch 不可变镜像；latest 仅显式晋升；单一串行发布者；同 SHA quality+tier+browser | `.github/workflows/docker-push.yml`、（删）`candidate-quality.yml:image`、`scripts/push-ghcr.sh`、两 Tooling 测试 | `yarn test:tooling` + mock docker 干跑 |
| WS3 | 完整性 tier 门（仅候选/发布路径；`--select=CANDIDATE` 选中 CANDIDATE、`--select=RELEASE` 选中 CANDIDATE+NIGHTLY+RELEASE；P0/P1；非 ACTIVE/缺 executable/空选集阻断）；tracked 可过期 waiver（`tests/tier-waivers.yaml`，D2 已决）；不填缺口 | `scripts/check-tier-gate.mjs`（新）、`tests/tier-waivers.yaml`（新）、`tests/tooling/**/tier-gate*`（新）、`docker-push.yml` 接线（`tier-gate` job）、`package.json` | `yarn test:static`、`yarn test:tooling` |
| WS4 | L3 脏树/`EXPECTED_TARGET_SHA` 守卫 | `tests/system/browser/harness/app-server.mjs`、`tests/tooling/browser/browser-harness.tooling.test.ts` | `yarn test:tooling`（目标 suite，需快照构建，串行） |
| WS5 | 版本化证据 schema（Node+浏览器 join） | `docs/testing/execution/evidence-schema.v1.json`（新）、`scripts/evidence-schema.mjs`（新）、`scripts/run-tests.mjs`、`harness/jsonl-reporter.ts`、`harness/evidence-recorder.mjs`、`harness/fixtures.ts`、`docs/testing/execution/evidence.md`、Tooling 测试 | `yarn test:tooling` + 真实跑样例行校验 |
| WS6 | 普通失败聚合；安全/bootstrap/timeout 保持 | `scripts/run-tests.mjs`、`tests/tooling/runner/runner-group-split.tooling.test.ts`、`docs/testing/execution/verdicts.md` | `yarn test:tooling` + 受控多 suite fixture |
| WS7 | 执行/夹具/维护文档对齐 harness；去 DSH；任务/结项 schema；脱敏 CI 工件 | `docs/testing/execution/{isolation,fixtures,evidence,verdicts,maintenance}.md`、`docs/engineering/artifacts-and-retention.md`（索引）、Tooling/静态 grep 门 | `yarn test:static` + grep 门 |
| WS8 | 仓库路由 Hermes/DSH/long-task-supervision（C8）＋本地 skill 优化实施与验证（C8 后本变更内执行，不产生 commit，不入库） | `docs/engineering/agent-collaboration.md`（路由句）＋仓库外本地 skill 路径 | grep 门 + skill 人工复核 + acceptance |

---

## 3. 垂直切片详单（每 WS：RED → GREEN → 文档 → 门）

### WS1 — 普通分支 checks-only（首做，为 WS2 清场）

1. **RED**：扩展 `candidate-quality-workflow.tooling.test.ts`：新增 `caseOrdinaryBranchesNoPublisher`——断言普通检查 workflow 内无 `packages: write`、无 `push-ghcr.sh`、无 `buildx build` 发布语义；`image` job 不存在或含 `if: false`。此时跑红（基线 `image` job 可达）。
2. **GREEN**：删 `candidate-quality.yml` 的 `image` job（含 QEMU/Buildx/login/push steps）；触发保留 `push`（普通分支）+ `pull_request`；确认顶层 `permissions: {}` + job `contents: read`。不碰 `docker-push.yml`（WS2 处理）。
3. **文档**：`docs/engineering/change-workflow.md` 提交与 PR 节补一句“普通分支 checks-only，无镜像”（一句话，不展开）。
4. **门**：`node scripts/suite-worker.mjs ./tests/tooling/ci/candidate-quality-workflow.tooling.test.ts` 通过；`yarn test:static` 通过。

### WS2 — 发布链路收敛（依赖 WS1；D1 已决：单一发布者收归 `docker-push.yml`）

1. **RED**：扩展两 Tooling 测试：
   - `release-pipeline`：默认干跑断言**不含** `latest` 且文件内无 `add_tag "latest"` 及等价同构建打 `latest` 路径；新增“缺 `source_digest` 即使 `promote_latest=true` 也拒绝晋升”“缺 `promote_latest` 即使有源 digest 也不晋升”两负例；新增“无 `GITHUB_SHA` 回退仍不含 `latest`”。
   - `candidate-quality-workflow`（或新 `release-publisher` 用例）：断言全仓恰一个 `packages: write` 发布 job（`docker-push.yml:docker-push`）、发布 workflow 含全局串行 `concurrency: image-publisher-global`、发布 job `needs` 含 quality + tier-gate + browser-smoke；晋升 step 含 `imagetools create`（或等价）且同时要求源 digest/ref 非空与 `promote_latest == true`；digest/OCI 回读 step 存在；全部 `uses:` 为 full-SHA pin；SBOM/provenance 启用（或已验证替代）；发布 workflow 有脱敏工件上传 + `retention-days: 30` + secret 扫描门。此时跑红。
2. **GREEN**：
   - `scripts/push-ghcr.sh`：删无条件 `add_tag "latest"` 及其整条同构建打 `latest` 路径（不加 `--promote-latest` 同构建开关）；release 构建只发 ref tag + `sha-<short>`；`sha-<short>` 与 OCI labels 保持；去重逻辑保持；构建 flags 改 `--sbom=true --provenance=true`（文件头注释更新，保持 macOS bash3.2 兼容）。
   - `docker-push.yml`：触发改为 `tags: v*` + `workflow_dispatch`（inputs: `tier_select: choice(CANDIDATE|RELEASE, default RELEASE)`、`source_digest: string`、`source_ref: string`、`promote_latest: boolean=false`）；删 `main` push 触发；`quality` job 保持并在首 step 加有界 secret 扫描（只查 tracked，见 §7）；新增 `tier-gate` job（`node scripts/check-tier-gate.mjs --select ${{ inputs.tier_select || 'RELEASE' }}`；tag 事件固定传 `RELEASE`）与 `browser-smoke` job（P0 Chromium+WebKit `retries=0`，复用 `browser.yml` 步骤）；`docker-push` job `needs: [quality, tier-gate, browser-smoke]` + `concurrency: image-publisher-global`；新增 `promote-latest` job（`needs: [docker-push]`，仅当 `source_digest`（或 `source_ref`）非空**且** `promote_latest == true` 时运行：`docker buildx imagetools create --tag <image>:latest <image>@<digest>` 无重构建 retag，随后 `imagetools inspect` 回读比对 digest 与 OCI label，失配即 FAIL）；新增脱敏工件 `upload-artifact`（白名单见 spec WS2.6，`retention-days: 30`）；全部 `uses:` 改 full-SHA pin；`notify` 保持。
   - `browser.yml`/`nightly-browser.yml` 不改发布语义（本就无发布），仅在头注中更新发布关系指向（WS2 的单一发布者）；其 `uses:` 同样改 full-SHA pin（C2 内一次完成，全仓无 tag-only 残留）。
3. **文档**：spec §WS2 已是权威；`change-workflow.md` 发布节补“tag/显式 dispatch 才发布；release 构建只发 version+sha、永不自动 latest；latest 仅经显式源 digest/ref + promote_latest 双输入无重构建 retag；单一串行发布者”（四句以内）。
4. **门**：两 Tooling suite 通过；mock docker 干跑五象限（默认无 latest / 缺源输入拒绝晋升 / 缺 promote 拒绝晋升 / 双输入齐全 retag 无重构建 + 回读通过 / tag 有 ref 无 latest + 去重）通过；`actionlint`（如可用）或至少 YAML 子串门通过。**禁真 push/真 dispatch/真晋升。**

### WS3 — Tier 完整性门（可与 WS1 并行准备，但接线只进发布路径；D2 已决：`tests/tier-waivers.yaml`）

1. **RED**：新增 `tests/tooling/tier/tier-gate.tooling.test.ts`（需在 `run-tests.mjs` 注册，`needs_db=false`）：受控 catalog fixture 正负例（spec §WS3 验收：`--select=CANDIDATE` 选中 CANDIDATE P0/P1、`--select=RELEASE` 选中 CANDIDATE+NIGHTLY+RELEASE P0/P1、空选集阻断、非法 `--select` 值 `exit 2`）；真实基线 catalog 断言两种选择下完整性门均为 RED（缺口清单非空）。同步新增 `scripts/check-tier-gate.mjs` 空壳（`exit 1` 占位）使 RED 可运行。
2. **GREEN**：实现 `check-tier-gate.mjs`（零依赖；catalog 解析只用一份——从 `check-test-catalog.mjs` 导出并导入其共用解析函数，**禁止复制第三份解析器、不新建 `lib/` 模块**）：
   - 入口：`node scripts/check-tier-gate.mjs --select <CANDIDATE|RELEASE> [--catalog <p>] [--waivers <p>]`，`exit 0` 通过 / `exit 1` 阻断并逐条打印 `case_id reason[WAIVED?]` / `exit 2` 参数非法（含缺 `--select`、非法值、空选集以 `empty-selection` 原因走 `exit 1`）。
   - Waiver 文件固定缺省 `tests/tier-waivers.yaml`（空数组即无豁免）：条目 schema `{case_id, reason, owner, issue, expires_at}` 全必填；`expires_at` 为 `YYYY-MM-DD` UTC，当天有效、过后阻断。
   - 基线交付时 waiver 为空（保持 RED 诚实）；CI 接线**只进发布路径**：`docker-push.yml:tier-gate` job（见 WS2）；`candidate-quality.yml` 及任何普通检查 workflow **不得**加完整性 gate step（Tooling 正例锁定）。
3. **文档**：`docs/testing/README.md` 缺口节补 tier 门一句 + waiver 指针；`coverage-matrix.md` 不改数字。
4. **门**：新 Tooling suite 通过；`node scripts/check-tier-gate.mjs --select CANDIDATE` 与 `--select RELEASE` 在基线均返回 `exit 1` 且清单与 checker 缺口交叉一致；`yarn test:static` 通过；`git diff --stat` 无产品 executable 新增（门脚本自动检查：`git diff --name-only` 含 `tests/unit|integration|system/browser/scenarios` 新增即 fail）。

### WS4 — L3 快照守卫（独立，可并行；需较重快照构建，单独跑）

1. **RED**：扩展 `browser-harness.tooling.test.ts`：新增 `caseDirtyTreeRejected`（临时 git 仓 fixture：`M` 脏文件 → `ensureSnapshot` 抛 BLOCKED）、`caseExpectedShaMismatchRejected`（设错 SHA → 抛）、`caseCleanTreePasses`（干净 → 放行逻辑可测到守卫通过点，不必全量 build）。此时跑红（基线无守卫）。
2. **GREEN**：`app-server.mjs` 新增 `assertArchivePreconditions({expectedSha})` 并在 `ensureSnapshot` 锁内调用（fast-path 前 + 锁内复判）：
   ```js
   execFileSync('git', ['status','--porcelain=v1','--untracked-files=no'], {cwd: repoRoot})
   execFileSync('git', ['rev-parse','HEAD'], {cwd: repoRoot})
   // 脏非空 → throw BLOCKED；EXPECTED_TARGET_SHA 非空且与 HEAD 失配（full 不等且非前缀等价）→ throw BLOCKED
   ```
   快照键改 full SHA（目录兼容：`snapshots/<short>` 保留为缓存键别名，但 manifest 与日志记 full；`unknown` 直接抛）。错误信息含 `expected/actual` 短 SHA + 脏文件头 N 行，禁 secrets。
3. **文档**：`isolation.md` 快照节补守卫两句（详写在 WS7 重写中，此处先行最小补丁，WS7 合并时归一）。
4. **门**：目标 Tooling suite 通过（含原有启停/端口释放用例）；`git status` 干净；端口释放确认通过。

### WS5 — 证据 schema v1（D3 已决：每 assertion 一行）

1. **RED**：新增 `tests/tooling/evidence/evidence-schema.tooling.test.ts`（注册 `needs_db=false`）：v1 JSON Schema 正负例（缺 `assertion_id`/`surface` 错配/非法 verdict/缺 `evidence_path` 均拒）+ Node 样例行与浏览器样例行的 join 断言（错配 `executable_ids` 即拒）。新增空壳 `docs/testing/execution/evidence-schema.v1.json` + `scripts/evidence-schema.mjs` 使 RED 可运行。
2. **GREEN**：
   - 定稿 schema（含 `schema_version=1` 必填与旧字段可选透传，`run_verdict` 禁入重申）。
   - `run-tests.mjs:writeResultsLine` 升级：每 suite 行附 `schema_version/case_ids(由 executable 反查)/evidence_path`，并新增每 assertion 行写入（`kind: assertion`，`summary` 行 `kind: summary`；粒度固定每 assertion 一行，不设内嵌备选）。
   - `jsonl-reporter.ts` + `evidence-recorder.mjs` + `fixtures.ts`：`case_id` 改 catalog `case_id`（注：烟雾 spec 需先在 catalog 登记 L3 executable 或映射表，**不得伪造 PASS**——若 catalog 暂无对应 case，行记 `BLOCKED(reason=no-catalog-binding)`；此为诚实缺口而非洗绿）。
   - `evidence.md` 更新到 v1（字段表 + join 规则 + 复用绑定 + 脱敏）。
3. **门**：新 suite 通过；一次真实 `run-tests.mjs --suite <small>` + 一次 `test:browser:smoke`（或 reporter 单元复算）产出行均过 `node scripts/evidence-schema.mjs --check <jsonl>`；`yarn test:static` 通过。

### WS6 — Runner 聚合（依赖 WS5 的行协议；D4 已决：安全停记 SKIPPED + `blocked_by`）

1. **RED**：扩展 `runner-group-split.tooling.test.ts`：新增 `caseOrdinaryFailuresAggregated`（fixture 双 suite：A 恒 FAIL + B 恒 PASS，跑真 runner 聚合 fixture——用临时注册表/临时磁盘 fixture，不碰真 `SUITES`）断言 B 仍执行、两行齐全、终态 `exit 1`。此时跑红（基线首 FAIL 即停）。
2. **GREEN**：`run-tests.mjs` 主循环改造：
   - 普通 FAIL（含 suite 进程 `exit 1`、断言失败）→ 写行 → **继续**下一 suite；终态汇总 `total/passed/failed/blocked/skipped/flaky` 并 `exit 1`（有 FAIL/FLAKY）或 `0`。
   - `exit 2/3/4` 路径不动（参数/空集、安全/bootstrap、超时仍立即停；超时先清该 suite DB + 写 BLOCKED 行；安全停按 D4 已决记 SKIPPED 行并注明 `blocked_by`）。
   - 汇总表打印到 stdout（供 CI 日志与 review 摘录）。
3. **文档**：`verdicts.md` §2 补聚合句（“普通 FAIL 继续跑隔离 suite 并汇总，终态 exit 1”已存在则逐字核对一致）。
4. **门**：扩展后 suite 通过；受控 A-FAIL/B-PASS 真跑验证通过；`exit 3/4` 负例（`lib/db` 扫描、超时 fixture）仍立即停止。

### WS7 — 文档对齐 + 去 DSH + schema/工件（WS1–WS6 之后做，避免合并冲突）

1. **RED**：新增 `tests/tooling/docs/governance-docs.tooling.test.ts`（注册 `needs_db=false`）：断言 `docs/testing/**`、`docs/engineering/**` 无 `DSH|STARTED_MOCK|mock.pid|:9301|10800|503/429`（白名单：本 spec/plan 与 `docs/archive/**`）；断言 `isolation.md` 含 `31120-31150`、`active.json`、`app-handle-`、`ownedMock`；断言 `maintenance.md` 无 `E2E-XX-YY` 主编号、无手工总数；断言任务 manifest 样例 + 结项样例字段齐全。此时跑红。
2. **GREEN**：重写 `isolation.md`（harness 真相）、收敛 `fixtures.md`（删 loader 范式）、重写 `maintenance.md`（catalog 驱动）、补 `evidence.md`（WS5 已做则此处只补 CI 工件节）、`artifacts-and-retention.md` 补任务 manifest/结项/工件索引；DSH 段整段删除（历史如需保留则移 `docs/archive/governance-hardening-20260910/` 并加索引，**不得**留在 current-state）；新增任务 manifest/结项 schema 专用 Tooling 校验测试（D5 已决：独立 suite，不并入 `check-test-catalog.mjs`）。
3. **门**：新 suite（含 D5 专用校验 suite）通过；`yarn test:static` 通过；`grep -ri` 去仓门通过（见 spec WS7 验收）。

### WS8 — 仓库路由 + 本地 skill 优化（用户已授权；C8 落盘后执行，不产生 commit）

1. **RED**：复用 WS7 的 docs suite 新增断言：`agent-collaboration.md` 含 `Hermes`、`DSH`、`long-task-supervision` 三路由。此时跑红。
2. **GREEN（C8，仓库内）**：`agent-collaboration.md` 首节补三条路由（各一句，链本地 skill 名，不抄操作步骤）。
3. **Skill 实施（C8 落盘之后，本变更内执行并验证，不产生 Git commit）**：按 spec §WS8.2 瘦身本地 skill（四类事实 + 去重 + `long-task-supervision` 独立路由）；实施前后各跑一次 `git status --porcelain`（必须干净）并记入 handover；人工复核 skill diff（本地路径 diff，不入库）并给出 PASS/CONCERN；结论纳入最终 acceptance（§9），失败即 acceptance 记 `CONCERN`，不记外部 `BLOCKED`。

---

## 4. Commit 边界（8 个，顺序执行；D1–D5 已裁决，直接执行）

| Commit | 主题（Conventional Commits） | 含 WS | 主要文件 |
|---|---|---|---|
| C1 | `ci(checks): ordinary branches checks-only, drop candidate image publisher` | WS1 | `candidate-quality.yml`、`candidate-quality-workflow.tooling.test.ts`、`change-workflow.md`（一句） |
| C2 | `ci(release): tag/explicit-dispatch immutable publisher, retag-only latest, serialized same-SHA gates` | WS2 | `docker-push.yml`、`push-ghcr.sh`、`browser.yml`/`nightly-browser.yml`（pins）、`release-pipeline.tooling.test.ts`、`candidate-quality-workflow.tooling.test.ts` |
| C3 | `test(tier): candidate/release P0/P1 gate with tracked expiring waivers` | WS3 | `scripts/check-tier-gate.mjs`、`check-test-catalog.mjs`（导出共用解析函数）、`tests/tier-waivers.yaml`、`tests/tooling/tier/*`、`package.json`、`docker-push.yml`（tier 接线）、`README.md`（一句） |
| C4 | `test(browser): reject dirty tree and target-sha mismatch before archive` | WS4 | `harness/app-server.mjs`、`browser-harness.tooling.test.ts` |
| C5 | `test(evidence): versioned Node+browser assertion join schema` | WS5 | `evidence-schema.v1.json`、`evidence-schema.mjs`、`run-tests.mjs`、`jsonl-reporter.ts`、`evidence-recorder.mjs`、`fixtures.ts`、`evidence.md`、新 Tooling 测试 |
| C6 | `test(runner): aggregate ordinary failures, keep safety/timeout stop classes` | WS6 | `run-tests.mjs`、`runner-group-split.tooling.test.ts`、`verdicts.md` |
| C7 | `docs(testing): align execution/fixtures/maintenance to harness, drop DSH policy, add task/closeout schemas` | WS7 | `isolation/fixtures/evidence/verdicts/maintenance.md`、`artifacts-and-retention.md`、新 docs Tooling 测试 |
| C8 | `docs(collab): route Hermes/DSH/long-task-supervision to local skills` | WS8（仓库侧） | `agent-collaboration.md` |

C8 落盘后执行 WS8 skill 优化（本地 skill 路径，不产生 C9、不进入 Git；见 §3 WS8.3）。skill 实施前后 `git status --porcelain` 必须干净。

回滚：任一 commit 可单独 `git revert`；C2 revert 必须同步声明“恢复双发布者过渡风险”；C3 revert 即恢复缺口不阻断语义（发布链回退到基线）。

---

## 5. 独立 Review / Fixup 编排

1. 每 commit 后即触发一次独立 Review 会话（不同会话、固定 `target_sha`，只读）：顺序核**范围**（changed files ∈ 本 WS 授权）→ **语义**（spec 验收逐项）→ **亲复**（重跑 §6 命令 + §7 四项检查，不采信实现者自报）。
2. FAIL 项写精确文件/行、预期/实际、复现命令；Fixup 会话从验收确认 SHA 起，仅修 reviewer 列出项并复验；Fixup 后换新 Reviewer 复验，不得自批。
3. 最终 Acceptance（C8 + skill 实施后）：全量 §6 门 + §7 检查 + D1–D5 按裁决执行情况 + WS8 skill 结论 + 未执行项清单（`NOT_RUN` 诚实标记，含分支保护），结论仅 `PASS/FAIL/CONCERN/BLOCKED`（`READY` 仅表示待验）。

---

## 6. 命令矩阵（实现/验证统一入口）

```bash
# 静态与 catalog（每 commit 必跑）
yarn test:static
node scripts/check-tier-gate.mjs --select CANDIDATE   # C3 起；基线预期 exit 1（诚实 RED），waiver 为空
node scripts/check-tier-gate.mjs --select RELEASE     # C3 起；基线预期 exit 1（诚实 RED），waiver 为空

# 单元/集成/工具（窄测 + 全量）
node scripts/suite-worker.mjs ./tests/tooling/ci/candidate-quality-workflow.tooling.test.ts
node scripts/suite-worker.mjs ./tests/tooling/release/release-pipeline.tooling.test.ts
node scripts/suite-worker.mjs ./tests/tooling/tier/tier-gate.tooling.test.ts            # C3 起
node scripts/suite-worker.mjs ./tests/tooling/evidence/evidence-schema.tooling.test.ts  # C5 起
node scripts/suite-worker.mjs ./tests/tooling/docs/governance-docs.tooling.test.ts      # C7 起
yarn test:unit && yarn test:integration && yarn test:tooling

# runner / evidence（C5–C6）
node scripts/run-tests.mjs --list
node scripts/evidence-schema.mjs --check .e2e-results/<run-id>/results.jsonl
node scripts/evidence-schema.mjs --check .e2e-results/browser/<run-id>/results.jsonl

# 类型/构建/整洁
yarn lint
yarn tsc --noEmit --incremental false
yarn build
git diff --check

# 浏览器（产品可观察行为必跑；C4–C5 后重点）
yarn test:browser:smoke   # Chromium + WebKit，retries=0

# 去仓 grep 门（C7–C8）
grep -ri "STARTED_MOCK\|mock.pid" docs/testing docs/engineering || echo "DSH pid policy clean"
grep -rIn "9301\|10800\|503/429" docs/testing/execution/isolation.md || echo "legacy numbers clean"
grep -rIn "E2E-[0-9][0-9]-" docs/testing/execution/maintenance.md || echo "old numbering clean"
```

---

## 7. 安全终态检查（每 WS 前后必做，记入 handover）

```bash
git status --porcelain
git diff --check
# secret：禁读禁记 .env*；只查 tracked 文件是否泄漏（不扫 untracked，不读 .env 内容）
git diff --cached --name-only | grep -E "^\.env|dev\.db|\.db$|\.e2e-runtime/|\.e2e-results/|\.agent-runs/" && echo "BLOCKED: forbidden staged" || echo "staged clean"
git grep -n -I -E "sk-|GHCR_TOKEN|BARK_WEBHOOK" -- ':!package-lock.json' ':!yarn.lock' ':!pnpm-lock.yaml' 2>/dev/null | sed -n '1,10p'; echo "secret scan done (tracked only, top 10)"
# dev.db：只读指纹，前后必须相同，绝不创建
ls -la prisma/dev.db 2>&1; stat -f "%m %z" prisma/dev.db 2>/dev/null || stat -c "%Y %s" prisma/dev.db 2>/dev/null || echo "dev.db absent (do NOT create)"
# 进程/端口：自有必须释放；生产 38080 永不触碰（Node 内置探针，跨平台；不用 ss/lsof）
node -e "const net=require('net');const ps=[38080,31111,31120,31121,9301];(async()=>{for(const p of ps){await new Promise((r)=>{const s=net.connect(p,'127.0.0.1');s.setTimeout(300);s.on('connect',()=>{console.log('PORT-OPEN '+p);s.end();r()});s.on('timeout',()=>{s.destroy();r()});s.on('error',()=>r())})}})().then(()=>console.log('ports clean (no PORT-OPEN above)'))"
ps -eo comm,args 2>/dev/null | grep -E -m 3 "next-server|mock-openai|playwright" || echo "no stray test processes"
```

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 发布链改错导致 tag 无法发版 | Tooling 锁定 + mock 干跑四象限；远端发布由仓库外显式任务执行，本变更不触远端 |
| tier 门基线 RED 被误读为回归 | Plan 明示双选择基线 RED 为诚实门生效证据；waiver 为空交付，豁免须另行 tracked 决策入库（本变更不预填） |
| L3 守卫误伤正常开发（untracked 构建物） | 守卫仅看 tracked（`--untracked-files=no`），untracked 不阻断；CI 本就干净检出 |
| 证据 v1 改动 runner/reporter 破坏现有 Tooling 断言 | 旧字段保留可选透传；Tooling 先 RED 后 GREEN；`results.jsonl` 行数语义按 D4 已决（SKIPPED + `blocked_by`） |
| 快照 full SHA 切换致缓存失效一次 | 一次性重建，后续命中新键；Tooling suite 串行执行 |
| skill 优化回归本地运维 | C8 后执行、可独立回退本地 skill 文件；skill 失败只记本变更 acceptance `CONCERN`，仓库 C1–C8 不受牵连 |

---

## 9. 交付与收尾

1. 8 commits 按 §4 落盘 + WS8 skill 实施后跑**全量终门**：`yarn test:static / lint / tsc / test:unit / test:integration / test:tooling / build / git diff --check / test:browser:smoke` + 双选择 tier 门（`--select CANDIDATE` / `--select RELEASE`，基线均 RED）+ §6 grep 门 + §7 四项检查 + skill 复核。
2. 独立 Acceptance 出具 `PASS/FAIL/CONCERN/BLOCKED` 报告（不同会话，证据落 `.e2e-results/<change-id>/<run-id>/` 与 `.agent-runs/<change-id>/acceptance/`，本地私有；含 WS8 skill 结论）。
3. 精炼结项 `docs/changes/2026-09-10-governance-and-release-hardening.md`（状态/基准/结果/入口/非阻断项/结论边界：技术 APPROVE ≠ 发布授权），原始日志与 DB 不入库。
4. 远端事项移交（均 `NOT_RUN` 在本变更）：分支保护 required checks 配置、tag 发布演练（含真实晋升 retag 演练）——由仓库外授权任务执行。
