# 测试体系重建方案底稿（验收基线）

> **归档状态：COMPLETED / HISTORICAL / DO NOT EXECUTE**
> 本文是 2026-09-10 测试体系重建的历史方案快照。当前事实与命令以根 `AGENTS.md`、`docs/testing/**` 和 `tests/test-catalog.yaml` 为准。

- 文档状态：`APPROVED-FOR-IMPLEMENTATION-PLANNING`
- 版本：`v1.3-final`（执行模式：单分支连续执行＋ROBOT 一次性终验；handoff 合并为全任务契约；只读审计事实已折入第18A节）
- 审计结论：架构基线可采纳；当前仅放行首批实施，后续批次须独立具体化，不代表全量实现或发布验收通过。
- 基线 commit：`8bd87b39ee69571923288e1be530536d34bcf3ec`
- 用途：ROBOT 终验基线；实现模型全程只读本文件
- 约束：本方案不授权 push、merge、deploy、生产访问或修改 `prisma/dev.db` / `.env.local`

## 1. 验收总目标

重建后必须同时满足：

1. 产品场景、规范、可执行测试、CI 门和运行证据可双向追踪。
2. L1/L2/L3 物理分层，Contract、Tooling、Static 不冒充产品覆盖。
3. 浏览器行为由真实浏览器执行，Node 集成测试不得命名或汇报为 E2E。
4. Unit 不建库；Integration 逐套件使用允许根目录内的隔离 SQLite；任何越界数据库地址 fail closed。
5. 测试通过以关键 oracle 真执行为准，不以文件存在、源码字符串、截图数量或 worker 自报为准。
6. 每个风险场景恰有一个 Primary defense；Secondary defense 可为空或多个，不要求三层填满。
7. 体系改造与产品缺陷修复分开提交；可信回归测试可以保持 FAIL/BLOCKED，禁止为全绿弱化 oracle。

## 2. 权威边界（消除双重 SSOT）

- `docs/e2e/**/场景.md`：产品语义、用户目标、前置条件、oracle 的语义权威。
- `tests/test-catalog.yaml`：机器元数据、路径绑定、层级、优先级、生命周期状态的机器权威。
- `docs/testing/README.md`：人工入口，由 catalog/checker 生成或校验统计，不独立维护数字。
- `docs/e2e/README.md`：迁移后成为兼容跳转页，不再声称全测试 SSOT。
- 运行 verdict：由 runner 结构化结果权威决定，不写回 catalog；catalog 只保存 lifecycle 状态。
- 冲突处理：spec 与 catalog 任一缺失或不一致均阻断；README 数字与 catalog 不一致时阻断生成/检查。

`AGENTS.md` 终态必须指向 `docs/testing/README.md`。

## 3. 分层定义

| 类别 | 定义 | 允许 | 禁止 |
|---|---|---|---|
| L1 Unit/Component | 单进程、单业务单元、确定性、无真实持久化与网络 | 纯函数、单 store、组件逻辑、注入时钟、内存 adapter | router+DB、跨 service、浏览器生命周期 |
| L2 Integration | 多个真实生产模块穿越明确 seam | store→service、service→router、router→隔离 DB；外部 LLM/TTS 可桩 | 伪 window、复刻算法、桩掉被测层、顺序写冒充并发 |
| L3 System/Browser E2E | 运行中 production build、公共 UI/API、真实浏览器 | 真 DOM/点击/导航/媒体加载事件；确定性本地上游 | Node caller、源码扫描、程序化 dispatch 冒充真实媒体链 |
| Contract | 边界兼容性 | API/schema/session/cookie/adapter | 产品旅程覆盖 |
| Tooling | 测试与发布工具自身 | runner/DB guard/mock/observer/release script | 产品旅程覆盖 |
| Static | 架构与资产禁令 | AST/ESLint/catalog/link checks | 运行时行为 |

“代码 E2E”术语废止，统一称 L2 Integration；E2E 仅指 L3。

## 4. 终态目录

```text
tests/
├── unit/{creation-chat,playback,identity-session,persistence-config,ui}/
├── integration/{creation-chat,playback,identity-session,persistence-config}/
├── contract/{api,session-cookie,persistence}/
├── system/browser/{smoke,creation-chat,playback,history-reuse,identity-session,persistence-config,recovery-security}/
├── tooling/{runner,db-guard,mock,observer,release}/
├── legacy/                       # 临时；LEGACY-NON-COVERAGE；最终必须清零
└── support/{builders,fixtures,db,mocks,browser}/

docs/testing/
├── README.md
├── coverage-matrix.md
├── risks.md
└── execution/{isolation,evidence,fixtures,verdicts,flaky-policy,maintenance}.md

docs/e2e/                         # 产品场景规范，保留稳定 E2E ID
├── 进入与身份/
├── 创作与流式反馈/
├── 连续聆听与播放控制/
├── 历史再利用与创作切换/
├── 跨会话保存与恢复/
├── 账户迁移与身份切换/
├── 设置与个性化/
└── 异常恢复与安全边界/
```

顶层按执行边界，二级按产品域。`tests/legacy/` 仅是迁移中转区，catalog 必须标 `LEGACY-NON-COVERAGE`，不得计覆盖，最终验收要求为 0。

## 5. 语义命名、兼容编号与当前统计

### 5.1 人类可读名称是主身份

目录、文件、catalog、runner 输出和报告必须首先展示语义名称，不得要求读者记忆 `E01`、`H01`、`B01` 等编号：

- 场景 ID 使用稳定英文 slug：`history-prompt-start-new-creation`。
- 中文展示名直接说明用户行为：`从提示词历史开始新创作`。
- 测试文件使用 `<subject>-<behavior>.<layer>.test.ts`；浏览器用 `<journey>-<behavior>.browser.spec.ts`。
- 批次使用动宾语名称：`保护测试数据库路径`，内部排序码仅作为 `legacy_alias`。
- 风险使用语义 slug：`playback-budget-exhausted-still-audible`；旧 `H-08` 只作历史别名。
- 旧 `E2E-XX-YY`、`H-XX`、`BXX` 只放 `legacy_aliases[]`，不能出现在新文件名、目录名、主标题或面向人的汇报首列。
- UI/报告格式固定为：`从提示词历史开始新创作（旧编号 E2E-02-11-01）`，而不是只显示编号。

### 5.2 兼容编号和统计

- 现状核验：40 个 runner 套件、4 个 fixture、59 个父 spec。
- 旧 `E2E-01-06` 有两个原子 case。
- 旧 H-21 文档混有两个独立行为，重构为：
  - `history-prompt-start-new-creation`：从提示词历史开始新创作；旧别名 `E2E-02-11-01`、`H-21`；
  - `generation-history-play-once`：生成历史本页单次回放；旧别名 `E2E-02-11-02`、`H-21`。
- 旧父 ID `E2E-02-11` 只作兼容场景组别名，不计独立执行结果。
- 拆分后口径：59 个父 spec、61 个原子 case；扣除旧 `E2E-06-08` 对应的 MANUAL 场景后，60 个声明自动化 case。
- 旧编号永久保留在 aliases 中用于历史报告回查；移动目录不重编号，也不再给新场景分配晦涩流水号。风险别名如 H-21 可关联多个 case，不受 case_id 唯一约束。61 个原子 case 是保全起点，不是新增场景后的固定总数；父场景组数与 Markdown 文件数分别统计。
- README 统计只能由 catalog 推导；不得手工维护多份总数。

## 6. 产品旅程与唯一主防线

| 场景 | Primary | Secondary | 必守 oracle |
|---|---|---|---|
| 访客冷启动 | L3 | L2,L1 | 路由正确、初始化门消失、audio paused、匿名 API 边界 |
| 首次创作与流式反馈 | L2 | L3,L1 | 单次提交、delta 顺序、状态终态、历史副作用 |
| 首故事自动播放 | L3 | L2 | 播放的是 delivered story；三处镜像同源 |
| 多段连续聆听 | L2 | L3,L1 | TTS 文本与段落一致、前瞻=1、进度单调、完播清理 |
| 暂停恢复与跨路由 | L3 | L2,L1 | 用户暂停不被慢 TTS/ended 覆盖；同一 audio 连续 |
| 预算耗尽 | L3 | L2,L1 | ended 错峰；0 预算所有入口拒绝且真实停声 |
| 从提示词历史开始新创作 | L2 | L3 | 新 Agent 上下文不含旧会话；新建干净当前会话；旧创作保留在历史可返回；新故事允许自动播放 |
| 生成历史本页回放 | L2 | L3,L1 | source/text 匹配；不触发 Agent/新历史/续写 |
| 跨会话保存恢复 | L2 | L3,L1 | DB source 一致、真 pagehide/close 送达、无悬空进度 |
| 注册登录登出迁移 | L2 | L3,L1 | 注册迁移、登录零迁移、cookie/reset、pause 先于卸载 |
| 设置与个性化 | L2 | L3,L1 | 防抖合并、乱序回滚、刷新一致、试音状态 |
| 异常恢复与安全 | L2 | L3,L1 | 触达次数、failed 过滤、无僵尸态、重试无重复副作用 |

覆盖按原子 case 计算。主防线必须通过，且所有被标 required 的辅助防线也必须通过。每条 assertion 显式绑定负责的 executable；L2 不得替 L3 证明关闭页面送达、实际音频或 DOM。上表是旅程汇总，拆原子 case 时浏览器专属断言以 L3 为主防线。

## 7. Catalog v1 规格

文件：`tests/test-catalog.yaml`；schema：`tests/test-catalog.schema.json`；`schema_version: 1`。

必需枚举：

- `priority`: `P0|P1|P2|P3`
- `layer`: `L1|L2|L3|CONTRACT|TOOLING|STATIC`
- `lifecycle_status`: `PLANNED|ACTIVE|BLOCKED|MANUAL|LEGACY-NON-COVERAGE|RETIRED`
- `ci_tier`: `CANDIDATE|NIGHTLY|RELEASE|PATH_FILTERED|NONE`
- `run_verdict` 不属于 catalog：`PASS|FAIL|BLOCKED|SKIPPED|FLAKY`
- `blocked_reason` 仅在 lifecycle 为 BLOCKED 时必需
- `manual_reason` 仅在 MANUAL 时必需

记录核心字段必须包含语义名称：`case_id`、`display_name_zh`、`legacy_aliases[]`、`journey_id`、`user_goal`、`primary_defense`、`required_assertions[].display_name_zh` 和 `executables[].display_name_zh`。所有命令行汇总与报告以 `display_name_zh`＋语义 `case_id` 为主，旧编号只在括号中显示。

```yaml
schema_version: 1
cases:
  - case_id: history-prompt-start-new-creation
    display_name_zh: 从提示词历史开始新创作
    legacy_aliases: [E2E-02-11-01, H-21]
    journey_id: reuse-history-to-create
    user_goal: 从历史提示词开始一段不串台的新创作
    priority: P0
    primary_defense: L2
    secondary_defenses: [L3]
    lifecycle_status: PLANNED
    risk_tags: [history, context-isolation, autoplay]
    spec_path: docs/e2e/历史再利用与创作切换/从提示词历史开始新创作.md
    required_assertions:
      - { assertion_id: new-request-excludes-previous-conversation, display_name_zh: 新请求不包含旧会话, surface: state }
      - { assertion_id: agent-called-once, display_name_zh: 创作请求只发送一次, surface: network }
    executables:
      - executable_id: integrate-history-prompt-into-clean-creation
        display_name_zh: 提示词历史进入干净创作会话
        layer: L2
        path: tests/integration/creation-chat/history-prompt-start-new-creation.integration.test.ts
        case_ids: [history-prompt-start-new-creation]
    fixtures: [active-creation-with-prompt-history]
    ci_tier: CANDIDATE
    owner: creation-chat
```

一文件可绑定多个 case，但必须通过唯一 `executable_id` 和 `case_ids[]` 显式声明。比较集合时只比较 catalog 中 executable path、runner registry suite path 与磁盘 suite glob；排除 `support/**`、fixtures 和 helper。

静态 checker 只证明绑定；运行器必须输出 JSONL：

```text
run_id, case_id, executable_id, assertion_id, surface, verdict, evidence_path
```

结构化运行结果是必要而非充分证据：assertion 记录只能在真实断言成功后产生，验收者还须审查被测生产链、负例/故障注入与实际原始证据。手写 PASS JSONL、扫描源码字符串均不能证明行为。

## 8. 40 套件唯一迁移表

| 旧文件 | 目标 | 类别/阶段 |
|---|---|---|
| test-sec-01.ts | unit/identity-session/session-roundtrip.unit.test.ts | L1/归位单元测试，合并入 session codec |
| test-session-branches.ts | unit/identity-session/session-codec.unit.test.ts | L1/归位单元测试 |
| test-audio-ended-guard.ts | unit/playback/audio-ended-guard.unit.test.ts | L1/归位单元测试 |
| test-rate-limit.ts | unit/identity-session/sliding-window-rate-limit.unit.test.ts | L1/归位单元测试 |
| test-chat-onboarding.ts | unit/creation-chat/onboarding-storage.unit.test.ts | L1/归位单元测试；源码锁移 Static |
| test-h08-budget-exhaustion.ts | unit/playback/budget-exhaustion.unit.test.ts | L1/归位单元测试；注入时钟 |
| test-h14-config-rollback.ts | unit/persistence-config/optimistic-rollback.unit.test.ts | L1/归位单元测试 |
| test-wave2-h14-saveseq.ts | unit/persistence-config/save-sequence.unit.test.ts | L1/归位单元测试；字符串锁移 Static |
| test-wave2-h03b-preload-context.ts | unit/creation-chat/preload-context-selection.unit.test.ts | L1/归位单元测试 |
| test-audio-ended-guard-wiring.ts | legacy/audio-ended-guard-wiring.legacy.test.ts | LEGACY/隔离工具测试和待重写测试；行为并 L1，架构禁令另审 |
| test-toast-terminal-priority.ts | legacy/toast-terminal-priority.legacy.test.ts | LEGACY/隔离工具测试和待重写测试；连接真实导出前不计覆盖 |
| test-agent-summarize-guard.ts | integration/identity-session/agent-summarize-authorization.integration.test.ts | L2/归位身份与持久化集成测试；源码锁移 Static |
| test-auth-guest-matrix.ts | integration/identity-session/identity-procedure-matrix.integration.test.ts | L2/归位身份与持久化集成测试 |
| test-guest-signed-cookie.ts | integration/identity-session/guest-cookie-authorization.integration.test.ts | L2/归位身份与持久化集成测试 |
| test-orphan-prevention.ts | integration/identity-session/registration-rollback.integration.test.ts | L2/归位身份与持久化集成测试 |
| test-guest-config.ts | integration/persistence-config/guest-config-crud.integration.test.ts | L2/归位身份与持久化集成测试；手工 localStorage 剧本后续重写 |
| test-guest-creative-sync.ts | integration/persistence-config/guest-creative-sync.integration.test.ts | L2/归位身份与持久化集成测试 |
| test-guest-creative-e2e-harness.ts | integration/persistence-config/guest-multisubject-lifecycle.integration.test.ts | L2/归位身份与持久化集成测试；去 E2E 命名 |
| test-paragraph-resume.ts | legacy/paragraph-resume-mixed.legacy.test.ts | LEGACY/归位创作与播放集成测试；后拆 L1+L2 |
| test-storycard-resume-fix01.ts | integration/playback/storycard-resume.integration.test.ts | L2/归位创作与播放集成测试 |
| test-fix03-resume-countdown.ts | integration/playback/resume-countdown.integration.test.ts | L2/归位创作与播放集成测试 |
| test-fix04-no-autocontinue.ts | integration/playback/final-segment-stop.integration.test.ts | L2/归位创作与播放集成测试；删除恒真断言另批 |
| test-h07-paragraph-guard.ts | integration/playback/paragraph-transition-guard.integration.test.ts | L2/归位创作与播放集成测试 |
| test-h08-explicit-budget.ts | integration/playback/explicit-play-budget.integration.test.ts | L2/归位创作与播放集成测试 |
| test-h03-preload-isolation.ts | integration/creation-chat/preload-isolation.integration.test.ts | L2/归位创作与播放集成测试 |
| test-h04-double-submit.ts | legacy/double-submit.legacy.test.ts | LEGACY/归位创作与播放集成测试；自造 gate 后续重写 |
| test-wave2-0202-ux.ts | legacy/pending-intent-ui.legacy.test.ts | LEGACY/归位创作与播放集成测试；emulator 后续重写 |
| test-h16-exit-flush.ts | integration/persistence-config/pending-save-flush.integration.test.ts | L2/归位身份与持久化集成测试；浏览器送达另交 L3 |
| test-wave2-h16-keepalive-dedup.ts | legacy/keepalive-dedup.legacy.test.ts | LEGACY/隔离工具测试和待重写测试；必须重写 |
| test-h15-concurrent-write.ts | integration/persistence-config/stale-conversation-write.integration.test.ts | L2/归位身份与持久化集成测试；不得称 concurrent |
| test-h15-wiring-e2e.ts | legacy/conversation-write-wiring.legacy.test.ts | LEGACY/隔离工具测试和待重写测试；真 DB 交叠与 Static 分拆 |
| test-h06-logout-probe.ts | integration/identity-session/logout-playback-reset.integration.test.ts | L2/归位身份与持久化集成测试 |
| test-wave2-h06-probe-hardening.ts | legacy/logout-probe-hardening.legacy.test.ts | LEGACY/隔离工具测试和待重写测试；故障注入后并 L2 |
| test-batch-02.ts | legacy/batch-source-locks.legacy.test.ts | LEGACY/隔离工具测试和待重写测试；schema 行为拆 L1，其余 Static |
| test-sec-02.ts | legacy/procedure-source-locks.legacy.test.ts | LEGACY/隔离工具测试和待重写测试；转 Static 后删除 |
| test-release-pipeline.ts | tooling/release/release-pipeline.tooling.test.ts | TOOLING/隔离工具测试和待重写测试 |
| test-restart-mock-managed.ts | tooling/mock/mock-lifecycle.tooling.test.ts | TOOLING/隔离工具测试和待重写测试 |
| test-e2e-db-guard.ts | tooling/db-guard/e2e-db-guard.tooling.test.ts | TOOLING/隔离工具测试和待重写测试 |
| test-e2e-db-guard-regression.ts | tooling/db-guard/e2e-db-guard-regression.tooling.test.ts | TOOLING/隔离工具测试和待重写测试 |
| test-e2e-stream-observe.ts | tooling/observer/e2e-stream-observer.tooling.test.ts | TOOLING/隔离工具测试和待重写测试 |

Fixture：

- `fixtures/story-seeds.ts` → `support/fixtures/playback-story.fixture.ts`
- `fixtures/subjects.ts` → `support/builders/auth-subject.builder.ts`
- `fixtures/ui-stubs.ts` → `support/mocks/ui-state.mock.ts`
- `fixtures/isolated-db.ts` → `support/db/isolated-db.helper.ts`

## 9. 文档迁移闭环

- `execution-isolation.md` → `docs/testing/execution/isolation.md`
- `fixtures.md` → `docs/testing/execution/fixtures.md`
- `MAINTENANCE.md` → `docs/testing/execution/maintenance.md`
- 新增 `evidence.md`、`verdicts.md`、`flaky-policy.md`
- 先建 catalog 和新入口，再一次性移动场景 spec、重写链接、由 checker 生成统计；禁止 Phase 0/Phase 4 各手改一次数字。
- 旧 `docs/e2e/README.md` 最终只保留指向 `docs/testing/README.md` 的兼容说明。

## 10. Runner、命令与退出语义

终态命令：

- `yarn test:unit` → L1；空集合 exit 2
- `yarn test:integration` → L2；空集合 exit 2
- `yarn test:contract` → Contract；直接选择空集合 exit 2；在尚无独立 Contract 测试的过渡期，聚合门显式报告 NOT_APPLICABLE，不伪造套件或计 PASS。
- `yarn test:tooling` → Tooling；空集合 exit 2
- `yarn test:static` → catalog/schema/link/architecture；exit 0/1
- `yarn test:e2e:p0` → L3 P0；无 ACTIVE case 时 exit 2
- `yarn test:e2e` → L3 全量；无 ACTIVE case 时 exit 2
- `yarn test` → unit + integration
- `yarn test:all` → static + unit + integration + contract + tooling + build；不含 browser

runner 参数：`--list` 不执行、`--group <enum>`、`--suite <id>`。未知参数/suite/group exit 2。

退出码：

- 0：所选 ACTIVE 套件均 PASS
- 1：普通断言 FAIL/FLAKY
- 2：配置、参数、空集合、catalog 不合法
- 3：安全/隔离/bootstrap 失败，立即停止整个 group
- 4：timeout/crash；清理该 suite 资源后汇总或按安全影响停止

普通断言失败继续运行互相隔离的套件并汇总；安全、路径越界、迁移、schema 损坏、外联风险立即全组停止。

统计字段固定：`total, passed, failed, blocked, skipped, flaky`；total = passed + failed + blocked + skipped + flaky，包含这五种互斥终态，不包含 catalog 中 RETIRED/MANUAL/LEGACY。FLAKY 只来自显式重复观察，候选门不自动重试产品失败。

## 11. 数据库安全算法

1. Unit/Contract/Tooling 在选择套件阶段不加载 Prisma，不创建 DB。
2. Integration 由父 runner 生成 suite ID，路径固定在仓库 realpath 下 `.e2e-runtime/test-db/<run-id>/<suite-id>.db`。
3. 仅接受 `file:` SQLite URL；拒绝非 SQLite、query 绕过、百分号解码后越界、`..`、symlink 逃逸及位于允许根之外的绝对/相对路径。
4. 父 runner 丢弃 ambient URL，生成受控路径并经参数交给子进程；子进程独立验证路径后才导入测试。环境变量/标记不作为认证凭证，不声称可抵御同账户恶意进程。
5. 建库→迁移→schema probe→执行→关闭连接→清理；SIGINT/SIGTERM 同样关闭并只清理本 run 所有资源。
6. FAIL 可把 DB 复制到 `.e2e-results/<run-id>/<suite-id>/db.sqlite` 后再清理 runtime；保留期由 evidence policy 管理。
7. 安全测试必须记录 `prisma/dev.db` 的存在状态、mtime、size 和 hash 前后相同；绝不为了验证而创建它。

## 12. L3 证据规格

真实媒体链定义：浏览器加载确定性 mock MP3 并由浏览器自然产生 media events；程序化 `dispatchEvent` 只能测 UI handler，不能满足真实媒体 case。

首批 case：

- `history-prompt-start-new-creation`（旧 `E2E-02-11-01`）：State + Network + UI；产品语义已批准为“新建干净当前会话，旧创作保留在历史可返回”。
- `generation-history-play-once`（旧 `E2E-02-11-02`）：UI + Audio + Network；DB 需验证没有新增历史。
- `reject-second-submit-while-streaming`（旧 H-02）：UI + Network + State。
- `stop-audio-when-budget-exhausted`（旧 H-01/H-08）：UI + Audio + Network。
- `pause-audio-before-logout-unload`（旧 H-06）：UI + Audio + 外部时间线；必须证明 pause timestamp < unload timestamp。
- `persist-tail-before-page-exit`（旧 H-16）：Network + DB + 外部时间线；关闭后由测试控制进程观测，不能靠页面内日志自证。

证据路径：`.e2e-results/<run-id>/<case-id>/`，manifest 必含 commit、browser/version、fixture hash、mock hash、runner hash、assertion 结果。

## 13. CI 拓扑

本项目不走 PR：

- 候选分支 push / manual dispatch：static、lint、typecheck、L1、L2、Contract、build、ACTIVE P0 browser smoke。
- Tooling 在 `scripts/**`、workflow、runner、mock、guard 改动时 path-filter 阻断；`test:all` 本地仍全跑 tooling。
- nightly：L3 P0/P1 全量与显式重复时序观察。
- main/tag 镜像：质量 job 与镜像 job 必须在同一 workflow，镜像 job `needs` 同一 SHA 的质量 job；禁止跨 workflow 假装 needs。
- 本方案不授权 workflow 实际 push 镜像或部署；本地只能静态/actionlint 验证，真实 Actions 结果由后续发布验收。
- Safari/WebKit 已确认属于正式支持范围：release 必须包含 WebKit P0 smoke；nightly 运行 WebKit P0/P1。若环境暂不可用，相关 release gate 为 BLOCKED，不能降级为 Chromium-only PASS。

## 14. Flaky 与覆盖状态

run verdict：`PASS|FAIL|BLOCKED|SKIPPED|FLAKY`；原因用 `reason_class`，如 `INFRA`。`CONDITIONAL` 不作为 verdict。

- 产品失败禁止自动重试洗绿；失败后显式 repeat 通过仍为 FLAKY。
- P0 不得长期 quarantine。
- 其他 quarantine 必须有 owner、issue、截止日，且不计覆盖。
- tracked flaky ledger：case、owner、首次时间、复现率、原因、截止日、issue。
- 历史 PASS 复用必须绑定 code/fixture/environment/oracle/runner hash，任一变化即失效。

## 15. 实施批次与验收门

面向人的名称是主名称，括号内排序码只用于依赖排序和旧记录回查：

- **锁定实施基线与产品规则**（旧 G0）：协调者锁定 base/branch、catalog、迁移表和 L3 证据；产品规则已确认，见第16节。
- **保护测试数据库路径**（旧 B01）：DATABASE_URL 与测试 DB 路径安全。
- **按测试类型拆分执行器**（旧 B02）：runner registry、分组、退出码和统计。
- **整理共享测试数据与工具**（旧 B03）：4 个 support fixture 机械迁移。
- **隔离工具测试和待重写测试**（旧 B04）：Contract/Tooling/Static/Legacy 机械迁移。
- **归位单元测试**（旧 B05）：Unit 机械迁移。
- **归位身份与持久化集成测试**（旧 B06）：Identity/Persistence Integration 机械迁移。
- **归位创作与播放集成测试**（旧 B07）：Creation/Playback Integration 机械迁移。
- **建立测试资产目录和自动校验**（旧 B08）：catalog schema、checker、坏 fixture 与机器绑定。
- **重组测试规范和产品覆盖视图**（旧 B09）：docs/testing、coverage、risks、执行规范、AGENTS 与一次性统计切换。
- **建立候选版本质量门**（旧 B10）：candidate CI 和同 SHA 镜像依赖。
- **逐项重写真正失真的测试**（旧 B11+）：每个失真 seam 独立 RED→GREEN；测试体系改造与产品修复分离。
- **验证真实浏览器测试技术栈**（旧 B20）：Playwright Chromium＋WebKit spike；真实输出由架构负责人 Go/No-Go。
- **建设浏览器测试与发布门禁**（旧 B21+）：harness、每条 P0 L3、browser CI 分提交。

机械迁移的 RED 标为 `N/A — non-behavioral migration`；迁移前后逐 suite verdict 向量必须一致。行为改造的可信 RED 必须来自连接真实生产链的断言，禁止语法错、人工 throw、反转断言或环境错。

执行模式（已定）：单一实现模型在单分支 `chore/test-architecture-rebuild` 连续完成上述 13 个任务，每任务一个 Conventional Commit 并自测过门后自动进入下一任务；ROBOT 在全部任务完成或硬停后做一次性终验。每任务的文件边界、验证门、回报格式和硬停点以 `docs/plans/HANDOFF-测试体系重建.md` 第16-20节为唯一执行契约。ROBOT 终验 APPROVE 前不 push、不 merge、不部署；终验 FAIL 的任务由用户重启实现模型从对应任务号修复。

## 16. 已确认产品决策

翔哥已正式确认：

1. **从提示词历史开始新创作**：新建干净的当前创作会话；旧创作作为历史资产保留并可返回；新 Agent 请求不得包含旧上下文；新故事允许自动播放。
2. **生成历史本页单次回放**：只切换 oneShot 播放源，不新增历史、不污染聊天、不触发续写。
3. **Safari/WebKit 正式支持**：WebKit P0 smoke 是 release 硬门，WebKit P0/P1 进入 nightly。环境不可用时必须 BLOCKED，不得以 Chromium 通过替代。

以上均不再是执行者可重新解释的待决项。若现有源码、spec 或实现约束与这些决定冲突，执行者应报告冲突并停在对应批次，不得自行改语义。

## 17. 最终审计裁定与过渡规则

- 当前40套件是快照，不是最终数量；首批新增安全测试亦须登记。迁移清单只决定第一落点，移动阶段不得合并、删断言、注入时钟或抽取生产导出；表中这些改造备注全部在独立重写批次实施。
- 新产品规范目录去掉数字前缀，使用“进入与身份/”“创作与流式反馈/”“连续聆听与播放控制/”“历史再利用与创作切换/”“跨会话保存与恢复/”“账户迁移与身份切换/”“设置与个性化/”“异常恢复与安全边界/”。旧路径仅保留迁移映射，不重复维护规范正文。
- 结构整理阶段必须先盘点全部旧 spec，产出逐文件旧路径→新路径→中文名称→语义 case_id→旧别名映射，经独立审查后才批量移动。当前没有给小模型自动重命名全部 spec 的授权。
- Catalog 中 `cases` 保存语义要求，`executables` 最终采用顶层唯一注册表，case 通过 executable_ids 引用。前节内嵌示例仅展示单条绑定，不得重复定义同一 executable；实现 schema 批次须将示例正规化并测试一文件多 case。
- Catalog 生命周期增加 PLANNED：产品语义已确定但代码尚不存在；示例 ACTIVE 仅在实现后成立。机器 checker 对 PLANNED/BLOCKED 允许缺少 executable，但报告为缺口；候选必测清单里的缺口必须阻断，不允许通过降为 PLANNED 洗绿。
- Contract 是目的标签，不强制新增一份重复测试；真实 DB 契约归 integration 并标 contract 标签；独立 contract 组只承接无 DB 的边界检查。工具自身的临时哨兵文件不是产品 DB，不违反 Tooling 不加载产品库的规则。
- Browser Agent 保留为 L3 的视觉复核与探索执行方式；稳定重复路径采用 Playwright。两者按相同 case/oracle 汇报；无法看图时不得宣称视觉验收通过。WebKit自动化通过不等于真实 Safari 全兼容，Safari 媒体策略须另有真实设备/浏览器抽验记录。
- 修复“干净新会话”不能只验证旧上下文消失：还须验证旧创作实际持久保留、用户能找回、取消/切换失败不丢数据。当前数据模型若不支持可返回会话，由产品实现批次提交设计，不得拿提示词历史替代完整旧创作。
- 本轮交付是可执行的首批 handoff 和整体验收底稿，不是所有未来批次的低层设计。后续批次的文件清单、完整 schema、CI YAML 和媒体时序须各自审定后放行。

## 18. 最终验收清单

ROBOT 只有在以下全部有独立证据时才可宣告完成：

- [ ] 40 个旧 suite 与 4 fixtures 均按表迁移或有明确删除提交；legacy=0。
- [ ] catalog/schema/checker 通过全部坏 fixture 与真实 catalog。
- [ ] 磁盘 suite path = runner registry path = catalog executable path。
- [ ] Unit 执行前后无 DB 文件变化；越界 URL fail closed；`prisma/dev.db` 未变。
- [ ] 各分组独立统计、退出码、空集合和安全停点均有测试。
- [ ] 原始场景保全映射完整；父组、原子 case、声明自动化、已实现自动化分别由 catalog 计算，新增场景有可追踪增量，不硬锁总数。
- [ ] 每个 ACTIVE 自动化 case 有 executable；MANUAL 有显式理由。
- [ ] Primary defense 唯一，Contract/Tooling/Legacy 不计产品覆盖。
- [ ] 首批 L3 的 required evidence surfaces 和结构化 assertions 真执行。
- [ ] flaky/quarantine 不染绿覆盖。
- [ ] CI 同 SHA 质量依赖静态验证通过；真实 GitHub 状态未验证时明确标 blocked。
- [ ] 全量窄测、lint、typecheck、build 均有真实 exit 0；任何已有失败单独列出，不包装。
- [ ] 秘密扫描、tracked diff、提交边界和工作树状态通过。
- [ ] 未 push、merge、deploy、触碰生产或共享开发库，除非另有明确授权。

## 18A. 只读审计已折入的现场事实（2026-09-09 核验）

以下事实已实测并写入执行契约，实现者不得当作意外：

- `lib/db.ts` 含 `file:./prisma/dev.db` 兜底：缺 DATABASE_URL 注入+静态导入=直写 dev.db，故任务1必须对全部注册套件统一注入隔离 URL（"按需建库"收敛推迟到任务2 needs_db 注册表）。
- `tests/test-orphan-prevention.ts` 模块加载即自管 DATABASE_URL 并在 `prisma/` 自建库；任务1记为显式偏差，任务6迁移时收敛为走 `tests/support` helper。
- `prisma/` 下存在历史测试库残留（`prisma/test-paragraph-resume.db`，167KB）：任务1 preflight 只读记录指纹，不清理；清理归后续维护批次。
- suite ID 生成规则（剥层级后缀）已写入 handoff 第5.1节；超时退出码 4、run-id 格式、schema probe SQL 已固定。
- 现存 `docs/e2e/README.md` 自称 SSOT 且统计口径 58/59 与基线 59/61 不一致：任务9 由 checker 一次性切换，不在迁移前手工改数。
- 现有唯一 workflow 为 docker-push.yml，无质量门：任务10 新建 candidate-quality.yml 并让镜像 job needs 同 workflow 同 SHA 的质量 job；`push-ghcr.sh` 增产 `sha-<shortSHA>` 不可变 tag 属任务10 授权（该脚本为其依赖）。
- 任务11 依赖 jsdom/RTL、任务12 依赖 @playwright/test，均须锁版本与 yarn.lock 同提交；其他新依赖一律 decisions_needed。

## 19. 最终文档与执行放行

本任务仅保留两份最终文档作为入库候选：本方案底稿与 `docs/plans/HANDOFF-测试体系重建.md`（全任务执行契约）。过程材料不入库，运行证据保留在私有忽略目录。

用户用两枚提示词驱动：①启动实现模型（连续执行任务1-13＋自测）；②启动 ROBOT 终验（全部完成或硬停后一次性验收）。ROBOT 终验 APPROVE 不自动授予 push/merge/部署权限，由用户另行决定。
