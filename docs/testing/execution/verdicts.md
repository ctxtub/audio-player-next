# Verdict 语义与退出码（verdicts）

本文档为新写，定义运行 verdict 与进程退出码。`CONDITIONAL` 不作为 verdict。

## 1. verdict 五态（互斥终态）

- `PASS`：所选 ACTIVE 套件/断言均通过，且证据链完整。
- `FAIL`：普通断言失败（含产品失败）。
- `BLOCKED`：安全/隔离/bootstrap 失败、环境不可用、依赖缺失等无法判定行为的阻断。
- `SKIPPED`：按规则跳过（如 MANUAL 不进自动化调度、`RETIRED` 不计）。
- `FLAKY`：只来自显式重复观察（失败后显式 repeat 通过仍为 FLAKY，见 [抖动策略](./flaky-policy.md)）。

统计字段固定：`total, passed, failed, blocked, skipped, flaky`。
`total = passed + failed + blocked + skipped + flaky`，包含这五种互斥终态，不包含 catalog 中的 `RETIRED/MANUAL/LEGACY`。
`run_verdict` 不属于 catalog：catalog 只保存 `lifecycle_status`（`PLANNED|ACTIVE|BLOCKED|MANUAL|LEGACY-NON-COVERAGE|RETIRED`），运行结论不写回 catalog。

## 2. 退出码

- `0`：所选 ACTIVE 套件均 PASS。
- `1`：普通断言 FAIL/FLAKY（继续运行互相隔离的套件并汇总）。
- `2`：配置、参数、空集合、catalog 不合法（含未知参数/suite/group、空选集、checker 不通过）。
- `3`：安全/隔离/bootstrap 失败，立即停止整个 group（路径越界、迁移失败、schema 损坏、外联风险同属此类）。
- `4`：timeout/crash；清理该 suite 资源后汇总或按安全影响停止。

普通断言失败继续运行互相隔离的套件并汇总；安全、路径越界、迁移、schema 损坏、外联风险立即全组停止。

## 3. 禁止项

- `CONDITIONAL` 不作为 verdict：任何“有条件通过”必须落到上述五态之一，并用 `reason_class`（如 `INFRA`）说明原因。
- 不得以文件存在、源码字符串、截图数量或 worker 自报作为通过依据；测试通过以关键 oracle 真执行为准。
- 可信回归测试可以保持 FAIL/BLOCKED，禁止为全绿弱化 oracle。
