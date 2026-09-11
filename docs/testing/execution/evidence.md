# 证据与留档规范（evidence，v1）

本文档定义运行证据的目录结构、manifest 要求、指纹与脱敏规则。
私有运行产物不得入库，结论不得回写 catalog。

行协议版本：v1（最小执行结果协议，`scripts/evidence-schema.mjs` 为唯一校验器，Node/浏览器/CI 共用同一口径；
`node scripts/evidence-schema.mjs --check <results.jsonl>` 必须 exit 0）。

## 1. 目录结构

- runner 隔离库：`.e2e-runtime/test-db/<run-id>/<suite-id>.db`（父 runner 生成，子进程复用验证，执行后关闭并清理）。
- 运行证据根：`.e2e-results/<run-id>/`，按 suite/case 分目录存放；多 Agent 协调任务推荐由编排层放入 `.e2e-results/<change-id>/<run-id>/` 并记录真实结果根。
- L3 结构化证据路径：`.e2e-results/browser/<run-id>/<case-id>/`；Playwright 自身 attachment/output 放 `.e2e-results/playwright/test-results/`。
- 失败时可把当次隔离库复制到对应 run 的 `db/` 或 `<suite-id>/db.sqlite` 后再清理 runtime，保留期由评审决定。

完整的仓库资产分类、Agent 过程目录和留存规则见 [临时产物、证据与留存](../../engineering/artifacts-and-retention.md)。

## 2. v1 最小执行结果协议

证据行降级为记录实际执行结果（不再使用 assertion/surface 伪精度与四维 join），每个真实 suite/test 只记录自己的实际 verdict。
行种类分为 `summary`（产品测试结果）与 `tooling-summary`（测试基础设施自测结果）。

### 2.1 字段表

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema_version` | 全行必填 | 恒为 `1` |
| `kind` | 全行必填 | `summary`（产品汇总）或 `tooling-summary`（基础设施汇总） |
| `run_id` | 全行必填 | 非空字符串 |
| `verdict` | 全行必填 | `PASS|FAIL|BLOCKED|SKIPPED|FLAKY`（必须反映真实执行） |
| `evidence_path` | 全行必填 | 相对仓库根的证据路径（相对路径，禁绝对路径与 `..` 段） |
| `case_id` / `case_ids` | 产品汇总建议/必填 | 绑定的产品 catalog case；无绑定时不得编造；Tooling 行**严禁包含** |
| `executable_id` / `suite_id` | 建议 | 对应的可执行体或 runner 套件标识 |
| `duration_ms` | 建议 | 执行耗时毫秒 |
| `browser` / `spec_path` | L3 建议 | Playwright project 与用例相对路径 |
| `reason` | 无绑定 BLOCKED/SKIPPED 必填 | 如 `no-catalog-binding` |
| `commit` | 建议 | 执行时 HEAD 完整 SHA（取不到记 `unknown`） |
| `suite_id`/`group`/`exit_code` | 旧字段，可选透传 | 保留供兼容工具解析 |

`run_verdict` 永不写回 catalog（维持禁令）。

### 2.2 防伪造与准入规则

- **产品汇总绑定**：verdict 为 `PASS/FAIL/FLAKY` 的产品 summary 行必须携带已在 catalog 中声明的有效 case 绑定（`case_id` 或 `case_ids`），无绑定的产品 PASS 坚决拒收。
- **无绑定诚实报告**：无绑定的 `BLOCKED/SKIPPED` 行必须带非空 `reason`（如 `no-catalog-binding`），严禁编造 `case_id`。
- **Tooling 覆盖隔离**：`tooling-summary` 结果必须来自已注册的 tooling suite，且不得包含 `case_id` 或 `case_ids`；Tooling PASS 不得被计入或聚合为产品用例覆盖。

## 3. manifest 要求

每个运行证据目录可包含机器可读的 manifest.json，记录真实执行信息，至少包含：

```text
run_id, case_id, executable_id, verdict, evidence_path
```

另可包含：`commit`、`browser/version`（L3）、执行耗时、步骤日志及 Playwright 原始附件路径（截图、视频、trace）。

## 4. 隔离与数据安全

- L2/L3 的 DB 证据必须说明库来源为本 run 隔离库，不得引用共享开发库 `prisma/dev.db` 或生产库。
- `prisma/dev.db` 的存在状态、mtime、size、SHA-256 在关键任务前后只读记录，前后必须相同；绝不为验证而创建它。

## 5. 脱敏（秘密与载荷）

- 测试账号、密钥口令只存在于本地未入库的 `.e2e-runtime/.env.e2e`（或隔离环境变量），规范与代码库一律使用符号标识符：`{{E2E_USER_A}}`、`{{E2E_USER_B}}`、`{{E2E_PASS_A}}`、`{{E2E_SESSION_SECRET}}`。任何真实密码密钥严禁进入 Git。
- 网络证据只记 pathname，不记 query（批输入在 query 中，防载荷泄露）；非流响应保留安全 body 摘要（截断上限 + truncated 标记）。
- `evidence_path` 只记相对路径，不记绝对路径（含用户目录名）、`file:` URL 与 `DATABASE_URL` 值；日志经 runner `sanitizeError` 口径脱敏后方可落盘。
- 运行产物在执行前后运行 `git status --porcelain` 自检，除预先授权的规范文件外必须保持工作区干净；证据目录本身已被 `.gitignore` 忽略，严禁 `git add`。

## 6. CI 工件（白名单/黑名单/脱敏与留存）

当前 `auto-delivery.yml` 不上传 `.e2e-results` / evidence artifact，也未配置 `retention-days`。本地 evidence 仍必须遵守脱敏规则。未来如重新接入 CI artifact，应单独定义留存期，而不是沿用历史数值。

未来接入或本地归档规范：
- 白名单（仅允许上传）：`results.jsonl`、`manifest.json`、汇总日志、P0 烟雾截图、digest 回读记录。
- 记录口径：pathname-only，无 query，无 body 载荷。
- 黑名单（永不上传）：`.env*`、一切数据库文件（含隔离库、共享开发库 `prisma/dev.db`、生产库）、一切 secret/token/cookie/连接串、`.e2e-runtime/` 全量。
- 脱敏规则：日志上传前复核 `file:` URL 与 `DATABASE_URL=` 值已脱敏（runner `sanitizeError` 口径，CI 侧复核）；
  网络证据只记 pathname；`evidence_path` 只记相对仓库根路径。
- 留存：当前未配置 `retention-days`。

## 7. 任务 manifest schema（D5：本节为规范正文，索引见工程留存文档）

任务 manifest 记录一次授权任务的身份、边界与交接，落 `.agent-runs/<change-id>/manifest.yaml`（本地私有，不入库）。
字段（全部必填）：

| 字段 | 说明 |
|---|---|
| `change_id` | 变更标识（如 `governance-hardening-20260910`） |
| `role` | 本任务角色（如 `Implementer`） |
| `workspace` | 授权工作目录绝对路径 |
| `branch` | 授权分支 |
| `base_sha` | 基线完整 SHA |
| `target_sha` | 验收目标 SHA（固定后只读复核） |
| `authorized_paths` | 授权路径清单（非空数组；只显式暂存其中文件） |
| `forbidden_actions` | 禁止动作清单（如 push/merge/deploy/触发 Actions） |
| `required_reads` | 必读文档清单（spec/plan 相关节） |
| `evidence_dir` | 证据目录（run-id 真实路径，不得伪造统一位置） |
| `handover` | 交接段（见下表） |

`handover` 子字段（全部必填）：

| 子字段 | 说明 |
|---|---|
| `commit_sha` | 落盘 commit SHA |
| `changed_files` | 变更文件清单 |
| `commands` | `{command, exit_code}` 数组（每条门命令与真实退出码） |
| `not_run` | 未执行项（`NOT_RUN` 诚实标记） |
| `ownership` | `PID/端口/DB 所有权`：`{pids, ports, db}`（自有已释放/未触碰如实记录） |
| `recovery` | 恢复锚点（回到干净态的命令与基线） |

校验器形态固定为专用 Tooling 校验测试（`tests/tooling/docs/`），不并入 `check-test-catalog.mjs`。

## 8. 结项 schema（D5：本节为规范正文，索引见工程留存文档）

精炼结项落 `docs/changes/YYYY-MM-DD-<topic>.md`。必填：

| 字段 | 说明 |
|---|---|
| `status` | 结论状态（`DONE/PARTIAL/BLOCKED`，不写 ETA） |
| `base_sha` | 基准 SHA |
| `result` | 结果（各 WS 验收逐项结论） |
| `entrypoints` | 入口（规范/计划/测试入口链接） |
| `known_non_blocking` | 已知非阻断项 |
| `conclusion_boundary` | 结论边界：技术 APPROVE ≠ 发布授权 |

校验器形态与 manifest 同口径（专用 Tooling 校验测试，缺字段负例须被拒）。
