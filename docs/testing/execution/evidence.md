# 证据与留档规范（evidence，v1）

本文档为新写，定义运行证据的目录结构、manifest 要求、指纹与脱敏规则。
私有运行产物不得入库，结论不得回写 catalog。

行协议版本：v1（`docs/testing/execution/evidence-schema.v1.json` 为机读字段声明，
`scripts/evidence-schema.mjs` 为唯一校验器，Node/浏览器/CI 共用同一口径；
`node scripts/evidence-schema.mjs --check <results.jsonl>` 必须 exit 0）。

## 1. 目录结构

- runner 隔离库：`.e2e-runtime/test-db/<run-id>/<suite-id>.db`（父 runner 生成，子进程复用验证，执行后关闭并清理）。
- 运行证据根：`.e2e-results/<run-id>/`，按 suite/case 分目录存放；多 Agent 协调任务推荐由编排层放入 `.e2e-results/<change-id>/<run-id>/` 并记录真实结果根。
- L3 结构化证据路径：`.e2e-results/browser/<run-id>/<case-id>/`；Playwright 自身 attachment/output 放 `.e2e-results/playwright/test-results/`。
- 失败时可把当次隔离库复制到对应 run 的 `db/` 或 `<suite-id>/db.sqlite` 后再清理 runtime，保留期由评审决定。

完整的仓库资产分类、Agent 过程目录和留存规则见 [临时产物、证据与留存](../../engineering/artifacts-and-retention.md)。

历史 E2E 证据（浏览器人工执行时代）沿用 `.e2e-results/<run-id>/E2E-xx-yy/` 结构，每用例至少包含截图、控制台、音频探针、网络清单与按需 DB 导出，详见 [隔离执行](./isolation.md) 第 7 节。

## 2. v1 行协议（每 assertion 一行）

Node `results.jsonl` 与浏览器 `results.jsonl` 均升级为**每 assertion 一行**
（每行一 claim：`case_id × executable_id × assertion_id × surface × verdict × evidence_path`）；
suite/case 级汇总行保留但标记 `kind: summary` 以示区别。

### 2.1 字段表

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema_version` | 全行必填 | 恒为 `1` |
| `kind` | 全行必填 | `assertion`（断言行）或 `summary`（汇总行） |
| `run_id` | 全行必填 | 非空字符串 |
| `case_id` | assertion 行必填 | catalog `case_id`（kebab-case）；无绑定汇总行**不得编造** |
| `executable_id` | assertion 行必填 | catalog `executable_id`，须出现在该 case 的 `executable_ids` |
| `assertion_id` | assertion 行必填 | 该 case `required_assertions[]` 中的 `assertion_id` |
| `surface` | assertion 行必填 | 须与 catalog 中该 assertion 的 `surface` 一致 |
| `verdict` | 全行必填 | `PASS\|FAIL\|BLOCKED\|SKIPPED\|FLAKY` |
| `evidence_path` | 全行必填 | 相对仓库根的证据路径（相对路径，禁绝对路径与 `..` 段） |
| `case_ids` | 汇总行建议 | Node suite 行附的 case 集合（由 executable 反查 catalog），逐项须 join |
| `reason` | 无绑定 BLOCKED/SKIPPED 必填 | 如 `no-catalog-binding` |
| `browser`/`spec_path` | L3 行建议 | Playwright project 与用例相对路径 |
| `commit`/`duration_ms` | 建议 | 执行时 HEAD 完整 SHA（取不到记 `unknown`）与耗时毫秒 |
| `suite_id`/`group`/`exit_code` | 旧字段，可选透传 | v1 保留，**不得删除**（不断既有 Tooling 断言） |

`run_verdict` 永不写回 catalog（维持禁令）。

### 2.2 join 规则

`case_id → catalog.cases[].case_id`；`executable_id → catalog.executables[].executable_id`
且必须出现在该 case 的 `executable_ids`（同时该 executable 的 `case_ids` 须含该 case，
双向一致，复用 checker 口径）；`assertion_id → 该 case 的 required_assertions[].assertion_id`；
`surface` 必须与 catalog 中该 assertion 的 `surface` 一致（L3 executable 的
`evidence_surfaces` 须覆盖它）。

### 2.3 汇总行防伪造规则

- verdict 为 `PASS/FAIL/FLAKY` 的汇总行须带有效 case 绑定（防伪造 PASS）。
- 无绑定的 `BLOCKED/SKIPPED` 汇总行须带非空 `reason`，且不得编造 `case_id`。
- Node runner 写行前校验，非法即记 `BLOCKED` 并 `exit 3`（属供给/契约损坏，
  非产品断言失败）；浏览器 reporter 同口径（行非法即转 `BLOCKED` 并在 stderr 明示，
  Playwright 退出码归属不变）。

### 2.4 复用绑定规则

- L3 executable 的 `evidence_surfaces` 即其可举证的 surface 全集；assertion 行的
  `surface` 超出该全集即非法。
- 若某行在 catalog 中暂无对应 case 绑定（例如烟雾 spec 尚未登记 L3 executable），
  该行必须记 `BLOCKED(reason=no-catalog-binding)`，**严禁伪造 PASS 或编造 case_id**。
  这是诚实缺口而非洗绿：manifest 与 jsonl 行均如实记录，待 catalog 登记后再转正常举证。

## 3. manifest 要求

每个 `<case-id>/` 目录必须有可机读的 manifest（JSON 或 JSONL 配套），至少包含：

```text
run_id, case_id, executable_id, assertion_id, surface, verdict, evidence_path
```

另建议包含：`commit`、`browser/version`（L3）、`fixture hash`、`mock hash`、`runner hash`、各 assertion 结果。
结构化运行结果是必要而非充分证据：assertion 记录只能在真实断言成功后产生，验收者还须审查被测生产链、负例/故障注入与实际原始证据。手写 PASS JSONL、扫描源码字符串均不能证明行为。

### 3.1 旧 manifest 字段映射表（v1）

| 旧 manifest 字段 | v1 行字段 | 说明 |
|---|---|---|
| `case_id`（标题归一化） | `case_id`（catalog `case_id`） | v1 改用 catalog 身份；目录名仍可用旧 slug，但行内不得用 slug 冒充 |
| `spec_path` | `spec_path` | 不变（相对仓库根） |
| `run_id` | `run_id` | 不变 |
| `commit` | `commit` | 不变（完整 SHA） |
| `browser`/`browser_version` | `browser`（行）+ manifest 全量 | 行内记 project，版本仍放 manifest |
| `verdict` | `verdict` | 枚举不变；无绑定时强制 `BLOCKED` |
| `assertions[]`（`playwright-expectations` 占位） | 每 assertion 一行（`assertion_id`+`surface` 取自 catalog） | 占位断言已取消，无绑定时为空数组 |
| `hashes.{fixture,mock,spec,runner,harness}` | 复用绑定（§2.4） | 口径不变，仍由 manifest 承载 |
| `suite_id`/`group`/`exit_code`（Node 旧行） | 同名可选透传 | v1 保留，不得删除 |

## 4. 指纹（可复现性绑定）

- 历史 PASS 复用必须绑定 `code/fixture/environment/oracle/runner hash`，任一变化即失效。
- L2/L3 的 DB 证据必须说明库来源为本 run 隔离库，不得引用共享开发库 `prisma/dev.db` 或生产库。
- `prisma/dev.db` 的存在状态、mtime、size、SHA-256 在关键任务前后只读记录，前后必须相同；绝不为验证而创建它。

## 5. 脱敏（秘密与载荷）

- 测试账号、密钥口令只存在于本地未入库的 `.e2e-runtime/.env.e2e`（或隔离环境变量），规范与代码库一律使用符号标识符：`{{E2E_USER_A}}`、`{{E2E_USER_B}}`、`{{E2E_PASS_A}}`、`{{E2E_SESSION_SECRET}}`。任何真实密码密钥严禁进入 Git。
- 网络证据只记 pathname，不记 query（批输入在 query 中，防载荷泄露）；非流响应保留安全 body 摘要（截断上限 + truncated 标记）。
- `evidence_path` 只记相对路径，不记绝对路径（含用户目录名）、`file:` URL 与 `DATABASE_URL` 值；日志经 runner `sanitizeError` 口径脱敏后方可落盘。
- 运行产物在执行前后运行 `git status --porcelain` 自检，除预先授权的规范文件外必须保持工作区干净；证据目录本身已被 `.gitignore` 忽略，严禁 `git add`。

## 6. CI 工件（发布 workflow：白名单/黑名单/脱敏与留存）

发布 workflow 仅上传白名单工件，并设显式 `retention-days: 30`（接线见发布 workflow，本文为规范指针，不复述 workflow 全文）。

- 白名单（仅允许上传）：`results.jsonl`、`manifest.json`、汇总日志、P0 烟雾截图、digest 回读记录。
- 记录口径：pathname-only，无 query，无 body 载荷。
- 黑名单（永不上传）：`.env*`、一切数据库文件（含隔离库、共享开发库 `prisma/dev.db`、生产库）、一切 secret/token/cookie/连接串、`.e2e-runtime/` 全量。
- 脱敏规则：日志上传前复核 `file:` URL 与 `DATABASE_URL=` 值已脱敏（runner `sanitizeError` 口径，CI 侧复核）；
  网络证据只记 pathname；`evidence_path` 只记相对仓库根路径。
- 留存：`retention-days: 30`。

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
