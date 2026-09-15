# M10-05-H1 · 生成历史回放 Anchor 抖动归因（诊断性 observability）

- 日期：2026-09-15（dated spec，冻结快照）
- change-id：M10-05-H1
- 角色：诊断 / 取证（不修产品、不修 oracle、不放宽阈值）
- 工作目录：仓库根（`/Users/tensho/Developments/audio-player-next`）
- 基线 SHA：`e12bb10fa3fc021ad0d2a33dbd653c404236798f`（分支 `feat/story-library-upgrade-20260912`，工作树干净）
- 诊断代码 SHA（取证所用）：`218a787880462af486e934a58bf56ff84b4f64f8`
- 结论：**REPRODUCED（第 3 轮命中）**；状态轨迹 = **A（现象层）**；责任层 = **harness/test 侧直连 DB 读与产品 anchor 写竞争**（非产品身份/覆盖逻辑缺陷）。
- 本项只做诊断；**不实施修复**、不解除 M10-05、不 push。

## 1. 被诊断现象

`tests/system/browser/scenarios/story-playback-global-controls-reachable.spec.ts:204`（用例「M9-F01 生成历史回放走正式 Work Session 且全局控制同帧可达」）在 full-suite WebKit 下间歇失败：

```
Expected: "work"
Received: "draft"
  at story-playback-global-controls-reachable.spec.ts:241
  await expect.poll(() => safeAnchorKind(dbFile, prompt), { timeout: 30000 }).toBe("work");
```

既有事实（不重复论证）：isolated webkit `retries=0 --repeat-each=3` × 2 批 = 6/6 绿；full-suite 已 3 次独立失败；分类 `FLAKY / FULL_SUITE_CONTEXT_SENSITIVE`，根层未定。

## 2. 观测设计与约束

- oracle、断言、超时、等待、分母、`retries=0` 全部保持原样；无 skip/fixme/retry/sleep。
- 新增 test-only/helper-only 诊断：
  - `tests/system/browser/scenarios/helpers/h1-diagnostics.ts`（新增，604 行）：单调 ms 时间线；网络（`playback.*` 请求/响应/失败，脱敏并截断）、页面内 probe 变化采样（100ms，仅签名变化落点）、capture 阶段点击事件、server Anchor / Work rows 直连只读快照；环形上限 5000；**仅 FAIL 落盘**（`testInfo.outputPath` + `.e2e-results/browser/<runId>/<project>__h1-diagnostics/`），PASS 静默。
  - H1 spec 内的 mark 采样（点击前 / 点击返回 / reload / finalize 等）与 `afterEach` finalize。
- 未新增任何产品 runtime probe；未改产品代码。
- 复现预算：最多 5 轮完整 full-suite（chromium + webkit，同 SHA，轮间不改 tracked file），命中即停；命中后 artifact 必须完整方可归因。

## 3. 轮次结果

命令：`npx playwright test --config tests/system/browser/playwright.config.ts --project=chromium --project=webkit`（完整分母 62）。

| 轮次 | 起（UTC） | 止（UTC） | 结果 | 失败定位 |
|---|---|---|---|---|
| 1 | 07:15:51 | 07:20:48 | 61 passed / 1 failed（exit 1） | chromium `m7-p3a-closure.spec.ts:60`（与本项无关：pause 后 probe status 期望 `paused` 实得 `playing`，30s 超时）；**H1 目标用例 PASS** |
| 2 | 07:20:48 | 07:25:24 | 62 passed / 0 failed（exit 0） | —；**H1 目标用例 PASS** |
| 3 | 07:25:24 | 07:31:39 | 58 passed / 4 failed（exit 1） | 全为 webkit：`canonical-work-playback:42`（waitForFunction 30s）、`expanded-sleep-timer:41`（`main-chrome` toBeAttached 15s）、`main-navigation-route-journey:26`（waitForURL `**/library` 15s）、**`story-playback-global-controls-reachable:204`（目标命中）** |
| 4 / 5 | — | — | 未执行 | runner 检测到目标命中，打印 `H1_TARGET_REPRODUCED round=3` 并停止剩余轮次 |

- 第 3 轮 runId：`2026-09-15T07-25-24-943Z-56ef9b`，app 端口 31120。
- 第 3 轮同轮另有 3 个 webkit 超时失败，说明该轮环境整体退化（慢/竞争），与 H1 命中同源背景一致；但 H1 命中本身有精确 500 证据，不依赖该退化推断。

## 4. 命中证据

### 4.1 artifact

- `tests/system/browser/.e2e-results/playwright/test-results/scenarios-story-playback-g-4ec93-放走正式-Work-Session-且全局控制同帧可达-webkit/h1-diagnostics.json`
- `.e2e-results/browser/2026-09-15T07-25-24-943Z-56ef9b/webkit__h1-diagnostics/h1-diagnostics.json`
  - size 31661 B；sha256 `309f54d0a306d172aeb4e295bde85d1b2f4fabe5adc21ca4b68c1d89b839db82`
- 计数：`network=8, page=4, node=8, probeChanges=1, clicks=3, dropped=0, total=20`。

### 4.2 ms 时间线（`t_ms` 相对用例起点）

| t_ms | 事件 | 关键内容 |
|---|---|---|
| 150 | NET REQ `beginSession` | 生成流自动播放：`source.kind=draft`，`messageId=assistant-e85d37ac…`，`sessionId=c46d1f30-…` |
| 159 | NET RES `beginSession` | 200，`state=ready` |
| 1731 / 1738 | NET REQ/RES `completeSession` | 200，`state=ended` |
| 3215 | SNAP `generate-complete` | probe=draft/ended；anchor=`draft`/`srcId=assistant-e85d37ac…`/`sess=c46d1f30-…`/`ended`；workRows=[27,28] |
| 5264 | SNAP `client-detached` | `page.goto(about:blank)`，probe absent；anchor 仍 draft/ended |
| 5300 / 5321 | NET REQ/RES `getAnchor` | 200，draft/ended |
| 5900 | SNAP `reloaded-chat` | probe=draft/`ready`；anchor=draft/ended |
| 7954 | PROBE | `{kind:draft, workId:null, messageId:assistant-e85d37ac…, sessionId:c46d1f30-…, status:ready, continuationMode:finite}` |
| 7975 / 8042 | CLICK | 「打开历史」、tab 切换（非回放） |
| 8082 | SNAP `before-replay-click` | probe=draft/ready；anchor=draft/ended；workRows=[27,28] |
| 8121 | CLICK | **真实回放项**：`aria-label=回放此故事`，`itemIndex=0/2`，item 文本含该 Work（`…请讲一个动物朋友互相帮助的故事…`） |
| 8125 | NET REQ `beginSession` | **正确**：`source={kind:work, workId:28}`、`mode=restart`、新 `sessionId=077a24ec-3079-47d7-bf38-f40c87ee62fb` |
| 8163 | SNAP `replay-click-returned` | probe=draft/ready；anchor=draft/ended（该快照含 2 次直连只读） |
| 8184 | NET RES `beginSession` | **500**（见 4.3） |
| 37852 | SNAP `finalize:failed` | probe=draft/ready；anchor=draft/ended；workRows=[27,28]（自始至终未变） |

### 4.3 500 响应体（原文，已脱敏）

```json
{"error":{"json":{"message":"\nInvalid `prisma.guestPlaybackAnchor.upsert()` invocation:\n\n\nOperation has timed out","code":-32603,"data":{"code":"INTERNAL_SERVER_ERROR","httpStatus":500,"path":"playback.beginSession"}}}}
```

即：产品的 Work 回放**确实**发起了正确的 `beginSession(work 28)`，但服务端 `guestPlaybackAnchor.upsert()` 抛 Prisma `P1008`「Operation has timed out」，HTTP 500；客户端 `beginPlayback` 失败并中止，**没有任何 work anchor 写入**。

## 5. 因果链（可复现证明）

1. **DB 锁配置脆弱**：隔离库实测 `PRAGMA journal_mode=delete`、`PRAGMA busy_timeout=0`（快照 `harness-build.db`；运行时库由同一 `prisma migrate deploy` 新建，Prisma 默认不设 WAL）。`lib/db.ts` 以 `new PrismaLibSql({ url })` 建连，未传 busy timeout；`node_modules/libsql/index.js:93` 默认 `timeout = opts?.timeout ?? 0.0`，即不等待锁。
2. **错误映射**：`@prisma/adapter-libsql` 的 `mapDriverError` 把 SQLITE_BUSY（`rawCode=5`）映射为 `kind:"SocketTimeout"`（dist 第 242-245 行）；Prisma runtime 把 `SocketTimeout` 渲染为 `P1008`，消息正是 **"Operation has timed out"**。故 4.3 的 500 = 底层 SQLITE_BUSY。
3. **竞争可达性实验**（本项新增的确定性复现）：
   - 单独的 libsql 写入 2ms 成功；持锁读者（`BEGIN; SELECT; sleep; COMMIT`）在旁时 → `SQLITE_BUSY: database is locked`。
   - **短读**压力：1 个 writer 连续 400 次 `INSERT`，并发另一进程 500 次 auto-commit `sqlite3 "SELECT count(*)…"` → **`busy=4`**（`SQLITE_BUSY: database is locked`）。证明测试进程的短直连读足以触发该错误。
4. **本次失败的具体对撞**：8125ms 产品写请求在途；8163ms 诊断的 `replay-click-returned` 快照对同一 DB 发起直连只读；8184ms 写入以 SQLITE_BUSY（→500）失败。test 侧直连读与 app 写在同一窗口对撞。
5. **现象闭合**：写失败 → anchor 保持 `draft`/`sess=c46d1f30…` → `expect.poll(safeAnchorKind)` 30s 内恒为 `draft` → FAIL；probe 因 `beginPlayback` 抛错从未进入 work。

## 6. 归因

### 6.1 状态轨迹：A（现象层）

- 真实点击项身份明确：`回放此故事`，`itemIndex=0/2`，对应 Work 28（`newestWorkId`）。
- 产品行为正确：发起 `beginSession({kind:work, workId:28, mode:restart})`，新 sessionId。
- 点击后 Probe **从未**进入目标 Work 身份（全程 draft/`c46d1f30…`）。
- 无任何「Work 已建立后被覆盖」证据。

### 6.2 反证 B（产品 supersede 竞争）：不成立

全 artifact 仅 2 次 `beginSession`：150ms（draft 自动播放）与 8125ms（work 回放）。work 之后**没有**任何 draft `beginSession`；anchor 的 `sourceType/sourceId/sessionId` 自 150ms 起从未改变。故不存在「work 建立 → 后被 draft 覆盖」。

### 6.3 反证 C（Anchor 持久化/检查点竞争）：不成立

C 的前提是「客户端 Probe 已稳定 work、server Anchor 仍 draft」。实测 `probeChanges=1`（仅初始采样），最终 probe 仍 `{kind:draft, sessionId:c46d1f30…}`。work 写从未成功，谈不上「Probe work 而 Anchor draft」。

### 6.4 责任层

**harness/test 侧观测方式 + 隔离库锁配置**，非产品身份/覆盖逻辑缺陷：

- 触发动作：test 进程对**活动 app 正在写的同一个 SQLite 文件**做直连 `sqlite3` 读（既有 oracle 的 `safeAnchorKind` 轮询，以及 H1 诊断快照），与 `guestPlaybackAnchor.upsert()` 的提交窗口对撞。
- 放大条件：`journal_mode=delete`（读者阻塞写者提交）+ `busy_timeout=0` / libsql `timeout=0`（不重试、立即 SQLITE_BUSY）。
- 产品侧仅有韧性缺口（对瞬时 SQLITE_BUSY 无重试），不是身份或覆盖逻辑错误。

> 说明：本 artifact 未直接证明锁持有者身份（SQLite 不报告持锁方）；证据指向 test 侧直连读（时间窗 8163ms 的读 vs 8184ms 的写，且该时刻 H1 页无其他网络活动）。app 内部多连接读竞争为次要可能，本次未被证据支持。

## 7. 诊断扰动评估（如实披露）

- `replay-click-returned` 快照在 8163ms 的直连只读落在产品写窗口内，**可能加宽**了对撞概率；这是本诊断中最贴近失败点的读。
- 但既有 oracle 在 `click()` 之后立即开始 `safeAnchorKind` 直连轮询，本就与写请求同窗；该竞争在无诊断的基线用例中同样存在（既有 3 次独立失败即为此机制）。
- 第 1、2 轮在**同一诊断代码**下 H1 全绿，第 3 轮同轮另有 3 个无关 webkit 超时，说明命中由环境竞争触发而非诊断必然导致；但「诊断绝对无扰动」不可证。
- 结论：归因成立；但若要量化基线复现率，应在锁修法（WAL）落地后、去掉诊断的前提下重跑预算。

## 8. 缺失 observability

- `tests/system/browser/harness/app-server.mjs:479-484` 以 `stdio:'ignore'` 启动 `next start`，服务端异常不落任何日志；本次 500 仅因诊断监听网络响应体才被捕获。
- 建议：把 app-server stdout/stderr 持久化到每轮 artifact 目录，便于后续区分服务端错误与客户端超时。

## 9. 最小修法方案（**不实施**，等评审授权）

按影响面从小到大：

1. **harness 侧（推荐，最小半径）**：在隔离库 `prisma migrate deploy` 后、`next start` 前设置 `PRAGMA journal_mode=WAL`（可选 `busy_timeout`）。WAL 下读者与单个写者不互相阻塞，直接消除 test 直连读对 anchor 写的对撞；不改产品、不改 oracle、不改时序。需复跑 5 轮预算验证。
2. **test 侧**：回放点击后，先等待该次 `beginSession` 响应 settle，再开始 `safeAnchorKind` 直连轮询，避免读/写同窗。会改动 ACTIVE 用例的观测时序，须评审。
3. **产品侧（备选，需评审）**：为 libsql/Prisma 适配器配置 busy timeout，或对 anchor upsert 的 SQLITE_BUSY 做有限重试；或在应用启动时设置 WAL。属产品 runtime 变更，H1 不实施。
4. **observability**：落实 §8 的 app-server 日志留存。

## 10. 边界与后续

- 不修产品、不修 oracle、不放宽阈值、不新增 retry/wait；M10-05 维持原分类，不解除、不洗绿。
- 未 push；最终原子提交=诊断代码+本结论文档。
- 若评审选择方案 1，建议以「无诊断 + WAL」重跑 full-suite 预算，独立确认基线复现率与修复有效性。
