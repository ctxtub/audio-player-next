# 实施计划：main 自动交付链

- 日期：2026-09-11
- change-id：`restore-main-auto-delivery-20260911`
- 分支：`integration/auto-delivery-20260911`（base `9edddfa6cecf3104eaca759fe3b952dd35c08737`）
- spec：`docs/specs/2026-09-11-main-auto-delivery.md`

## 步骤（顺序即落地顺序，每步可独立验证）

### P1 恢复 pin 校验器与 lock

- 从 `301c58a^` 恢复 `scripts/verify-action-pins.mjs`（逻辑逐行不动，
  只修正头注“编造 SHA”段落为 2026-09-11 API 实测结论）。
- 新建 `tests/tooling/ci/action-pins.lock.json`，4 条目
  （checkout/setup-node/setup-buildx/login-action），`files` 均为
  `["auto-delivery.yml"]`。
- 验证：`node scripts/verify-action-pins.mjs` 在有网环境 PASS
  （本地无网则 INFRA 分类退出，不记 PASS 也不记 FAIL，见完成门记录）。

### P2 新建唯一 workflow

- 新建 `.github/workflows/auto-delivery.yml`（全仓唯一的 workflow 文件）：
  `quality → publish → deploy → notify(always)`，触发仅 `push: branches: [main]`，
  顶层 `permissions: {}` + `concurrency: {group: auto-delivery-main, cancel-in-progress: false}`。
- 验证：本地 `node -e` 小脚本或守卫测试解析确认触发/job 图；
  `git grep 'uses:'` 确认全部 `@<40hex> # v…`。

### P3 守卫测试与三方接线

- 新建 `tests/tooling/delivery/auto-delivery.tooling.test.ts`，钉死：
  触发条件（仅 main push，无 pr/schedule/tag/dispatch）、job 依赖顺序、
  concurrency、顶层+job 级 permissions（唯一的 `packages:write` 在 publish）、
  pin 全 SHA、只发 sha 不可变标签（workflow 代码无 `:main`/`:latest`、
  publish 不传 ref 名、脚本无 `"main"` 逻辑与 `add_tag "latest"`）、
  deploy 在 publish 之后、staleness 守卫存在、部署 secret 名齐全、
  deploy 含备份+原子替换（禁 `sed -i`）+`config -q`+先登录再拉+
  健康断言 200+失败自动回滚+产物一致性校验+回滚点记录+幂等分支、
  notify `always()` + Bark warn-only 标记。
- 接线：`scripts/run-tests.mjs` 注册 `auto-delivery`（总数注释 53→54）；
  `tests/test-catalog.yaml` 新增 `exec-auto-delivery` 并双向挂到
  `guest-identity-cookie-upgrade`（与 `exec-tier-gate` 等同口径）；
  `runner-group-split` 的 `metaSuiteIds` 追加 `auto-delivery`
  （新测试只读文件、无 runner 调用，是 needs_db=false 叶子）。
- 验证：`yarn test:tooling`（目标 suite）→ `yarn test:static` 绿。

### P4 旧政策表述清理（不留双重真相）

- `AGENTS.md` 完成门：删“仓库不含 CI 自动触发”，改为 main push 自动交付 + 本地手动命令。
- `docs/engineering/change-workflow.md` §8 发布节 + 提交与 PR 节：
  改为“main push 自动交付链；只发 sha-<short> 不可变标签，不发移动标签；
  部署改 compose 上线，备份+原子替换+健康+失败回滚+产物一致；
  全仓唯一串行发布者 auto-delivery.yml”。
- `tests/tooling/runner/runner-group-split.tooling.test.ts` 第 38 行注释：
  “缩为两个”→ 含新 delivery 元测试的表述。
- 不碰：`docs/archive/**`（历史快照）、dated spec/plan（历史快照，只追加状态）。

### P5 完成门与推送

- 依次：`yarn test:static`、`yarn lint`、
  `yarn tsc --noEmit --incremental false`、`yarn test:unit`、
  `yarn test:integration`、`yarn test:tooling`、`yarn build`、
  `git diff --check`。`test:browser:smoke` 为 NOT_RUN（无浏览器行为变更；
  新 workflow 不含浏览器 job，见 spec §3 取舍）。
- `git fetch origin` 确认远端分支仍在 base SHA 后，显式路径
  `git add` + 提交（Conventional Commits，可分 2–3 个提交：spec/plan、
  workflow+脚本守卫、测试+文档），push 到
  `origin/integration/auto-delivery-20260911`。

## 失败语义速查（实现时对照）

| 位置 | 失败 | 行为 |
|---|---|---|
| quality 任一步 | 非零退出/超时 | 红，publish/deploy 不运行 |
| pin 实解析不一致 | mismatch | 红，拒绝写 lock |
| pin 解析网络故障 | unresolved/INFRA | 红但分类为基建，不记“pin 伪造”结论 |
| publish | 非零退出 | 红，deploy 不运行 |
| deploy secret 缺失 | 空变量 | 红 + 三段式可照做报错 |
| deploy staleness | 非头部 | 绿退 skip，显式说明 |
| deploy image 行缺失/config 非法 | 定位失败/校验失败 | 红（config 失败先还原备份） |
| deploy pull/up/健康/产物不一致 | 非零/超时/ID 不等 | 红 + 自动回滚（还原→重起→再探测→打印结果），仍 exit 非零 |
| notify Bark 传输 | curl 失败 | `::warning::`，不翻转结论 |
| notify 无 BARK_WEBHOOK | 空 | 跳过提示，exit 0 |

## 设计修正记录（2026-09-11 第二轮，ROBOT 生产实测后）

- 否掉“发布 `main` 移动标签 + 生产 compose 引用 `:main`”方案：
  生产实际钉的是 `sha-e5f41be`，且生产容器无 Docker healthcheck；
  移动指针在失败时无法回滚。改为 publish 只发 `sha-<short>`，
  deploy 直接改写 compose 的 `image:` 行为本次 sha。
- 新增：回滚点打印、时间戳备份、`mv` 原子替换（禁 `sed -i`）、
  `config -q` 先验、远端先 `docker login`（宿主凭据寿命 UNPROVEN）、
  curl 断言 200、健康失败自动回滚、运行中 image ID 与产物比对、
  同 SHA no-op 幂等分支。

## 回滚（与 spec §10 同口径，不重复）

revert 即正常交付；旧镜像 `sha-` 标签可取；生产 compose 同目录时间戳
备份可直接恢复；Actions 全停时回 `scripts/push-ghcr.sh` 手动链。
