# 工程变更工作流

本文件定义本仓库从需求到发布的长期门禁。具体测试语义以 [`docs/testing/README.md`](../testing/README.md) 为准。

## 生命周期

1. **需求**：写清目标、非目标、用户可见验收标准、风险和允许副作用。
2. **方案**：非平凡变更在 `docs/specs/YYYY-MM-DD-<topic>.md` 记录方案与取舍。
3. **计划**：在 `docs/plans/YYYY-MM-DD-<topic>.md` 拆成可独立验证的实施步骤。
4. **基线**：记录分支、完整 SHA、工作区、相关测试与受保护资源指纹。
5. **实现**：影响面评估后允许条件化多写者（同一工作区并发与不相交路径所有权、显式路径提交、重套件串行、干净树门静默时运行，worktree 为需授权的强隔离选项）；行为变更先得到可信 RED，再做最小 GREEN。
   - 并行分支须同时声明落地契约（目标/顺序/验证/清理），细节见 `docs/specs/2026-09-10-multi-writer-concurrency-rule.md`。
6. **独立验收**：不同会话复核 diff、测试、进程、端口、数据库与秘密边界；不采信实现者自报。
7. **安全门**：检查 tracked 范围、历史、依赖、Actions、Docker context、日志和前端产物。
8. **发布**：`push` 到 `main` 即自动触发交付链（全仓唯一的 `.github/workflows/auto-delivery.yml`）：quality fail-closed 全绿 → 构建并推送 GHCR（只发 `sha-<short>` 不可变标签，不发任何移动标签）→ 成功/失败都发 Bark 通知；生产部署由仓库外机制负责或另有流程，当前仓库 `.github/workflows/auto-delivery.yml` 本身不执行 SSH 上线；技术 APPROVE 不等于发布授权，推 `main` 前必须先跑通本地完成门。历史设计细节见 `docs/specs/2026-09-11-main-auto-delivery.md`。
9. **运行验收与收尾**：回读远端状态、记录回滚点、遗留问题和精炼 closeout。

## 变更影响与测试选择

- 行为契约变化：更新 `docs/e2e`、catalog 与对应 L1/L2/L3 测试。
- 内部实现变化：声明受影响 catalog case，运行受影响 case 当前实际绑定的有效 executable。
- 测试工具或 CI 变化：运行 `test:tooling`、`test:catalog`，并直接验证被改入口。
- 文档变化：运行链接/静态门；文档中出现的命令和路径必须对照仓库事实。
- 不能证明的项目标为 `BLOCKED` 或 `NOT_RUN`，不能写成 PASS。

## 提交与 PR

- 一个提交只承担一个工程目标，遵循 Conventional Commits。
- PR 必须填写 `.github/pull_request_template.md` 的测试影响与验证记录。
- PR 不触发任何 workflow（交付链只在 `push` 到 `main` 时运行）：PR 合并前必须在本地跑通完成门并如实填写 PR 模板验证记录；浏览器可观察行为必须附 `test:browser:smoke` 证据。
- 交付链 `quality` 即 required 语义：红即阻断发布，不存在可忽略的红。
- GitHub required checks 由仓库管理员在分支保护中配置；workflow 文件存在本身不构成 required check 证明。

## 文档状态

- `docs/testing/**`、当前架构文档和代码是 current-state authority。
- `docs/specs/**`、`docs/plans/**` 是按日期发布的决策/实施快照，完成后只更新状态或追加勘误，不重写历史。
- `docs/archive/**` 只用于追溯，必须有索引和醒目标记，不得作为新任务执行入口。
- 重大变更完成后可在 `docs/changes/` 保存精炼 closeout；原始日志、截图、数据库和 transcript 不入 Git。
