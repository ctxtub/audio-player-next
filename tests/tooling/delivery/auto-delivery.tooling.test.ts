import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * main 自动交付链 tooling 守卫（2026-09-11 轻量政策，fail-closed）。
 *
 * 钉死 `.github/workflows/auto-delivery.yml`（全仓唯一 workflow）：
 * ①触发：仅 main push（allowlist 恰为 {push}，无 pull_request_target/workflow_call/workflow_run/release 等）；
 * ②job 图：quality → publish → notify(always)，无 deploy job；
 * ③concurrency：整链单组串行，不取消旧链；
 * ④permissions：顶层空，job 最小，packages:write 只在 publish，无 packages:read（无上线拉取）；
 * ⑤pin：全部第三方 action 为真实完整 SHA + tag 注释，与 lock 一致；
 * ⑥无自动 latest 漂移；
 * ⑦轻量契约：无 deploy、无 SSH、无 DEPLOY_前缀、无 compose 改写、无回滚、无生产健康逻辑（重上线构造全部缺席）；
 * ⑧notify 必须 always()，按 publish 结论区分标题，Bark 传输 warn-only。
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
// 中文注释：重上线 secret 名（轻量链必须全部缺席，只断言名缺席，绝不触值）。
const forbiddenDeploySecrets: string[] = [
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
 * 抽取顶层 on: 触发键（仅 2 空格缩进的一级键；4 空格为 push 配置，忽略）。
 */
function triggerKeys(workflow: string): string[] {
  const lines: string[] = workflow.split('\n');
  const onIdx: number = lines.findIndex((l) => /^'on':\s*$/.test(l) || /^on:\s*$/.test(l));
  assert.ok(onIdx >= 0, '缺顶层 on: 段=RED');
  const keys: string[] = [];
  for (let i = onIdx + 1; i < lines.length; i++) {
    const line: string = lines[i];
    // 顶层键（permissions/jobs/concurrency/name）出现即 on 段结束。
    if (/^[A-Za-z0-9_'"]+:\s*(#.*)?$/.test(line) && !line.startsWith(' ')) break;
    if (/^(permissions|jobs|concurrency|name):/.test(line)) break;
    const m: RegExpExecArray | null = /^  ([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/**
 * 用例①：全仓恰好一个 workflow，且触发仅为 main push（allowlist，防新键绕过）。
 */
async function caseSingleWorkflowMainPushOnly(): Promise<void> {
  const dir: string = path.join(repoRoot, '.github', 'workflows');
  const files: string[] = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
  assert.deepStrictEqual(files, ['auto-delivery.yml'], `全仓必须恰好一条交付链，实际=${JSON.stringify(files)}=RED`);
  const workflow: string = readText(workflowRel);
  // 触发键 allowlist：顶层集合恰为 {push}（黑名单可被新键 pull_request_target 等绕过，故用 allowlist）。
  const keys: string[] = triggerKeys(workflow);
  assert.deepStrictEqual(keys, ['push'], `触发键集合必须恰为 {push}，实际=${JSON.stringify(keys)}=RED`);
  // 显式否高危多链入口（allowlist 已覆盖，此处逐键点名防回归）。
  for (const denied of ['pull_request', 'pull_request_target', 'workflow_call', 'workflow_run', 'release', 'schedule', 'workflow_dispatch']) {
    assert.ok(!keys.includes(denied), `不得存在 ${denied} 触发=RED（第二条链入口）`);
    assert.ok(!new RegExp(`^  ${denied}:\\s*`, 'm').test(workflow), `不得存在顶层 ${denied}: 段=RED`);
  }
  assert.ok(workflow.includes('branches:') && workflow.includes('- main'), 'push 必须限定 branches main=RED');
  // push 段内禁 tags:（同属 push 键下的第二触发面，allowlist 看不到，需另行点名）。
  assert.ok(!/^    tags:\s*$/m.test(workflow), 'push 段内不得存在 tags:（tag 是第二入口）=RED');
  console.log('PASS: 用例① 全仓唯一 workflow 且仅 main push 触发');
}

/**
 * 用例②：轻量 job 图 quality → publish → notify，其中 notify 必须 always()，无 deploy。
 */
async function caseJobOrder(): Promise<void> {
  const workflow: string = readText(workflowRel);
  // 中文注释：job 键只从顶层 jobs: 段内取（on.push 等触发键同缩进，需排除）。
  const jobsIdx: number = workflow.split('\n').findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(jobsIdx >= 0, '缺顶层 jobs: 段=RED');
  const jobsText: string = workflow.split('\n').slice(jobsIdx).join('\n');
  const keys: string[] = jobsText.split('\n').filter((l) => /^  [A-Za-z0-9_-]+:\s*$/.test(l)).map((l) => l.trim().replace(/:$/, ''));
  assert.deepStrictEqual(keys, ['quality', 'publish', 'notify'], `轻量链 job 集合必须恰为 quality/publish/notify（无 deploy），实际=${JSON.stringify(keys)}=RED`);
  assert.ok(!workflow.includes('  deploy:'), '不得存在 deploy job=RED（轻量链不做上线）');
  assert.ok(/needs:\s*\[quality\]/.test(jobSection(workflow, 'publish')), 'publish 必须 needs: [quality]=RED');
  const notify: string = jobSection(workflow, 'notify');
  assert.ok(/needs:\s*\[quality,\s*publish\]/.test(notify), 'notify 必须 fan-in quality/publish=RED');
  assert.ok(/^\s*if:\s*always\(\)\s*$/m.test(notify), 'notify 必须 if: always()=RED（失败也要通知）');
  // 中文注释：真负例——缺 always() 的 fan-in 不得被误判为通知门。
  assert.ok(!/^\s*if:\s*always\(\)\s*$/m.test(jobSection(workflow, 'publish')), '负例：publish 不得带 always()=RED');
  // 中文注释：轻量链 notify 不得引用已删除的 deploy 结论。
  assert.ok(!workflow.includes('needs.deploy'), 'notify 不得引用 needs.deploy（deploy 已删除）=RED');
  console.log('PASS: 用例② 轻量 job 顺序 quality→publish→notify + notify always()');
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
 * 用例④：顶层空权限 + job 最小权限，packages 写只在 publish，无 packages:read（无上线拉取）。
 */
async function casePermissions(): Promise<void> {
  const workflow: string = readText(workflowRel);
  assert.ok(/^permissions: \{\}\s*$/m.test(workflow), '顶层必须 permissions: {}=RED');
  assert.strictEqual((workflow.match(/packages:\s*write/g) || []).length, 1, 'packages:write 必须恰出现一次=RED');
  assert.ok(/packages:\s*write/.test(jobSection(workflow, 'publish')), '唯一的 packages:write 必须在 publish=RED');
  // 中文注释：轻量链无上线拉取，不需要 packages:read；出现即说明残留重上线逻辑。
  assert.strictEqual((workflow.match(/packages:\s*read/g) || []).length, 0, '轻量链不得出现 packages:read（上线拉取已删除）=RED');
  assert.ok(!/packages:/.test(jobSection(workflow, 'quality')), 'quality 不得含 packages 域（只需 contents:read）=RED');
  assert.ok(!/packages:/.test(jobSection(workflow, 'notify')), 'notify 不得含 packages 域（须空权限）=RED');
  assert.ok(/contents:\s*read/.test(jobSection(workflow, 'quality')), 'quality 须 contents: read=RED');
  assert.ok(/contents:\s*read/.test(jobSection(workflow, 'publish')), 'publish 须 contents: read=RED');
  assert.ok(/^ {4}permissions: \{\}\s*$/m.test(jobSection(workflow, 'notify')), 'notify 须 job 级 permissions: {}=RED');
  assert.ok(!workflow.includes('write-all'), '不得出现 write-all=RED');
  assert.ok(!workflow.includes('contents: write'), '不得出现 contents: write=RED');
  console.log('PASS: 用例④ 最小权限 + packages 写只在 publish、无读');
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
 * 用例⑥：只发 sha-<short> 不可变标签，无任何移动标签（无 main、无 latest）。
 */
async function caseNoLatestDrift(): Promise<void> {
  const workflow: string = readText(workflowRel);
  const script: string = readText(pushScriptRel);
  assert.ok(!workflow.includes(':latest'), 'workflow 不得出现 :latest 字面=RED（永不发 latest）');
  // 中文注释：只查代码行——注释里可以讨论被否掉的方案，代码里不许留。
  const workflowCode: string = workflow.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.ok(!workflowCode.includes(':main'), 'workflow 代码不得引用 main 移动标签=RED（只发 sha 不可变标签）');
  assert.ok(!script.includes('add_tag "latest"'), 'push-ghcr.sh 不得含 add_tag "latest"=RED');
  assert.ok(script.includes('!= "latest"'), 'push-ghcr.sh 须保留 latest 输入守卫=RED');
  assert.ok(script.includes('add_tag "sha-${SHORT_SHA}"'), '脚本须产出不可变 sha-<short> 标签=RED');
  assert.ok(!script.includes('"main"'), 'push-ghcr.sh 不得被加 main 标签逻辑=RED（脚本契约不动）');
  // 中文注释：publish 必须无参数调用（空 tag = sha-only 既有语义），不得传 ref 名造移动标签。
  // 行级正则：字面传参（./scripts/push-ghcr.sh main）会绕过旧的子串守卫并真的推出 main 浮动标签，故必须逐行动词断言。
  const publish: string = jobSection(workflow, 'publish');
  const publishCodeLines: string[] = publish.split('\n').filter((l) => !l.trimStart().startsWith('#'));
  const invocations: string[] = publishCodeLines.filter((l) => l.trimStart().startsWith('./scripts/push-ghcr.sh'));
  assert.ok(invocations.length >= 1, 'publish 须经 push-ghcr.sh 发布=RED');
  for (const line of invocations) {
    assert.ok(/^\s*\.\/scripts\/push-ghcr\.sh\s*$/.test(line), `publish 必须无参调用 push-ghcr.sh（空 tag=sha-only），违规行=${line.trim()}=RED`);
  }
  assert.ok(!publish.includes('github.ref_name'), 'publish 不得传 ref 名（会造移动标签）=RED');
  console.log('PASS: 用例⑥ 只发 sha 不可变标签（无 main/latest 移动标签）');
}

/**
 * 用例⑦：轻量契约——无 deploy job、无重上线构造（无 SSH、无 DEPLOY_前缀、无 compose 改写、无回滚、无生产健康）。
 */
async function caseLightweightNoDeploy(): Promise<void> {
  const workflow: string = readText(workflowRel);
  // 中文注释：deploy job 本体缺席（job 图已断言，此处再点名防旁路）。
  assert.ok(!workflow.includes('  deploy:'), '不得存在 deploy job 段=RED（轻量链只发布不上线）');
  assert.ok(!workflow.includes('needs.deploy'), '不得引用 needs.deploy=RED');
  // 中文注释：重上线 secret 名全部缺席（只断言名）。
  for (const name of forbiddenDeploySecrets) {
    assert.ok(!workflow.includes(name), `轻量链不得含重上线 secret 名 ${name}=RED`);
  }
  assert.ok(!workflow.includes('DEPLOY_'), '不得出现 DEPLOY_ 前缀=RED');
  assert.ok(!workflow.includes('GHCR_DEPLOY_TOKEN'), '不得出现 GHCR_DEPLOY_TOKEN=RED（上线 token 已删除）');
  // 中文注释：传输与主机操作全部缺席（大小写不敏感查 ssh，防 SSH/Ssh 旁路）。
  assert.ok(!workflow.toLowerCase().includes('ssh'), '不得出现 ssh/SSH（轻量链不触达生产）=RED');
  assert.ok(!workflow.includes('StrictHostKeyChecking'), '不得出现 StrictHostKeyChecking=RED');
  // 中文注释：compose 改写与容器操作全部缺席。
  assert.ok(!workflow.includes('docker compose'), '不得出现 docker compose=RED（不上线即不操作容器）');
  assert.ok(!workflow.includes('mktemp'), '不得出现 mktemp=RED（无临时私钥/临时目录）');
  assert.ok(!workflow.includes('config -q'), '不得出现 compose config 校验=RED（不上线）');
  // 中文注释：生产健康与回滚全部缺席。
  assert.ok(!workflow.includes('38080'), '不得出现生产端口 38080=RED');
  assert.ok(!workflow.includes('127.0.0.1'), '不得出现生产回环地址=RED');
  assert.ok(!workflow.includes('http_code'), '不得出现 http_code 健康探针=RED');
  assert.ok(!workflow.includes('do_rollback') && !workflow.includes('ROLLBACK'), '不得出现回滚逻辑=RED');
  // 中文注释：staleness 守卫属于上线链，轻量链不得残留。
  assert.ok(!workflow.includes('stale=true') && !workflow.includes('stale=false'), '不得残留 staleness 输出=RED');
  assert.ok(!workflow.includes('origin/main'), '不得残留 origin/main staleness 取头=RED');
  console.log('PASS: 用例⑦ 轻量契约（无 deploy/SSH/compose/回滚/生产健康）');
}

/**
 * 用例⑧：Bark 成功/失败通知 + warn-only 传输语义 + secret 卫生（按 publish 结论）。
 */
async function caseBarkNotify(): Promise<void> {
  const workflow: string = readText(workflowRel);
  const notify: string = jobSection(workflow, 'notify');
  // 只查代码行：注释行栽赃 ::warning:: 不得算数；|| exit 1 会把 warn-only 翻成 fail，不得出现。
  const notifyCode: string = notify.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.ok(notify.includes('BARK_WEBHOOK'), 'notify 须用 BARK_WEBHOOK=RED');
  assert.ok(notify.includes('needs.publish.result'), 'notify 标题须按 publish 结论区分成功/失败=RED');
  assert.ok(!notify.includes('needs.deploy'), 'notify 不得引用已删除的 deploy 结论=RED');
  assert.ok(notify.includes('推送成功') && notify.includes('推送失败'), 'notify 须区分推送成功/失败标题=RED');
  assert.ok(notifyCode.includes('::warning::'), 'Bark 传输失败须记 ::warning::（代码行，非注释，warn-only 不翻转结论）=RED');
  assert.ok(!notifyCode.includes('|| exit 1'), 'notify 禁止 || exit 1（翻转 warn-only）=RED');
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
  await caseLightweightNoDeploy();
  await caseBarkNotify();
  await caseSelfRegistered();
}

export default main();
