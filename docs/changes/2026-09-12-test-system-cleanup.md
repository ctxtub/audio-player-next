# 测试体系清理结项

- 状态：APPROVED
- 完成基准：ebae35b0412e4b07169a61f5bd3f3335b3550cd0
- 日期：2026-09-12

## 结果

交付范围：`main@5fc99a7` → `main@ebae35b0412e4b07169a61f5bd3f3335b3550cd0`（23 个提交，含 fixup）。固定分母 18 项，全部经外部评审逐项 APPROVE。每个 item 一个原子提交，fixup 一律叠加新提交。

- M0 / P0 方案文档：清理方案与执行清单落仓（`bcba9ef`）。
- P0-01：删除手工维护的覆盖矩阵与统计快照（`e133d15`）。
- P0-02：消除 `test:static` 命名错位，统一为 `test:catalog`（`0163534`）。
- P0-03：删除空 Contract 层及 runner 中空 group（`b4a4b57`）。
- P0-04：删除未实际承担校验职责的 `test-catalog.schema.json`（`827467c`，fixup `92e172f`）。
- P0-05：删除 `tests/static/**` legacy source-shape locks（`4e46862`）。
- P0-06：删除未接入交付链的 Tier Gate 与 `ci_tier`（`a5e1f2b`）。
- P0-07：摘除 3 条虚假强证据的 L3 executable（`5c47521`）。
- P0-08：删除与执行事实冲突的 CI / 发布 / Evidence 文档描述（`22c9f56`）。
- P1-01：将 Tooling 从产品 catalog 彻底解耦（`cf87471`，fixup `9a483d3`）。
- P1-02：删除 `primary_defense` / `secondary_defenses` 期望防线元数据（`5915e21`）。
- P1-03：删除 assertion / surface 级伪精度，evidence 降级为执行结果记录（`66c0dbb`，fixup `14b3fc8`）。
- P1-04：删除 `case.executable_ids ↔ executable.case_ids` 双向人工登记（`60909d0`）。
- P1-05：降级 Agent manifest / handoff / 独立会话强制协议（`6324769`，fixup `8b653b6`）。
- P1-06：停止维护 `docs/testing/risks.md` legacy alias 人工镜像（`34e83fe`）。
- P1-07：将 `smoke.spec.ts` 从产品 L3 正常执行链中移出（`defd559`，fixup `6aa2e35`）。
- P2-01：KEEP / DEFERRED，无提交。保留 `tests/system/browser/smoke.spec.ts` 手工环境诊断入口：browser-harness 的 Tooling 套件不启动真实浏览器，无法替代「production 页面可达 + 真实 MP3 解码产生 media events + Chromium / WebKit autoplay policy」这层诊断；该入口在 P1-07 后已退出默认 `yarn test:browser`、无 catalog binding、不属产品 coverage、不作为完成条件。评审明确要求不得为凑「每项一个提交」制造纯状态提交。
- P2-02：复查剩余 `*-legacy` executable，全部保留、0 删除（`d8c50d0`，fixup `ebae35b`）。逐项核对确认六项各自保护独立的 L1 / L2 行为，非 source-shape lock。

## 当前入口

- 测试体系：[`docs/testing/README.md`](../testing/README.md)
- 协作与变更入口：[`AGENTS.md`](../../AGENTS.md)
- 本次清理方案快照：[`docs/specs/2026-09-11-test-system-cleanup.md`](../specs/2026-09-11-test-system-cleanup.md)
- 变更流程：[`docs/engineering/change-workflow.md`](../engineering/change-workflow.md)
- 产物与留存：[`docs/engineering/artifacts-and-retention.md`](../engineering/artifacts-and-retention.md)

## 已知非阻断项

- `docs/specs/**` 与 `docs/plans/**` 中的历史命令名保留为当日快照，不改写。
- 生产部署不在仓库交付链内，本次合入不触发仓库侧上线。
- 六项 `*-legacy` executable 依据 P2-02 复核结论保留，不视为残留债务。

## 结论边界

本结项表示技术 APPROVE 且已合入 `main`，不等于生产上线 / 发布授权。
