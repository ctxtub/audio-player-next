# 前代调度政策删除段落原文（HISTORICAL / DO NOT EXECUTE）

> 来源：`2f4910fe8f178bcf164406b6d16a9afa48820557` 落盘前的 current-state 文档。
> C7 已将其整段删除（不留「曾用」描述），现行规范见 `docs/testing/execution/isolation.md`（harness 真相）
> 与 `docs/testing/execution/maintenance.md`（catalog 驱动）。本文件仅追溯，严禁作为执行依据。

## A. `docs/testing/execution/isolation.md` 原 §3.2（首行 + 全文）

原首行：`### 3.2 原子 DSH Worker 托管 Mock 生命周期契约（Canonical Execution Contract）`

```text
### 3.2 原子 DSH Worker 托管 Mock 生命周期契约（Canonical Execution Contract）
每个原子 DSH Worker 独立拥有对其测试执行期间 Mock 服务的生命周期治理权，所有执行提示词必须强制遵守本契约：

1. **测试前置探测与启动（Pre-test Detection & Startup）**：
   - 探测 9301 端口：执行 `ss -ltn | grep -q ":9301 "`。
   - 若 9301 端口已存在监听：记录 `STARTED_MOCK=0`，复用既有 Mock 服务，**绝对不可**重复启动或覆盖 `.e2e-runtime/mock.pid`。
   - 若 9301 端口未监听：记录 `STARTED_MOCK=1`，使用项目真实本地启动器启动：
     ```bash
     (set -a; [ -f .e2e-runtime/env.e2e.sh ] && source .e2e-runtime/env.e2e.sh; set +a; nohup node .e2e-runtime/mock-openai.mjs > .e2e-runtime/mock.log 2>&1 & echo $! > .e2e-runtime/mock.pid)
     ```
2. **PID 追踪（PID Tracking）**：
   - 将启动的 Mock 进程 PID 保存至 `.e2e-runtime/mock.pid` 与 Worker 局部变量 `MOCK_PID`，明确生命周期所有权。
3. **健康检查端点与有界等待（Bounded Health Check）**：
   - 健康检查端点：`POST http://127.0.0.1:9301/v1/chat/completions`
   - 健康检查命令：
     ```bash
     curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:9301/v1/chat/completions \
       -H 'content-type: application/json' \
       -d '{"messages":[{"role":"user","content":"ping"}],"stream":false}'
     ```
   - 有界等待窗口：最长等待 10 秒（每 0.5 秒轮询一次，上限 20 次）。当返回 HTTP `200` 时判定服务就绪。
   - **启动失败熔断**：若超时未能返回 200 或进程崩溃，本次用例立即中止，判定结果直接标记为 `UNVERIFIED`，严禁继续推进业务断言。
4. **请求定向与环境保留（Traffic Redirection & Environment Preservation）**：
   - 应用与上游请求全部且仅定向至 `http://127.0.0.1:9301/v1`（`OPENAI_BASE_URL` 注入）。
   - 应用服务（31111 端口 next-server）与测试数据库（`.e2e-runtime/e2e.db`）持续保留，严禁跨用例重启应用，严禁清空或删除数据库。
5. **用例后置清理（Post-case Cleanup）**：
   - 测试用例执行完毕（无论成功、失败或未决）：
     - 若且仅若当前 Worker 启动了 Mock 进程（`STARTED_MOCK=1`）：读取 `.e2e-runtime/mock.pid`，执行 `kill $(cat .e2e-runtime/mock.pid)` 停止自身启动的 Mock 进程，并清理 pid 文件。
     - 若 9301 在用例执行前已存在（`STARTED_MOCK=0`）：必须保持其继续运行，**绝对不可**终止该预存监听。
     - 任何情况下，绝对不可改动或停止 31111 应用服务与 `.e2e-runtime/e2e.db`。
```

删除确认：现行 `isolation.md` 已无本节，mock/app 生命周期改为 harness 真相（`ownedMock` + 指针文件，谁拉起谁回收）。

## B. `docs/testing/execution/isolation.md` 原 §9 第 2 项（首行 + 全文）

原首行：`2. **DSH 调度治理铁律与执行契约**：`

```text
2. **DSH 调度治理铁律与执行契约**：
   - **共享环境单一执行 Worker**：同一 Git 工作区及共享 `.e2e-runtime` / `.e2e-results` 结果根任何时刻仅允许 1 个 E2E 执行 Worker；固定同一 SHA 的只读 review 可并行，但不得启动服务、写证据或清理进程。独立 worktree 只有分配独立 runtime/results 根与所有权后才能并行执行。
   - **显式 3 小时时限**：各任务启动显式配置 `--timeout 10800`，彻底杜绝默认时限杀进程导致未决。
   - **Worker 自主托管 Mock 生命周期**：严格执行 §3.2 规范契约（前置 9301 探测、本地真实启动器、PID 记录、有界健康检查、失败判定 `UNVERIFIED`、执行后仅清理自身启动进程、保留 31111 与数据库）。所有未来 DSH 提示词必须强制包含并遵从本契约。
   - **终态报告与证据门禁**：每个任务必须以合规 `report.md`、关键证据文件与终端 VERDICT 闭环为准，方可启动下一任务。
   - **上游 503/429 弹性退避**：捕获 503/429 时强制静默等待 60 秒，单任务重试上限 ≤ 3 次。
   - **运行时与数据库资产持续复用**：应用服务（31111）与测试数据库（`.e2e-runtime/e2e.db`）跨用例保持存活，严禁跨用例重启应用或删除数据库。
   - **准入通过项保护**：已通过终态验证与完整证据核验的用例予以保护，队列仅调度待执行或未决项。
```

删除确认：原 §9 整节已删除；调度改为 catalog 驱动（见现行 `maintenance.md` §4）。

## C. `docs/testing/execution/isolation.md` 原 §2/§8 相关行（31111 / 固定上游原文）

```text
| 服务端口 | `{{E2E_PORT}}` = 31111 | 与 dev(3000)/docker(38080) 隔离 |
| 数据库 | `{{E2E_DB_URL}}` = `file:{{E2E_RUNTIME_DIR}}/e2e.db` | 独立 SQLite；每轮执行前重建 |
| LLM/TTS 上游 | `{{E2E_MOCK_OPENAI}}` = `http://127.0.0.1:9301/v1` | 经 `OPENAI_BASE_URL` 注入 |
```

```text
   - Mock 生命周期收口：若本原子 Worker 在前置准备时启动了 Mock 进程（`STARTED_MOCK=1`），测试结束后必须且仅清理自身启动的该 Mock 进程（读取 `.e2e-runtime/mock.pid` 并 kill，随后删除 pid 文件）；若 9301 在用例执行前已处于监听状态（`STARTED_MOCK=0`），绝对不可终止该预存监听。
   - 应用与数据库保全铁律：绝对严禁终止、重启或干扰应用服务（31111 端口 next-server）；绝对严禁删除、重置或清空测试数据库 `.e2e-runtime/e2e.db`。
```

删除确认：端口改为 `31120-31150` 当次空闲端口，库改为 per-run 独占隔离库，收口改为 `ownedMock` 所有权语义。

## D. `docs/testing/execution/maintenance.md` 原编号/端口/时限/退避/手工总数行

```text
   - 父用例统一使用纯数字大写规范 ID：`E2E-XX-YY`（其中 `XX` 为套件编号 `01`..`06`，`YY` 为用例序号 `01`..`12`）。
   - 原子执行单元在父用例 ID 基础上扩展两位序号：`E2E-XX-YY-ZZ`（如 `E2E-01-06-01`、`E2E-01-06-02`）。
   - 严禁使用任何非规范前缀或别名。
```

```text
   - 测试服务统一使用隔离端口 `31111`，数据库指向 `.e2e-runtime/e2e.db`。
   - 外部 LLM 与 TTS 服务统一指向本地 Mock 服务 `http://127.0.0.1:9301/v1`。
```

```text
   - 任务启动显式配置超时时限 10800 秒。
   - 遇 503/429 错误时强制静默退避 60 秒，单任务重试上限 3 次。
```

```text
1. **规范完整性**：保持 59 个父场景文件与 62 个原子 case 的完整覆盖（H-21 一拆二后），不得遗漏功能路径。数量口径唯一以 `yarn test:static`（checker）输出为准，本文件不手维护第二份总数。
```

删除确认：编号改为 kebab-case `case_id` 唯一身份（`legacy_aliases` 仅回查），环境指向 `isolation.md` harness 真相，
时限/退避整段删除，手工总数删除（数量唯一以 `yarn test:static` 为准）。
