# E2E 隔离执行设计（通用规范）

本文档是全部功能套件（01..06）的共用前置。目标：**让任何 E2E 执行都碰不到生产/共享数据，也碰不到 git 工作区**。

## 1. 硬边界（违反任何一条即中止执行）

1. **严禁生产数据**：不连接、不读写生产数据库（Docker 生产路径 `/app/data/app.db`、生产 38080 端口）；不触碰共享开发库 `prisma/dev.db`；任何 DB 断言只对 `{{E2E_DB_URL}}` 执行。
2. **严禁真实凭证**：测试账号口令、`SESSION_SECRET`、`OPENAI_API_KEY` 只存在于本地未入库文件 `.e2e-runtime/.env.e2e`（已被 `.gitignore` 覆盖）；文档/仓库内一律使用符号标识符（第 5 节）。
3. **严禁外联**：LLM/TTS 上游一律指向本地 mock `{{E2E_MOCK_OPENAI}}`（经 `OPENAI_BASE_URL` 注入）；不访问任何真实域名、不发真实网络请求。
4. **严禁污染 git**：执行前后 `git status --porcelain` 必须为空（仅允许 docs/e2e 下的新增资产）；所有运行时产物只写 `.e2e-results/`、`.e2e-runtime/`。
5. **不修改应用源码**：测试执行阶段若需探针（如音频状态），通过浏览器 eval 读取既有 DOM/`<audio>` 元素，不改源码。

## 2. 环境设计

| 项 | 值 | 说明 |
| --- | --- | --- |
| 服务端口 | `{{E2E_PORT}}` = 31111 | 与 dev(3000)/docker(38080) 隔离 |
| 数据库 | `{{E2E_DB_URL}}` = `file:{{E2E_RUNTIME_DIR}}/e2e.db` | 独立 SQLite；每轮执行前重建 |
| 会话密钥 | `{{E2E_SESSION_SECRET}}` | 仅存 `.e2e-runtime/.env.e2e` |
| LLM/TTS 上游 | `{{E2E_MOCK_OPENAI}}` = `http://127.0.0.1:9301/v1` | 经 `OPENAI_BASE_URL` 注入 |
| 模型名 | `{{E2E_MODEL_STORY}}` / `{{E2E_MODEL_AGENT}}` / `{{E2E_TTS_MODEL}}` | mock 端识别用假名 |
| 浏览器 | agent-browser MCP，每用例独立会话 | 用例开始前清 cookie/storage |

标准启动命令（执行阶段使用，本阶段不运行）：

```bash
# 1) 临时环境目录（git 忽略）
mkdir -p .e2e-runtime .e2e-results
# 2) 隔离库结构部署（仓外路径）
DATABASE_URL=file:.e2e-runtime/e2e.db npx prisma migrate deploy
# 3) mock 上游（脚本存于 .e2e-runtime/，不入库）
node .e2e-runtime/mock-openai.mjs   # /v1/chat/completions(SSE) + /v1/audio/speech(固定 MP3)
# 4) 应用（读取 .e2e-runtime/.env.e2e 中的敏感值后导出）
yarn dev -p 31111
```

## 3. mock 上游设计与 Worker 生命周期托管契约（`.e2e-runtime/mock-openai.mjs`）

### 3.1 服务端能力与路由规范
- `POST /v1/chat/completions`：按请求序返回可配置的 SSE 故事流（固定 4 段文本，每段约 200 字，段落边界稳定），支持注入故障：`500`、慢速（延时发 token）、中途断流。
- `POST /v1/audio/speech`：返回固定短 MP3 字节（约 2s），响应头含时长，保证 `<audio>` 断言（duration≈2s）稳定。
- 故障注入开关由环境变量 `MOCK_FAIL_TTS=1`、`MOCK_FAIL_LLM=1`、`MOCK_SLOW_LLM_MS=…` 控制，另支持 `MOCK_ABORT_LLM=1`（流中途断开）、`MOCK_SLOW_TTS_MS=…`（TTS 慢速，放大段落切换窗口），供 02/04/05/06 各功能套件复用。
- 保留位声明（R4 实证固化）：`MOCK_FAIL_CONFIG`（`config.get` 失败）、`MOCK_FAIL_CONFIG_UPDATE`（`config.updateMine` 失败）、`MOCK_FAIL_MIGRATE_STEP`（注册迁移中途失败）在上游 Mock 与应用代码中**均无读取实现**（mock 仅头部注释透传记录）。`config.*`/注册迁移均为应用层 tRPC，不经过上游 Mock，故障须走应用层/调用侧等价注入（04-03 页内 fetch hook 范式、05-02 caller 写点包装范式）；01-05 初始化失败面运行时不可达，见各用例规范。

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

## 4. 数据准备与夹具

- 注册类账号经 `/auth` UI 注册生成（同时验证注册链路），或用 `{{E2E_DB_URL}}` + Prisma 直插 seed 脚本（存 `.e2e-runtime/seed.mjs`）。
- 访客身份：浏览器清 cookie 后经「访客进入」按钮创建，服务端签发 `guest=<opaque 签名 token>`（验签还原出 `g_` 开头 gid，不以明文 `g_` 存放；响应体不返 `guestId`）；需要固定访客时用 seed 指定 `g_e2e_seed1` 这类**仓库内可见的假 ID**（仅 seed 名义 ID，不含真实凭证）。
- 故事夹具：mock 上游固定 4 段文本 ⇒ `{{E2E_STORY_4P}}`；其段落哈希记为 `{{E2E_STORY_HASH}}`，供断点恢复断言。
- 进度夹具：seed 一行 `UserPlaybackProgress`/`GuestPlaybackProgress`（指向 `{{E2E_STORY_4P}}` 源，`nextParagraphIndex=2`、`remainingAllowedMs=null|数值` 两变体）。

## 5. 符号标识符表（仓库内唯一允许的引用方式）

| 符号 | 含义 | 真值存放 |
| --- | --- | --- |
| `{{E2E_USER_A}}` / `{{E2E_PASS_A}}` | 注册账号 A 及其口令 | `.e2e-runtime/.env.e2e` |
| `{{E2E_USER_B}}` / `{{E2E_PASS_B}}` | 注册账号 B（隔离/切号用例） | 同上 |
| `{{E2E_SESSION_SECRET}}` | 测试会话密钥 | 同上 |
| `{{E2E_PORT}}` | 隔离端口 31111 | 本文件（非敏感） |
| `{{E2E_DB_URL}}` | 隔离库地址 | 本文件（非敏感） |
| `{{E2E_MOCK_OPENAI}}` | mock 上游基址 | 本文件（非敏感） |
| `{{GUEST_FRESH}}` | 每用例新建访客（清 cookie 后进入） | 运行时产生 |
| `{{GUEST_JAR_1}}` / `{{GUEST_JAR_2}}` | 并行双访客上下文 | 运行时产生 |
| `{{E2E_STORY_4P}}` / `{{E2E_STORY_HASH}}` | 4 段固定故事夹具/其哈希 | seed 生成 |
| `{{E2E_PROMPT_SMOKE}}` / `{{E2E_PROMPT_1..3}}` / `{{E2E_PROMPT_DRAFT}}` | 固定输入短语（冒烟/连击/预载草稿用，mock 端按序识别） | `.e2e-runtime/.env.e2e` |
| `{{E2E_MOCK_SWITCHES}}` | mock 故障注入开关集（§3 全部 `MOCK_*` 变量） | `.e2e-runtime/.env.e2e` |

## 6. DB 只读观测（AUT-API 断言方式）

```bash
node -e "const{createClient}=require('@libsql/client');(async()=>{
  const db=createClient({url:'file:.e2e-runtime/e2e.db'});
  const r=await db.execute('select \"userId\",count(*) c from ChatMessage group by 1');
  console.log(r.rows);
})()"
```

约束：只读 SELECT；测试库表见 `prisma/schema.prisma`（`User`、`ChatMessage`、`GuestChatMessage`、`UserConfig`、`GuestConfig`、`GenerationHistory`、`GuestGenerationHistory`、`PromptHistory`、`GuestPromptHistory`、`UserPlaybackProgress`、`GuestPlaybackProgress`）。

## 7. 证据规范（`.e2e-results/`，git 忽略）

目录：`.e2e-results/<run-id>/E2E-xx-yy/`，每用例至少包含：

1. `ui-*.png` — 关键步骤截图（含失败态）。
2. `console.json` — 每步后的控制台记录（判定：除「预期报错」用例外零未捕获异常）。
3. `audio.json` — `<audio>` 探针快照（`src` 前缀、`paused`、`currentTime`、`duration`、`playbackRate`）。
4. `network.json` — tRPC 调用清单（`performance.getEntriesByType('resource')` 过滤 `/api/trpc/`）。
5. `db.txt` — 相关只读查询输出（如适用）。

## 8. 清理规范

- 用例级：
  - 浏览器状态清理：清空 cookie + `localStorage` + `sessionStorage`；必要时对该用例造的数据做 `DELETE`（仅限 `{{E2E_DB_URL}}`）。
  - Mock 生命周期收口：若本原子 Worker 在前置准备时启动了 Mock 进程（`STARTED_MOCK=1`），测试结束后必须且仅清理自身启动的该 Mock 进程（读取 `.e2e-runtime/mock.pid` 并 kill，随后删除 pid 文件）；若 9301 在用例执行前已处于监听状态（`STARTED_MOCK=0`），绝对不可终止该预存监听。
  - 应用与数据库保全铁律：绝对严禁终止、重启或干扰应用服务（31111 端口 next-server）；绝对严禁删除、重置或清空测试数据库 `.e2e-runtime/e2e.db`。
- 批次级：重建浏览器上下文；核对 `git status --porcelain` 为空（仅允许 docs/e2e 下授权规范资产）。
- 全局：全量测试套件执行完毕并完成独立留档后，方可全局停止 mock 与 next dev 进程，保留 `.e2e-results/` 供评审（本地）。

## 9. 执行顺序与调度治理（套件顺序 01 → 02 → 03 → 04 → 05 → 06）

1. **执行序列与调度拓扑**：
   - 六大功能套件按 `01 → 02 → 03 → 04 → 05 → 06` 串行调度。
   - 场景、原子 case、声明自动化、已实现与缺口数量唯一以 `yarn test:static` 输出为准；本文不维护第二份手工总数或连续序号。
   - 自动调度集合以 `tests/test-catalog.yaml` 的 `lifecycle_status`、`executable_ids` 与 `ci_tier` 为准；`MANUAL` case 不进入自动执行队列。
   - **人工排除项**：`E2E-06-08`（bfcache/pageshow 探针，MANUAL，P3）保持 `manual_excluded`，移出自动化执行队列。
2. **DSH 调度治理铁律与执行契约**：
   - **共享环境单一执行 Worker**：同一 Git 工作区及共享 `.e2e-runtime` / `.e2e-results` 结果根任何时刻仅允许 1 个 E2E 执行 Worker；固定同一 SHA 的只读 review 可并行，但不得启动服务、写证据或清理进程。独立 worktree 只有分配独立 runtime/results 根与所有权后才能并行执行。
   - **显式 3 小时时限**：各任务启动显式配置 `--timeout 10800`，彻底杜绝默认时限杀进程导致未决。
   - **Worker 自主托管 Mock 生命周期**：严格执行 §3.2 规范契约（前置 9301 探测、本地真实启动器、PID 记录、有界健康检查、失败判定 `UNVERIFIED`、执行后仅清理自身启动进程、保留 31111 与数据库）。所有未来 DSH 提示词必须强制包含并遵从本契约。
   - **终态报告与证据门禁**：每个任务必须以合规 `report.md`、关键证据文件与终端 VERDICT 闭环为准，方可启动下一任务。
   - **上游 503/429 弹性退避**：捕获 503/429 时强制静默等待 60 秒，单任务重试上限 ≤ 3 次。
   - **运行时与数据库资产持续复用**：应用服务（31111）与测试数据库（`.e2e-runtime/e2e.db`）跨用例保持存活，严禁跨用例重启应用或删除数据库。
   - **准入通过项保护**：已通过终态验证与完整证据核验的用例予以保护，队列仅调度待执行或未决项。
3. **提交门禁**：全部执行 + 独立评审完成之前，测试资产不得 commit/push（本轮约定）。

## 10. 写库单元防损坏标准流程（缺陷 #6，06-07 实证固化）

- 背景：app dev server 常驻持有隔离库连接时，seed 并发写曾致 SQLite 页损坏；
  后续轮以本流程规避成功，现固化为一切直接写库单元（seed/回滚/GC 准备）的强制流程。
- 流程（`scripts/e2e-db-guard.mjs` 为跟踪执行器，`tests/test-e2e-db-guard.ts` 为契约测试）：
  1. 准入 `check {{E2E_DB_URL}}`：共享/错误库（`prisma/dev.db`、`/app/data/app.db`、疑似生产库）
     直接 `FORBIDDEN` 拒绝（路径先剥 `file:` 前缀与 query/fragment，再大小写不敏感规范比较，
     已存在路径含 symlink 经 realpath 穿透复判）；库旁 `<db>.lock`、环境变量锁文件或活跃排他锁存在时 `LOCKED` 拒绝，
     缺失库 `MISSING` 拒绝（建连接前，libsql 不得创建空库）；失败而不是硬写。
  2. 写前 `snapshot {{E2E_DB_URL}}`（末行输出快照路径，损坏可回退）：与写库受同一排他守卫约束，
     确认无锁后拷贝主库并附带 `-wal`/`-shm` 一致拷贝（WAL 安全）。
  3. 串行单连接写库 `write {{E2E_DB_URL}} "<sql>"`：单 client（等价 `connection_limit=1`）+
     `PRAGMA busy_timeout=5000`，一次一条语句，同连接随即 `integrity_check`；
     Prisma 写库 URL 同步追加 `?busy_timeout=5000&connection_limit=1`；
     同一用例内一次只跑一个写操作，严禁与常驻 app 写并发；
     强制备份前置——目标库同目录无 `.snap-*.db` 快照时 `BACKUP_REQUIRED` 拒绝，须先 snapshot。
  4. 每阶段 `verify {{E2E_DB_URL}}`（`PRAGMA integrity_check` 必须 `integrity=ok`）；
     任一阶段失败即 `restore <快照> {{E2E_DB_URL}}` 后中止本单元并判 `UNVERIFIED`；
     `restore` 同样受排他守卫约束，按快照恢复 `-wal`/`-shm`（快照中不存在的 sidecar 在目标库上清除）。
- 禁止事项：手写 SQL 以外低阶修复（如 `.recover`）；未经快照的直接写库；
  对 `prisma/dev.db` 与生产库执行本流程（隔离库专用）。

## 11. 流观察 hook 不消费流标准（缺陷 #7 实证固化）

- 背景：旧观察 hook 用 `clone().text()` 读取 tRPC 流响应做 `network.json` 证据；
  当应用已持有流 reader（流式端点常态）时 clone 必抛 body 消费类异常，旧实现
  把它记为请求失败——成功流也被报取消类失败，观察证据失真。
- 铁律（`scripts/e2e-stream-observe.mjs` 为跟踪实现，`tests/test-e2e-stream-observe.ts` 为契约测试）：
  1. 流式响应（或 body 已锁定）只记可验证元数据（状态、content-type、响应建立），
     绝不调用 clone/text/cancel，绝不消费或取消流；hook 原样返回响应原对象。
  2. 消费/取消类异常（AbortError、terminated、`Body has already been consumed` 等）
     verdict 一律为 `cancelled`，绝不记为失败；实现中不存在 `failed` verdict。
  3. “流成功”证据固定为 UI + 后端日志 + 下游调用三角互证，hook 不对流做成功断言。
  4. 非流响应保留安全 body 摘要（截断上限 + truncated 标记）；记录只含 pathname，
     不记 query（批输入在 query 中，防载荷泄露）。
- 禁止事项：对流式响应调用 clone/text；把取消类异常记为失败；用 hook body 断言流成功。
