# 测试体系人工入口（docs/testing）

本文档是本仓库测试体系的**人工入口**，不独立维护统计数字。
一切数量口径以机器权威为准，由 `scripts/check-test-catalog.mjs` 生成并校验。

> 统计口径声明：本页数字为基线快照引用，不手维护多份总数。
> 生成工具：`scripts/check-test-catalog.mjs`（`yarn test:static`）。
> 基线 run-id：`20260909T105219Z-fea26406`，集成基线 `c84a27b`。
> 若本页数字与 checker 输出不一致，以 checker 输出为准并阻断。

## 1. 基线快照（checker 输出引用）

```text
原子case数=61
父组数=59
声明自动化数=50
已实现数=25
缺口数=25
```

- 原子 case 共 **61**：`ACTIVE 25 / PLANNED 25 / MANUAL 1 / LEGACY-NON-COVERAGE 10`。
- 可执行注册表 `executables` 共 **41**，按落盘分组：
  `unit 9 / integration 16（含 tests/ 根下 2 个待归位）/ tooling 6 / legacy 10`。
- 优先级分布：`P0 16 / P1 26 / P2 18 / P3 1`。
- 主防线分布：`L1 9 / L2 26 / L3 26`（`L1/L2/L3` 含义见第 3 节分层定义）。
- 旅程分布（8 个 `journey_id`）：`smoke-baseline 9 / interactive-race 10 / playback-kernel 12 / cloud-storage 5 / persistence-recovery 6 / auth-session 10 / error-rate-limit 8 / history-reuse-create 1`。
- 缺口 25 项均为 `PLANNED 缺 executable，属预期缺口`（产品语义已确定、代码尚不存在），候选必测清单中的缺口必须阻断，不得降为通过。

复现命令（仓库根执行，预期 exit 0）：

```bash
node scripts/check-test-catalog.mjs
```

## 2. 权威边界（消除双重 SSOT）

| 资产 | 权威内容 | 说明 |
| --- | --- | --- |
| `docs/e2e/**/场景.md` | 产品语义、用户目标、前置条件、oracle 的语义权威 | 场景文件保留在原目录，本任务不移动场景文件 |
| `tests/test-catalog.yaml` | 机器元数据、路径绑定、层级、优先级、生命周期的机器权威 | `schema_version: 1`，旧编号只进 `legacy_aliases` |
| `docs/testing/README.md`（本页） | 人工入口，由 catalog/checker 生成或校验统计 | 不独立维护数字，不一致时阻断 |
| `docs/e2e/README.md` | 兼容跳转页，不再声称全测试 SSOT | 仅保留指向本页的说明与场景目录索引 |
| 运行 verdict | 由 runner 结构化结果权威决定，不写回 catalog | catalog 只保存 `lifecycle_status`，`run_verdict` 不属于 catalog |

冲突处理：spec 与 catalog 任一缺失或不一致均阻断；README 数字与 catalog 不一致时阻断生成/检查。

## 3. 双向追踪（spec ↔ catalog ↔ suite）

追踪链为三段式，任一段断链即阻断：

```text
产品场景 spec（docs/e2e/**.md）
  ↕ spec_path（catalog 每 case 必填，形如 docs/e2e/….md[#锚点]）
机器目录 catalog（tests/test-catalog.yaml：case ↔ executable 双向引用）
  ↕ executable_ids / case_ids（双向一致 + executable.path 落盘）
可执行套件 suite（tests/unit/**、tests/integration/**、tests/tooling/**、tests/legacy/**）
  ↕ runner 注册表（scripts/run-tests.mjs --list）与磁盘 glob 三方一致
```

- 正向：从任一场景 spec 出发，经 `spec_path` 找到 catalog case，再经 `executable_ids` 找到可执行文件与 runner 注册项。
- 反向：从任一可执行文件出发，经 `executables[].case_ids` 回到 case，再经 `spec_path` 回到场景 spec。
- 校验器覆盖：schema 合法、双向引用一致、ACTIVE 非空、executable 路径落盘、registry/磁盘/catalog 三方一致、统计输出。

旧编号回查：`E2E-XX-YY`、`H-XX` 只出现在 `legacy_aliases[]` 与 [风险语义索引](./risks.md) 中，不作为新文件名、目录名、主标题或汇报首列。

## 4. 文档地图

- [产品覆盖矩阵：8 旅程 × case 分布](./coverage-matrix.md)——由 catalog 数据推导，主防线 L2/L3 标注，必守 oracle 引用方案第 6 节。
- [风险语义 slug 索引](./risks.md)——风险语义名为第一身份，旧 `H-XX` 只作历史别名。
- 执行规范（`execution/`）：
  - [隔离执行](./execution/isolation.md)（由 `docs/e2e/execution-isolation.md` 迁移）
  - [合成数据与夹具](./execution/fixtures.md)（由 `docs/e2e/fixtures.md` 迁移）
  - [证据与留档](./execution/evidence.md)（新写：`.e2e-results` 结构、manifest 要求、指纹/脱敏）
  - [ verdict 语义与退出码](./execution/verdicts.md)（新写：PASS/FAIL/BLOCKED/SKIPPED/FLAKY，exit 0/1/2/3/4）
  - [抖动测试策略](./execution/flaky-policy.md)（新写：产品失败禁自动重试、quarantine 门槛）
  - [维护与变更](./execution/maintenance.md)（由 `docs/e2e/MAINTENANCE.md` 迁移）
- 产品场景规范（语义权威，保留在原目录）：`../e2e/` 下 6 大套件目录，入口见兼容跳转页 `../e2e/README.md`。
- 机器资产：`../../tests/test-catalog.yaml`、`../../tests/test-catalog.schema.json`、`../../scripts/check-test-catalog.mjs`。

## 5. 常用命令

```bash
node scripts/check-test-catalog.mjs        # 目录校验（static 门）
node scripts/run-tests.mjs --list          # 查看 runner 注册表（三方一致的一方）
yarn test:unit                              # L1
yarn test:integration                       # L2
yarn test:tooling                           # Tooling
yarn test:static                             # catalog 校验（同第一条）
```

分层速查：L1 单进程单单元确定性；L2 多真实生产模块穿越明确 seam；L3 运行中 production build + 真实浏览器；Contract 为边界兼容；Tooling 为测试工具自身；Static 为架构与资产禁令。Contract/Tooling/Static 不计产品覆盖。
