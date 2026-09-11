import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * main 自动交付链 tooling 守卫（2026-09-11 新政策，fail-closed）。
 *
 * 钉死 `.github/workflows/auto-delivery.yml`（全仓唯一 workflow）：
 * ①触发：仅 main push，无 pull_request/schedule/tag/dispatch；
 * ②job 图：quality → publish → deploy → notify(always)；
 * ③concurrency：整链单组串行，不取消旧链；
 * ④permissions：顶层空，job 最小，唯一的 packages:write 在 publish；
 * ⑤pin：全部第三方 action 为真实完整 SHA + tag 注释，与 lock 一致；
 * ⑥无自动 latest 漂移；
 * ⑦deploy 在 publish 之后，含 staleness 守卫与 secret fail-closed 门；
 * ⑧notify 必须 always()，Bark 传输 warn-only。
 *
 * 口径：纯文件结构断言，不触 DB/网络/浏览器；needs_db=false 叶子套件。
 * 本文件只读 workflow/脚本/lock 与 runner 注册表文本，不执行任何套件，无自指递归。
 */

// 中文注释：仓库根（全部被测路径均以 cwd 为仓库根解析）。
const repoRoot: string = process.cwd();
// 中文注释：被测 workflow / 脚本 / lock 相对路径。
const workflowRel: string = path.join('.github', 'workflows', 'auto-delivery.yml');
const pushScriptRel: string = path.join('scripts', 'push-ghcr.sh');
const lockRel: string = path.join('tests', 'tooling', 'ci', 'action-pins.lock.json');
// 中文注释：runner 注册表相对路径（仅文本断言自身已登记，不执行 runner）。
const runnerRel: string = path.join('scripts', 'run-tests.mjs');
// 中文注释：预期 pin 真值表（2026-09-11 经 GitHub API 逐个验真，见 spec §9）。
const expectedPins: Array<{ repo: string; tag: string; sha: string }> = [
  { repo: 'actions/checkout', tag: 'v4.2.2', sha: '11bd71901bbe5b1630ceea73d27597364c9af683' },
  { repo: 'actions/setup-node', tag: 'v4.2.0', sha: '1d0ff469b7ec7b3cb9d8673fde0c81c44821de2a' },
  { repo: 'docker/setup-buildx-action', tag: 'v3.10.0', sha: 'b5ca514318bd6ebac0fb2aedd5d36ec1b5c232a2' },
  { repo: 'docker/login-action', tag: 'v3.3.0', sha: '9780b0c442fbb1117ed29e0efdff1e18412f7567' },
];
// 中文注释：部署必填 secret 名（只断言名出现，绝不断言值）。
const requiredDeploySecrets: string[] = [
  'DEPLOY_SSH_KEY',
  'DEPLOY_KNOWN_HOSTS',
  'DEPLOY_HOST',
  'DEPLOY_USER',
  'DEPLOY_COMPOSE_DIR',
  'DEPLOY_SERVICE',
];

/**
 * 读文本文件（缺失即 RED）。
 */
function readText(rel: string): string {
  const abs: string = path.join(repoRoot, rel);
  assert.ok(fs.existsSync(abs), `缺失被测文件应 RED：${rel}`);
  return fs.readFileSync(abs, 'utf-8');
}

/**
 * 抽取顶层 job 段（jobs 下两空格缩进 job 名起，至下一同级 job 止）。
 */
function jobSection(workflow: string, jobName: string): string {
  const lines: string[] = workflow.split('\n');
  // 中文注释：只从顶层 jobs: 段内定位（on.push 等触发键同缩进，需排除）。
  const jobsIdx: number = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(jobsIdx >= 0, '缺顶层 jobs: 段=RED');
  const start: number = lines.findIndex((l, i) => i > jobsIdx && new RegExp(`^  ${jobName}:\\s*$`).test(l));
  assert.ok(start >= 0, `缺 job ${jobName}=RED`);
  let end: number = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * 用例①：全仓恰好一个 workflow，且触发仅为 main push。
 */
async function caseSingleWorkflowMainPushOnly(): Promise<void> {
  const dir: string = path.join(repoRoot, '.github', 'workflows');
  const files: string[] = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
  assert.deepStrictEqual(files, ['auto-delivery.yml'], `全仓必须恰好一条交付链，实际=${JSON.stringify(files)}=RED`);
  const workflow: string = readText(workflowRel);
  assert.ok(/^\s{2}push:/m.test(workflow), '缺 push 触发=RED');
  assert.ok(workflow.includes('branches:') && workflow.includes('- main'), 'push 必须限定 branches main=RED');
  assert.ok(!/^\s{2}pull_request:/m.test(workflow), '不得存在 pull_request 触发=RED（第二条链入口）');
  assert.ok(!workflow.includes('schedule:'), '不得存在 schedule 触发=RED');
  assert.ok(!workflow.includes('workflow_dispatch:'), '不得存在 workflow_dispatch 触发=RED（交付不需要人工二次点击）');
  assert.ok(!workflow.includes('tags:'), '不得存在 tag 触发=RED（main push 是唯一入口）');
  console.log('PASS: 用例① 全仓唯一 workflow 且仅 main push 触发');
}

/**
 * 用例②：job 图 quality → publish → deploy → notify，其中 notify 必须 always()。
 */
async function caseJobOrder(): Promise<void> {
  const workflow: string = readText(workflowRel);
  // 中文注释：job 键只从顶层 jobs: 段内取（on.push 等触发键同缩进，需排除）。
  const jobsIdx: number = workflow.split('\n').findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(jobsIdx >= 0, '缺顶层 jobs: 段=RED');
  const jobsText: string = workflow.split('\n').slice(jobsIdx).join('\n');
  const keys: string[] = jobsText.split('\n').filter((l) => /^  [A-Za-z0-9_-]+:\s*$/.test(l)).map((l) => l.trim().replace(/:$/, ''));
  assert.deepStrictEqual(keys, ['quality', 'publish', 'deploy', 'notify'], `job 集合必须恰为 quality/publish/deploy/notify，实际=${JSON.stringify(keys)}=RED`);
  assert.ok(/needs:\s*\[quality\]/.test(jobSection(workflow, 'publish')), 'publish 必须 needs: [quality]=RED');
  assert.ok(/needs:\s*\[publish\]/.test(jobSection(workflow, 'deploy')), 'deploy 必须 needs: [publish]（部署必须在发布之后）=RED');
  const notify: string = jobSection(workflow, 'notify');
  assert.ok(/needs:\s*\[quality,\s*publish,\s*deploy\]/.test(notify), 'notify 必须 fan-in quality/publish/deploy=RED');
  assert.ok(/^\s*if:\s*always\(\)\s*$/m.test(notify), 'notify 必须 if: always()=RED（失败也要通知）');
  // 中文注释：真负例——缺 always() 的 fan-in 不得被误判为通知门。
  assert.ok(!/^\s*if:\s*always\(\)\s*$/m.test(jobSection(workflow, 'deploy')), '负例：deploy 不得带 always()=RED');
  console.log('PASS: 用例② job 依赖顺序 + notify always()');
}

/**
 * 用例③：concurrency 整链单组串行，不取消旧链。
 */
async function caseConcurrency(): Promise<void> {
  const workflow: string = readText(workflowRel);
  assert.ok(workflow.includes('group: auto-delivery-main'), '缺顶层串行组 auto-delivery-main=RED');
  assert.ok(workflow.includes('cancel-in-progress: false'), '必须 cancel-in-progress: false=RED（取消旧链会破坏顺序可推理）');
  assert.ok(!workflow.includes('cancel-in-progress: true'), '不得出现 cancel-in-progress: true=RED');
  assert.strictEqual((workflow.match(/auto-delivery-main/g) || []).length, 1, '串行组必须恰出现一次（顶层共享，不搞 per-job 分组）=RED');
  console.log('PASS: 用例③ concurrency 单组串行且不取消');
}

/**
 * 用例④：顶层空权限 + job 最小权限，全仓唯一的 packages:write 在 publish。
 */
async function casePermissions(): Promise<void> {
  const workflow: string = readText(workflowRel);
  assert.ok(/^permissions: \{\}\s*$/m.test(workflow), '顶层必须 permissions: {}=RED');
  assert.strictEqual((workflow.match(/packages:\s*write/g) || []).length, 1, 'packages:write 必须恰出现一次=RED');
  assert.ok(/packages:\s*write/.test(jobSection(workflow, 'publish')), '唯一的 packages:write 必须在 publish=RED');
  assert.ok(/contents:\s*read/.test(jobSection(workflow, 'quality')), 'quality 须 contents: read=RED');
  assert.ok(/contents:\s*read/.test(jobSection(workflow, 'deploy')), 'deploy 须 contents: read（staleness 需 git 数据）=RED');
  assert.ok(/^ {4}permissions: \{\}\s*$/m.test(jobSection(workflow, 'notify')), 'notify 须 job 级 permissions: {}=RED');
  assert.ok(!workflow.includes('write-all'), '不得出现 write-all=RED');
  assert.ok(!workflow.includes('contents: write'), '不得出现 contents: write=RED');
  console.log('PASS: 用例④ 最小权限 + 唯一 packages:write 在 publish');
}

/**
 * 用例⑤：全部 uses 为完整 SHA pin，与真值表及 lock 离线一致。
 */
async function casePins(): Promise<void> {
  const workflow: string = readText(workflowRel);
  const pinRe: RegExp = /uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})\s*#\s*(v[\w.\-]+)/;
  const found: Array<{ repo: string; sha: string; tag: string }> = [];
  for (const line of workflow.split('\n')) {
    if (!line.includes('uses:')) continue;
    const m: RegExpExecArray | null = pinRe.exec(line);
    assert.ok(m, `uses 行必须为完整 SHA + tag 注释 pin，违规行=${line.trim()}=RED`);
    found.push({ repo: m[1], sha: m[2], tag: m[3] });
  }
  assert.ok(found.length > 0, '须至少一个 pin=RED');
  // 中文注释：真负例——浮动 tag 行必须通不过 pin 形状断言。
  assert.ok(!pinRe.test('uses: actions/checkout@v4'), '负例：浮动 tag 不得通过 pin 形状=RED');
  for (const exp of expectedPins) {
    assert.ok(
      found.some((f) => f.repo === exp.repo && f.sha === exp.sha && f.tag === exp.tag),
      `缺预期 pin ${exp.repo}@${exp.sha} # ${exp.tag}=RED`,
    );
  }
  // 中文注释：同一 action 会在多 job 复用，按 repo@tag 去重后必须恰为预期 4 个（禁悄悄加 action）。
  const uniqueKeys: Set<string> = new Set(found.map((f) => `${f.repo}@${f.tag}`));
  assert.strictEqual(uniqueKeys.size, expectedPins.length, `pin 种类必须恰为 ${expectedPins.length}（禁悄悄加 action），实际=${uniqueKeys.size}=RED`);
  const lock: { entries: Array<{ repo: string; tag: string; sha: string; files: string[] }> } = JSON.parse(readText(lockRel));
  for (const exp of expectedPins) {
    const entry: { repo: string; tag: string; sha: string; files: string[] } | undefined = lock.entries.find(
      (e) => e.repo === exp.repo && e.tag === exp.tag,
    );
    assert.ok(entry, `lock 缺条目 ${exp.repo}@${exp.tag}=RED`);
    assert.strictEqual(entry?.sha, exp.sha, `lock 与 workflow 不一致：${exp.repo}@${exp.tag}=RED`);
    assert.deepStrictEqual(entry?.files, ['auto-delivery.yml'], `lock files 必须为唯一 workflow，实际=${JSON.stringify(entry?.files)}=RED`);
  }
  assert.strictEqual(lock.entries.length, expectedPins.length, 'lock 不得有陈旧多余条目=RED');
  console.log('PASS: 用例⑤ 全 SHA pin + 真值表 + lock 离线一致');
}

/**
 * 用例⑥：无自动 latest 漂移。
 */
async function caseNoLatestDrift(): Promise<void> {
  const workflow: string = readText(workflowRel);
  const script: string = readText(pushScriptRel);
  assert.ok(!workflow.includes(':latest'), 'workflow 不得出现 :latest 字面=RED（永不自动 latest）');
  assert.ok(!script.includes('add_tag "latest"'), 'push-ghcr.sh 不得含 add_tag "latest"=RED');
  assert.ok(script.includes('!= "latest"'), 'push-ghcr.sh 须保留 latest 输入守卫=RED');
  assert.ok(script.includes('add_tag "sha-${SHORT_SHA}"'), '脚本须产出不可变 sha-<short> 标签=RED');
  assert.ok(workflow.includes('./scripts/push-ghcr.sh "${{ github.ref_name }}"'), 'publish 须经 push-ghcr.sh 以 ref 名发布（main 追踪标签）=RED');
  console.log('PASS: 用例⑥ 无自动 latest 漂移（sha 不可变 + main 追踪）');
}

/**
 * 用例⑦：deploy 隔离、staleness 守卫、secret fail-closed、无值泄露。
 */
async function caseDeployGuards(): Promise<void> {
  const workflow: string = readText(workflowRel);
  const deploy: string = jobSection(workflow, 'deploy');
  // 中文注释：staleness 守卫四要素缺一即 RED。
  for (const anchor of ['origin/main', 'rev-parse', 'stale=true', 'stale=false']) {
    assert.ok(deploy.includes(anchor), `deploy 缺 staleness 要素 ${anchor}=RED`);
  }
  assert.ok(deploy.includes("steps.stale.outputs.stale != 'true'"), 'SSH 步骤必须以 staleness 输出为门=RED');
  assert.ok(deploy.includes('STALE'), '过期跳过必须显式说明=RED');
  // 中文注释：部署 secret 名齐全（只断言名）。
  for (const name of requiredDeploySecrets) {
    assert.ok(deploy.includes(`secrets.${name}`), `deploy 缺 secret 名 ${name}=RED`);
  }
  assert.ok(deploy.includes('StrictHostKeyChecking=yes'), 'SSH 必须强制主机指纹校验=RED');
  assert.ok(deploy.includes('docker compose pull') || deploy.includes('docker compose -f'), 'deploy 须 docker compose pull=RED');
  assert.ok(deploy.includes('up -d'), 'deploy 须 up -d=RED');
  assert.ok(deploy.includes('38080'), 'deploy 健康校验须命中生产端口事实 38080=RED');
  assert.ok(deploy.includes('exit 1'), 'deploy 须有 fail-closed 退出=RED');
  // 中文注释：无值泄露——禁 echo secret 变量、禁 set -x（只查代码行，注释行除外）。
  const deployCode: string = deploy.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.ok(!deployCode.includes('echo "${DEPLOY_') && !deployCode.includes("echo '${DEPLOY_"), 'deploy 禁止 echo secret 变量值=RED');
  assert.ok(!deployCode.includes('set -x'), 'deploy 禁止 set -x（会泄露 secret）=RED');
  console.log('PASS: 用例⑦ deploy 隔离 + staleness + secret fail-closed + 无值泄露');
}

/**
 * 用例⑧：Bark 成功/失败通知 + warn-only 传输语义 + secret 卫生。
 */
async function caseBarkNotify(): Promise<void> {
  const workflow: string = readText(workflowRel);
  const notify: string = jobSection(workflow, 'notify');
  assert.ok(notify.includes('BARK_WEBHOOK'), 'notify 须用 BARK_WEBHOOK=RED');
  assert.ok(notify.includes('needs.deploy.result'), 'notify 标题须按 deploy 结论区分成功/失败=RED');
  assert.ok(notify.includes('::warning::'), 'Bark 传输失败须记 ::warning::（warn-only，不翻转结论）=RED');
  assert.ok(!workflow.includes('${{ secrets.BARK_WEBHOOK }}/'), 'BARK_WEBHOOK 禁止直接拼进 run 字面（须 env 映射）=RED');
  console.log('PASS: 用例⑧ Bark 成功/失败通知 + warn-only + secret 卫生');
}

/**
 * 用例⑨：本测试自身已登记进 runner 注册表（防“写了守卫却没跑”）。
 */
async function caseSelfRegistered(): Promise<void> {
  const runnerSrc: string = fs.readFileSync(path.join(repoRoot, runnerRel), 'utf8');
  assert.ok(runnerSrc.includes("id: 'auto-delivery'"), 'runner 注册表须登记 auto-delivery=RED');
  assert.ok(
    runnerSrc.includes('./tests/tooling/delivery/auto-delivery.tooling.test.ts'),
    'runner 注册表 path 须指向本文件=RED',
  );
  console.log('PASS: 用例⑨ 守卫自身已进 runner 注册表');
}

/**
 * 测试入口：顺序执行全部用例。
 */
async function main(): Promise<void> {
  await caseSingleWorkflowMainPushOnly();
  await caseJobOrder();
  await caseConcurrency();
  await casePermissions();
  await casePins();
  await caseNoLatestDrift();
  await caseDeployGuards();
  await caseBarkNotify();
  await caseSelfRegistered();
}

export default main();
