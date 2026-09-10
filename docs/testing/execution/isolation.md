# 隔离执行设计（harness 真相）

本文档是浏览器 L3 harness 与全部隔离执行的共用前置。目标：**任何执行都碰不到生产/共享数据，也碰不到 git 工作区**。
实现口径以 `tests/system/browser/harness/` 代码为准；本文件只做规范转述，不另设政策。
前代调度政策原文已移入 [`docs/archive/governance-hardening-20260910/`](../../archive/governance-hardening-20260910/README.md)（历史追溯专用，非现行规范）。

## 1. 硬边界（违反任何一条即中止执行）

1. **严禁生产数据**：不连接、不读写生产数据库（Docker 生产路径 `/app/data/app.db`、生产端口 `38080`）；不触碰共享开发库 `prisma/dev.db`；任何 DB 断言只对当次隔离库执行。
2. **严禁真实凭证**：合成密钥只存在于进程内合成环境或本地未入库文件（已被 `.gitignore` 覆盖）；文档/仓库内一律使用符号标识符（第 5 节）。
3. **严禁外联**：LLM/TTS 上游一律指向当次常驻 mock（经 `OPENAI_BASE_URL` 注入，地址见指针文件）；不访问任何真实域名、不发真实网络请求。
4. **严禁污染 git**：快照前 tracked 树必须干净（第 3 节守卫）；所有运行时产物只写 `.e2e-runtime/`、`.e2e-results/`（git 忽略）。
5. **不修改应用源码**：测试执行阶段若需探针（如音频状态），通过浏览器 eval 读取既有 DOM/`<audio>` 元素，不改源码。

## 2. 环境设计（harness 真相）

| 项 | 值 | 说明 |
| --- | --- | --- |
| 应用端口 | `31120-31150` 范围内当次空闲端口 | `pickAppPort` 顺序取首个空闲；停止后确认释放 |
| 隔离库 | 快照内 `prisma/harness-<port>-<runTag>.db` | per-run 独占；启动时 `migrate deploy`；停止时删除 |
| 构建期库 | 快照内 `prisma/harness-build.db` | 仅 `next build` 收集页用，与运行时库分离 |
| 会话密钥 | 进程内合成随机值 | `buildSnapshotEnv` 每次启动合成，不落盘 |
| LLM/TTS 上游 | 当次常驻 mock 地址（`mockUrl + /v1`） | `OPENAI_BASE_URL` 注入；端口由 `mock-port-<run>.json` 记录 |
| 模型名 | 合成假名 | mock 端识别用，不对应真实模型 |
| 浏览器 | Playwright 独立上下文 | 每用例独立会话，用例开始前清状态 |

## 3. production 快照（`git archive HEAD` + 前置守卫）

快照构建（`ensureSnapshot`）只打包 tracked 文件（`.env` 系、`.db`、`.next`、`node_modules` 天然排除），
`node_modules` 以只读 symlink 回真仓库，快照内补 `prisma generate`，随后在构建期隔离库上 `migrate deploy` + `next build`。
快照键为 commit 完整 SHA（目录名兼容 short/full，manifest 与日志记 full；`unknown` 禁止构建，直接抛 `BLOCKED`）。

前置守卫（取锁前 fast-path 先验、取锁后锁内复验；缓存命中路径同样先验，脏树即使快照已就绪也拒绝复用）：

- 脏 tracked 树拒绝：`git status --porcelain=v1 --untracked-files=no` 非空即抛 `BLOCKED`（信息仅含前 20 行脏文件状态行，不含 secrets）；untracked（`??`）不阻断。
- `EXPECTED_TARGET_SHA` 绑定：环境变量非空时，`git rev-parse HEAD`（full）必须与其相等（允许短 SHA 前缀等价，规范要求 full；失配信息仅含 `expected/actual` 短 SHA）。
- 守卫失败归 `BLOCKED`（环境/供给不可证），不得记 FAIL/FLAKY；`globalSetup` 透出后整轮不跑业务断言。

## 4. 服务拉起与指针文件

`globalSetup` 拉起 detached 常驻 mock（setup 进程退出后继续存活）与隔离 production server（unref 常驻），
将当次 run 地址写入运行时指针文件；回收由 `globalTeardown` 按持久化 handle 跨进程完成。

| 文件（`.e2e-runtime/browser-harness/` 下） | 内容 |
| --- | --- |
| `active.json` | 当次指针：`runId/appUrl/appPort/mockUrl/mockPort/mockPid/commit` |
| `app-handle-<run>.json` | app 持久化 handle：`port/pgid/dbFile`（teardown 跨进程回收用） |
| `mock-port-<run>.json` | mock 端口文件：`port/pid`（setup 等待其出现后继续） |

`active.json` 缺失时 teardown 直接通过（setup 未成功，无服务可收）；回收后删除指针与过程文件。

## 5. mock/app 所有权（谁拉起谁回收）

- `startAppServer({ mockBaseUrl })`：调用方显式传入上游时不拉 mock；缺省时自动拉起自有 mock 并置 `ownedMock=true`，`stopAppServer` 按句柄 kill 子进程树 → 确认端口释放 → 清理本次隔离库 → 回收自有 mock（`ownedMock` 为真且有 handle 时）。
- `globalSetup` 的常驻 mock 由 `globalTeardown` 按 `active.json` 指针回收（`stopMockServerByPid` + 删 `mock-port-<run>.json`）；启动失败时 setup 内联回收已拉 mock，不留孤儿。
- 启动失败（health 超时）时：kill 服务树 → 删本次隔离库 → 回收自有 mock 后再抛。
- 禁止 broad kill/rm：只回收指针与句柄名下的自有进程、端口与库文件；生产端口与共享库永不触碰。

## 6. 数据准备与夹具

- 注册类账号经 `/auth` UI 注册生成（同时验证注册链路），或用当次隔离库 + Prisma 直插 seed 脚本（存 `.e2e-runtime/seed.mjs`，不入库）。
- 访客身份：浏览器清状态后经「访客进入」按钮创建，服务端签发签名 token；需要固定访客时用 seed 指定仓库内可见的假 ID（仅 seed 名义 ID，不含真实凭证）。
- 故事夹具：mock 上游固定 4 段文本 ⇒ `{{E2E_STORY_4P}}`；其段落哈希记为 `{{E2E_STORY_HASH}}`，供断点恢复断言。
- 进度夹具：seed 一行播放进度（指向 `{{E2E_STORY_4P}}` 源，`nextParagraphIndex=2`、`remainingAllowedMs=null|数值` 两变体）。

## 7. 符号标识符表（仓库内唯一允许的引用方式）

| 符号 | 含义 | 真值存放 |
| --- | --- | --- |
| `{{E2E_USER_A}}` / `{{E2E_PASS_A}}` | 注册账号 A 及其口令 | 本地未入库环境 |
| `{{E2E_USER_B}}` / `{{E2E_PASS_B}}` | 注册账号 B（隔离/切号用例） | 同上 |
| `{{E2E_SESSION_SECRET}}` | 测试会话密钥 | 进程内合成（harness）或本地未入库环境 |
| `{{E2E_PORT}}` | 当次隔离端口（`31120-31150` 内） | 指针文件（非敏感） |
| `{{E2E_DB_URL}}` | 当次隔离库地址 | 持久化 handle（非敏感） |
| `{{E2E_MOCK_OPENAI}}` | 当次 mock 上游基址 | 指针文件（非敏感） |
| `{{GUEST_FRESH}}` | 每用例新建访客（清状态后进入） | 运行时产生 |
| `{{GUEST_JAR_1}}` / `{{GUEST_JAR_2}}` | 并行双访客上下文 | 运行时产生 |
| `{{E2E_STORY_4P}}` / `{{E2E_STORY_HASH}}` | 4 段固定故事夹具/其哈希 | seed 生成 |
| `{{E2E_PROMPT_SMOKE}}` / `{{E2E_PROMPT_1..3}}` / `{{E2E_PROMPT_DRAFT}}` | 固定输入短语（冒烟/连击/预载草稿用，mock 端按序识别） | 本地未入库环境 |
| `{{E2E_MOCK_SWITCHES}}` | mock 故障注入开关集 | 本地未入库环境 |

## 8. DB 只读观测（允许语句）

```bash
node -e "const{createClient}=require('@libsql/client');(async()=>{
  const db=createClient({url:'file:.e2e-runtime/browser-harness/snapshots/<sha>/prisma/harness-<port>-<runTag>.db'});
  const r=await db.execute('select \"userId\",count(*) c from ChatMessage group by 1');
  console.log(r.rows);
})()"
```

约束：只读 `SELECT` 与 `PRAGMA integrity_check`；对象仅为当次隔离库；测试库表见 `prisma/schema.prisma`。
`prisma/dev.db` 与生产库只做存在/mtime/size/SHA 只读指纹比对，绝不打开读写、绝不为验证而创建。

## 9. 证据规范（`.e2e-results/`，git 忽略）

目录：`.e2e-results/browser/<run-id>/<case-id>/`，结构化行协议与 manifest 口径见 [证据与留档](./evidence.md)（v1：每 assertion 一行）。
历史人工执行证据沿用 `.e2e-results/<run-id>/E2E-xx-yy/` 结构，每用例至少包含截图、控制台、音频探针、网络清单与按需 DB 导出。

## 10. 清理规范

- 用例级：浏览器状态清理（清空 cookie + `localStorage` + `sessionStorage`）；必要时对该用例造的数据做 `DELETE`（仅限当次隔离库）。
- 服务级：按第 5 节所有权回收（自有 mock 随 handle 回收；常驻 mock/app 随 teardown 按指针回收并确认端口释放；本次隔离库文件删除）。
- 批次级：重建浏览器上下文；核对快照守卫口径的 tracked 树状态。
- 全局：全量套件执行完毕并完成独立留档后，方可停止常驻 mock 与 production server，保留 `.e2e-results/` 供评审（本地）。

## 11. 调度说明

执行调度以 catalog 为准（`lifecycle_status`/`executable_ids`/`ci_tier`），`MANUAL` 不进自动队列；数量口径以 `yarn test:static` 为准。
详见 [维护规范](./maintenance.md)。

## 12. 写库单元防损坏标准流程（缺陷 #6，06-07 实证固化）

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

## 13. 流观察 hook 不消费流标准（缺陷 #7 实证固化）

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

## 14. `git status` 自检边界

- 快照守卫（第 3 节）：`git status --porcelain=v1 --untracked-files=no`，只看 tracked；`??` 不阻断。
- 运行前后自检：执行前后各跑一次 `git status --porcelain`，除预先授权的规范文件外必须干净；
  证据与运行时目录本身已被 `.gitignore` 忽略，严禁 `git add`。
- 自检只读状态、不读内容：绝不为自检而打开 `.env` 系文件或数据库。
