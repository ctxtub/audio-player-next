# 测试体系重建结项

- 状态：`APPROVED`
- 完成基准：`e494ed050702079f4dcab0cd759729bf36322fd6`
- 日期：`2026-09-10`

## 结果

- 建立 L1 Unit、L2 Integration、L3 Browser、Contract、Tooling、Static 的明确边界。
- 建立 `docs/e2e` 产品语义、`tests/test-catalog.yaml` 机器元数据和 executable/runner 的双向追踪。
- Unit 不建库；需要数据库的套件使用受控隔离 SQLite，危险路径 fail closed。
- 浏览器测试使用真实 Chromium + WebKit、retries=0、隔离 production harness 和本地 mock。
- 建立结构化 verdict、退出码、manifest、hash、脱敏和原始证据要求。
- Candidate、Browser、Nightly workflow 建立质量与浏览器门。
- 独立终验通过；第二轮窄 Fixup 关闭失真手工统计与孤儿 mock 进程。

## 当前入口

- 测试体系：[`docs/testing/README.md`](../testing/README.md)
- 多 Agent 协作：[`docs/engineering/agent-collaboration.md`](../engineering/agent-collaboration.md)
- 产物留存：[`docs/engineering/artifacts-and-retention.md`](../engineering/artifacts-and-retention.md)
- 历史原始材料：[`docs/archive/test-architecture-rebuild/2026-09-10/`](../archive/test-architecture-rebuild/2026-09-10/)

## 已知非阻断项

- 真机 Safari 手势不由 Playwright WebKit 证明，需在相关产品变更或发布风险要求时单独验证。
- Sass `@import` 与 Next turbo deprecation warning 属后续维护债，不影响本次测试体系批准。
- GitHub required checks 仍需仓库管理员在远端分支保护中配置；workflow 入库不等于远端规则已经启用。

## 结论边界

本结项表示测试体系技术 APPROVE，不自动授予 push、merge 或部署权限。
