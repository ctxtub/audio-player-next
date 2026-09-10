# 治理硬化历史归档（2026-09-10，WS7）

> **状态：HISTORICAL / DO NOT EXECUTE**
>
> 本目录保存治理硬化变更（`governance-hardening-20260910` C7）从 current-state 文档中整段删除的前代调度政策原文，仅用于追溯。
> 当前隔离/调度/证据事实以 `docs/testing/execution/`、`docs/engineering/artifacts-and-retention.md`、
> `tests/test-catalog.yaml` 与 `tests/system/browser/harness/` 代码为准。

- [`dsh-policy-excerpts.md`](dsh-policy-excerpts.md)：删除段落原文（`isolation.md` 原 §3.2 全节、原 §9 第 2 项、
  原 §2/`§8` 相关行、`maintenance.md` 原编号/端口/时限/退避/手工总数行），附来源 SHA 与删除确认。
- 变更依据：`docs/specs/2026-09-10-governance-and-release-hardening.md` §WS7、
  `docs/plans/2026-09-10-governance-and-release-hardening.md` §3 WS7 / §4 C7。

不得把本目录中的端口、超时、退避、PID 文件约定复制回现行文档或新任务；先读取根 `AGENTS.md` 和 `docs/testing/execution/isolation.md`。
