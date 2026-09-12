# 产品大改版前测试体系清理方案（spec）

> **勘误 / 执行结果**：本文正文条目保留为 2026-09-11 当日快照（`## [ ] P0-xx / P1-xx / P2-xx` 不再勾选改写），执行结果以结项 `docs/changes/2026-09-12-test-system-cleanup.md` 为准。P2-01 最终裁定为 **KEEP / DEFERRED（保留 `tests/system/browser/smoke.spec.ts` 手工环境诊断入口）**，不再执行删除。

- 日期：2026-09-11
- change-id：`test-system-cleanup-20260911`
- 状态：已完成（18/18 项交付并经外部评审通过，已合入 `main@ebae35b`；执行结果与遗留见结项 `docs/changes/2026-09-12-test-system-cleanup.md`）
- 类型：测试体系清理方案（只清理、不重建）
- 基线：`main@5fc99a7`
- 来源：外部评审（ChatGPT GPT-5.6 Sol，最高思考档）+ 本地逐条核实修订（R1–R6 已并入）
- 说明：本文同时充当执行清单；执行时按「串行拓扑」阶段化为小步 commit，每步独立评审。

> 适用基线：`audio-player-next`，`main@5fc99a7`
> 目标：在产品流程与界面大改版前，先删除测试体系中已经失效、重复维护、仪式化或产生虚假置信度的部分，降低改版期间同步和迁移成本。
> 原则：**只清理，不重建。** 本文不新增产品测试、不重新设计覆盖模型、不新增 CI 门禁。

## 0. 结论先行

本轮清理建议保留以下核心资产，不把它们当作“复杂度”删除：

* `docs/e2e/**`：产品场景、用户目标、oracle 的语义资产；
* `tests/test-catalog.yaml` 中的风险 case 身份、priority、lifecycle、spec 绑定和真正的 executable 绑定；
* L1 / L2 / L3 三层测试模型及已有真实有效测试；
* runner 的独立测试数据库、安全路径保护；
* L3 的隔离 production build、本地 mock、禁止真实 LLM/TTS/生产数据库等安全边界；
* 少量真正保护测试基础设施的 Tooling tests。

本轮优先删除五类东西：

1. **同一事实的人工镜像**：coverage matrix、README 统计快照、风险别名人工索引；
2. **名存实亡的机制**：Contract、未接线 Static layer、Tier gate；
3. **产品 case 与测试治理的错误耦合**：Tooling executable 挂到产品 case；
4. **没有增加真实信息量的证据仪式**：`required_assertions × surface × evidence_surfaces`、双向 case/executable 登记、强制 Agent manifest；
5. **名义上很强、实际 oracle 不成立的 L3 测试**。

清理后希望得到的不是“更弱的测试体系”，而是：

> 产品语义只维护一份，测试绑定只维护一份，Tooling 只负责测试工具自己，执行结果只陈述实际运行结果；产品大改版时，不再被旧治理元数据拖着一起迁移。

本轮所有清理还必须遵守一个额外原则：

> **任何删除或改名，不允许让当前 fail-closed 的 runner / checker / Tooling 门因为“旧锚点、旧绑定、旧 schema 预期”而意外变红。若清理本身触发这种引用关系，必须在同一 To-do 内完成最小必要接线。**

---

# 1. P0：立即执行

## [ ] P0-01 删除手工维护的覆盖矩阵与统计快照

**动作类型：删除 / 合并**

### 精确范围

删除：

* `docs/testing/coverage-matrix.md`

修改：

* `docs/testing/README.md`

  * 删除「基线快照」整节；
  * 删除原子 case 数、ACTIVE/PLANNED 数、L1/L2/L3 数、journey 数等静态数字；
  * 删除“README 数字与 catalog 不一致即阻断”的描述；
  * 保留“`docs/e2e` 是产品语义权威、catalog 是机器资产目录”的职责说明。
* `docs/e2e/README.md`

  * 删除 `docs/testing/coverage-matrix.md` 链接；
  * 删除“8 旅程”及旅程数量分布；
  * 保留产品场景目录索引。
* 全仓搜索并删除 current-state 文档对 `coverage-matrix.md` 的引用：

```bash
rg 'coverage-matrix|覆盖矩阵'
```

历史文档不为追求“零命中”而重写：

* `docs/plans/**`
* `docs/archive/**`
* 明确标记为历史设计记录的旧 spec

### 证据

* `docs/testing/coverage-matrix.md` 手工维护 lifecycle、journey、覆盖状态；
* `tests/test-catalog.yaml` 已经是当前机器事实源；
* 当前两者已经出现实际 lifecycle 漂移；
* `docs/e2e/README.md` 的旅程数量也与当前 catalog/matrix 不再一致。

### 理由

这是已经被实际仓库状态证明会漂移的双份维护。

继续维护“机器 catalog + 人工 matrix + README 数字快照”会导致产品大改版期间每次 case 增删、状态调整都要同步三处，而这些镜像并不提供独立质量保护。

### 前置依赖与顺序

无。

可与 P0-02、P0-03、P0-04、P0-08 并行。

### 验证方式

```bash
test ! -e docs/testing/coverage-matrix.md
rg 'coverage-matrix|覆盖矩阵' docs AGENTS.md
```

预期：

* 文件不存在；
* current-state 文档无残余链接；
* `docs/e2e/**/场景.md` 一个不删。

随后运行：

```bash
yarn test:catalog
yarn test:tooling
```

### 风险等级

**低**

### 最坏情况

失去一个“快速看全部 case 的 Markdown 表格”。

不会失去产品语义和机器数据，因为这些仍分别存在于：

* `docs/e2e/**`
* `tests/test-catalog.yaml`

---

## [ ] P0-02【修订 R1】消除 `test:static` 的命名错位，统一为 `test:catalog`

**动作类型：合并 / 改接线**

### 精确范围

修改 `package.json`。

删除：

```json
"test:static": "node scripts/check-test-catalog.mjs --require-full-spec-coverage"
```

将当前独立的 catalog 入口统一为：

```json
"test:catalog": "node scripts/check-test-catalog.mjs --require-full-spec-coverage"
```

`tests/tooling/catalog/catalog-checker.tooling.test.ts` 不再需要独立 package script；它继续由：

```bash
yarn test:tooling
```

运行。

修改 `.github/workflows/auto-delivery.yml`：

```text
Static check
```

改为：

```text
Catalog check
```

命令：

```bash
yarn test:static
```

改为：

```bash
yarn test:catalog
```

修改所有 current-state 文档引用，至少包括：

* `AGENTS.md`
* `docs/testing/README.md`
* `docs/testing/execution/maintenance.md`
* `docs/engineering/change-workflow.md`
* `docs/testing/execution/**` 中其他仍引用 `yarn test:static` 的 current-state 页面

搜索：

```bash
rg 'test:static|Static check'
```

### 【修订 R1】最小必要接线：同步修正 governance-docs Tooling 锚点

当前：

* `tests/tooling/docs/governance-docs.tooling.test.ts`
* 用例 4

会检查：

```text
docs/testing/execution/maintenance.md
```

必须包含：

```text
yarn test:static
```

因此 P0-02 不能只改文档，否则：

```bash
yarn test:tooling
```

会 fail-closed 变红。

本项必须在同一个 commit 中同步修改：

* `docs/testing/execution/maintenance.md`

  * `yarn test:static` → `yarn test:catalog`
* `tests/tooling/docs/governance-docs.tooling.test.ts`

  * 用例 4 的锚点：

    ```text
    yarn test:static
    ```

    改为：

    ```text
    yarn test:catalog
    ```

这里只修改锚点名称，不改变 governance test 的职责，不提前执行 P1-05 的治理测试删除。

### 证据

* `package.json` 当前 `test:static` 实际执行 catalog checker；
* 真正的 `tests/static/**` 由 `scripts/run-tests.mjs --group static` 管理，是另一套东西；
* `.github/workflows/auto-delivery.yml` 的 “Static check” 实际调用的是 catalog checker；
* `tests/tooling/docs/governance-docs.tooling.test.ts` 用例 4 对 `yarn test:static` 存在硬编码锚点。

### 理由

当前“Static”一词同时表示：

1. catalog 静态一致性 checker；
2. runner 中真正的 Static source-shape suite。

产品大改版期间，这种命名会让维护者无法判断“Static 通过”到底证明什么。

同时，清理不能破坏现有 governance Tooling 的 fail-closed 约束，所以改名必须同步更新它的锚点。

### 前置依赖与顺序

建议最先执行。

P0-05 删除真正的 Static layer 后，语义会完全干净。

### 验证方式

```bash
yarn test:catalog
yarn test:tooling

rg 'test:static|Static check' \
  package.json .github docs AGENTS.md tests/tooling
```

预期：

* `yarn test:catalog` 通过；
* `yarn test:tooling` 不因 governance 用例 4 变红；
* current-state 路径不再出现旧命令。

额外验证：

```bash
rg 'yarn test:catalog' \
  docs/testing/execution/maintenance.md \
  tests/tooling/docs/governance-docs.tooling.test.ts
```

文档和 Tooling 锚点应同步指向新名称。

### 风险等级

**低**

### 最坏情况

遗漏某个 active 调用方仍执行 `yarn test:static`，导致命令不存在。

由于 CI 和 Tooling 都是 fail-closed，更可能立即暴露，而不是静默放行。

---

## [ ] P0-03【修订 R6】删除空的 Contract 层以及 runner 中其他从未存在 suite 的空 group

**动作类型：删除**

### 精确范围

修改 `package.json`：

删除：

```json
"test:contract": "node -e \"console.log('NOT_APPLICABLE');process.exit(0)\""
```

修改 `scripts/run-tests.mjs`。

从：

```text
ALLOWED_GROUPS
```

删除：

* `contract`
* `legacy`
* `e2e`
* `browser`

其中：

* `contract`：没有任何真实 suite；
* `legacy`：没有独立 runner group；
* `e2e`：没有 Node runner suite；
* `browser`：实际由 Playwright 独立执行，不应在 Node runner 留空 group。

修改 `scripts/check-test-catalog.mjs`：

* 从 layer enum 删除 `CONTRACT`。

修改：

* `docs/testing/README.md`

  * 删除 Contract 层描述；
* 其他 current-state 文档：

```bash
rg '\bCONTRACT\b|test:contract|group contract'
```

### 【修订 R6】最小必要接线：同步 runner-group-split 的白名单副本

当前：

```text
tests/tooling/runner/runner-group-split.tooling.test.ts
```

存在一份与 runner 分组语义相对应的白名单/注册表校验副本。

调整：

```text
scripts/run-tests.mjs → ALLOWED_GROUPS
```

时必须在同一 To-do 中同步修改该 Tooling 测试，使其不再把：

* `contract`
* `legacy`
* `e2e`
* `browser`

视为当前合法 Node runner group。

本项只做**同步维护**，不把白名单结构重新设计成共享模块。

后续 P0-05 删除 `static` group 时，同一测试也必须再次同步删除 `static`。

### 证据

* `scripts/run-tests.mjs` 当前允许上述 group；
* runner 注册表中不存在相应真实 suite；
* `package.json` 的 `test:contract` 固定输出 `NOT_APPLICABLE`；
* `runner-group-split.tooling.test.ts` 有一份分组白名单副本。

### 理由

空 group 会产生不存在能力的概念表面。

尤其：

```bash
yarn test:contract
```

固定 exit 0，会制造“Contract 已通过”的视觉噪声。

同时删除 runner group 时，如果不维护 Tooling 测试中的对应白名单，虽然未必立即 hard fail，也会形成：

> runner 实际支持集合 ≠ Tooling 所声明集合

的下一份漂移。

### 前置依赖与顺序

无。

建议 P0-04 同期或先完成，避免同步维护即将删除的 JSON Schema。

### 验证方式

```bash
rg 'test:contract|\bCONTRACT\b' \
  package.json scripts docs/testing tests/tooling
```

运行：

```bash
node scripts/run-tests.mjs --group contract
```

预期：

* 作为非法 group fail；
* 不再输出 `NOT_APPLICABLE`。

同时：

```bash
yarn test:unit
yarn test:integration
yarn test:tooling
```

必须通过。

检查白名单一致性：

```bash
rg 'contract|legacy|e2e|browser' \
  scripts/run-tests.mjs \
  tests/tooling/runner/runner-group-split.tooling.test.ts
```

只允许出现在解释性测试文本中，不应继续作为合法 Node group。

### 风险等级

**低**

### 最坏情况

仓库外脚本仍调用：

```bash
yarn test:contract
```

或：

```bash
node scripts/run-tests.mjs --group browser
```

将失效。

**不确定：**公开仓库无法确认是否存在仓库外调用方。

---

## [ ] P0-04 删除未实际承担校验职责的 `test-catalog.schema.json`

**动作类型：删除 / 合并**

### 精确范围

删除：

* `tests/test-catalog.schema.json`

修改：

* `scripts/check-test-catalog.mjs`

  * 删除 `schemaPath`；
  * 删除 `--schema` CLI 参数；
  * 删除 help 中 `--schema`；
  * 删除 schema 文件读取与 `JSON.parse()`；
  * 删除“与 `tests/test-catalog.schema.json` 同口径”一类注释；
  * 保留现有 `validateSchemaHandwritten()`。

修改：

* `tests/tooling/catalog/catalog-checker.tooling.test.ts`

  * 删除 fixture 对 `--schema` 或临时 schema 文件的依赖；
  * 保留实际生效的 catalog validation 测试。

删除 current-state 文档中的 schema 文件引用。

### 证据

当前 checker：

1. 读取 `tests/test-catalog.schema.json`；
2. 只验证它能被 `JSON.parse()`；
3. 真正 catalog 字段和 enum 校验由：

   ```text
   validateSchemaHandwritten()
   ```

   执行。

### 理由

当前结构实际是：

```text
JSON Schema：维护一份规则，但不执行
手写 validator：再维护一份规则，而且真正执行
```

产品大改版即将删除大量 catalog 字段，如果继续保留 schema 文件，每次都必须同步修改两份定义。

### 最小必要接线

只修改 catalog checker 的 Tooling 测试。

本项：

* 不引入 Ajv；
* 不引入新的 YAML/schema dependency；
* 不重写 catalog 格式。

### 前置依赖与顺序

无硬依赖。

建议在 P0/P1 大量删除 catalog 字段之前优先完成。

### 验证方式

```bash
test ! -e tests/test-catalog.schema.json

rg 'test-catalog\.schema\.json|--schema' \
  scripts tests/tooling docs/testing

yarn test:catalog
yarn test:tooling
```

### 风险等级

**低—中**

### 最坏情况

手写 validator 漏掉 JSON Schema 中某个规则。

但该 JSON Schema 在当前基线本来就没有真正参与 catalog validation，因此本项不会删除一条当前实际生效的机器门。

---

## [ ] P0-05【修订 R6】删除 `tests/static/**` 这组 legacy source-shape locks

**动作类型：删除**

### 精确范围

删除：

* `tests/static/procedure-source-locks.static.test.ts`
* `tests/static/batch-source-locks.static.test.ts`
* `tests/static/audio-ended-guard-wiring.static.test.ts`
* `tests/static/conversation-write-wiring.static.test.ts`

修改 `scripts/run-tests.mjs`。

删除四个 suite：

* `procedure-source-locks`
* `batch-source-locks`
* `audio-ended-guard-wiring`
* `conversation-write-wiring`

从：

```text
ALLOWED_GROUPS
```

删除：

```text
static
```

### 【修订 R6】同步修改 runner-group-split Tooling 白名单

P0-03 已明确：

```text
tests/tooling/runner/runner-group-split.tooling.test.ts
```

存在 runner group 白名单副本。

本项删除 `static` group 时，必须再次同步该文件：

* 从其合法 group 集合删除 `static`；
* 删除或调整针对 Static group 存在性的断言；
* 不允许出现：

  ```text
  runner 已无 static group，但 Tooling 仍声明 static 合法
  ```

这属于删除 Static layer 的**最小必要接线**。

### Catalog 修改

修改 `tests/test-catalog.yaml`：

删除 executable：

* `exec-procedure-source-locks-legacy`
* `exec-batch-source-locks-legacy`
* `exec-audio-ended-guard-wiring-legacy`
* `exec-conversation-write-wiring-legacy`

从对应 case 的 `executable_ids` 删除上述 ID。

对应 case：

* `protected-api-401-guard-matrix`
* `config-init-gate-retry`
* `segment-end-double-jump-guard`
* `dual-tab-same-account-write-cover`

其中：

* `protected-api-401-guard-matrix` 仍有真实 L2；
* `segment-end-double-jump-guard` 仍有真实 L1；
* `dual-tab-same-account-write-cover` 仍有真实 L2；
* `config-init-gate-retry` 本身为 PLANNED，可恢复为无 executable 的真实缺口。

修改 `scripts/check-test-catalog.mjs`：

* layer enum 删除 `STATIC`；
* 删除 Static 层统计/描述。

修改 current-state 文档：

* `docs/testing/README.md`
* 其他仍把 Static 描述为有效测试层的页面。

### 证据

* 上述四个测试全部由 `scripts/run-tests.mjs` 作为 Static suite 注册；
* CI/正常完成门并没有执行：

  ```bash
  run-tests.mjs --group static
  ```
* 当前所谓：

  ```bash
  yarn test:static
  ```

  实际只是 catalog checker，且在 P0-02 已更名。

### 理由

这组测试锁定的是源代码形状/wiring 结构，而不是产品行为。

对于即将进行流程与界面大改版的代码库，它们非常容易因为实现重写产生高频假红，却又没有进入当前真实交付链。

### 前置依赖与顺序

建议：

1. P0-02 先完成命名清理；
2. P0-03 已同步整理 runner group 白名单；
3. 再删除 Static layer。

P0-04 完成后修改 catalog 字段成本更低。

### 验证方式

```bash
test ! -d tests/static

rg 'procedure-source-locks|batch-source-locks|audio-ended-guard-wiring|conversation-write-wiring'

rg 'layer: STATIC|group: .static.' tests scripts

yarn test:catalog
yarn test:unit
yarn test:integration
yarn test:tooling
```

同时检查：

```bash
rg '\bstatic\b' \
  scripts/run-tests.mjs \
  tests/tooling/runner/runner-group-split.tooling.test.ts
```

不应再把 `static` 作为 Node runner 合法 group。

### 风险等级

**中**

### 最坏情况

某次改动破坏过去被源码字符串锁住的 wiring，而已有行为测试没有发现。

这是显式接受的风险，因为继续保留这些 source-shape locks 在大改版期间产生误报和迁移负担的概率更高。

---

## [ ] P0-06【修订 R5】删除当前未接入真实交付链的 Tier Gate 与 `ci_tier`

**动作类型：删除 / 明确废弃标注**

### 精确范围

删除：

* `scripts/check-tier-gate.mjs`
* `tests/tooling/tier/tier-gate.tooling.test.ts`
* `tests/tier-waivers.yaml`

修改 `scripts/run-tests.mjs`：

删除 Tooling suite：

```text
tier-gate
```

修改 `tests/test-catalog.yaml`：

删除全部 case 的：

```yaml
ci_tier:
```

删除 executable：

```text
exec-tier-gate
```

从相关产品 case 的 executable binding 中删除该 ID。

修改 `scripts/check-test-catalog.mjs`：

删除：

* `CI_TIER_SET`
* `ci_tier` allowed-key；
* `ci_tier` enum validation；
* tier 相关统计；
* tier 专用错误/输出。

### 【修订 R5】同步清理 checker 顶部过期复用声明

当前：

```text
scripts/check-test-catalog.mjs
```

顶部存在“导出共用解析函数供 `scripts/check-tier-gate.mjs` 复用”一类说明。

删除 `check-tier-gate.mjs` 后必须同步：

* 删除该注释；
* 或改成只描述现存的真实 consumer。

如果该文件存在纯粹为了 tier gate 而 `export` 的解析函数，并且全仓确认无其他 consumer：

```bash
rg '函数名' scripts tests
```

则可一起移除无用 export。

若仍有其他 consumer，则保留函数本身，只删除过期的：

```text
供 check-tier-gate.mjs 复用
```

陈述。

### 文档修改

修改：

* `docs/testing/README.md`
* `docs/testing/execution/isolation.md`
* `docs/engineering/change-workflow.md`
* `AGENTS.md`
* 其他 current-state 文档

搜索：

```bash
rg 'check-tier-gate|tier-waivers|ci_tier|CANDIDATE|NIGHTLY|PATH_FILTERED'
```

### 证据

* `scripts/check-tier-gate.mjs` 存在完整 CANDIDATE/RELEASE 逻辑；
* `tests/tooling/tier/tier-gate.tooling.test.ts` 只证明 gate 自己能工作；
* `.github/workflows/auto-delivery.yml` 没有调用该 gate；
* 多个 P1 PLANNED case 通过 `ci_tier: NONE` 根本不进入 gate；
* `check-test-catalog.mjs` 仍带有为 tier gate 复用而写的顶部说明。

### 理由

Tier gate 当前属于“实现完整但未进入真实交付链”的治理机制。

产品大改版期间继续维护：

* `ci_tier`
* waiver
* tier checker
* tier Tooling test
* tier 文档

只会增加 case 迁移成本。

本轮原则是“不重建”，因此不把它重新接入 CI。

### 前置依赖与顺序

P0-04 最好先完成，避免同步编辑即将删除的 JSON Schema。

可与 P0-05 并行。

### 验证方式

```bash
test ! -e scripts/check-tier-gate.mjs
test ! -e tests/tier-waivers.yaml
test ! -d tests/tooling/tier

rg 'check-tier-gate|tier-waivers|ci_tier' \
  tests scripts package.json .github docs/testing docs/engineering AGENTS.md

yarn test:catalog
yarn test:tooling
```

针对 R5 追加：

```bash
rg 'check-tier-gate.*复用|供.*tier.*复用' scripts/check-test-catalog.mjs
```

预期无过期说明。

### 风险等级

**中**

### 最坏情况

仓库外人工发布脚本仍执行：

```bash
node scripts/check-tier-gate.mjs ...
```

删除后该流程失效。

**不确定：**公开仓库无法确认仓库外自动化或个人脚本是否使用它。

---

## [ ] P0-07 摘除 3 条产生虚假强证据的 L3 executable

**动作类型：删除 / 降级**

本项不是删除产品风险，而是删除**不能证明自己名字所声称语义的测试实现**。

### 精确范围

删除：

* `tests/system/browser/scenarios/stop-audio-when-budget-exhausted.spec.ts`
* `tests/system/browser/scenarios/pause-audio-before-logout-unload.spec.ts`
* `tests/system/browser/scenarios/persist-tail-before-page-exit.spec.ts`

修改 `tests/test-catalog.yaml`。

删除 executable：

* `exec-l3-stop-audio-when-budget-exhausted`
* `exec-l3-pause-audio-before-logout-unload`
* `exec-l3-persist-tail-before-page-exit`

从对应 case 删除上述 binding：

* `budget-exhausted-tap-play-audio-state`
* `logout-during-play-instant-silence`
* `quick-exit-loses-tail-hanging-progress`

**不要删除三个产品 case。**

**不要删除对应 `docs/e2e` 产品场景。**

三个 case 仍有已有的 L1/L2 防线：

* budget case：`exec-budget-exhaustion`
* logout case：`exec-logout-playback-reset` 等
* quick-exit case：`exec-pending-save-flush`、`exec-keepalive-dedup-legacy`

### 证据

#### 预算耗尽 L3

当前测试直接给 `<audio>` 设置固定 MP3，再等待浏览器自然 `ended`。

它证明的是：

```text
HTMLAudioElement 自然播放结束 → ended / paused
```

没有真正构造：

```text
产品预算状态由 >0 → 0 → playback controller 主动停声
```

#### 登出前暂停 L3

当前测试在导航完成后记录 `unloadMs`，再读取新页面 audio 状态，最终使用宽松时间关系声称证明：

```text
pause happened before unload
```

实际 observation 顺序无法证明该命题。

#### 退出 flush L3

当前测试在 close 之前已经：

* 等待正常生成完成；
* 读取 DB；
* 观察 tail 已存在；

之后关闭页面只要求数据仍存在。

因此即使 exit flush 完全失效，只要正常保存已提前完成，也可能 PASS。

### 理由

错误的强证据比显式缺口更危险。

产品即将大改版，此时不应该投入成本修复旧产品语义下的三个 L3，而应先把它们从“已完成保护”中摘除。

### 前置依赖与顺序

无技术依赖。

建议在大改版开始前执行。

### 验证方式

```bash
test ! -e tests/system/browser/scenarios/stop-audio-when-budget-exhausted.spec.ts
test ! -e tests/system/browser/scenarios/pause-audio-before-logout-unload.spec.ts
test ! -e tests/system/browser/scenarios/persist-tail-before-page-exit.spec.ts

rg 'exec-l3-stop-audio-when-budget-exhausted|exec-l3-pause-audio-before-logout-unload|exec-l3-persist-tail-before-page-exit'

yarn test:catalog
yarn test:unit
yarn test:integration
```

可追加现有浏览器套件：

```bash
yarn test:browser:smoke
```

### 风险等级

**中—高**

### 最坏情况

在改版后重新建立这些 browser journey 前，三个行为失去 browser-specific regression protection。

这是有意识接受的缺口，比保留一个无法证明语义却显示 PASS 的 L3 更安全。

---

## [ ] P0-08【修订 R2 / R4】删除与当前执行事实冲突的 CI / 发布 / Evidence 文档描述

**动作类型：删除 / 明确废弃标注 / 改接线**

### 精确范围

修改：

* `docs/engineering/change-workflow.md`
* `AGENTS.md`

删除“当前 workflow 自动 SSH 部署生产”的 current-state 描述。

当前仓库内可确认的执行链只描述为：

```text
main push
→ quality
→ build/push immutable GHCR image
→ Bark notify
```

生产侧如何消费 GHCR 镜像，只保留：

> 生产部署由仓库外机制负责或另有流程；当前仓库 `.github/workflows/auto-delivery.yml` 本身不执行 SSH 上线。

不要编造仓库外具体实现。

### 【修订 R2】Evidence 文档修订后的锚点策略

修改：

* `docs/testing/execution/evidence.md`

删除错误的 current-state 声明：

* 当前 CI 已执行 evidence `upload-artifact`；
* 当前 CI 已设置：

  ```text
  retention-days: 30
  ```

改为明确写当前事实，例如：

> 当前 `auto-delivery.yml` 不上传 `.e2e-results` / evidence artifact，也未配置 `retention-days`。本地 evidence 仍必须遵守脱敏规则。未来如重新接入 CI artifact，应单独定义留存期，而不是沿用历史数值。

保留：

* `retention-days` 这个配置概念；
* “未配置”的 current-state 语义；
* “脱敏”安全规则。

**不要为了满足旧 Tooling 测试而在正文中保留虚假的 `30` 天 current-state 数字。**

同步修改：

* `tests/tooling/docs/governance-docs.tooling.test.ts`
* 用例 7

将原本要求 evidence 文档包含：

```text
retention-days
30
脱敏
```

改为检查新的真实语义锚点，例如：

```text
retention-days
未配置
脱敏
```

并移除对：

```text
30
```

的硬编码要求。

这是 P0-08 的**最小必要接线**，避免文档改正确后 `yarn test:tooling` 反而 fail-closed 变红。

### 【修订 R4】勘误 current-state authority spec

处理：

```text
docs/specs/2026-09-11-main-auto-delivery.md
```

该文件头部当前自称 current-state authority，但其中 §5 / §7 仍描述：

* SSH 自动部署；
* staleness guard；
* 与当前轻量 workflow 不一致的上线链路。

本次不重写其历史设计正文。

在文件顶部增加显式勘误/取代声明，并删除或废止其：

```text
current-state authority
```

身份。

建议语义：

> **勘误 / 已取代**：自 `main@5fc99a7` 起，本文件 §5、§7 中关于 SSH 自动部署及 staleness guard 的描述不再代表当前仓库执行事实。当前 workflow 以 `.github/workflows/auto-delivery.yml` 和 `docs/engineering/change-workflow.md` 为准。本文件保留为历史设计记录，不再作为 current-state authority。

不要修改：

* `docs/plans/**`
* `docs/archive/**`

中的历史快照。

如果 `docs/specs/2026-09-11-main-auto-delivery.md` 内部仍有其他位置宣称自己为 current-state authority，应一并改为“历史设计记录 / 已被当前实现取代”。

### 证据

* `.github/workflows/auto-delivery.yml` 当前明确只发布镜像，不做上线动作；
* `docs/engineering/change-workflow.md` / `AGENTS.md` 存在与 workflow 不一致的 SSH 上线描述；
* `docs/testing/execution/evidence.md` 当前声称 CI 上传 evidence 并配置 30 天 retention，但 workflow 中没有对应 step；
* `governance-docs.tooling.test.ts` 用例 7 仍以旧的 `retention-days + 30 + 脱敏` 为硬锚点；
* `docs/specs/2026-09-11-main-auto-delivery.md` 自称 current-state authority，但 §5 / §7 与现行 workflow 不一致。

### 理由

这是 current-state 文档清理，而不是 CI 重建。

大改版前必须先明确：

> 什么是真实执行事实，什么只是历史设计。

否则维护者会根据已经失效的发布和 retention 描述做错误判断。

### 前置依赖与顺序

无。

可与 P0-01、P0-02 并行。

但：

* evidence.md 的修订；
* governance-docs 用例 7 的锚点修订；

必须同 commit 完成。

### 验证方式

检查真实 workflow：

```bash
rg 'ssh|upload-artifact|retention-days' .github/workflows/auto-delivery.yml
```

其结果应与文档 current-state 一致。

检查文档：

```bash
rg 'SSH 自动部署|retention-days: 30|自动上传.*evidence' \
  docs/engineering \
  docs/testing \
  AGENTS.md
```

current-state 页面不应再声称这些能力已经接线。

验证 R2：

```bash
rg 'retention-days|未配置|脱敏' \
  docs/testing/execution/evidence.md \
  tests/tooling/docs/governance-docs.tooling.test.ts

yarn test:tooling
```

用例 7 应基于真实 current-state 继续通过。

验证 R4：

```bash
rg 'current-state authority|SSH|staleness' \
  docs/specs/2026-09-11-main-auto-delivery.md
```

允许历史正文继续出现 SSH/staleness，但文件顶部必须明确：

* 已取代；
* 不再是 current-state authority；
* 当前事实源指向现行 workflow/current-state 文档。

明确不处理：

```text
docs/plans/**
docs/archive/**
```

### 风险等级

**低**

### 最坏情况

如果仓库外确实存在自动部署服务，仓库文档将不再描述它的具体实现。

这优于在仓库内继续声称当前 GitHub workflow 自己执行 SSH。

**不确定：**仓库外生产拉取/部署机制的具体实现无法从公开仓库确认。

---

# 2. P1：产品大改版前必须完成

## [ ] P1-01【修订 R3】将 Tooling 从产品 catalog 中彻底解耦

**动作类型：合并 / 改接线**

这是本轮最重要的结构性清理之一。

### 精确范围

### A. `tests/test-catalog.yaml`

删除所有：

```yaml
layer: TOOLING
```

executable。

包括当前仍存在的 Tooling catalog executable，例如：

* `exec-mock-lifecycle`
* `exec-e2e-db-guard`
* `exec-e2e-db-guard-regression`
* `exec-e2e-stream-observer`
* `exec-runner-database-path-safety`
* `exec-browser-harness`
* `exec-runner-group-split`
* `exec-catalog-checker`
* `exec-evidence-schema`
* `exec-auto-delivery`
* `exec-governance-docs`

`exec-tier-gate` 已在 P0-06 删除。

同时从所有产品 case 的：

```yaml
executable_ids:
```

删除上述 Tooling executable ID。

### B. 保留有价值的 Tooling 测试文件

本项**不是删除 Tooling tests**。

继续保留实际保护测试基础设施的用例，例如：

* DB guard；
* runner safety；
* browser harness；
* catalog checker；
* delivery workflow guard；
* mock lifecycle；
* evidence validator 在 P1-03 前的自测。

继续通过：

```bash
yarn test:tooling
```

运行。

### C. `scripts/check-test-catalog.mjs`

当前 checker 会把 Tooling 与 product executable 一起纳入：

```text
catalog ↔ runner registry ↔ disk
```

一致性。

修改为：

* product catalog registry check 只覆盖：

  * L1 / unit
  * L2 / integration
* L3 继续独立按 Playwright path/catalog 检查；
* `tests/tooling/**` 不再要求进入 product catalog；
* Tooling 的 disk/registry 一致性若当前已有独立 runner 自检，则继续由 Tooling 自己承担，不重新建立“Tooling catalog”。

### D. `scripts/run-tests.mjs`

Tooling suite 仍由 runner 执行。

但：

```text
group === tooling
```

时，不再要求：

* product `case_id`
* product `executable_id`
* product catalog binding

Tooling PASS/FAIL 只表达：

> 这个测试基础设施 suite 自己是否通过。

### 【修订 R3】E. 证据校验器最小必要接线

当前：

```text
scripts/evidence-schema.mjs
```

中 `validateRow` 对：

```text
kind=summary
verdict=PASS/FAIL/FLAKY
```

强制要求存在有效产品 case binding。

如果只从 catalog 摘除 Tooling，但不改这一层：

```text
Tooling suite
→ 无 product case
→ summary PASS
→ validateRow 判非法
→ suite 被记为 BLOCKED
→ exit 3
```

因此本项必须同步处理 runner 与 validator 两侧。

#### 采用的最小口径

在 P1-03 尚未整体简化 evidence 协议之前，临时明确区分：

```text
产品 summary
Tooling summary
```

推荐最小实现：

* 产品测试继续使用：

  ```text
  kind=summary
  ```
* Tooling 测试使用一个明确的非产品结果类型，例如：

  ```text
  kind=tooling-summary
  ```

`tooling-summary`：

* 必须有真实 runner suite 标识；
* 必须来自 `group=tooling` 的已注册 suite；
* 可以没有 product case binding；
* **不得包含或声称 product case coverage**；
* 不得被 product coverage/evidence 聚合器视为产品 PASS。

`summary` 原有防伪规则保持不变：

```text
PASS / FAIL / FLAKY
→ 仍必须有有效 product case binding
```

因此不能采用下面这种宽松方式：

```text
所有 summary 缺 case 时也允许 PASS
```

这会真正打开伪造产品 PASS 的通道，禁止这么做。

#### Runner 侧

`scripts/run-tests.mjs`：

```text
suite.group === tooling
```

时生成 Tooling 自己的结果行，而不是构造虚假的 product case binding。

#### Validator 侧

`scripts/evidence-schema.mjs`：

* `summary`：继续保持当前 product binding 强校验；
* `tooling-summary`：只允许表达 Tooling suite 结果，不接受 product coverage 声明。

同步修改相关 Tooling 自测：

* `tests/tooling/evidence/evidence-schema.tooling.test.ts`
* 以及任何测试 runner evidence output shape 的 Tooling case。

这里只解决“Tooling 不再属于产品 catalog 后，自己的 PASS 怎样合法表达”。

P1-03 随后会整体把 evidence 降级为更简单的执行结果协议，因此这里**不要继续扩展字段或设计新的证据平台**。

### F. 文档

修改：

* `docs/testing/README.md`

追踪链从：

```text
产品 case + Tooling executable 混在统一 catalog
```

改为：

```text
产品 catalog → L1 / L2 / L3
Tooling → 独立测试测试基础设施
```

明确：

> Tooling PASS 不等于任何产品 case PASS。

### 证据

* `tests/test-catalog.yaml` 当前将多个 Tooling executable 绑定到产品 case；
* `scripts/run-tests.mjs` 当前 Tooling 与产品 suite 共用 catalog/evidence 路径；
* `scripts/evidence-schema.mjs::validateRow` 对 PASS/FAIL/FLAKY summary 强制产品 case binding；
* 因此“只删 catalog Tooling binding”会直接把 Tooling 运行转成 BLOCKED。

### 理由

当前模型把：

```text
CI workflow 自测
DB guard 自测
catalog checker 自测
```

表达成某个产品身份/播放 case 的 executable。

这是职责错误。

但解耦时必须保持两条安全性质：

1. Tooling 能正常 fail-closed；
2. 产品 PASS 不能通过“无 case 绑定”获得新的绕过路径。

### 前置依赖与顺序

必须在：

* P0-05 Static 删除；
* P0-06 Tier 删除；

之后执行。

必须在 P1-03 evidence 简化之前执行。

### 验证方式

Catalog：

```bash
rg 'layer: TOOLING' tests/test-catalog.yaml
```

预期无命中。

Runner：

```bash
node scripts/run-tests.mjs --list
```

仍应列出保留的 Tooling suites。

正常执行：

```bash
yarn test:catalog
yarn test:tooling
```

必须均为 0。

### R3 防伪验证

至少验证三个场景：

#### 1. 正常 Tooling PASS

不带 product case binding，仍能合法 PASS。

#### 2. Tooling FAIL

仍必须让：

```bash
yarn test:tooling
```

非 0，不能因为解耦而被吞掉。

#### 3. 产品 summary 无 case binding

人为构造/单测验证：

```text
kind=summary
verdict=PASS
无有效 case binding
```

仍必须被 `validateRow` 拒绝。

同时验证：

```text
kind=tooling-summary
```

不能被 product evidence 聚合为任何 case PASS。

### 风险等级

**高**

### 最坏情况

接线错误可能造成两类严重问题之一：

1. Tooling 全部因为无 case binding 被判 BLOCKED；
2. 为了修复 1，错误地放宽 `summary`，导致无 case 的伪造产品 PASS 被接受。

因此本项必须在一个原子 commit 内同时处理：

```text
catalog
runner
evidence validator
相关 Tooling tests
```

不能拆成半成品。

---

## [ ] P1-02 删除 `primary_defense` / `secondary_defenses` 这层“期望防线”元数据

**动作类型：删除**

### 精确范围

`tests/test-catalog.yaml`：

删除所有 case：

```yaml
primary_defense:
secondary_defenses:
```

保留：

* `priority`
* `lifecycle_status`
* `risk_tags`
* `spec_path`
* `executable_ids`

修改 `scripts/check-test-catalog.mjs`：

删除：

* `primary_defense` allowed-key；
* `secondary_defenses` allowed-key；
* 两者 validation；
* 主防线分布统计。

修改：

* `docs/testing/README.md`
* `docs/engineering/change-workflow.md`

  * 删除“运行 primary defense / required secondary defense”要求；
  * 改为“运行受影响 case 当前实际绑定的有效 executable”。

浏览器 spec 若仅用注释镜像：

```text
primary_defense: L3
```

也删除该镜像注释。

### 证据

当前已经存在：

```text
P0
primary_defense=L3
ACTIVE
实际 executable 只有 L2
```

的 case。

而 checker 对：

```text
primary_defense
```

只验证非空，并不验证它与实际 executable layer 一致。

### 理由

它既不是产品 oracle，也不是实际 coverage。

产品马上大改版，继续维护旧产品架构下的“期望防线层”反而容易误导。

本轮不重建 primary-defense checker，直接删除失真的元数据。

### 前置依赖与顺序

建议：

1. P0-06 Tier 删除；
2. P0-05 Static 删除；
3. 再执行。

可与 P1-05 并行。

### 验证方式

针对 current-state 路径：

```bash
rg 'primary_defense|secondary_defenses' \
  tests scripts docs/testing docs/engineering AGENTS.md
```

不要为了零命中去修改：

* `docs/specs/**`
* `docs/plans/**`
* `docs/archive/**`

历史记录。

随后：

```bash
yarn test:catalog
yarn test:unit
yarn test:integration
```

### 风险等级

**中**

### 最坏情况

以后无法仅看 catalog 得知“作者原先希望这个 case 最终在哪一层证明”。

但大改版本身就会使旧期望失效，继续保留它的误导风险更大。

---

## [ ] P1-03 删除 assertion/surface 级伪精度，将 evidence 降级为执行结果记录

**动作类型：降级 / 合并 / 改接线**

### 精确范围

### A. Catalog

删除所有 case：

```yaml
required_assertions:
```

删除 L3 executable：

```yaml
evidence_surfaces:
```

产品 oracle 只保留在：

```text
docs/e2e/**/场景.md
```

### B. Checker

修改：

* `scripts/check-test-catalog.mjs`

删除：

* required assertion schema validation；
* `assertion_id`；
* `surface`；
* L3 `evidence_surfaces` coverage 检查。

### C. Evidence validator

修改：

* `scripts/evidence-schema.mjs`

删除：

* `kind=assertion`
* `expandAssertionClaims()`
* `assertion_id`
* `surface`
* case × executable × assertion × surface 四维 join。

保留最低限度的运行结果字段，例如：

```text
run_id
verdict
case_id / case_ids（仅产品测试）
executable_id 或 suite_id
duration_ms
evidence_path
browser/spec_path（L3）
reason（BLOCKED/SKIPPED）
```

P1-01 临时建立的 Tooling 非产品结果语义，在这里一并简化为最终最小执行结果协议；仍须保持：

> Tooling 结果不能被当作产品 case PASS。

### D. Node runner

修改：

* `scripts/run-tests.mjs`

删除：

```text
expandAssertionClaims
```

以及逐 assertion 自动复制 verdict 的逻辑。

一个真实 suite 只记录自己实际得到的 verdict。

### E. Browser reporter

修改：

* `tests/system/browser/harness/jsonl-reporter.ts`

删除：

```text
一个 Playwright test outcome
→ catalog 中 N 条 required assertion
→ 自动产生 N 条相同 verdict
```

的展开。

只记录：

* 这个真实 spec/test 跑了什么；
* 对应 case/executable；
* verdict；
* raw evidence path。

### F. Evidence schema / 文档

删除：

* `docs/testing/execution/evidence-schema.v1.json`

精简：

* `docs/testing/execution/evidence.md`

删除：

* “每 assertion 一行”协议；
* assertion/surface join；
* per-assertion manifest；
* 与该四维 join 强绑定的 fixture/mock/hash 仪式；
* 已在 P0-08 勘误的 CI artifact 虚假 current-state 描述。

保留：

* `.e2e-results` 是一次实际运行记录；
* PASS/FAIL/BLOCKED/SKIPPED 必须真实；
* raw Playwright attachment；
* DB 来源必须是隔离测试 DB；
* secret / query / DATABASE_URL 脱敏规则。

修改：

* `tests/tooling/evidence/evidence-schema.tooling.test.ts`

只测试新的最小结果协议和产品/Tooling 边界。

### 证据

当前：

* runner 从一个 suite 总 verdict 展开多个 assertion；
* Playwright reporter 从一个 test 总 verdict 展开多个 assertion；
* 这些 assertion 行并没有独立 observation。

因此：

```text
N 条 assertion PASS
```

并不代表 N 次独立验证。

### 理由

这是一种“结构上的精确”，不是“信息上的精确”。

产品 oracle 已经有更适合跟随大改版演进的 SSOT：

```text
docs/e2e/**
```

无需在 machine evidence 中再复制一份 oracle 结构。

### 前置依赖与顺序

必须在：

```text
P1-01 Tooling 解耦
```

之后。

必须在：

```text
P1-04 删除 executable.case_ids
```

之前。

### 验证方式

```bash
rg 'required_assertions|evidence_surfaces|assertion_id|expandAssertionClaims' \
  tests/test-catalog.yaml \
  scripts \
  tests/system/browser/harness \
  docs/testing
```

current-state evidence 实现中应无旧协议残余。

运行：

```bash
yarn test:catalog
yarn test:unit
yarn test:integration
yarn test:tooling
yarn test:browser:smoke
```

P1-07 完成后改为：

```bash
yarn test:browser
```

额外人工/Tooling 验证：

* 一个正常 PASS；
* 一个 FAIL；
* 一个 BLOCKED；
* 一个 Tooling PASS；
* 一个无有效 case 的产品 PASS。

最后一种必须继续被拒绝。

### 风险等级

**高**

### 最坏情况

仓库外 evidence consumer 正在解析：

* `assertion_id`
* `surface`

清理后会失效。

**不确定：**公开仓库无法证明是否存在仓库外 consumer。

---

## [ ] P1-04 删除 `case.executable_ids ↔ executable.case_ids` 的双向人工登记

**动作类型：合并**

### 精确范围

保留唯一人工方向：

```yaml
cases:
  - case_id: ...
    executable_ids:
      - ...
```

删除：

```yaml
executables:
  - executable_id: ...
    case_ids:
      - ...
```

修改：

* `scripts/check-test-catalog.mjs`

删除：

* executable → case 人工反向一致性检查；
* `case_ids` required validation。

保留：

* case 引用的 executable 必须存在；
* executable path 必须存在；
* ACTIVE case 必须有 executable；
* product executable 与 registry/disk 不断链。

需要反查时，由：

```text
cases[].executable_ids
```

在内存中派生 reverse index。

修改：

* `scripts/evidence-schema.mjs`
* `scripts/run-tests.mjs`
* `tests/system/browser/harness/jsonl-reporter.ts`

使反向 case 查询来自派生 index，而不是：

```text
executables[].case_ids
```

修改：

* `docs/testing/README.md`

追踪关系明确为：

```text
spec → case → executable
```

反向关系属于计算结果，不是人工 SSOT。

### 证据

当前 checker 专门做两轮互查：

```text
case.executable_ids → executable.case_ids
executable.case_ids → case.executable_ids
```

这说明两字段存储的是同一条 graph edge。

### 理由

这是最典型的：

> 同一事实人工写两遍，再写一套 checker 防止两遍写得不一样。

产品大改版会大量重排 executable/case 关系，应在此前把双写降为单写。

### 前置依赖与顺序

必须在：

```text
P1-03
```

之后。

否则旧 assertion evidence join 仍依赖 executable 的反向 case 信息。

### 验证方式

```bash
rg 'case_ids:' tests/test-catalog.yaml
```

预期无命中。

随后：

```bash
yarn test:catalog
yarn test:unit
yarn test:integration
yarn test:tooling
yarn test:browser
```

若 P1-07 尚未完成：

```bash
yarn test:browser:smoke
```

额外验证：

* 一个 executable 绑定多个 case 时能反查全部；
* 一个 case 绑定多个 executable 时全部可定位。

### 风险等级

**高**

### 最坏情况

reverse index 接线错误，使 runner/reporter 找不到真实 case。

因此本项应独立 commit，不与大量产品改版代码混在一起。

---

## [ ] P1-05 降级 Agent manifest / handoff / 独立会话强制协议

**动作类型：降级 / 删除**

### 精确范围

删除：

* `tests/tooling/docs/governance-docs.tooling.test.ts`

> 注意：P0-02 / P0-08 已先同步更新这个测试的旧锚点，以保证 P0 阶段不会提前变红；到本项才正式删除该治理测试。

修改 `scripts/run-tests.mjs`：

删除 Tooling suite：

```text
governance-docs
```

修改：

* `docs/testing/execution/evidence.md`

删除：

* 任务 manifest 强制 schema；
* closeout 强制 schema；
* “专用 Tooling 校验上述字段”的要求。

修改：

* `docs/engineering/artifacts-and-retention.md`

将：

```text
.agent-runs/
```

从有固定 schema 的强制治理资产，降级为：

> 可选 Agent 调试/恢复记录，不作为普通测试完成条件。

删除其固定 schema pointer 与强制目录结构。

修改：

* `docs/engineering/agent-collaboration.md`

保留安全底线：

* 未授权不得 push/merge/deploy；
* 不得越权修改路径；
* 并行写者必须明确 ownership；
* 不得误杀未知进程；
* 安全敏感/发布变更建议独立 review。

删除或降级：

* Implementer / Reviewer / Publisher 必须不同会话；
* 每次任务必须有完整 transfer packet；
* 每次 Fixup 后必须新 Reviewer；
* 每次交接必须记录 PID/port/DB/recovery anchor；
* 普通修改必须生成 `.agent-runs` manifest。

### 证据

当前 Agent governance 对普通工程变更与高风险发布采用近似统一协议，并由：

```text
governance-docs.tooling.test.ts
```

对文档锚点做机器约束。

### 理由

这些规则对：

* 多 Agent 并发；
* 发布；
* DB migration；
* 安全敏感修改；

有价值。

但大改版会产生大量日常 UI/flow 迭代，全量套用会造成高仪式成本。

### 前置依赖与顺序

P1-01 Tooling 解耦后执行最干净。

P0-02 和 P0-08 必须已经完成其最小必要锚点修复，保证在到达 P1-05 之前 Tooling 一直保持绿色。

可与 P1-02 并行。

### 验证方式

```bash
test ! -e tests/tooling/docs/governance-docs.tooling.test.ts

rg 'governance-docs|manifest.yaml|ownership.*PID|新的 Reviewer' \
  scripts tests/tooling docs/testing docs/engineering
```

允许：

* `docs/specs/**`
* `docs/plans/**`
* `docs/archive/**`

保留历史治理记录。

运行：

```bash
yarn test:tooling
```

### 风险等级

**中**

### 最坏情况

高并发多 Agent 任务的交接信息减少，异常恢复与审计成本增加。

因此本项降级的是“普通任务强制仪式”，不是删除安全授权边界。

---

## [ ] P1-06 停止维护 `docs/testing/risks.md` 这份 legacy alias 人工镜像

**动作类型：明确废弃标注 / 删除**

### 精确范围

删除：

* `docs/testing/risks.md`

修改：

* `docs/e2e/README.md`

  * 删除“风险语义索引”链接；
* `docs/testing/README.md`

  * 删除该索引链接。

保留：

```yaml
legacy_aliases:
```

在：

```text
tests/test-catalog.yaml
```

旧 H-XX 查询仍可通过：

```bash
rg 'H-08' tests/test-catalog.yaml
```

完成。

### 证据

`docs/testing/risks.md` 本身已经说明：

* 内容由 catalog `legacy_aliases` 推导；
* 冲突时 catalog 为准；
* 不一致时要同步本表。

### 理由

它没有独立信息，只是 catalog 的手工镜像。

产品大改版时风险 case 会大量变化，继续同步 H-XX 表格价值低。

### 前置依赖与顺序

无。

可与 P1-05 并行。

### 验证方式

```bash
test ! -e docs/testing/risks.md
rg 'testing/risks|风险语义索引' docs AGENTS.md
```

随机确认：

```bash
rg 'H-01|H-08|H-21' tests/test-catalog.yaml
```

历史 alias 仍可检索。

### 风险等级

**低—中**

### 最坏情况

旧报告里的 H-XX 不再有一张专门 Markdown 对照表。

catalog 仍保留原 alias 数据。

**不确定：**是否有仓库外页面直接链接 `docs/testing/risks.md`。

---

## [ ] P1-07 将 `smoke.spec.ts` 从产品 L3 正常执行链中移出

**动作类型：降级 / 改接线**

### 精确范围

修改：

* `tests/system/browser/playwright.config.ts`

从：

```ts
testMatch: ["smoke.spec.ts", "scenarios/*.spec.ts"]
```

改为只匹配：

```ts
testMatch: ["scenarios/*.spec.ts"]
```

暂时保留：

* `tests/system/browser/smoke.spec.ts`

在文件顶部明确标注：

> harness/environment manual diagnostic；不属于产品 coverage；不进入默认 product L3。

修改 `package.json`：

建议把：

```text
test:browser:smoke
```

改名为：

```text
test:browser
```

因为默认命令此后只运行正式 product scenarios。

更新所有 current-state 文档引用。

### 证据

当前：

* Playwright `testMatch` 同时包含 `smoke.spec.ts` 与 `scenarios/*.spec.ts`；
* `smoke.spec.ts` 没有 product catalog binding；
* reporter 会因此产生 `no-catalog-binding` 类型结果；
* smoke 内的 audio/autoplay probe 主要是环境能力检查，并非产品 journey。

### 理由

环境诊断与产品 L3 不应混在同一默认运行集合里。

否则：

> product test command 的结构化结果里永久混着一个“没有 product binding”的测试。

### 最小必要接线

只调整：

* `testMatch`
* package script 名称
* current-state 文档命令

不为 smoke 创建新产品 case。

### 前置依赖与顺序

建议 P1-03 evidence 简化后执行，避免 reporter/文档重复修改。

### 验证方式

```bash
yarn test:browser
```

确认：

* 默认运行不包含 `smoke.spec.ts`；
* 不再产生 smoke 导致的 `no-catalog-binding`；
* `scenarios/*.spec.ts` 正常运行。

需要环境诊断时仍可显式：

```bash
npx playwright test \
  --config tests/system/browser/playwright.config.ts \
  tests/system/browser/smoke.spec.ts
```

若 `testMatch` 会阻止显式路径运行，则使用对应 Playwright 参数/独立调用方式；本轮不为此创建新 harness。

### 风险等级

**低—中**

### 最坏情况

日常 browser run 不再顺便检查固定 MP3 decode / autoplay 环境。

这些检查本身不属于产品行为。

---

# 3. P2：可以延后

## [ ] P2-01 在确认无人手工依赖后彻底删除 `smoke.spec.ts`

**动作类型：删除**

### 精确范围

删除：

* `tests/system/browser/smoke.spec.ts`

前提：

* P1-07 已将它移出默认 L3；
* 维护者确认没有把它作为日常环境诊断入口。

### 证据

P1-07 后它将不再参与：

* product L3；
* product catalog；
* 默认 browser command。

### 理由

届时只剩手工环境探针价值。

如果 browser harness Tooling 足以承担维护需要，就没有必要继续维护第二个诊断入口。

### 前置依赖与顺序

必须在 P1-07 后。

### 验证方式

```bash
rg 'smoke\.spec\.ts'
```

无 active 引用。

运行：

```bash
yarn test:tooling
yarn test:browser
```

### 风险等级

**低**

### 最坏情况

失去一个手工 MP3 decode/autoplay 环境探针。

**不确定：**browser-harness Tooling 是否覆盖维护者实际需要的全部手工环境诊断需求，因此不要求大改版前强制完成。

---

## [ ] P2-02 复查剩余 `*-legacy` executable，只删除真正没有独立行为价值者

**动作类型：明确废弃标注 / 删除**

### 精确范围

搜索：

```bash
rg 'legacy' \
  tests/test-catalog.yaml \
  scripts/run-tests.mjs \
  tests
```

重点逐项确认：

* `exec-logout-probe-hardening-legacy`
* `exec-keepalive-dedup-legacy`
* `exec-paragraph-resume-mixed-legacy`
* 其他仍存在的 legacy executable。

原则：

* 只是名字旧、但仍测试真实 L1/L2 行为：保留；
* 只是旧实现/source-shape lock：删除；
* 禁止按 `legacy` 名称批量删除。

### 证据

当前仓库中的 `legacy` 并非同一种语义：

* 一部分只是旧命名；
* 一部分仍保护真实 regression；
* 一部分如 P0-05 的 Static locks 才是纯实现形状保护。

### 理由

本项的目的不是“看见 legacy 就删”，而是大清理后再做一次低风险扫尾。

### 前置依赖与顺序

所有 P0/P1 完成后。

### 验证方式

每删除一个 executable：

```bash
yarn test:catalog
yarn test:unit
yarn test:integration
```

并确认对应 ACTIVE case 仍有真正独立保护。

### 风险等级

**中**

### 最坏情况

把名字旧但实际仍有独立 regression 价值的测试一起删除。

因此禁止自动批量处理。

---

# 4. 串行拓扑

建议按下面顺序落 commit，不要把全部清理塞进一个巨型提交。

```text
阶段 A：无行为风险的事实清理
├─ P0-01 删除 coverage matrix / 数字快照
├─ P0-02 test:static → test:catalog
│    └─ 同步 governance-docs 用例4锚点【R1】
├─ P0-03 删除空 Contract / 空 runner groups
│    └─ 同步 runner-group-split 白名单【R6】
├─ P0-04 删除重复 JSON Schema
└─ P0-08 修正文档执行事实
     ├─ 同步 governance-docs 用例7锚点【R2】
     └─ 勘误 main-auto-delivery current-state spec【R4】

                ↓

阶段 B：删除已失效机制
├─ P0-05 删除 Static legacy layer
│    └─ 再次同步 runner-group-split，删除 static【R6】
├─ P0-06 删除 Tier gate / ci_tier
│    └─ 清理 catalog checker 过期复用注释【R5】
└─ P0-07 摘除 3 条虚假强 L3

                ↓

阶段 C：解除治理与产品 coverage 的耦合
P1-01 Tooling 与 product catalog 解耦
  └─ runner + evidence validator 同步允许“非产品 Tooling 结果”
     且不放宽 product PASS binding【R3】

                ↓

阶段 D：Catalog 瘦身
P1-02 删除 primary_defense / secondary_defenses

                ↓

阶段 E：Evidence 瘦身
P1-03 删除 assertion/surface 证据协议

                ↓

阶段 F：删除最后一份双写关系
P1-04 删除 executables[].case_ids

                ↓

阶段 G：工程流程去仪式化
├─ P1-05 降级 Agent manifest / handoff
├─ P1-06 删除 risks.md 人工镜像
└─ P1-07 smoke 退出默认 L3

                ↓

阶段 H：可选扫尾
├─ P2-01 删除 smoke.spec.ts
└─ P2-02 逐项审计剩余 legacy executable
```

其中两条顺序特别重要。

第一条：

```text
P0-02 / P0-08
→ 先更新 governance-docs 旧锚点
→ P1-05 才删除 governance-docs 测试
```

不能反过来假设“P1 以后反正会删”，否则阶段 A 的：

```bash
yarn test:tooling
```

会直接变红。

第二条：

```text
P1-01 Tooling 解耦
    ↓
P1-03 assertion evidence 简化
    ↓
P1-04 executable.case_ids 删除
```

不能逆序。

---

# 5. 可并行分组

## 并行组 A：事实/命名清理

可并行开发：

```text
P0-01
P0-02
P0-08
```

但 P0-02 / P0-08 各自必须包含对应 governance Tooling 锚点调整，不能把“文档修改”和“Tooling 接线”拆到两个阶段。

冲突主要集中在：

* current-state README；
* `change-workflow.md`
* `governance-docs.tooling.test.ts`

最终 merge 后必须重新跑完整 `yarn test:tooling`。

## 并行组 B：独立机制删除

P0-04 完成后可以并行：

```text
P0-03 Contract / 空 group
P0-05 Static
P0-06 Tier
P0-07 flawed L3
```

但 P0-03 与 P0-05 都会修改：

```text
runner-group-split.tooling.test.ts
```

如果由不同分支并行实现，合并时必须人工确认最终白名单和：

```text
scripts/run-tests.mjs::ALLOWED_GROUPS
```

完全一致。

## 并行组 C：流程文档

P1-01 完成后：

```text
P1-05 Agent governance
P1-06 risks.md
```

可与 P1-02 独立进行。

## 不允许拆开的原子修改

以下必须在单个 To-do/commit 范围内保持一致：

### P0-02

```text
package script
CI command
maintenance.md
governance-docs 用例4
```

### P0-08

```text
evidence.md
governance-docs 用例7
current-state delivery docs/spec 勘误
```

### P1-01

```text
catalog Tooling binding
runner Tooling output
evidence-schema Tooling validation
相关 Tooling tests
```

### 强制串行链

```text
P1-01 → P1-03 → P1-04
```

---

# 6. 每阶段统一验收门

每完成一个阶段，不为了“清理”发明新门，只使用当前核心保护。

## Node 基线

```bash
yarn test:catalog
yarn test:unit
yarn test:integration
yarn test:tooling
yarn lint
yarn tsc --noEmit --incremental false
```

P0-02 完成后统一使用：

```bash
yarn test:catalog
```

不再调用：

```bash
yarn test:static
```

## Browser 相关阶段

只要修改：

* L3 scenario；
* Playwright config；
* reporter；
* evidence；
* browser harness；

则追加 browser suite。

P1-07 之前：

```bash
yarn test:browser:smoke
```

P1-07 之后：

```bash
yarn test:browser
```

## 删除完整性检查

每一项删除至少满足：

```text
1. 目标文件/字段已不存在；
2. catalog 无旧引用；
3. runner 无旧注册；
4. package script / CI 无旧引用；
5. current-state docs 无旧引用；
6. 与其绑定的 Tooling 锚点已经同步；
7. 核心 L1/L2/L3 安全保护仍可运行。
```

不要采用下面方式“让清理绿起来”：

* 新增 ignore list；
* 将异常吞掉；
* 将 BLOCKED 改成 PASS；
* 放宽产品 evidence 的有效 binding 要求；
* 为旧机制留下永久兼容 alias。

## Fail-closed 专项验收

涉及 runner/evidence 的 P1-01～P1-04，每阶段还必须验证：

### 真 FAIL 仍为 FAIL

任意真实 assertion failure：

```text
exit code != 0
```

### 真 BLOCKED 仍为 BLOCKED

安全/供给阻断不能因协议简化变 PASS。

### 产品 PASS 不得无绑定

特别是 P1-01：

```text
product summary + PASS + no valid case binding
```

必须继续非法。

### Tooling PASS 不得冒充产品 PASS

Tooling 可以不绑定 product case，但它只能证明：

> 测试基础设施 suite 自己通过。

不能提高任何产品 case 的 coverage/lifecycle。

---

# 7. 本轮明确不做

虽然上一轮评审中下列内容属于真实问题，但**不属于本次清理范围**：

* 不新增 `first-story-stream-autoplay` L3；
* 不新增 TTS failure / stream interruption L3；
* 不新增 route continuity L3；
* 不给 P0/P1 重新设计完整性门；
* 不把 tier gate 重新接 CI；
* 不增加 PR workflow；
* 不给 CI 新增 browser tests；
* 不重新设计 Catalog v2；
* 不为了删除自制 YAML parser 而引入 YAML/Ajv 等新依赖；
* 不修复 P0-07 三条错误 L3 后继续保留——直接摘除，等产品新语义稳定后再决定是否重写；
* 不在本阶段调整 L3 clean-tree / `git archive HEAD` 隔离模型；
* 不删除 DB path guard、real-secret guard、真实上游禁用等安全保护；
* 不重写 `docs/plans/**`、`docs/archive/**` 的历史快照；
* 不把 `docs/specs/2026-09-11-main-auto-delivery.md` 的旧设计正文重写成新实现，只增加明确勘误/取代声明；
* 不因为 P1-01 Tooling 解耦而放宽产品 evidence 防伪规则。

尤其是：

```text
scripts/check-test-catalog.mjs
```

中的自制 YAML parser 虽然维护成本偏高，但删除它必然要求：

* 引入替代 parser；
* 或迁移 catalog 文件格式。

这属于重建，不夹带在本次清理中。

---

# 8. 清理后的目标态

清理结束后，测试体系只保留下列职责。

## 8.1 产品语义

```text
docs/e2e/**
```

负责：

* 用户目标；
* 场景；
* oracle；
* 产品风险语义。

产品大改版主要更新这里。

---

## 8.2 Test Catalog

```text
tests/test-catalog.yaml
```

只负责最小机器事实：

```text
case:
- case_id
- priority
- lifecycle_status
- risk_tags
- spec_path
- executable_ids
- 必要时 legacy_aliases

executable:
- executable_id
- layer: L1 | L2 | L3
- path
```

不再保存：

```text
primary_defense
secondary_defenses
required_assertions
ci_tier
Tooling bindings
evidence_surfaces
executable.case_ids
```

---

## 8.3 产品测试

```text
L1 → 单元/确定性逻辑
L2 → 真实模块 + seam / DB
L3 → 必须由真实 production browser 证明的行为
```

三层模型继续保留。

产品测试必须继续有真实 product case binding。

---

## 8.4 Tooling

```text
tests/tooling/**
```

只证明测试基础设施本身，例如：

* runner 没坏；
* DB guard 没坏；
* browser harness 没坏；
* catalog checker 没坏；
* workflow guard 没坏。

Tooling：

```text
不进入产品 catalog
不绑定产品 case
不提供产品 coverage
```

但仍然：

```text
FAIL 时 fail-closed
```

---

## 8.5 Catalog Checker

只负责：

```text
spec 存在
case/executable 引用存在
ACTIVE 有真实 executable
executable path 存在
L1/L2 registry/disk/catalog 不断链
L3 path 不断链
docs/e2e 产品场景被认领
```

不负责：

* 证明业务行为；
* 测试 Agent 流程；
* 发布 tier；
* assertion/surface 证据展开；
* Tooling 产品 coverage。

---

## 8.6 Evidence

只回答：

```text
什么被运行
结果是什么
属于哪个真实产品 case（产品测试）
或者只是 Tooling（基础设施测试）
在哪个 commit/browser
原始证据在哪里
为什么 BLOCKED
```

不再把：

```text
一个 suite/spec PASS
```

复制成：

```text
N 个 assertion PASS
```

同时保持：

```text
产品 PASS 必须有合法产品 binding
Tooling PASS 永远不能冒充产品 PASS
```

---

## 8.7 CI

本轮保持当前真实结构，不重建：

```text
main push
→ catalog
→ lint/typecheck
→ L1
→ L2
→ Tooling
→ build
→ GHCR publish
→ notify
```

仓库内 current-state 文档只描述这条可确认的链。

生产如何消费 GHCR 镜像：

**不确定，属于仓库外机制，不在本次清理中编造。**

是否在产品大改版稳定后重新加入：

* PR gate；
* L3；
* release completeness；

属于下一阶段决策。

---

# 9. 完成判定

本次清理可以认为完成，当且仅当：

```text
[ ] coverage-matrix 和人工统计快照已消失

[ ] test:static 命名歧义已消失
[ ] maintenance.md 与 governance-docs 用例4 已同步到 test:catalog

[ ] Contract 已消失
[ ] runner 空 group 已消失
[ ] runner-group-split 的白名单与真实 ALLOWED_GROUPS 一致

[ ] 重复 JSON Schema 已消失

[ ] Static legacy layer 已消失
[ ] runner-group-split 不再把 static 视为合法 group

[ ] Tier gate / ci_tier 已消失
[ ] check-test-catalog 顶部不存在 check-tier-gate 复用过期注释

[ ] 3 条错误 L3 不再被算作有效保护

[ ] current-state 发布文档不再声称 workflow 执行 SSH 上线
[ ] evidence.md 不再声称 CI 已配置 retention-days: 30
[ ] governance-docs 用例7 已改为验证“retention-days 未配置 + 脱敏”
[ ] docs/specs/2026-09-11-main-auto-delivery.md 已明确标记被当前实现取代，不再是 current-state authority
[ ] docs/plans/** 与 docs/archive/** 历史快照未被清洗

[ ] Tooling 不再绑定产品 case
[ ] Tooling 无产品 binding 时仍可正常 PASS/FAIL
[ ] 产品 PASS 无有效 case binding 时仍然非法
[ ] Tooling PASS 无法冒充产品 PASS

[ ] primary_defense / secondary_defenses 已消失

[ ] required_assertions / evidence_surfaces 已消失
[ ] 一个总 verdict 不再自动展开为 N 个 assertion verdict

[ ] executable.case_ids 双写已消失

[ ] Agent manifest 不再是普通测试完成条件

[ ] risks.md 不再作为第二份 current-state

[ ] smoke 不再污染产品 L3 verdict

[ ] L1/L2/L3 核心测试仍可运行
[ ] DB / secret / real-upstream 安全隔离仍保持
[ ] catalog checker 仍能阻止真正的资产断链
[ ] test:tooling 在每个阶段均保持 fail-closed 可用
```

达到这个状态后，产品大改版面对的测试维护问题会从：

```text
一个产品语义变化
→ 改 spec
→ 改 coverage matrix
→ 改 README 统计
→ 改 catalog 多层元数据
→ 改 ci_tier
→ 改 primary/secondary defense
→ 改 assertion/surface
→ 改 executable 双向 binding
→ 改 evidence join
→ 改 governance manifest
```

缩减成：

```text
产品语义变了
→ 改 docs/e2e spec/oracle
→ 判断哪些风险 case 仍成立
→ 更新/删除真正的 L1/L2/L3
→ 更新一条 case → executable binding
→ 运行对应测试
```

这就是本次“大改版前先清理、不重建”的目标基线。

这版已把 R1–R6 都放进对应 To-do 的原子执行边界里，尤其避免了三个危险的中间态：**改完文档却被 governance Tooling 打红、Tooling 解耦后被 evidence validator 全部判 BLOCKED、以及删除 runner group 后 Tooling 里的白名单继续漂移。**
