# AGENTS.md

本文件是本仓库对所有编码 Agent 与人工协作者的统一入口。仓库内规则优先于本地 skill、模型默认习惯和历史任务文档。

## 30 秒入口

1. 项目说明与启动方式见 [README.md](README.md)。
2. 测试体系、分层、Catalog 与命令见 [docs/testing/README.md](docs/testing/README.md)。
3. 工程变更生命周期见 [docs/engineering/change-workflow.md](docs/engineering/change-workflow.md)。
4. 多 Agent 角色与权限见 [docs/engineering/agent-collaboration.md](docs/engineering/agent-collaboration.md)。
5. 临时产物、证据与留存见 [docs/engineering/artifacts-and-retention.md](docs/engineering/artifacts-and-retention.md)。
6. `docs/archive/**` 仅为历史快照，不是当前实现或执行规范。

## 测试事实源

- 产品场景与 oracle：`docs/e2e/**`。
- case、executable、层级、生命周期与 CI tier：`tests/test-catalog.yaml`。
- 机器一致性：`yarn test:static`；统计与文档冲突时以 checker 为准并阻断。
- L1：`yarn test:unit`；L2：`yarn test:integration`；Tooling：`yarn test:tooling`；L3：`yarn test:browser:smoke`。
- `MANUAL` 不进入自动执行队列；不得把 PLANNED/BLOCKED 伪装为 ACTIVE 或 PASS。

## 变更时必须同步什么

| 变更 | 必须处理 |
|---|---|
| 用户行为、API 契约、鉴权、状态机变化 | 更新/新增对应 `docs/e2e` 场景；核对 catalog case 与 oracle |
| case 生命周期、优先级、执行绑定变化 | 更新 `tests/test-catalog.yaml` 并运行 `yarn test:static` |
| runner、harness、workflow、测试工具变化 | 更新/新增 Tooling 测试并运行 `yarn test:tooling` |
| 内部实现变化但外部契约不变 | 不强制碰文档；必须声明受影响 case 并运行对应回归 |
| 非平凡功能或架构变化 | 先写 dated spec/plan，再实现；已发布历史文档不改写为当前事实 |

禁止为了满足检查而无意义 touch 文档。若无法自动化，必须如实登记 `PLANNED`、`BLOCKED` 或 `MANUAL`。

## 完成门

按变更影响运行窄测；提交前至少执行：

```bash
yarn test:static
yarn lint
yarn tsc --noEmit --incremental false
yarn test:unit
yarn test:integration
yarn build
git diff --check
```

修改 `scripts/**`、`.github/workflows/**`、`tests/tooling/**` 或 `prisma/schema.prisma` 时加跑 `yarn test:tooling`。浏览器可观察行为必须跑 `yarn test:browser:smoke`；产品失败不得靠重试或弱化 oracle 洗绿。

## 安全边界

- 禁止测试访问生产端口 `38080`、生产数据库 `/app/data/app.db` 或共享开发库 `prisma/dev.db`。
- 测试数据库和服务必须使用 `docs/testing/execution/isolation.md` 定义的隔离路径、端口与本地 mock。
- 禁止读取、复制、提交或记录真实 `.env*`、token、密码、cookie、连接串和用户数据。
- 运行前后检查 `git status`；不得提交 `.e2e-runtime/`、`.e2e-results/`、`.agent-runs/`、`test-results/` 或 `playwright-report/`。

## 多 Agent 与 Git

- 评估影响面后允许多写者并行：优先各自独立 worktree 与分支并声明不相交路径所有权；只用显式路径提交；重套件串行；需干净 tracked 树的门只在相关写者静默时运行；只读调研和 review 可并行。
- 并行分支须同时声明落地契约（目标/顺序/验证/清理），细节见 `docs/specs/2026-09-10-multi-writer-concurrency-rule.md`。
- Planner、Implementer、Reviewer/Acceptor、Publisher 分权；实现者不得自批，验收者不得顺手修实现。
- 每个会话必须记录 change-id、角色、工作目录、目标 SHA、授权路径和证据位置。
- 未获明确授权不得 push、merge、deploy、触发 Actions、reset、rebase、force 或修改生产状态。
- 只显式暂存授权文件；禁止用 `git add .` 或 `git add -A` 把临时产物带入提交。
