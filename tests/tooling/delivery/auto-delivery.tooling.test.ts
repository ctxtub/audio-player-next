import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * main 自动交付链 tooling 守卫（2026-09-11 新政策，fail-closed）。
 *
 * 钉死 `.github/workflows/auto-delivery.yml`（全仓唯一 workflow）：
 * ①触发：仅 main push（allowlist 恰为 {push}，无 pull_request_target/workflow_call/workflow_run/release 等）；
 * ②job 图：quality → publish → deploy → notify(always)；
 * ③concurrency：整链单组串行，不取消旧链；
 * ④permissions：顶层空，job 最小，packages:write 只在 publish、packages:read 只在 deploy；
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
 * 用例④：顶层空权限 + job 最小权限，packages 写只在 publish、读只在 deploy。
 */
async function casePermissions(): Promise<void> {
  const workflow: string = readText(workflowRel);
  assert.ok(/^permissions: \{\}\s*$/m.test(workflow), '顶层必须 permissions: {}=RED');
  assert.strictEqual((workflow.match(/packages:\s*write/g) || []).length, 1, 'packages:write 必须恰出现一次=RED');
  assert.ok(/packages:\s*write/.test(jobSection(workflow, 'publish')), '唯一的 packages:write 必须在 publish=RED');
  // deploy 回退 token（GHCR_TOKEN || GITHUB_TOKEN）拉私有包需 packages:read，否则 login 成功但 pull 鉴权失败。
  assert.ok(/packages:\s*read/.test(jobSection(workflow, 'deploy')), 'deploy 须 packages: read（私有包 pull 鉴权）=RED');
  assert.strictEqual((workflow.match(/packages:\s*read/g) || []).length, 1, 'packages:read 必须恰出现一次（deploy）=RED');
  assert.ok(!/packages:/.test(jobSection(workflow, 'quality')), 'quality 不得含 packages 域（只需 contents:read）=RED');
  assert.ok(!/packages:/.test(jobSection(workflow, 'notify')), 'notify 不得含 packages 域（须空权限）=RED');
  assert.ok(/contents:\s*read/.test(jobSection(workflow, 'quality')), 'quality 须 contents: read=RED');
  assert.ok(/contents:\s*read/.test(jobSection(workflow, 'deploy')), 'deploy 须 contents: read（staleness 需 git 数据）=RED');
  assert.ok(/^ {4}permissions: \{\}\s*$/m.test(jobSection(workflow, 'notify')), 'notify 须 job 级 permissions: {}=RED');
  assert.ok(!workflow.includes('write-all'), '不得出现 write-all=RED');
  assert.ok(!workflow.includes('contents: write'), '不得出现 contents: write=RED');
  console.log('PASS: 用例④ 最小权限 + packages 写只在 publish、读只在 deploy');
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
 * 用例⑦：deploy 隔离、staleness 守卫、secret fail-closed、无值泄露、
 * 备份 + 原子替换 + 健康探测 + 失败回滚 + 产物一致性校验。
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
  // 硬化：保留锚子串但门恒真（if: … != 'true' || true）须判红；只查 if: 代码行，不误伤 do_rollback || true 等合法或。
  const deployIfLines: string[] = deploy
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .filter((l) => l.trimStart().startsWith('if:'));
  assert.ok(deployIfLines.length >= 1, 'deploy 须有 if: 门=RED');
  for (const line of deployIfLines) {
    assert.ok(!line.includes('||'), `stale 门禁止 ||（恒真绕过）违规行=${line.trim()}=RED`);
  }
  // 中文注释：部署 secret 名齐全（只断言名）。
  for (const name of requiredDeploySecrets) {
    assert.ok(deploy.includes(`secrets.${name}`), `deploy 缺 secret 名 ${name}=RED`);
  }
  assert.ok(deploy.includes('StrictHostKeyChecking=yes'), 'SSH 必须强制主机指纹校验=RED');
  assert.ok(deploy.includes('docker compose pull') || deploy.includes('docker compose -f'), 'deploy 须 docker compose pull=RED');
  assert.ok(deploy.includes('up -d'), 'deploy 须 up -d=RED');
  assert.ok(deploy.includes('38080'), 'deploy 健康校验须命中生产端口事实 38080=RED');
  assert.ok(deploy.includes('exit 1'), 'deploy 须有 fail-closed 退出=RED');
  // 硬化：exit 1 || true 把 fail-closed 中和，保留锚子串但永不红，须判红。
  // 只否 exit 1 ||，不否 do_rollback || true / awk … || true 等合法或。
  // 无值泄露与 sed -i 检查只查代码行（注释行会讨论被禁写法，需排除），下文复用 deployCode。
  const deployCode: string = deploy.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.ok(!deployCode.includes('exit 1 ||'), 'deploy 禁止 exit 1 ||（中和 fail-closed）=RED');
  // R1：probe 禁 -f（-f 在 4xx/5xx 下先打印码再 exit 22，|| echo 会拼出 500000）；超时 -w 本身输出 000，禁 || echo。
  // 只查代码行（注释行会讨论被禁写法，需排除；栽赃注释不得算数）。
  assert.ok(!deployCode.includes('curl -fsS'), 'probe 禁 -f（会把 500 拼成 500000）=RED');
  assert.ok(deployCode.includes('curl -sS --max-time 10'), 'probe 须 curl -sS 取真实码=RED');
  assert.ok(!deployCode.includes("|| echo '000'"), 'probe 禁 || echo 000（超时 -w 已输出 000，会拼成 000000）=RED');
  // R3：token 禁止进 ssh argv（ps 可见）；须经 stdin 首行 + 远端 read（只查代码行）。
  assert.ok(!deployCode.includes("GHCR_TOKEN='${GHCR_DEPLOY_TOKEN}'"), 'GHCR token 禁止进 ssh argv（单引号）=RED');
  assert.ok(!deployCode.includes('GHCR_TOKEN="${GHCR_DEPLOY_TOKEN}"'), 'GHCR token 禁止进 ssh argv（双引号）=RED');
  assert.ok(deployCode.includes('printf \'%s\\n\' "${GHCR_DEPLOY_TOKEN}"'), 'token 须经 stdin 首行传递（printf 内建）=RED');
  assert.ok(deployCode.includes('IFS= read -r GHCR_TOKEN'), '远端须 read -r 消费 stdin 首行 token=RED');
  // 中文注释：备份 + 原子替换（禁 sed -i 就地改）。
  assert.ok(deploy.includes('.bak.'), 'deploy 须带时间戳备份 compose=RED');
  assert.ok(deploy.includes('cp "${FILE}" "${BACKUP}"') || deploy.includes('cp "${BACKUP}" "${FILE}"'), 'deploy 须 cp 备份/还原=RED');
  assert.ok(deploy.includes('mv "${TMP_NEW}" "${FILE}"'), 'deploy 须经临时文件 mv 原子替换（禁 sed -i）=RED');
  // R2：临时文件须与目标同目录，否则跨 FS 是拷贝+删除而非原子重命名（只查代码行）。
  assert.ok(deployCode.includes('mktemp -p "$(dirname "${FILE}")"'), '临时文件须 mktemp -p 与目标同目录=RED');
  assert.ok(!deployCode.includes('TMP_NEW="$(mktemp)"'), '禁止 /tmp 落临时文件（跨 FS 非原子）=RED');
  // 有界保留：远端每次非幂等部署留备份，须只留最近 5 个防堆积（只查代码行）。
  assert.ok(deployCode.includes('tail -n +6'), '备份须有界保留（只留最近 5 个）=RED');
  // 凭据隔离：docker login 不得污染宿主 /root/.docker/config.json，须临时 DOCKER_CONFIG + 清理（只查代码行）。
  assert.ok(deployCode.includes('DOCKER_CONFIG="$(mktemp -d)"'), '须用临时 DOCKER_CONFIG 承接 login=RED');
  assert.ok(deployCode.includes('rm -rf "${DOCKER_CONFIG}"'), '临时 DOCKER_CONFIG 须清理=RED');
  // 单副本假设：ps -q 多行会使 inspect 多行恒不等误判回滚，须取首行（只查代码行）。
  assert.ok(deployCode.includes('ps -q "${SVC}" | head -n 1'), 'ps -q 须取首行防多副本误判=RED');
  // 中文注释：无值泄露与 sed -i 检查只查代码行（注释行会讨论被禁写法，需排除）。
  assert.ok(!deployCode.includes('sed -i'), 'deploy 禁止 sed -i 就地改生产文件=RED');
  // 中文注释：替换后先校验再拉取。
  assert.ok(deploy.includes('config -q'), 'deploy 替换后须 compose config -q 校验=RED');
  // 中文注释：先登录再拉（不依赖宿主既有凭据；token 经 stdin）。
  assert.ok(deploy.includes('docker login') && deploy.includes('--password-stdin'), 'deploy 须先 docker login（stdin，不依赖宿主凭据）=RED');
  // 中文注释：主动健康探测必须断言 200 并打印状态码（生产容器无 healthcheck）。
  assert.ok(deploy.includes('http_code'), 'deploy 健康探测须取 http_code=RED');
  assert.ok(deploy.includes('"200"'), 'deploy 健康探测须断言 200=RED');
  // 中文注释：健康失败必须自动回滚（还原 → 重起 → 再探测 → 仍 exit 非零），回滚失败给人工指引。
  for (const anchor of ['ROLLBACK', 'do_rollback', '人工介入']) {
    assert.ok(deploy.includes(anchor), `deploy 缺回滚要素 ${anchor}=RED`);
  }
  // 中文注释：产物一致性——运行中 image ID 必须等于本次产物 image ID，不只看 pull/up 退出码。
  assert.ok(deploy.includes('{{.Image}}') && deploy.includes('{{.Id}}'), 'deploy 须比对运行中 image ID 与本次产物 image ID=RED');
  assert.ok(deploy.includes('不一致'), '产物不一致须按失败处理=RED');
  // 中文注释：回滚点记录（当前 image 行 + 运行中容器 image ID）。
  assert.ok(deploy.includes('回滚点'), 'deploy 须打印回滚点=RED');
  // 中文注释：幂等——同 SHA 跳过替换，直接校验。
  assert.ok(deploy.includes('IDEMPOTENT'), 'deploy 须有同 SHA no-op 幂等分支=RED');
  // 中文注释：无值泄露——禁 echo secret 变量（无论是否加引号，echo ${VAR} 同样泄露）、禁 set -x/xtrace、禁 env|sort。
  assert.ok(!/echo[^#\n]*\$\{?DEPLOY_/.test(deployCode), 'deploy 禁止 echo secret 变量值（无论是否加引号）=RED');
  assert.ok(!/echo[^#\n]*\$\{?GHCR_/.test(deployCode), 'deploy 禁止 echo GHCR token 变量值（无论是否加引号）=RED');
  assert.ok(!deployCode.includes('set -x'), 'deploy 禁止 set -x（会泄露 secret）=RED');
  assert.ok(!deployCode.includes('xtrace'), 'deploy 禁止 set -o xtrace（会泄露 secret）=RED');
  assert.ok(!/env\s*\|\s*sort/.test(deployCode), 'deploy 禁止 env|sort（会泄露 secret）=RED');
  console.log('PASS: 用例⑦ deploy 隔离 + staleness + fail-closed + 备份/原子替换/健康/回滚/产物一致');
}

/**
 * 用例⑧：Bark 成功/失败通知 + warn-only 传输语义 + secret 卫生。
 */
async function caseBarkNotify(): Promise<void> {
  const workflow: string = readText(workflowRel);
  const notify: string = jobSection(workflow, 'notify');
  // 只查代码行：注释行栽赃 ::warning:: 不得算数；|| exit 1 会把 warn-only 翻成 fail，不得出现。
  const notifyCode: string = notify.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.ok(notify.includes('BARK_WEBHOOK'), 'notify 须用 BARK_WEBHOOK=RED');
  assert.ok(notify.includes('needs.deploy.result'), 'notify 标题须按 deploy 结论区分成功/失败=RED');
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
  await caseDeployGuards();
  await caseBarkNotify();
  await caseSelfRegistered();
}

export default main();
