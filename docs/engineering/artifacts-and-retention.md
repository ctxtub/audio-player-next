# 临时产物、证据与留存

## 分类原则

- Git 保存长期事实：产品契约、测试规范、机器 schema、工程决策和精炼 closeout。
- `.e2e-results/` 保存一次运行实际发生了什么。
- `.agent-runs/` 保存谁在什么权限下做了什么。
- `.e2e-runtime/` 只承载运行中的短命环境。
- 任何目录都不得保存真实 secret、生产数据或未脱敏载荷。

## 仓库内长期资产

```text
docs/specs/YYYY-MM-DD-<topic>.md       # 需求、方案、验收标准
docs/plans/YYYY-MM-DD-<topic>.md       # 实施计划快照
docs/changes/YYYY-MM-DD-<topic>.md     # 精炼结项
docs/archive/<topic>/<date>/           # 标明历史状态的原始重要材料
docs/testing/**                        # 当前测试体系权威
```

原始命令日志、截图、视频、数据库、副本、完整 transcript、port/PID 文件不得入库。

## 本地私有目录

### `.e2e-runtime/`

短命测试环境：隔离数据库、服务 handle、端口文件、mock 状态和合成环境。任务结束应按所有权清理；不得 broad kill/rm。失败时需要保留的数据库先复制到 `.e2e-results/`。

### `.e2e-results/`

协调任务推荐结构：

```text
.e2e-results/<change-id>/<run-id>/
  manifest.json
  results.jsonl
  suites/
  cases/
  logs/
  screenshots/
  db/
  acceptance/
```

现有 runner 的 `.e2e-results/<run-id>/` 与浏览器 reporter 的 `.e2e-results/browser/<run-id>/` 是兼容入口；多 Agent 编排层必须在 handoff 中记录真实路径，不得伪造统一位置。支持自定义结果根的工具优先配置到 `<change-id>/<run-id>`；不支持时保留原生路径并在 change manifest 建立索引。

### `.agent-runs/`

```text
.agent-runs/<change-id>/
  manifest.yaml
  planner/<session-id>/
  implementer/<session-id>/
  reviewer/<session-id>/
  fixup/<session-id>/
  acceptance/<session-id>/
```

可保存脱敏 prompt、授权范围、目标 SHA、会话 ID、报告、失败原因和恢复锚点；测试 oracle 原始证据仍归 `.e2e-results/`。

### Playwright 临时输出

Playwright attachment/output 统一放 `.e2e-results/playwright/`。历史默认目录 `/test-results/` 与 `/playwright-report/` 继续列入 `.gitignore`，防旧命令或第三方 reporter 污染工作区。

## 规范落点索引（治理硬化 WS7）

- 任务 manifest schema（规范正文）：[`docs/testing/execution/evidence.md`](../testing/execution/evidence.md) §7
 （含 `handover` 所有权与恢复锚点字段）；校验器为 `tests/tooling/docs/` 下专用 Tooling 校验测试（D5，不并入 checker）。
- 结项 closeout schema（规范正文）：[`docs/testing/execution/evidence.md`](../testing/execution/evidence.md) §8
 （`docs/changes/YYYY-MM-DD-<topic>.md` 必填：状态/基准 SHA/结果/入口/已知非阻断项/结论边界）。
- CI 工件清单（白名单/黑名单/脱敏规则与 `retention-days` 指针）：[`docs/testing/execution/evidence.md`](../testing/execution/evidence.md) §6。
- 前代调度政策历史（非现行规范，仅追溯）：[`docs/archive/governance-hardening-20260910/`](../archive/governance-hardening-20260910/README.md)。

## 保留与清理

- `.e2e-runtime/`：正常运行完成立即清理；BLOCKED 时仅保留无法安全清理的自有资源并报告。
- PASS 原始证据：至少保留到独立验收和发布决策完成。
- FAIL/CONCERN 证据：保留到问题关闭及下一轮验收完成。
- 需要长期追溯的内容提炼为 `docs/changes/`；不要把整个本地证据目录提交。
- 清理前核对 change-id、run-id、PID/端口所有权和完整路径；禁止模糊批量删除。
