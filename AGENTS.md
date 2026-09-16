# AGENTS.md

本文件是本仓库对所有编码 Agent 与人工协作者的统一入口。仓库内规则优先于本地 skill、模型默认习惯和历史任务文档。

## 30 秒入口

1. 项目说明与启动方式见 [README.md](README.md)。
2. 测试与交付验证方式见 [docs/testing/README.md](docs/testing/README.md)。
3. 工程变更生命周期见 [docs/engineering/change-workflow.md](docs/engineering/change-workflow.md)。
4. 多 Agent 角色与权限见 [docs/engineering/agent-collaboration.md](docs/engineering/agent-collaboration.md)。
5. 临时产物、证据与留存见 [docs/engineering/artifacts-and-retention.md](docs/engineering/artifacts-and-retention.md)。

## 测试策略

- 现行政策见 `docs/testing/README.md` 与 `docs/specs/2026-09-16-lean-testing-product-journey-policy.md`。
- 开发阶段只运行受影响范围的最小验证，不维护覆盖率或分层测试数量目标。
- 不使用字母加数字的阶段号、用例号或任务号；文件名和描述直接表达功能。
- 用户视角浏览器测试仅在交付最后阶段运行；必须从可见 UI 操作 production build，不得调用内部测试入口、Store、状态机或注入发布开关。
- 不新增源码字符串断言、生产测试入口、测试专用业务开关或重复跨层测试。

## 变更时必须同步什么

| 变更 | 必须处理 |
|---|---|
| 用户行为变化 | 优先更新产品 spec/验收标准；复用现有旅程，不机械新增 case/test 文件 |
| API、鉴权、持久化、状态机变化 | 运行最小相关验证；仅高损失风险补自动测试 |
| 末期用户旅程变化 | 更新一份直接描述用户目标的浏览器场景；不用编号、阶段号或映射目录 |
| runner、harness、测试工具变化 | 直接验证被改入口；不建立测试基础设施自测套件 |
| 内部实现变化但外部契约不变 | 不强制碰文档；运行最小相关验证 |
| 非平凡功能或架构变化 | 先写 dated spec/plan，再实现；已发布历史文档不改写为当前事实 |

禁止为了满足检查而无意义 touch 文档。若无法自动化，必须如实登记 `PLANNED`、`BLOCKED` 或 `MANUAL`。

## 完成门

按变更影响运行窄测；功能收口前至少执行：

```bash
yarn test:fast
yarn build
git diff --check
```

CI 云端只运行 lint、类型检查和 build，不运行重测试或真实用户模拟。用户视角浏览器验证只在准备交付的最后阶段由本地 production build 执行；日常开发、局部提交和中间 review 不要求浏览器全量门。

## 安全边界

- 禁止测试访问生产端口 `38080`、生产数据库 `/app/data/app.db` 或共享开发库 `prisma/dev.db`。
- 测试数据库和服务必须使用独立临时路径、随机本地端口与本地 mock。
- 禁止读取、复制、提交或记录真实 `.env*`、token、密码、cookie、连接串和用户数据。
- 运行前后检查 `git status`；不得提交 `.e2e-runtime/`、`.e2e-results/`、`.agent-runs/`、`test-results/` 或 `playwright-report/`。

## 多 Agent 与 Git

- 评估影响面后允许多写者并行：同一工作区即可并发，worktree 为需授权的强隔离选项，并声明不相交路径所有权；只用显式路径提交；重套件串行；需干净 tracked 树的门只在相关写者静默时运行；只读调研和 review 可并行。
- 并行分支须同时声明落地契约，包括目标、顺序、验证和清理方式。
- Planner、Implementer、Reviewer/Acceptor、Publisher 分权；实现者不得自批，验收者不得顺手修实现。
- 每个会话必须记录 change-id、角色、工作目录、目标 SHA、授权路径和证据位置。
- 未获明确授权不得 push、merge、deploy、触发 Actions、reset、rebase、force 或修改生产状态。
- 只显式暂存授权文件；禁止用 `git add .` 或 `git add -A` 把临时产物带入提交。
