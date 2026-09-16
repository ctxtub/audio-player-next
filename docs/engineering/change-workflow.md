# 工程变更工作流

本文件定义本仓库从需求到发布的长期门禁。具体测试语义以 [`docs/testing/README.md`](../testing/README.md) 为准。

## 生命周期

1. **需求**：写清目标、非目标、用户可见验收标准、风险和允许副作用。
2. **方案**：非平凡变更在 `docs/specs/YYYY-MM-DD-<topic>.md` 记录方案与取舍。
3. **计划**：在 `docs/plans/YYYY-MM-DD-<topic>.md` 拆成可独立验证的实施步骤。
4. **基线**：记录分支、完整 SHA、工作区、相关测试与受保护资源指纹。
5. **实现**：影响面评估后允许条件化多写者（同一工作区并发与不相交路径所有权、显式路径提交、重套件串行、干净树门静默时运行，worktree 为需授权的强隔离选项）；优先完成真实用户旅程与 UI 表达，开发中只跑最小相关验证。
   - 并行分支须同时声明落地契约，包括目标、顺序、验证和清理方式。
6. **功能收口**：运行 `test:fast`、build 与高风险窄测，不默认运行全量 unit/integration/tooling。
7. **交付验收**：只在准备交付的最后阶段，以生产构建和默认发布配置运行精简用户浏览器旅程；不接受内部测试入口或状态注入证据。
8. **安全门**：检查 tracked 范围、历史、依赖、Actions、Docker context、日志和前端产物。
9. **发布**：`push` 到 `main` 即自动触发交付链（全仓唯一的 `.github/workflows/auto-delivery.yml`）：轻量 quality 门 → 构建并推送 GHCR（只发 `sha-<short>` 不可变标签，不发任何移动标签）→ 成功/失败都发 Bark 通知；生产部署由仓库外机制负责或另有流程。技术 APPROVE 不等于发布授权。
10. **运行验收与收尾**：回读远端状态、记录回滚点、遗留问题和精炼 closeout。

## 变更影响与测试选择

- 行为契约变化：更新 dated product spec 和可见验收标准；优先复用完整用户旅程，不机械新增多层测试。
- 内部实现变化：运行受影响范围的最小验证；无高损失风险时不新增测试。
- 测试工具或 CI 变化：直接验证被改入口，不为测试基础设施另建自测体系。
- 文档变化：运行链接/静态门；文档中出现的命令和路径必须对照仓库事实。
- 不能证明的项目标为 `BLOCKED` 或 `NOT_RUN`，不能写成 PASS。

## 提交与 PR

- 一个提交只承担一个工程目标，遵循 Conventional Commits。
- PR 必须填写 `.github/pull_request_template.md` 的测试影响与验证记录。
- PR 不触发任何 workflow（交付链只在 `push` 到 `main` 时运行）：功能收口前跑通轻量门并如实填写记录；用户浏览器证据仅在该 PR 已进入交付最后阶段时要求。
- 交付链 `quality` 即 required 语义：红即阻断发布，不存在可忽略的红。
- GitHub required checks 由仓库管理员在分支保护中配置；workflow 文件存在本身不构成 required check 证明。

## 文档状态

- `docs/testing/**`、当前架构文档和代码是 current-state authority。
- `docs/specs/**`、`docs/plans/**` 是按日期发布的决策/实施快照，完成后只更新状态或追加勘误，不重写历史。
- 重大变更完成后可在 `docs/changes/` 保存精炼 closeout；原始日志、截图、数据库和 transcript 不入 Git。
