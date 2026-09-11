# 自动交付链：main push 触发的串行交付（spec）

- 日期：2026-09-11
- change-id：`restore-main-auto-delivery-20260911`
- 状态：current-state authority（与实现同口径；旧政策文档见文末替代声明）
- 取代：`301c58a`“删除全部 CI 自动触发”决策与 `ac45dc4`“仅 workflow_dispatch”决策；
  `docs/specs/2026-09-10-governance-and-release-hardening.md` §WS1/WS2、
  `docs/plans/2026-09-10-governance-and-release-hardening.md` WS1/WS2/C1 为历史快照，不再是现行规范。

## 1. 用户决策（最高优先级）

1. `main` 分支 push 必须自动触发交付流水线，无需人工二次点击。
2. 自动检查必须真实可用：不通过即阻断后续发布与部署，不做装饰性检查。
3. 检查通过后自动构建并推送镜像到 GHCR。
4. 自动部署到生产，不需要人工再点一次。
5. 恢复 Bark 成功/失败通知。

## 2. 方案：恰好一条 workflow

新建唯一 workflow `.github/workflows/auto-delivery.yml`，触发条件只有
`push: branches: [main]`。无 `pull_request` / `schedule` / `tag` /
`workflow_dispatch` 触发——多入口会产生可并发的第二条链，与“恰好一条串行链”
矛盾，故全部删掉。失败重跑语义：GitHub 对失败 run 的 Re-run 仍可用；
需要重新部署同一提交时以空提交 push（`git commit --allow-empty`）触发新链，
保持“一切交付都经过完整 quality 门”的不变量。

job 图（线性，fan-in 即顺序）：

```text
quality → publish → deploy → notify(always)
```

- `quality`：fail-closed 门，见 §3。任何一步非零退出即红，`publish`/`deploy`
  因 `needs` 不再运行（GitHub 对未运行的 needs 记 `skipped`）。
- `publish`：`needs: [quality]`，构建并推送镜像，见 §4。
- `deploy`：`needs: [publish]`，SSH 到生产并滚动服务，见 §5。
- `notify`：`needs: [quality, publish, deploy]` + `if: always()`，Bark 通知，见 §6。

## 3. quality 门（fail-closed，全部用仓库自己的命令）

步骤顺序（与 `AGENTS.md` 完成门同序，另加 tooling 与 pin 校验）：

1. `yarn install --frozen-lockfile`
2. `npx prisma generate`
3. `node scripts/verify-action-pins.mjs`（供应链：pin 必须与 upstream 真实 tag 一致）
4. `yarn test:static`
5. `yarn lint`
6. `npx next typegen`
7. `yarn tsc --noEmit --incremental false`
8. `yarn test:unit`
9. `yarn test:integration`
10. `yarn test:tooling`（无条件全量跑，不做 path-filter 抽查——旧链的
    “未命中 tooling 路径就跳过 `test:tooling`”在本链是不可接受的弱化：
    交付链的结论必须与守卫测试结论一致）
11. `yarn build`

取舍：

- 不含浏览器 smoke（`yarn test:browser:smoke` 仍是本地人工门，
  见 `AGENTS.md`）。理由：Playwright 双浏览器在共享 runner 上耗时与抖动都大，
  放进自动交付链会把“交付是否成功”与“浏览器环境是否抖动”耦合；
  Node 层（L1/L2/tooling/static）已覆盖交付相关回归。浏览器可观察行为变更
  仍必须在本地跑 smoke，证据进 PR。
- 不含 tier-gate（`check-tier-gate.mjs`）。理由：本链每一次运行都是 RELEASE
  语义（生产部署），不存在 CANDIDATE/RELEASE 双选分支；tier 豁免机制
  （`tests/tier-waivers.yaml`）留给本地发布评审用，不进自动链。
- 超时上限：`quality` 30 分钟，`publish` 20 分钟，`deploy` 15 分钟，
  `notify` 5 分钟。超时即红（fail-closed），不静默挂起。

## 4. publish（GHCR，只发不可变 sha 标签）

- 登录：`docker/login-action`，`password: ${{ secrets.GHCR_TOKEN || secrets.GITHUB_TOKEN }}`
 （与旧链一致：私有 GHCR 写优先用 `GHCR_TOKEN`，回退 `GITHUB_TOKEN`）。
- 构建：复用 `scripts/push-ghcr.sh`，**无参数调用** = 只发 `sha-<shortSHA>`
  （脚本既有语义：空 tag 即 sha-only；与生产既有 `sha-e5f41be` 约定一致，7 位）。
- 不发任何移动标签：不发 `main`（移动指针在部署失败时无法回滚），
  不发 `latest`（脚本内 `add_tag` 有字面守卫）；tooling 守卫钉死
  workflow 代码无 `:main`/`:latest`、publish 不传 ref 名、脚本无 `"main"` 逻辑。
- 平台：`linux/amd64`（生产 VPS 单架构）。因此不需要 QEMU 模拟：
  旧链的 `setup-qemu-action` 在本链删除，供应链暴露面减一。
  若将来生产出现多架构，再加 qemu + 平台矩阵（届时同步更新 lock 与守卫）。
- provenance + sbom：脚本默认 `--provenance=true --sbom=true`，保持旧链 WS2 要求。

## 5. deploy（隔离 job + 隔离步骤，SSH，幂等，fail-closed）

传输方式：VPS 自带 `openssh-client` 的 `ssh`（`ubuntu-latest` 预装），
不引入第三方 ssh action（供应链暴露面减一）。认证：`DEPLOY_SSH_KEY`
（ed25519/curve 私钥内容）写临时文件 `chmod 600`，`StrictHostKeyChecking=yes`
配合 `DEPLOY_KNOWN_HOSTS` 校验主机指纹；命令结束即 `rm -f` 私钥文件。
不读、不打印、不提交任何 secret 值（只映射进 `env`，GitHub 自动脱敏；
脚本内禁 `echo`/`set -x` 触碰 secret 变量）。

可变参数只来自 Secrets（只写名，不写值）：

| secret 名 | 用途 |
|---|---|
| `DEPLOY_SSH_KEY` | SSH 私钥内容 |
| `DEPLOY_KNOWN_HOSTS` | 主机指纹（`ssh-keyscan` 输出行） |
| `DEPLOY_HOST` | 生产主机 |
| `DEPLOY_USER` | SSH 用户 |
| `DEPLOY_COMPOSE_DIR` | 生产 compose 目录（事实：`/opt/1panel/docker/compose/audio-player-next`，以 secret 值为准） |
| `DEPLOY_SERVICE` | compose service 名（与根 `docker-compose.yml` 同口径，默认约定 `web`，仍必须显式配置） |
| `DEPLOY_PORT` | 可选，默认 `22` |

注：SSH 步骤另把 `secrets.GHCR_TOKEN || secrets.GITHUB_TOKEN` 映射为
`GHCR_DEPLOY_TOKEN` 传给远端先登录再拉：runner 侧经 stdin 首行传递
（`printf '%s\n'` 为 shell 内建，不进 `ssh` argv，`ps` 不可见；远端
`IFS= read -r GHCR_TOKEN; export GHCR_TOKEN` 消费首行后 `bash -s` 读剩余脚本），
远端再经 `--password-stdin` 进 `docker login`，不落日志；
宿主 GHCR 凭据寿命未知（UNPROVEN），绝不依赖宿主既有凭据。

失败语义（全部 fail-closed，静默成功是 bug）：

1. secret 缺失门：任一必填 secret 为空即 `exit 1`，报错信息给出
   “缺哪个 secret、在哪个仓库 Settings → Secrets and variables → Actions
   配、配完重跑方式（空提交 push）”三段，可直接照做。
2. staleness 守卫（§7）通过后才 SSH。
3. 远端定位目标 service 的 `image:` 行：必须存在，否则 fail-closed
   并打印该 service 段实际内容（不猜、不自动改生产文件）。
4. 部署前记录并打印回滚点：当前 `image:` 行原文 + 运行中容器的
   image ID（`docker inspect --format '{{.Image}}'`）与配置引用
   （`{{.Config.Image}}`）。
5. 备份 + 原子替换：compose 备份为同目录时间戳副本
   （`<file>.bak.<UTC时间戳>`）；只替换目标 service 的 `image:` 值为
   `${IMAGE}:sha-${SHORT_SHA}`，临时文件须 `mktemp -p "$(dirname "${FILE}")"`
   与目标同目录（跨文件系统 `mv` 是拷贝＋删除而非原子重命名），写入后 `mv`
   原子替换，禁 `sed -i` 就地改。有界保留：只留最近 5 个备份
  （`ls -1t <file>.bak.* | tail -n +6 | xargs -r rm -f`），防无限堆积。
6. 替换后先校验再拉取：`docker compose config -q` 必须成功；
   失败即还原备份并 `exit 1`。
7. 先 `docker login ghcr.io`（临时 `DOCKER_CONFIG="$(mktemp -d)"` 承接登录，
   `trap 'rm -rf "${DOCKER_CONFIG}"' EXIT` 结束即删，不写宿主
   `/root/.docker/config.json`、不污染宿主持久凭据库；注入的 token 经
   `--password-stdin`，不落日志；宿主 GHCR 凭据寿命未知=UNPROVEN，不依赖宿主既有凭据），
   再 `docker compose pull <service> && docker compose up -d <service>`；
   任一失败即 `exit 1`（`set -euo pipefail` + SSH 非零穿透：
   `ssh … bash -s` 的退出码即远端脚本退出码）。
8. 主动健康探测（生产容器无 Docker healthcheck，这是唯一真实探针）：
   `curl -sS --max-time 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:38080/`，
   禁 `-f`（`-f` 在 4xx/5xx 下先打印码再 exit 22，会与 fallback 拼出 `500000`；
   去掉后 4xx/5xx 由 `-w` 直出真实码并 exit 0，交断言处理；超时/连不上 `-w`
   本身输出 `000`，故 fallback 用 `|| true` 而不用 `|| echo '000'`，否则拼出 `000000`），
   有界重试（12 次 × 10 秒），必须实际断言 200 并打印状态码。
9. 健康失败必须自动回滚：还原备份 → `up -d` → 再探测一次 →
   打印回滚结果 → 仍然 `exit 1`（回滚成功不等于交付成功）；
   回滚失败打印明确的人工介入指引（登录生产、目录、备份文件名、
   手动恢复命令）。
10. 产物一致性：`up -d` 后读取运行中容器的 image ID，与本次
    `sha-${SHORT_SHA}` 对应本地 image ID 比对，一致才算通过；
    不一致按失败处理（含回滚分支）。不得只凭 `pull`/`up` 退出码
    判定生产已更新。生产当前单副本；`ps -q` 取首行
   （`ps -q "${SVC}" | head -n 1`）防 `replicas>1` 时多行误判回滚。
11. 幂等：同一 SHA 重跑时 image 行已是目标值，跳过备份替换，
    直接做健康与产物一致性校验（no-op 路径）。

副作用边界（deploy 远端）：`docker login` 的凭据只写临时 `DOCKER_CONFIG`
目录（`mktemp -d`，`trap EXIT` 删除），`pull` 用该临时凭据；宿主
`/root/.docker/config.json` 不被改写、不残留本次 token。边界：同一宿主上
的并发外部 `docker` 调用不受本链控制；`trap` 仅保证本脚本退出（成功/失败/
回滚）时删除临时目录，不清理宿主既有凭据。

## 6. Bark 通知（成功与失败，warn-only）

- `notify` job：`needs: [quality, publish, deploy]`，`if: always()`，
  顶层 `permissions: {}` 的 job 级 `permissions: {}`（只需读 needs 上下文与
  `BARK_WEBHOOK` secret，无写需求）。
- 标题判定：`${{ needs.deploy.result }} == 'success'` →“生产部署 推送成功”；
  否则（quality 红 / publish 红 / deploy 红或 skipped）→“生产部署 推送失败”，
  正文统一带仓库名、`main`、`sha-<short>`。
- 传输失败语义（已选定，代码注释同步声明）：**warn-only**。
  `curl --fail --max-time 15 … || echo "::warning::Bark …"`：
  Bark 抖动/配错不得把一次成功的部署标红，也不得吞掉失败——失败标题
  已尽力送出，`::warning::` 注解保证在 run 页面可见。
  `BARK_WEBHOOK` 未配置：跳过并打印“去配 secret 名”的提示，`exit 0`
  （通知是可观察性旁路，不是交付门；交付门 fail-closed 见 §3/§5）。
- 卫生：沿用旧链 `env` 映射 + `python3 urllib.parse.quote` 编码，
  禁止把 `${{ secrets.BARK_WEBHOOK }}` 直接拼进 `run:` 字面。

## 7. staleness 守卫（过期提交不得覆盖新部署）

- 位置：`deploy` job 内、SSH 步骤之前，独立步骤 `Check staleness`。
- 实现：`git fetch origin main` 后比较
  `git rev-parse origin/main` 与 `${{ github.sha }}`。
  不等 → `stale=true`（`$GITHUB_OUTPUT`），后续 SSH/健康步骤
  `if: steps.stale.outputs.stale != 'true'` 跳过；本 job 以
  “`STALE: 待部署 <short> 已不是 main 头部（头部=<short>），跳过部署`”
  显式绿退（skip 不是 fail：旧 run 变红会误导值班以为生产坏了）。
- 与 `concurrency` 的配合（§8）：队列串行保证“旧 run 先、 新 run 后”或
  反之任一顺序下，旧提交的 deploy 步骤永远命中 `stale=true` 而跳过；
  只有 main 头部的那次运行会真正 SSH。旧部署覆盖新部署在构造上不可能。

## 8. 并发、权限、供应链

- `concurrency: { group: auto-delivery-main, cancel-in-progress: false }`
 （顶层，整链共享）：同一时刻只有一条链在跑；新 push 排队不取消旧链
  （取消旧链会让“谁先 publish、谁后 deploy”不可推理；排队 + staleness
  跳过才是可证明的顺序安全）。
- 顶层 `permissions: {}`；`quality: contents:read`；
  `publish: contents:read + packages:write`（全仓唯一的 `packages:write`）；
  `deploy: contents:read + packages:read`（staleness 需 git 数据；回退 token
  `GHCR_TOKEN || GITHUB_TOKEN` 拉私有包需 `packages` 域，否则 login 成功但 pull
  鉴权失败，无写需求）；
  `notify: {}`。
- 第三方 action 全部固定真实完整 SHA + `# <tag>` 注释，
  由 `scripts/verify-action-pins.mjs` 向 GitHub API 实解析复验
  （本 spec 起草时已用 API 逐个验真 §9 表），lock 在
  `tests/tooling/ci/action-pins.lock.json`；tooling 守卫做离线形状 +
  lock 一致性断言（不断网）。

## 9. pin 真值表（2026-09-11 经 GitHub API 逐个验真）

| action | tag | commit SHA |
|---|---|---|
| `actions/checkout` | `v4.2.2` | `11bd71901bbe5b1630ceea73d27597364c9af683` |
| `actions/setup-node` | `v4.2.0` | `1d0ff469b7ec7b3cb9d8673fde0c81c44821de2a` |
| `docker/setup-buildx-action` | `v3.10.0` | `b5ca514318bd6ebac0fb2aedd5d36ec1b5c232a2` |
| `docker/login-action` | `v3.3.0` | `9780b0c442fbb1117ed29e0efdff1e18412f7567` |

注：旧 `verify-action-pins.mjs` 头注称这批 SHA 为“编造”（2026-09-11 上下文），
与 2026-09-11 当日 API 实测矛盾——五个 tag（含已删除 qemu `v3.6.0` =
`29109295f81e9208d7d86ff1c6c12d2833863392`）全部解析命中。
恢复脚本时以实测为准修正头注，逻辑不动。

## 10. 回滚点

1. 链本身误触发/误部署：revert 本 change 的 workflow 文件提交并 push 到 main
   （revert 自身也会触发一次链——预期内：revert 后的链 quality 照跑，
   publish 推出 revert 后 content 的镜像，deploy 上线它；即“回滚即一次
   正常交付”，无需特殊通道）。
2. 镜像坏/上线错版本：生产 compose 同目录有时间戳备份
   （链每次非幂等改写前自动留，有界保留只留最近 5 个），手动 `cp <备份> docker-compose.yml &&
   docker compose up -d` 即回滚；或直接把 `image:` 改为上一个绿
   `sha-<short>` 再 `pull + up -d`；不可变 `sha-` 标签永不覆盖，
   旧产物一直在 registry 可取。
3. 流水线全停（Actions 中断）：回退到 `scripts/push-ghcr.sh` 手动推镜像 +
   手动 SSH 上线（该脚本与本链同 tag 语义，未动）。
4. 恢复锚点：base `9edddfa6cecf3104eaca759fe3b952dd35c08737`；
   本分支 `integration/auto-delivery-20260911`；远端只允许 push 该分支。
