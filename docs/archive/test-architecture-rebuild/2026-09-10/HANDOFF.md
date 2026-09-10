# HANDOFF：测试体系重建（全任务执行契约）

> **归档状态：COMPLETED / HISTORICAL / DO NOT EXECUTE**
> 本文是一次性实现 worker 契约，其中 SHA、任务状态、数量、路径与授权边界可能已经过期。新任务必须从根 `AGENTS.md` 与 `docs/testing/README.md` 开始。

## 0. 任务身份（测试体系重建，任务1-13）

- 方案基线：`docs/plans/TEST-ARCHITECTURE-REBUILD-BASELINE.md`（只读，不得修改）
- 起始任务：第16节任务1（保护测试数据库路径）；终止条件见第18节
- 版本：`v1.3-final`（单分支连续执行＋ROBOT 一次性终验；方案底稿第18A节现场事实与本契约矛盾修正已生效）
- 基线 SHA：`8bd87b39ee69571923288e1be530536d34bcf3ec`
- 指定分支：`chore/test-architecture-rebuild`（全程单分支，每任务一提交）
- 工作区：`<repo>`（历史执行时为本机仓库根）
- 执行角色：实现 worker；自测通过不等于验收，不得自称 APPROVE（终验属 ROBOT，见第18.4条）
- 本 handoff 是全任务唯一执行契约：按第16节任务序列连续执行到第18节报告点为止。任务间不停顿、不征询、不等待用户。

## 1. 先读文件

按顺序完整读取：

1. `AGENTS.md`
2. `docs/plans/TEST-ARCHITECTURE-REBUILD-BASELINE.md`
3. `scripts/run-tests.mjs`
4. `scripts/suite-worker.mjs`
5. `scripts/e2e-db-guard.mjs`
6. `tests/test-e2e-db-guard.ts`
7. `tests/test-e2e-db-guard-regression.ts`
8. `tests/fixtures/isolated-db.ts`
9. `package.json`
10. `.gitignore`

不得运行 `yarn test` 作为探查：当前 runner 会先创建 SQLite。

## 2. Preflight

必须真实执行并记录输出：

```bash
git rev-parse HEAD
git status --short --branch
git diff -- scripts/run-tests.mjs scripts/suite-worker.mjs scripts/e2e-db-guard.mjs tests/test-e2e-db-guard.ts tests/test-e2e-db-guard-regression.ts tests/fixtures/isolated-db.ts package.json
```

允许存在的预先未跟踪资产：

- `.hermes/`
- `docs/plans/TEST-ARCHITECTURE-REBUILD-BASELINE.md`
- `docs/plans/HANDOFF-保护测试数据库路径.md`
- `.e2e-runtime/`
- `.e2e-results/`

若 HEAD 恰为 `8bd87b3` 且当前在 `main`，只允许执行：

```bash
git switch -c chore/test-architecture-rebuild 8bd87b3
```

若指定分支已存在且指向 `8bd87b3`，只允许切到该分支。本任务全程不新增分支。任何其他 HEAD、已有授权路径改动或分支冲突：立即 BLOCKED，不 reset/rebase/stash/覆盖。

记录 `prisma/dev.db` 的存在状态；若存在，只读记录 mtime、size、SHA-256。不得创建、打开写连接、迁移或修复该文件。

## 3. 任务1：保护测试数据库路径

本节是任务1的专属契约。只完成测试 DB 安全边界，不做目录迁移、catalog、CI、Playwright 或产品修复（这些属于任务2-13）：

1. 不再信任外部 ambient `DATABASE_URL`。
2. runner 对全部注册 suite 统一注入独立隔离 SQLite：`.e2e-runtime/test-db/<run-id>/<suite-id>.db`。
   已知例外（显式偏差，不算失败）：`tests/test-orphan-prevention.ts` 模块加载即自管 `DATABASE_URL` 并在 `prisma/` 自建库，而它不在本任务 allowlist。runner 对它仍照常注入受控 URL（子进程内该套件可能忽略注入），在任务回报中记入 `blocked_decisions`（注明"归任务6迁移时收敛"）；`prisma/` 下已存在的测试库残留（如 `prisma/test-paragraph-resume.db`）preflight 只读记录指纹，本轮不清理。
3. 路径经过 canonical realpath/ancestor 校验，不能通过绝对路径、`..`、symlink、百分号编码或 query 绕出允许根。
4. 只接受 `file:` SQLite URL；非 SQLite URL fail closed。
5. 任务1对全部 runner 注册套件逐套建库（包括纯内存套件，宁可浪费）：`lib/db.ts` 存在 `file:./prisma/dev.db` 兜底，缺注入+静态导入=直写 dev.db，fail-safe 只能统一注入；"按需建库（needs_db）"收敛属任务2的注册表设计。先验证路径与现有祖先，再建父目录，再 migrate，再 schema probe，再执行 suite；suite 完成后关闭子进程并清理其 DB。失败时可复制证据到 `.e2e-results/test-architecture-rebuild/<run-id>/tasks/task-01-保护测试数据库路径/db.sqlite`，随后清理 runtime。
6. SIGINT/SIGTERM 只清理当前 runner 拥有的资源。
7. 安全/隔离/bootstrap 失败立即全组停止，使用 exit 3；普通测试失败保持现有 exit 1。
8. 任务1暂不实现 Unit 零建库；该目标属于任务2“按测试类型拆分执行器”的分组选择后延迟初始化。不得提前声称已完成。

## 4. 任务1文件边界

允许修改：

- `scripts/run-tests.mjs`
- `scripts/suite-worker.mjs`（仅当子进程关闭/信号处理确有必要）
- `scripts/e2e-db-guard.mjs`
- `tests/test-e2e-db-guard.ts`
- `tests/test-e2e-db-guard-regression.ts`
- `tests/fixtures/isolated-db.ts`
- `tests/tooling/db-guard/runner-database-path-safety.tooling.test.ts`（允许新建）
- `package.json`（仅新增语义命令 `test:runner-database-safety`；禁止依赖变更）
- `scripts/test-database-path-safety.mjs`（允许新建纯路径安全模块）

禁止修改/暂存：

- `prisma/dev.db`
- `.env.local` 与任何 `.env*`
- `docs/plans/**`
- `.hermes/**`
- `docs/e2e/**` 与 `.github/**`（任务9/10/13 按第16节授权除外）
- `yarn.lock`
- 所有业务源码：`app/** components/** stores/** lib/** middleware.ts`
- 上述 allowlist 之外任何仓库源文件；任务1证据目录（第7.1节）与本 run 临时快照除外

本边界仅约束任务1。任务2-13 各自的授权文件以第16节任务表为准；第17节全局边界始终生效。

禁止动作：push、merge、deploy、rebase、reset、stash、依赖升级、真实网络请求、生产端口 `38080`、开发共享 DB、启动长期服务。

## 5. 任务1实现契约

### 5.1 路径解析

建议把纯逻辑放进 `scripts/test-database-path-safety.mjs`，导出可直接测试的函数。要求：

- 允许根：`realpath(<repo>/.e2e-runtime/test-db)`。
- URL 必须由 runner 构造，不接受调用 shell 原样提供的 URL。
- 输入契约固定：生成端仅输出 `pathToFileURL(absolutePath).href`；验证端只接受这种规范绝对 file URL。先检查原始 query/hash/编码段与点段，再 `fileURLToPath` 解码一次；拒绝相对 URL、编码斜杠、残留百分号、多次编码与点段，不自行重复 decode。
- 拒绝 hostname、非空 query/hash、NUL、非 `.db` 后缀、空路径。
- 写前先以 lstat/realpath 验证所有已存在祖先，从仓库 realpath 开始；运行根及其下禁止 symlink，包括目标文件。确认边界后逐级创建缺失目录，每步复核；首次危险路径测试不得创建仓外目录。run 目录以独占创建、权限 0700 建立；仅操作本 run 的文件。
- 使用 `path.relative(allowedRoot, candidate)` 判定：结果不得为空外的越界形式、不得以 `..` 开头、不得为绝对路径。
- suite ID 固定匹配 `^[a-z0-9][a-z0-9-]{0,95}$`，不符直接拒绝。生成规则固定：文件名剥去 `.<layer>.test.ts` 层级后缀（layer ∈ unit|integration|contract|tooling|legacy；浏览器为 `.browser.spec.ts`），无后缀旧文件取全名去 `.ts`；唯一性在启动前检查，不允许执行者自行选择转义策略。例：`tests/tooling/db-guard/runner-database-path-safety.tooling.test.ts` → suite ID `runner-database-path-safety`。
- 不使用字符串前缀 `startsWith(root)` 作为唯一安全判断。

### 5.2 生命周期

- runner 启动时生成不含秘密的 `run-id`，格式固定 `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$`（UTC+随机）。子进程 env 构造：先 `delete` ambient `DATABASE_URL` 再赋受控值，防同 key 残留。schema probe：migrate 后开连接执行 `SELECT name FROM sqlite_master WHERE type='table'`，断言 schema 模型表集合为其子集，失败 exit 3。
- 每个 suite 启动前构造唯一 DB 路径并执行 Prisma migrate。
- 子进程只收到 runner 生成的 `DATABASE_URL`；删除/覆盖 inherited ambient URL。
- migrate/schema probe 失败：打印脱敏错误、exit 3、停止后续 suite。迁移使用 execFile 参数数组及受控 env，禁止 shell 字符串插值。
- suite exit 1：按现有普通失败处理；不要包装为安全失败。隔离化后若出现共享库时代没有的新失败：按"发现测试耦合"记入 known_failures 并停在当前任务报告，不算可修的产品缺陷，不扩 allowlist。
- 所有清理只针对本 run 路径；禁止 broad rm/prune。
- 不打印任何环境变量值或 secret。采用异步 spawn 管理拥有的子进程；每 suite 上限 180 秒，收到 SIGINT/SIGTERM 时先终止子进程并等待关闭，再清理 DB/WAL/SHM。180 秒超时 → 终止子进程并等待关闭 → 清理后以 exit 4 结束本组（与基线第10节 timeout/crash=4 一致）；仅当无法确认子进程已关闭时保留隔离目录、返回 BLOCKED，禁止强删仍使用中的库。

### 5.3 现有 fixture

`tests/fixtures/isolated-db.ts` 保持现有 API，但在 runner 下必须复用经验证的本 suite 已迁移数据库。`setupIsolatedDb` 不再另建/删库/迁移/切换 URL；`isolatedDbPath` 返回同一受控路径。缺少受控上下文则抛安全错误，不 fallback。独立 fixture 调用方须通过 runner 启动，不得裸跑。若已有测试强依赖多库或跨 suite 固定路径，记录具体调用点并停下，不扩大业务修改范围。

## 6. 任务1可信 RED

安全测试的最初 RED 必须在临时沙箱中复现旧 runner 行为：把旧 runner 的复制件作为被测入口（复制件=测试数据，允许且应当把其中 testFiles 改写为 1 个哑套件；仓库真文件不动），工作目录指向本 run 内合成仓库，模拟 Prisma 可执行文件仅记录调用，不接触真实数据库。哑套件记录继承到的 `DATABASE_URL`，作为"旧 runner 透传 ambient URL"的 RED 证据。用独立哨兵文件模拟保护对象，证明旧 runner 接受 ambient URL、缺少隔离或处理错误。不得在真实仓库带 `file:prisma/dev.db` 运行旧 runner。

新纯安全模块不存在时，“import not found”不算 RED；可以先搭可导入的接口骨架，再以真实边界断言展示失败。历史 guard 中原本已正确的用例允许初始 PASS，只有本批修复目标需要可信失败，不能要求每个拒绝用例一律 RED。


先写测试，覆盖至少：

1. `file:prisma/dev.db` 被拒绝；
2. 仓外绝对路径被拒绝；
3. `../` 越界被拒绝；
4. 百分号编码后的 `..` 被拒绝；
5. query/hash 被拒绝；
6. `https:` / `libsql:` 被拒绝；
7. symlink ancestor 逃逸被拒绝；
8. 合法 `.e2e-runtime/test-db/<run>/<suite>.db` 被接受；
9. 两个 suite 得到不同 DB；
10. ambient `DATABASE_URL` 不会成为子 suite URL；
11. bootstrap 失败映射 exit 3；
12. 清理函数不会删除 allowed run 根外文件；
13. `pathToFileURL` 规范式之外的 `file:` 写法（如相对式 `file:prisma/x.db`）一律拒绝。

先运行任务1窄测，当前实现应因缺少安全行为而失败。可信 RED 必须是目标行为断言失败。

无效 RED：语法错、导入错、类型错、环境缺依赖、人工 throw、反转断言、硬编码失败。若所有针对本批已知缺口的新断言都立即 PASS，停止核查目标是否已经修复或测试是否未连接真实入口，不得人为制造失败。

## 7. 任务1 GREEN 与验证

只做满足契约的最小实现。完成后执行并记录真实退出码：

1. 新 runner DB safety 窄测；
2. 两个既有 DB guard 窄测；
3. `node --check` 检查所有修改/新增 `.mjs`；
4. `yarn lint`；
5. `yarn tsc --noEmit --incremental false`；
6. 与本任务相关、不会连接真实/共享库的安全测试；
7. `git diff --check`。

只有在确认 runner 使用隔离路径后，才允许跑现有 `yarn test`；它可能耗时，但不得访问真实上游。若无法证明，标 BLOCKED，不运行。

验证后再次只读记录 `prisma/dev.db`；存在状态、mtime、size、SHA-256 必须与 preflight 相同。确认 `.env.local` 未出现在 changed/staged 列表；不要读取其内容。

### 7.1 命令与环境安全补充（任务1）

`package.json` 新增的 `test:runner-database-safety` 必须直接调用：

```text
node scripts/suite-worker.mjs ./tests/tooling/db-guard/runner-database-path-safety.tooling.test.ts
```

它不得经过旧 runner 的迁移入口。新安全套件同时登记进现有 runner 数组；此时原40套件加新增套件，数量由扫描计算，不能仍报告40。

执行 `yarn test:runner-database-safety` 保存完整日志；自测中的 expected exit 3 应被父断言验证后使整个自测 exit 0，不能将整体安全失败当 PASS。

全量 `yarn test` 只有在安全窄测通过后启动，必须限制公网外联、移除注入的业务凭据，并显式提供合成 SESSION_SECRET 等实际必需测试变量。缺少变量时报告变量名，不读取 `.env.local` 寻找值。

`yarn tsc --noEmit --incremental false` 替代默认 tsc，避免产生 tsbuildinfo。lint 执行前检查不会加载私有环境。`yarn build` 必须在本 run 内临时快照执行：仅复制 Git tracked 文件与 allowlist 的当前实现，排除全部 `.env*`、数据库、缓存和运行产物，使用本地已安装依赖与显式合成环境；禁止直接在有 `.env.local` 的根目录运行 Next build。无法安全构建则报告 BLOCKED，不声称四道门全绿。临时快照属于本 run 产物，不属于业务文件修改授权。

信号处理的预期测试只能终止自测自己创建的沙箱子进程；非预期超时/信号才触发硬停点。

任务1证据统一写 `.e2e-results/test-architecture-rebuild/<run-id>/tasks/task-01-保护测试数据库路径/`：`preflight.json`、`red.log`、`green.log`、`regression.log`、`quality.log`。私有运行产物不得暂存；记录执行命令、退出码、时间与基线完整 SHA。没有运行的验证明确 NOT_RUN。任务2-13 的每任务日志与 verdict 向量写入第19节统一结构。

## 8. 每任务提交规则（任务1细则在此，任务2-13 同规则）

提交前：

```bash
git status --short
git diff --check
git diff --cached --name-only
```

只显式 stage 当前任务授权文件中实际变更的文件，禁止 `git add .`、`git add -A`。

任务1提交信息固定：

```text
test(infra): isolate suite databases and reject unsafe URLs
```

任务2-13 提交信息在对应任务内按 Conventional Commits 语义自定，type 限 test/chore/ci/docs。

提交后执行：

```bash
git show --stat --oneline HEAD
git status --short --branch
```

不得 push。本提交仅完成当前任务；立即按第16节继续下一任务。

## 9. 硬停点（单任务级；全任务级见第20节）

命中任一项立即停止，不提交、不扩大范围：

- HEAD/base/branch 与本 handoff 不符；
- 当前任务授权文件内已有未知改动；
- 已知缺口无法取得可信 RED，或只有导入/环境错误；
- 需要修改 allowlist 外文件、业务代码或 lockfile；
- 触及 `prisma/dev.db`、`.env.local`、生产、真实上游或端口 38080；
- 无法安全区分 runner 生成 URL 与 ambient URL；
- symlink/query/encoding 边界无法 fail closed；
- migrate/schema/bootstrap 失败却需要继续跑；
- 测试 timeout、signal 或无退出码；
- 发现产品语义、公开 API 或 schema 需要改变；
- 出现新的基线失败且无法证明与当前任务无关；
- staged diff 含任何禁止路径。

基础设施问题报告 `BLOCKED` + `reason_class: INFRA`，不得重试洗绿。

## 10. 每任务回报格式（写入第19节 evidence 目录的任务日志末尾）

```yaml
task_id: 1
task_name: 保护测试数据库路径
type: 行为|机械
status: DONE|BLOCKED|FAILED
commit_sha:
commit_message:
authorized_files: []
changed_files: []
unexpected_files: []
red: {command:, exit_code:, observed_failure:, credible: true|false}   # 机械任务填 N/A — non-behavioral migration
green: {command:, exit_code:, result:}
verification: [{command:, exit_code:, result:, evidence_path:}]
verdict_vector_before: [...]   # 机械任务必填；行为任务 N/A
verdict_vector_after: [...]
safety: {prisma_dev_db_unchanged:, env_local_unchanged:, external_network_used:, owned_processes_cleaned:}
deviations: []
blocked_decisions: []
known_failures: []
```

必须给真实命令、exit code 和 changed files；“测试通过”四个字不构成证据。

## 11. 已确认的后续产品规则

执行者不得重新解释：

- 从提示词历史开始新创作时，新建干净当前会话；旧创作保留在历史并可返回；新请求不含旧上下文；新故事允许自动播放。
- 生成历史只在播放器本页单次回放，不新增历史、不污染聊天、不触发续写。
- Safari/WebKit 属于正式支持范围；release 必须通过 WebKit P0 smoke，nightly 覆盖 WebKit P0/P1。

这些规则是已确认产品语义，任何任务不得重新解释；若与现有实现冲突，记入 decisions_needed 停在当前任务，等待终验后由用户裁决。测试体系任务本身不修改产品代码。

## 16. 任务序列（唯一执行顺序；实现模型连续执行，任务间不停顿）

每个任务 = 完整目标：先写/改测试得 RED（行为任务）或盘点对照（机械任务），最小实现，跑任务门验证，然后一个 Conventional Commit。上一任务的提交 SHA 是下一任务的集成基线。禁止把多个任务揉进一个提交；禁止跳过任务门直接下一个任务。

| 序号 | 任务 | 类型 | 关键产出与验证门 | 主要授权文件 |
|---|---|---|---|---|
| 1 | 保护测试数据库路径 | 行为 | 第3-7节全部要求；新安全套件登记 runner；`yarn test` 全绿（隔离）；dev.db 未变 | 第4节 allowlist |
| 2 | 按测试类型拆分执行器 | 行为 | runner 重构为注册表 `{id, path, group, needs_db}`；`--list`（JSON）、`--group`、`--suite`，未知参数/空选集 exit 2；退出码 0/1/2/3/4；Unit 组剥离 DATABASE_URL+静态扫描禁 `lib/db` 导入（命中 exit 3）；JSONL 结果 `.e2e-results/<run-id>/results.jsonl`（套件级字段，断言级留待任务11）；分组行为有自测；全量 `yarn test` 不回归 | `scripts/run-tests.mjs`、`scripts/suite-worker.mjs`、`package.json`、`tests/tooling/runner/**`（新建） |
| 3 | 整理共享测试数据与工具 | 机械 | 4 个 fixture 移到 `tests/support/**` 语义名，旧路径 re-export shim 或全量改 import；`yarn test` verdict 向量一致 | `tests/fixtures/**`、`tests/support/**`（新建）、`tests/**` import 行 |
| 4 | 隔离工具测试和待重写测试 | 机械 | 迁移表中 TOOLING/LEGACY 目标落位（`tests/tooling/**`、`tests/legacy/**`）；runner registry 同步新路径；verdict 向量一致 | 上述迁移表目标文件、`scripts/run-tests.mjs` |
| 5 | 归位单元测试 | 机械 | 9 个 Unit 目标落位 `tests/unit/**`；registry 同步；verdict 向量一致 | 迁移表目标文件、`scripts/run-tests.mjs` |
| 6 | 归位身份与持久化集成测试 | 机械 | identity/persistence 集成目标落位；registry 同步；verdict 向量一致；`test-orphan-prevention.ts` 迁移时一并改为走 `tests/support` 隔离库 helper（此文件允许随本任务修改，收敛任务1的显式偏差） | 迁移表目标文件、`scripts/run-tests.mjs`、`tests/test-orphan-prevention.ts` |
| 7 | 归位创作与播放集成测试 | 机械 | creation/playback 集成目标落位；registry 同步；`tests/legacy/` 仅剩表内指定文件；verdict 向量一致 | 迁移表目标文件、`scripts/run-tests.mjs` |
| 8 | 建立测试资产目录和自动校验 | 行为 | `tests/test-catalog.yaml`+`schema_version:1` 收录全部 61 原子 case（PLANNED/ACTIVE 如实）；schema JSON、checker 脚本、坏 fixture 负例测试；`yarn test:static` 注册 | `tests/test-catalog.yaml`、`tests/test-catalog.schema.json`、`scripts/check-test-catalog.mjs`、`package.json` |
| 9 | 重组测试规范和产品覆盖视图 | 机械 | `docs/testing/**` 全套建齐；`docs/e2e/README.md` 改兼容跳转页；`AGENTS.md` 指向 `docs/testing/README.md`；统计由 checker 生成 | `docs/testing/**`（新建）、`docs/e2e/README.md`、`AGENTS.md` |
| 10 | 建立候选版本质量门 | 行为 | `.github/workflows/candidate-quality.yml`：static+lint+typecheck+L1+L2+contract（过渡期显式 NOT_APPLICABLE 不伪造）+build 同 workflow 同 SHA needs；tooling path-filter（`scripts/**`、workflow、runner、mock、guard）；`docker-push.yml` 镜像 job 增加 needs 质量 job；`scripts/push-ghcr.sh` 增产 `sha-<shortSHA>` 不可变 tag；actionlint 通过；不接真实部署，真实 Actions 结果标 blocked | `.github/workflows/candidate-quality.yml`（新建）、`.github/workflows/docker-push.yml`、`scripts/push-ghcr.sh` |
| 11 | 逐项重写真正失真的测试 | 行为×N | 迁移表标注"重写"的 legacy 每项独立提交：RED→GREEN（连接真实导出，组件类用 jsdom 渲染真实组件）；源码字符串锁（contains/indexOf）移 `tests/static/**`；`test-sec-02.ts` 转 Static 后删除；恒真断言删除；生产时钟注入点（playbackStore）单独提交在前、测试提交在后；终态 `tests/legacy/` 清零；迁移后向 catalog 补齐断言级 JSONL | 迁移表对应文件、`tests/static/**`（新建）、`stores/playbackStore.ts`（仅时钟注入点）、`package.json`（jsdom/RTL） |
| 12 | 验证真实浏览器测试技术栈 | 行为 | 新增 `@playwright/test` devDependency；spike 验证矩阵：①隔离环境 production build 可启动（31111 端口、隔离 DB、合成 SESSION_SECRET、本地 mock 上游 9301）②mock 返回固定 MP3，浏览器自然产生 loadedmetadata/ended 真媒体事件（dispatchEvent 不算）③WebKit 可装可跑，不可用记 BLOCKED 不得 Chromium 洗绿 ④Safari autoplay/手势策略实测记录；结果如实，ROBOT Go/No-Go | `tests/system/browser/**`（新建）、`package.json`（@playwright/test） |
| 13 | 建设浏览器测试与发布门禁 | 行为×N | 先建 tracked harness（mock-openai、app-server 启停、每用例新 context、evidence-recorder、JSONL reporter、playwright.config chromium+webkit 双 project serial retries=0，harness 自测 tooling 套件）；再 6 个首批 L3 场景各一提交：history-prompt-start-new-creation、generation-history-play-once、reject-second-submit-while-streaming、stop-audio-when-budget-exhausted、pause-audio-before-logout-unload、persist-tail-before-page-exit（登出/退出类必须由测试进程在页面关闭后直查隔离 DB/时间线，禁止页面内日志自证）；browser/nightly workflow；WebKit P0 smoke 入 release 门 | `tests/system/browser/**`、`tests/support/**`、`.github/workflows/browser.yml`、`.github/workflows/nightly-browser.yml`（新建） |

机械任务验证门：迁移前后逐 suite verdict 向量一致 + 全量 `yarn test` exit 0 + `git diff --check`。行为任务验证门：可信 RED→GREEN + 第7节质量门全绿。

## 17. 全局安全边界（所有任务永久生效）

- 永不触碰：`prisma/dev.db`、`.env.local` 与 `.env*`、生产端口 38080、真实上游 API、生产 Compose/账号；测试只能用隔离端口、隔离库、合成 secret 与假账号。
- 永不：push、merge、deploy、rebase、reset、stash、force 操作、依赖升级。唯二例外（均须锁版本，package.json 与 yarn.lock 同一提交）：任务11 重写组件行为测试允许新增 `jsdom`、`@testing-library/react`、`@testing-library/dom` devDependencies；任务12 允许新增 `@playwright/test` devDependency。若认为还需其他依赖，记入 decisions_needed 停在当前任务，不得悄悄绕过。
- 每任务只动该任务授权文件＋第4节数据库 allowlist；两份方案文档与本 handoff 全程只读不得提交；过程材料不入库。
- 外联仅限 localhost；spawn 子进程必须可回收（超时+信号清理）。
- SQLite 串行：seed/迁移/清理持排他锁；禁止对任何 malformed 库跑 `.recover`。
- 任务10/13 的 workflow 只允许新建文件与 actionlint 本地验证，不触发真实 Actions。
- 夜间静默：23:00–09:00 遇必须决策的事项记入 blocked_decisions 继续；09:00 后汇总。

## 18. 执行、自测与终验流程

1. **连续执行**：实现模型从任务1起按序推进。每个任务完成（commit 落盘+任务门全绿）后立即开始下一任务，不等待、不征询、不输出"等待确认"。
2. **自测即门禁**：每任务必须先让本任务新/改测试失败（行为任务可信 RED），实现后全绿才算完成；机械任务 verdict 向量逐 suite 一致。全量 `yarn test`+lint+无增量 tsc+隔离 build 在每个行为任务后、至少每3个机械任务后重跑一次。
3. **报告点**：仅两种情况输出终报并结束本轮：
   a) 任务13最后一个提交完成、全任务门绿 → `status: ALL_TASKS_COMPLETE`，列 13 任务各自 commit SHA、每任务退出码、证据目录、遗留已知失败清单。
   b) 命中第9节硬停点或连续2次修复尝试失败 → `status: BLOCKED_AT_TASK_<N>`，写明停点任务、已完成任务及 SHA、根因、所需决策、恢复锚点（handoff 第16节任务N）。修复尝试范围=当前任务授权文件，禁止回退已完成任务的提交。
4. **ROBOT 终验（用户启动）**：全部完成后 ROBOT 一次性终验——回读全部提交与 diff、复跑关键验证（含分组退出码、catalog checker、browser spike 真实输出、WebKit smoke）、核对迁移表保全、verdict 向量、catalog/registry/磁盘三方一致、安全边界与秘密扫描；输出终验报告与 FAILED_TASKS 清单（若有）。终验 FAIL 的任务由用户重启实现模型从对应任务号修复；终验 APPROVE 后由用户决定 push/merge/部署。
5. **终验前无验收**：实现模型自测通过≠验收；实现模型不得自称 APPROVE。除报告点外，实现模型不产生面向用户的验收叙述。

## 19. 回报与证据结构（全任务）

`.e2e-results/test-architecture-rebuild/<run-id>/`：`tasks/task-<NN>-<slug>.log`（每任务命令与退出码）、`verdict-vectors/task-<NN>.json`（机械任务前后向量）、`final-report.json`。final report:

```yaml
task: 测试体系重建
status: ALL_TASKS_COMPLETE | BLOCKED_AT_TASK_<N> | FAILED_AT_TASK_<N>
base_sha: 8bd87b39ee69571923288e1be530536d34bcf3ec
branch: chore/test-architecture-rebuild
tasks_completed: [{id: 1, slug: 保护测试数据库路径, commit_sha: ...}, ...]
stopped_at_task:
root_cause:
decisions_needed:
evidence_dir: .e2e-results/test-architecture-rebuild/<run-id>/
known_failures: []
next_action: 用户启动 ROBOT 终验
```

## 20. 硬停点（全任务版，覆盖第9节单批语义）

命中任一项立即停止输出终报，不扩大范围：
- 任一任务需要改动其授权文件之外的仓库文件（两份方案文档、handoff、`.hermes/` 永远禁改）；
- 迁移任务 verdict 向量不一致且两次对齐尝试失败；
- 任务8 catalog 无法如实表达现有测试（缺 spec/双 SSOT 冲突）；
- 任务11 重写时发现真实产品缺陷需要产品代码改动；
- 任务12 spike 发现 Chromium/WebKit 均不可用或依赖缺失且无法本地解决；
- 第9节全部硬停点在此同样生效（dev.db/生产/环境/超时/信号类）。

产品语义冲突（含第11节产品规则与现有 schema 矛盾）记入 `decisions_needed` 并停在当前任务，等待终验后由用户裁决，不自行改语义。

## 21. 终验范围预告（ROBOT 用，实现模型忽略）

终验除第18.4条外还核验：每个提交恰好对应一个任务；13 任务序号连续无跳批；`tests/legacy/` 清零或每项有重写提交映射；`yarn test:unit`/`test:integration`/`test:tooling`/`test:static` 空集合与正常集合退出码实测；catalog 61 case 与 docs/e2e 原子 case 双向对账；WebKit smoke 证据含真实 browser/version manifest。
