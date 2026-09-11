## 变更说明

- 目标：
- 非目标：
- 变更类型：功能 / 修复 / 重构 / 测试基础设施 / 文档 / CI

## 测试影响

- 影响的产品旅程：
- 影响的 catalog case：
- primary / required secondary defense：
- spec 是否更新：是 / 否 / 不适用（说明原因）
- catalog 是否更新：是 / 否 / 不适用（说明原因）

## 已执行的验证命令

> 填写真实命令、退出码和关键结果；未运行写 `NOT_RUN` 与原因。

- [ ] `yarn test:catalog`
- [ ] `yarn lint`
- [ ] `yarn tsc --noEmit --incremental false`
- [ ] `yarn test:unit`
- [ ] `yarn test:integration`
- [ ] `yarn test:tooling`（命中 tooling 敏感路径时）
- [ ] `yarn build`
- [ ] `git diff --check`

## 浏览器验证

- 是否需要：是 / 否（说明原因）
- Chromium 结果：
- WebKit 结果：
- retries：
- evidence/run-id：

## 安全与边界

- [ ] 未修改或提交 `.env*`、真实 secret、数据库或用户数据
- [ ] `prisma/dev.db` 未被测试写入
- [ ] 临时产物仅在 ignored 目录
- [ ] 自有进程与端口已清理
- [ ] 未执行未经授权的 push/merge/deploy/Actions/history rewrite

## 已知缺口

- 无 / 列出 `PLANNED`、`BLOCKED`、`MANUAL`、`NOT_RUN` 或待决策事项：
