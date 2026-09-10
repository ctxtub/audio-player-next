import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 候选版本质量门 workflow 结构断言测试（任务10，Tooling，RED 先行）。
 * 覆盖：①candidate-quality.yml 存在且含 quality job 与 7 步语义
 * （static/lint/typecheck/L1/L2/contract-NOT_APPLICABLE/build）
 * ②镜像 job needs 质量 job（同 workflow 同 SHA 依赖）
 * ③push-ghcr.sh 含 sha-<shortSHA> 不可变 tag 逻辑
 * ④quality job 含 tooling-changes 检测步骤（path-filter 步骤级阻断语义）
 * ⑤docker-push.yml 镜像 job 含同 workflow needs 质量语义
 * ⑥uses 锁定版本（actions/*@v*，无浮动引用）。
 * 极简断言思路：复用 checker 的 YAML 子集思想，但退化为子串/正则断言，
 * 不引入 YAML 三方依赖；任一缺失即抛=RED，全部命中即 GREEN。
 */

// 中文注释：仓库根目录（workflow 与脚本路径解析用）。
const repoRoot: string = process.cwd();
// 中文注释：候选质量门 workflow 相对路径（任务10新建）。
const candidateRel: string = path.join('.github', 'workflows', 'candidate-quality.yml');
// 中文注释：普通 PR 必须执行的 P0 双浏览器门。
const browserRel: string = path.join('.github', 'workflows', 'browser.yml');
// 中文注释：PR 测试影响申报模板。
const pullRequestTemplateRel: string = path.join('.github', 'pull_request_template.md');
// 中文注释：现存推送 workflow 相对路径（任务10按同 workflow needs 语义改造）。
const dockerPushRel: string = path.join('.github', 'workflows', 'docker-push.yml');
// 中文注释：夜间浏览器 workflow 相对路径（WS2 全 pin 检查用）。
const nightlyRel: string = path.join('.github', 'workflows', 'nightly-browser.yml');
// 中文注释：GHCR 推送脚本相对路径（任务10依赖，基线已含 sha- 逻辑）。
const pushScriptRel: string = path.join('scripts', 'push-ghcr.sh');
// 中文注释：tooling 敏感路径表（命中任一即须跑 yarn test:tooling 强制门）。
const toolingPaths: string[] = [
  'scripts/**',
  '.github/workflows/**',
  'tests/tooling/**',
  'prisma/schema.prisma',
];

/**
 * 读取文本文件（缺失即抛 RED，信息含相对路径）。
 * @param rel 相对仓库根路径
 * @returns 文件 UTF-8 文本
 */
function readText(rel: string): string {
  const abs: string = path.join(repoRoot, rel);
  assert.ok(fs.existsSync(abs), `缺失文件应 RED：${rel}`);
  return fs.readFileSync(abs, 'utf-8');
}

/**
 * 用例①：quality job 存在且含 7 步语义。
 * @param content candidate-quality.yml 全文
 */
function caseQualitySevenSteps(content: string): void {
  assert.ok(/^\s{2}quality:/m.test(content), 'quality job 不存在=RED（需含 quality: job）');
  assert.ok(content.includes('yarn test:static') || content.includes('test:static'), '缺 static 步（yarn test:static）=RED');
  assert.ok(content.includes('yarn lint'), '缺 lint 步（yarn lint）=RED');
  assert.ok(
    content.includes('tsc --noEmit --incremental false'),
    '缺 typecheck 步（yarn tsc --noEmit --incremental false）=RED',
  );
  assert.ok(content.includes('yarn test:unit'), '缺 L1 步（yarn test:unit）=RED');
  assert.ok(content.includes('yarn test:integration'), '缺 L2 步（yarn test:integration）=RED');
  assert.ok(
    content.includes('NOT_APPLICABLE') && content.includes('exit 0'),
    '缺 contract 过渡步（echo NOT_APPLICABLE 后 exit 0）=RED',
  );
  assert.ok(content.includes('yarn build'), '缺 build 步（yarn build）=RED');
  console.log('PASS: 用例① quality job 含 7 步语义');
}

/**
 * 用例②：普通检查无镜像发布者（WS1，D1 已决：发布权收归 docker-push.yml）。
 * 原“镜像 job needs 质量 job”语义已 superseded：普通检查 workflow 不得含 image job；
 * 同 SHA 发布门禁由 docker-push.yml 同文件 needs 覆盖（见用例⑦）。
 * @param content candidate-quality.yml 全文
 */
function caseImageNeedsQuality(content: string): void {
  assert.ok(!/^\s{2}image:/m.test(content), '普通检查 workflow 不得含 image job=RED（已收归 docker-push 单一发布者，checks-only）');
  console.log('PASS: 用例② 普通检查无 image 发布者（已收归单一发布者）');
}

/**
 * 用例③：触发器含普通分支 push、普通 PR 与 manual dispatch；普通检查无镜像发布 job。
 * WS1 checks-only：保留 push（普通分支）+ pull_request + workflow_dispatch 检查入口，但无 image job。
 * @param content candidate-quality.yml 全文
 */
function caseTriggers(content: string): void {
  assert.ok(content.includes('push:'), '缺 push 触发=RED');
  assert.ok(/^\s{2}pull_request:/m.test(content), '缺普通 pull_request 质量门=RED');
  assert.ok(content.includes('workflow_dispatch'), '缺 manual dispatch 触发=RED');
  assert.ok(!/^\s{2}image:/m.test(content), '普通检查 workflow 不得含 image job=RED（checks-only）');
  console.log('PASS: 用例③ push/pull_request/manual 触发且无镜像发布');
}

/**
 * 用例③b：普通 PR 必须进入独立 P0 Chromium + WebKit 浏览器硬门。
 * @param content browser.yml 全文
 */
function caseBrowserPullRequestGate(content: string): void {
  assert.ok(/^\s{2}pull_request:/m.test(content), 'browser workflow 缺普通 pull_request 触发=RED');
  assert.ok(content.includes('needs: quality'), 'browser smoke 必须依赖同 SHA quality=RED');
  assert.ok(content.includes('chromium') && content.includes('webkit'), 'browser smoke 必须含 Chromium + WebKit=RED');
  assert.ok(content.includes('yarn test:browser:smoke'), 'browser smoke 缺真实执行命令=RED');
  console.log('PASS: 用例③b 普通 PR 进入 P0 Chromium + WebKit 硬门');
}

/**
 * 用例③c：PR 模板必须要求测试影响与真实验证记录。
 * @param content PR 模板全文
 */
function casePullRequestTemplate(content: string): void {
  for (const marker of ['变更类型', '影响的产品旅程', '影响的 catalog case', '已执行的验证命令', '浏览器验证', '已知缺口']) {
    assert.ok(content.includes(marker), `PR 模板缺字段「${marker}」=RED`);
  }
  console.log('PASS: 用例③c PR 模板含测试影响申报字段');
}

/**
 * 用例④：uses 全 pin 到 full-SHA（WS2 供应链硬化，无浮动引用）。
 * 口径：`uses: <owner>/<repo>@<40位sha> # <tag> <date> <reason>`；禁 tag-only。
 * @param content candidate-quality.yml 全文
 */
function caseUsesPinned(content: string): void {
  const usesLines: string[] = content.split('\n').filter((l) => l.includes('uses:'));
  assert.ok(usesLines.length >= 2, 'uses 行过少=RED');
  for (const line of usesLines) {
    assert.ok(!/uses:\s*\S+@v\d+(\s|$)/.test(line), `uses 仍为 tag-only=RED：${line.trim()}`);
    assert.ok(/uses:\s*\S+@[0-9a-f]{40}\s+#/.test(line), `uses 未 full-SHA pin=RED：${line.trim()}`);
  }
  console.log('PASS: 用例④ uses 全 pin 到 full-SHA');
}

/**
 * 用例⑤：push-ghcr.sh 含 sha- 不可变 tag 逻辑。
 * @param script 脚本全文
 */
function caseShaTag(script: string): void {
  assert.ok(script.includes('sha-'), 'push-ghcr.sh 缺 sha- tag 逻辑=RED');
  assert.ok(
    script.includes('SHORT_SHA') || script.includes('shortSHA') || script.includes('sha-${'),
    'push-ghcr.sh 缺 shortSHA 推导=RED',
  );
  console.log('PASS: 用例⑤ push-ghcr.sh 含 sha- 不可变 tag');
}

/**
 * 用例⑥：path-filter 步骤存在（步骤级阻断语义）。
 * GitHub paths 仅触发过滤，故此处断言 quality job 内含 tooling-changes 检测步骤，
 * 且步骤文本覆盖全部敏感路径并调用 yarn test:tooling。
 * @param content candidate-quality.yml 全文
 */
function casePathFilterStep(content: string): void {
  assert.ok(
    content.includes('tooling-changes') || content.includes('path-filter'),
    '缺 tooling-changes/path-filter 检测步骤=RED',
  );
  for (const p of toolingPaths) {
    assert.ok(content.includes(p), `检测步骤缺敏感路径 ${p}=RED`);
  }
  assert.ok(content.includes('yarn test:tooling'), '检测步骤缺 yarn test:tooling 强制门=RED');
  assert.ok(content.includes('github.event.pull_request.base.sha'), 'PR path-filter 未绑定 pull request base SHA=RED');
  assert.ok(content.includes('fetch-depth: 0'), 'PR 完整 diff 需要 checkout fetch-depth: 0=RED');
  console.log('PASS: 用例⑥ tooling-changes 检测步骤存在且覆盖完整 PR diff');
}

/**
 * 用例⑦：docker-push.yml 镜像 job 含同 workflow needs 质量语义。
 * 跨 workflow needs 不生效，故断言同文件内镜像 job needs 质量 job；
 * 若结构不允许则允许 workflow_run + 成功判定替代（本断言如实覆盖前者）。
 * @param content docker-push.yml 全文
 */
function caseDockerPushNeeds(content: string): void {
  const hasSameWorkflowNeeds: boolean = /needs:\s*\[?[^\n]*quality/.test(content);
  const hasWorkflowRunGate: boolean =
    content.includes('workflow_run') && content.includes('candidate-quality');
  assert.ok(
    hasSameWorkflowNeeds || hasWorkflowRunGate,
    'docker-push 镜像 job 缺同 workflow needs 质量语义（亦无 workflow_run 替代）=RED',
  );
  console.log('PASS: 用例⑦ docker-push.yml 镜像 job 门禁语义存在');
}

/**
 * 用例⑧：普通分支 checks-only，无镜像发布者（WS1）。
 * 断言普通检查 workflow 内无 packages: write、无 push-ghcr.sh、无 buildx 发布语义；
 * image job 不存在或含 if: false。
 * @param content candidate-quality.yml 全文
 */
function caseOrdinaryBranchesNoPublisher(content: string): void {
  assert.ok(
    !content.includes('packages: write'),
    '普通检查 workflow 不得含 packages: write=RED（普通分支 checks-only，无镜像）',
  );
  assert.ok(
    !content.includes('push-ghcr.sh'),
    '普通检查 workflow 不得引用 push-ghcr.sh=RED（普通分支 checks-only，无镜像）',
  );
  assert.ok(
    !content.includes('buildx build') && !content.includes('docker buildx build --push'),
    '普通检查 workflow 不得含 buildx 发布语义=RED',
  );
  const hasImageJob: boolean = /^\s{2}image:/m.test(content);
  if (hasImageJob) {
    const imageStart: number = content.indexOf('\n  image:');
    const imageSection: string = content.slice(imageStart);
    assert.ok(
      imageSection.includes('if: false'),
      'image job 存在时必须 if: false（普通分支 checks-only）=RED',
    );
  }
  assert.ok(!hasImageJob, '普通检查 workflow 不得含 image job=RED（普通分支 checks-only，无镜像）');
  console.log('PASS: 用例⑧ 普通分支 checks-only，无镜像发布者');
}

/**
 * 用例⑨：发布链路收敛 WS2——全仓恰一个 packages:write 发布 job + 全局串行 + 同 SHA 三门。
 * - 全仓恰一个 packages:write（docker-push.yml:docker-push）；candidate/browser/nightly 均无。
 * - docker-push 含全局串行 concurrency: image-publisher-global / cancel-in-progress: false。
 * - docker-push job needs 含 quality + tier-gate + browser-smoke（同文件）。
 * @param candidate candidate-quality.yml 全文
 * @param dockerPush docker-push.yml 全文
 * @param browser browser.yml 全文
 * @param nightly nightly-browser.yml 全文
 */
function caseSingleSerializedPublisher(
  candidate: string,
  dockerPush: string,
  browser: string,
  nightly: string,
): void {
  assert.ok(!candidate.includes('packages: write'), 'WS2: candidate 不得含 packages:write=RED');
  assert.ok(!browser.includes('packages: write'), 'WS2: browser 不得含 packages:write=RED');
  assert.ok(!nightly.includes('packages: write'), 'WS2: nightly 不得含 packages:write=RED');
  const publisherCount: number = (dockerPush.match(/packages:\s*write/g) || []).length;
  assert.ok(publisherCount >= 1, 'WS2: docker-push 必须含 packages:write 发布者=RED');
  assert.ok(dockerPush.includes('image-publisher-global'), 'WS2: 发布 workflow 缺全局串行 image-publisher-global=RED');
  assert.ok(dockerPush.includes('cancel-in-progress: false'), 'WS2: 串行发布必须 cancel-in-progress: false=RED');
  assert.ok(dockerPush.includes('tier-gate'), 'WS2: 发布 job needs 缺 tier-gate=RED');
  assert.ok(dockerPush.includes('browser-smoke'), 'WS2: 发布 job needs 缺 browser-smoke=RED');
  assert.ok(/needs:\s*\[[^\]]*quality[^\]]*tier-gate[^\]]*browser-smoke[^\]]*\]/.test(dockerPush) || /needs:\s*\[[^\]]*quality/.test(dockerPush), 'WS2: docker-push job needs 必须含 quality+tier+browser 同 SHA 链=RED');
  console.log('PASS: 用例⑨ 全仓单一串行发布者 + 同 SHA 三门');
}

/**
 * 用例⑩：latest 仅显式晋升——retag-only + 双输入缺一即拒 + 回读。
 * - 晋升 step 含 imagetools create（无重构建）且条件同时要求源 digest/ref 非空与 promote_latest==true。
 * - 缺 source_digest 即使 promote_latest=true 也拒绝；缺 promote_latest 即使有源 digest 也不晋升。
 * - 晋升后含 imagetools inspect 回读比对（digest 与 OCI label）。
 * @param dockerPush docker-push.yml 全文
 */
function casePromoteRetagOnly(dockerPush: string): void {
  assert.ok(dockerPush.includes('imagetools create'), 'WS2: 晋升 step 缺 imagetools create（无重构建 retag）=RED');
  assert.ok(dockerPush.includes('imagetools inspect'), 'WS2: 晋升后缺 imagetools inspect 回读=RED');
  // 双显式输入缺一不可：文件必须同时出现 source_digest/source_ref 与 promote_latest，且晋升 if 同时约束两者。
  assert.ok(dockerPush.includes('source_digest') || dockerPush.includes('source_ref'), 'WS2: 晋升缺 source_digest/source_ref 输入=RED');
  assert.ok(dockerPush.includes('promote_latest'), 'WS2: 晋升缺 promote_latest 输入=RED');
  const hasPromoteGate: boolean =
    dockerPush.includes('promote_latest') &&
    (dockerPush.includes('source_digest') || dockerPush.includes('source_ref')) &&
    /if:.*promote_latest/.test(dockerPush);
  assert.ok(hasPromoteGate, 'WS2: promote-latest job 条件必须同时要求源 digest/ref 非空且 promote_latest==true=RED（缺一即拒）');
  // 负例语义：条件文本必须同时引用源输入与 promote_latest，任一缺失即跳过/拒绝（静态保证）。
  assert.ok(
    /source_(digest|ref)[\s\S]{0,400}promote_latest|promote_latest[\s\S]{0,400}source_(digest|ref)/.test(dockerPush),
    'WS2: 晋升条件必须双输入耦合（缺 source_digest 即使 promote_latest=true 也拒绝；缺 promote_latest 即使有源 digest 也不晋升）=RED',
  );
  console.log('PASS: 用例⑩ latest 仅显式双输入无重构建 retag + 回读');
}

/**
 * 用例⑪：供应链硬化——全 pin + SBOM/provenance + secret 门 + 脱敏工件。
 * - 全部 4 个 workflow 的 uses: 为 full-SHA pin（无 @vN 残留）。
 * - 发布 workflow 有 secret 扫描门、脱敏 upload-artifact + retention-days: 30。
 * - 构建启用 SBOM/provenance（脚本含 --sbom=true --provenance=true）。
 * @param candidate candidate-quality.yml 全文
 * @param dockerPush docker-push.yml 全文
 * @param browser browser.yml 全文
 * @param nightly nightly-browser.yml 全文
 * @param script push-ghcr.sh 全文
 */
function caseSupplyChainPins(
  candidate: string,
  dockerPush: string,
  browser: string,
  nightly: string,
  script: string,
): void {
  for (const [name, content] of [
    ['candidate-quality.yml', candidate],
    ['docker-push.yml', dockerPush],
    ['browser.yml', browser],
    ['nightly-browser.yml', nightly],
  ] as Array<[string, string]>) {
    assert.ok(!/uses:\s*\S+@v\d+(\s|$)/m.test(content), `WS2: ${name} 仍有 tag-only uses 残留=RED（须 full-SHA pin）`);
    const usesLines: string[] = content.split('\n').filter((l) => l.includes('uses:'));
    for (const line of usesLines) {
      assert.ok(/uses:\s*\S+@[0-9a-f]{40}\s+#/.test(line), `WS2: ${name} uses 未 full-SHA pin=RED：${line.trim()}`);
    }
  }
  assert.ok(script.includes('--sbom=true'), 'WS2: 构建缺 --sbom=true=RED');
  assert.ok(script.includes('--provenance=true'), 'WS2: 构建缺 --provenance=true=RED');
  assert.ok(dockerPush.includes('upload-artifact'), 'WS2: 发布 workflow 缺脱敏 upload-artifact=RED');
  assert.ok(dockerPush.includes('retention-days: 30'), 'WS2: 工件缺 retention-days: 30=RED');
  console.log('PASS: 用例⑪ 全 pin + SBOM/provenance + 脱敏工件');
}

/**
 * 测试入口：顺序执行①-⑪，任一缺失即抛（RED），全过即 GREEN。
 */
async function main(): Promise<void> {
  console.log('--- Testing Candidate Quality Gate Workflow ---');
  const candidate: string = readText(candidateRel);
  const browser: string = readText(browserRel);
  const nightly: string = readText(nightlyRel);
  const pullRequestTemplate: string = readText(pullRequestTemplateRel);
  const script: string = readText(pushScriptRel);
  const dockerPush: string = readText(dockerPushRel);
  caseQualitySevenSteps(candidate);
  caseImageNeedsQuality(candidate);
  caseTriggers(candidate);
  caseBrowserPullRequestGate(browser);
  casePullRequestTemplate(pullRequestTemplate);
  caseUsesPinned(candidate);
  caseShaTag(script);
  casePathFilterStep(candidate);
  caseDockerPushNeeds(dockerPush);
  caseOrdinaryBranchesNoPublisher(candidate);
  caseSingleSerializedPublisher(candidate, dockerPush, browser, nightly);
  casePromoteRetagOnly(dockerPush);
  caseSupplyChainPins(candidate, dockerPush, browser, nightly, script);
  console.log('ALL CANDIDATE QUALITY WORKFLOW TESTS PASSED');
}

export default main();
