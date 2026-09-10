# 多 Agent 协作标准

本文件定义项目无关具体模型的协作协议；Hermes/DSH 的调用、恢复和监督技巧放在本地 skill，不在仓库复制；其中 DSH 调用/恢复/监督走本地 DSH skill。

Hermes 调用/恢复走本地 Hermes skill。

长任务监督（超时、中断恢复、重叠写者防范）走本地 long-task-supervision skill。

## 角色与权限

| 角色 | 允许 | 禁止 |
|---|---|---|
| Planner | 只读调研；编写 spec/plan；定义范围和验收标准 | 修改业务实现；自行发布 |
| Implementer | 在授权工作区和路径内实现、测试、提交 | 自称最终 APPROVE；push/merge/deploy；扩大范围 |
| Reviewer/Acceptor | 只读审查；亲自复跑；写私有验收证据 | 修改 tracked 实现；替实现者补修 |
| Fixup | 只修 reviewer 列出的精确问题并复验 | 顺手重构或增加功能 |
| Publisher | 在明确授权后执行远端写入并回读 | 把技术 APPROVE 当作发布授权 |

## 并发模型

- **影响面评估后允许条件化多写者。** 并行写者优先使用各自独立 worktree 与分支，事先声明不相交路径所有权；只用显式路径提交；重套件串行；需干净 tracked 树的门只在相关写者静默时运行。
- 并行分支须同时声明落地契约（目标/顺序/验证/清理），细节见 `docs/specs/2026-09-10-multi-writer-concurrency-rule.md`。
- 只读代码调查、日志分析、spec review 可以并行，但必须固定同一目标 SHA。
- 需要并行实现时使用独立 worktree/分支，并事先定义所有权和合并顺序；不得共享运行时目录和数据库。
- 实现、review/acceptance、发布必须是不同会话；用户明确批准的例外要写入 change manifest。

## 会话最小传递包

每个 Agent 启动时必须获得：

```yaml
change_id:
role:
workspace:
branch:
base_sha:
target_sha:
authorized_paths: []
forbidden_actions: []
required_reads: []
required_commands: []
evidence_dir:
resume_anchor:
```

字段未知时不得猜。实现者报告只能作为证据索引；Reviewer 以 Git、磁盘、进程和亲复命令为准。

## 状态与交接

统一状态：

- `READY`：实现完成，等待独立验收，不代表通过。
- `PASS`：所选门由当前验收者独立证明。
- `FAIL`：行为或契约明确不满足。
- `CONCERN`：证据不足、所有权不明或风险待用户裁决。
- `BLOCKED`：环境、安全或权限阻止继续执行。

交接必须包含实际 SHA、changed files、命令与退出码、未执行项、已知失败、进程/端口所有权和恢复锚点。超时或连接中断后先回读旧会话、Git 状态与进程，不得直接启动重叠写者。

## Review 与 Fixup

1. Reviewer 先核范围，再核语义，最后亲复测试和安全终态。
2. FAIL 写出精确文件/行、PID/端口、预期、实际和复现命令。
3. Fixup 从验收确认的 SHA 开始，仅修改授权路径。
4. Fixup 完成后由新的 Reviewer 验收；不得让 Fixup 会话自批。
5. Reviewer 不 kill、不修代码、不清理未知进程；所有权不能证明时标 `CONCERN`。

## Git 与外部状态

- 未经授权禁止 push、merge、deploy、Actions dispatch、reset、rebase 和 force。
- 外部写入成功后必须从目标系统回读精确 ref/run/image/deployment；命令 exit 0 不是任务完成证明。
- Agent 过程证据写 `.agent-runs/`，测试行为证据写 `.e2e-results/`，两者都不得提交。
