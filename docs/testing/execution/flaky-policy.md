# 抖动测试策略（flaky-policy）

本文档为新写，定义抖动与隔离（quarantine）规则。目标：失败不洗绿，覆盖不染绿。

## 1. 产品失败禁自动重试

- 产品失败禁止自动重试洗绿；候选门不自动重试产品失败。
- 失败后显式 repeat 通过仍为 `FLAKY`，不得记为 `PASS`（见 [verdict 语义](./verdicts.md)）。
- `FLAKY` 只来自显式重复观察（含显式 `repeat` 与时序观察），不得由单次通过推定。

## 2. 显式重复与台账

- 显式重复需记录：case、owner、首次时间、复现率、原因、截止日、issue（tracked flaky ledger）。
- 历史 PASS 复用必须绑定 `code/fixture/environment/oracle/runner hash`，任一变化即失效。
- 抖动观察在 nightly 做显式重复时序观察，不阻塞候选门，但结论必须留档。

## 3. quarantine 门槛

- `P0` 不得长期 quarantine。
- 其他 quarantine 必须同时具备 `owner + issue + 截止日`，缺一不可，且不计覆盖。
- quarantine 期间该 case 的缺口不得计入已实现数，catalog 如实标出。
- 到期未解决必须升级为 `BLOCKED` 或完成修复，不得静默延长。

## 4. 与覆盖的关系

- `LEGACY-NON-COVERAGE`、`MANUAL`、`RETIRED` 本就不计覆盖；quarantine 中的 ACTIVE 同样不计覆盖。
- 禁止通过降为 `PLANNED` 来洗绿候选必测清单中的缺口。
