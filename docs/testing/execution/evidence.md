# 证据与留档规范（evidence）

本文档为新写，定义运行证据的目录结构、manifest 要求、指纹与脱敏规则。
私有运行产物不得入库，结论不得回写 catalog。

## 1. 目录结构

- runner 隔离库：`.e2e-runtime/test-db/<run-id>/<suite-id>.db`（父 runner 生成，子进程复用验证，执行后关闭并清理）。
- 运行证据根：`.e2e-results/<run-id>/`，按 suite/case 分目录存放。
- L3 证据路径：`.e2e-results/<run-id>/<case-id>/`（`case_id` 为语义名，如 `stop-audio-when-budget-exhausted`）。
- 失败时可把当次隔离库复制为 `.e2e-results/<run-id>/<suite-id>/db.sqlite` 后再清理 runtime，保留期由评审决定。

历史 E2E 证据（浏览器人工执行时代）沿用 `.e2e-results/<run-id>/E2E-xx-yy/` 结构，每用例至少包含截图、控制台、音频探针、网络清单与按需 DB 导出，详见 [隔离执行](./isolation.md) 第 7 节。

## 2. manifest 要求

每个 `<case-id>/` 目录必须有可机读的 manifest（JSON 或 JSONL 配套），至少包含：

```text
run_id, case_id, executable_id, assertion_id, surface, verdict, evidence_path
```

另建议包含：`commit`、`browser/version`（L3）、`fixture hash`、`mock hash`、`runner hash`、各 assertion 结果。
结构化运行结果是必要而非充分证据：assertion 记录只能在真实断言成功后产生，验收者还须审查被测生产链、负例/故障注入与实际原始证据。手写 PASS JSONL、扫描源码字符串均不能证明行为。

## 3. 指纹（可复现性绑定）

- 历史 PASS 复用必须绑定 `code/fixture/environment/oracle/runner hash`，任一变化即失效。
- L2/L3 的 DB 证据必须说明库来源为本 run 隔离库，不得引用共享开发库 `prisma/dev.db` 或生产库。
- `prisma/dev.db` 的存在状态、mtime、size、SHA-256 在关键任务前后只读记录，前后必须相同；绝不为验证而创建它。

## 4. 脱敏（秘密与载荷）

- 测试账号、密钥口令只存在于本地未入库的 `.e2e-runtime/.env.e2e`（或隔离环境变量），规范与代码库一律使用符号标识符：`{{E2E_USER_A}}`、`{{E2E_USER_B}}`、`{{E2E_PASS_A}}`、`{{E2E_SESSION_SECRET}}`。任何真实密码密钥严禁进入 Git。
- 网络证据只记 pathname，不记 query（批输入在 query 中，防载荷泄露）；非流响应保留安全 body 摘要（截断上限 + truncated 标记）。
- 运行产物在执行前后运行 `git status --porcelain` 自检，除预先授权的规范文件外必须保持工作区干净；证据目录本身已被 `.gitignore` 忽略，严禁 `git add`。
