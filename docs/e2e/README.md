# E2E 场景规范（兼容跳转页）

> 本页为兼容跳转页，不再是测试体系入口。
> 人工入口已迁移至 [docs/testing/README.md](../testing/README.md)，统计口径以 `scripts/check-test-catalog.mjs` 为准。
> 本目录下的产品场景规范（`docs/e2e/**/场景.md`）仍为产品语义权威，保留在原目录，本次不移动场景文件。

## 前往新入口

- 人工入口：[docs/testing/README.md](../testing/README.md)
- 产品覆盖矩阵（8 旅程 × case 分布）：[docs/testing/coverage-matrix.md](../testing/coverage-matrix.md)
- 风险语义索引：[docs/testing/risks.md](../testing/risks.md)
- 执行规范：[隔离执行](../testing/execution/isolation.md)、[合成数据与夹具](../testing/execution/fixtures.md)、[证据与留档](../testing/execution/evidence.md)、[verdict 语义](../testing/execution/verdicts.md)、[抖动策略](../testing/execution/flaky-policy.md)、[维护与变更](../testing/execution/maintenance.md)

## 产品场景目录（语义权威，保留在原目录）

| 场景目录 | 说明 |
| --- | --- |
| [01-基础冒烟与页面基线](./01-基础冒烟与页面基线/) | 访客冷启动、身份签发、首个故事、镜像一致、路由守卫 |
| [02-交互并发与竞态防御](./02-交互并发与竞态防御/) | 连击互斥、预载隔离、清空防孤儿、徽标一致、历史切换 |
| [03-播放状态与内核一致性](./03-播放状态与内核一致性/) | 倒计时耗尽、预算耗尽、段落切换、断点恢复、历史回放 |
| [04-云端存储与多端数据调和](./04-云端存储与多端数据调和/) | 并发覆盖、退出丢尾、乐观回滚、隔离零串读、摘要公开 |
| [05-认证授权与会话生命周期](./05-认证授权与会话生命周期/) | 注册迁移、登录隔离、登出清理、会话失效、切号隔离 |
| [06-异常处理与接口限流](./06-异常处理与接口限流/) | 限流 429、白名单回退、合成失败、中断重试、401 守卫、GC |

## 旅程索引（8 旅程，逻辑视图）

逻辑旅程分布详见 [产品覆盖矩阵](../testing/coverage-matrix.md)：`smoke-baseline 9`、`interactive-race 10`、`playback-kernel 12`、`cloud-storage 5`、`persistence-recovery 6`、`auth-session 10`、`error-rate-limit 8`、`history-reuse-create 1`。
旅程为逻辑分组，物理场景文件仍按上表 6 大套件目录存放，追踪关系为 `场景 spec ↔ tests/test-catalog.yaml ↔ 可执行套件`，以 checker 校验为准。
