# 测试体系人工入口（docs/testing）

本文档是本仓库测试体系的**人工入口**，不独立维护统计数字。
一切数量口径以机器权威为准，由 `scripts/check-test-catalog.mjs` 生成并校验。

## 1. 权威边界（消除双重 SSOT）

| 资产 | 权威内容 | 说明 |
| --- | --- | --- |
| `docs/e2e/**/场景.md` | 产品语义、用户目标、前置条件、oracle 的语义权威 | 场景文件保留在原目录，本任务不移动场景文件 |
| `tests/test-catalog.yaml` | 机器元数据、路径绑定、层级、优先级、生命周期的机器权威 | `schema_version: 1`，旧编号只进 `legacy_aliases` |
| `docs/testing/README.md`（本页） | 人工入口 | 不独立维护数字，以 catalog 为准 |
| `docs/e2e/README.md` | 兼容跳转页，不再声称全测试 SSOT | 仅保留指向本页的说明与场景目录索引 |
| 运行 verdict | 由 runner 结构化结果权威决定，不写回 catalog | catalog 只保存 `lifecycle_status`，`run_verdict` 不属于 catalog |

冲突处理：spec 与 catalog 任一缺失或不一致均阻断。

## 2. 追踪链（spec → case → executable）

追踪链为三段式，任一段断链即阻断：

```text
产品场景 spec（docs/e2e/**.md）
  ↕ spec_path（catalog 每 case 必填，形如 docs/e2e/….md[#锚点]）
机器目录 catalog（tests/test-catalog.yaml：case.executable_ids 单向登记）
  ↓ executable_ids（引用已注册 executable + executable.path 落盘）
可执行套件 suite（tests/unit/**、tests/integration/** 为 Node 层，tests/system/browser/** 为 Playwright L3 层）
  ↕ Node 层经 runner 注册表（scripts/run-tests.mjs --list）与磁盘 glob 三方一致；L3 层经 catalog 与 manifest 证据绑定
```

- 正向：从任一场景 spec 出发，经 `spec_path` 找到 catalog case，再经 `executable_ids` 找到可执行文件与 runner 注册项。
- 反向：从任一可执行文件出发，通过内存中由 `cases[].executable_ids` 派生的反向索引查回对应 case，再经 `spec_path` 回到场景 spec（无需在 catalog 中人工双向登记 `executable.case_ids`）。
- 校验器覆盖：schema 合法、case->executable 引用完整、ACTIVE 非空、executable 路径落盘、registry/磁盘/catalog 三方一致、统计输出。
- Tooling 独立说明：Tooling（`tests/tooling/**`）为测试基础设施自测套件，独立运行与自测，不属于产品 catalog，不绑定产品 case；Tooling PASS 不等于任何产品 case PASS。

旧编号回查：`E2E-XX-YY`、`H-XX` 只作为历史别名保存在 catalog `legacy_aliases[]` 中（可在 `tests/test-catalog.yaml` 内检索），不作为新文件名、目录名、主标题或汇报首列。

## 3. 文档地图

- 执行规范（`execution/`）：
  - [隔离执行](./execution/isolation.md)（由 `docs/e2e/execution-isolation.md` 迁移）
  - [合成数据与夹具](./execution/fixtures.md)（由 `docs/e2e/fixtures.md` 迁移）
  - [证据与留档](./execution/evidence.md)（新写：`.e2e-results` 结构、manifest 要求与脱敏规则）
  - [verdict 语义与退出码](./execution/verdicts.md)（新写：PASS/FAIL/BLOCKED/SKIPPED/FLAKY，exit 0/1/2/3/4）
  - [抖动测试策略](./execution/flaky-policy.md)（新写：产品失败禁自动重试、quarantine 门槛）
  - [维护与变更](./execution/maintenance.md)（由 `docs/e2e/MAINTENANCE.md` 迁移）
- 产品场景规范（语义权威，保留在原目录）：`../e2e/` 下 6 大套件目录，入口见兼容跳转页 `../e2e/README.md`。
- 机器资产：`../../tests/test-catalog.yaml`、`../../scripts/check-test-catalog.mjs`。
- 工程治理：[变更工作流](../engineering/change-workflow.md)、[多 Agent 协作](../engineering/agent-collaboration.md)、[产物留存](../engineering/artifacts-and-retention.md)。

## 4. 常用命令

```bash
yarn test:catalog                            # catalog 校验（含 docs/e2e 全认领）
node scripts/run-tests.mjs --list          # 查看 runner 注册表（三方一致的一方）
yarn test:unit                              # L1
yarn test:integration                       # L2
yarn test:tooling                           # Tooling
yarn test:browser                           # L3（正式产品场景）
yarn test:browser:diagnostics               # smoke 环境手诊（不属产品 coverage，不作为完成条件）
```

分层速查：L1 单进程单单元确定性；L2 多真实生产模块穿越明确 seam；L3 运行中 production build + 真实浏览器；Tooling 为测试基础设施自测。Tooling 独立运行，不属于产品 catalog，不计产品覆盖，Tooling PASS 不等于任何产品 case PASS。smoke 为环境手诊入口（`yarn test:browser:diagnostics` 或 `npx playwright test --config tests/system/browser/playwright.config.ts tests/system/browser/smoke.spec.ts`），不属产品 coverage、不作为完成条件。
