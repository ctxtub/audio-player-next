# 临时产物、证据与留存

## 分类原则

- Git 保存长期事实：产品契约、测试规范、机器 schema、工程决策和精炼 closeout。
- `.e2e-results/` 保存一次运行实际发生了什么。
- `.agent-runs/` 保存可选 Agent 调试/恢复记录。
- `.e2e-runtime/` 只承载运行中的短命环境。
- 任何目录都不得保存真实 secret、生产数据或未脱敏载荷。

## 仓库内长期资产

```text
docs/specs/**      # 仍约束当前行为的需求与验收标准
docs/archive/**    # 从已完成方案中提炼的长期决策
docs/testing/**    # 当前测试体系权威
```

临时实施计划、阶段报告和重复方案不长期保留。功能完成后，将仍有解释价值的内容合并到当前规范或精炼归档，其余删除。

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

现有 runner 的 `.e2e-results/<run-id>/` 与浏览器 reporter 的 `.e2e-results/browser/<run-id>/` 是兼容入口；多 Agent 编排如需统一索引，可在交接记录中注明真实路径，不得伪造统一位置。支持自定义结果根的工具可优先配置到 `<change-id>/<run-id>`；不支持时保留原生路径即可。

### `.agent-runs/`

可选 Agent 调试/恢复记录，不作为普通测试完成条件。
可按需保存脱敏 prompt、授权范围、目标 SHA、会话 ID、报告、失败原因和恢复锚点；测试 oracle 原始证据仍归 `.e2e-results/`。

### Playwright 临时输出

Playwright attachment/output 统一放 `.e2e-results/playwright/`。历史默认目录 `/test-results/` 与 `/playwright-report/` 继续列入 `.gitignore`，防旧命令或第三方 reporter 污染工作区。

## 保留与清理

- `.e2e-runtime/`：正常运行完成立即清理；BLOCKED 时仅保留无法安全清理的自有资源并报告。
- PASS 原始证据：至少保留到独立验收和发布决策完成。
- FAIL/CONCERN 证据：保留到问题关闭及下一轮验收完成。
- 需要长期解释的内容提炼到当前规范或 `docs/archive/`；不要把整个本地证据目录提交。
- 清理前核对 change-id、run-id、PID/端口所有权和完整路径；禁止模糊批量删除。
