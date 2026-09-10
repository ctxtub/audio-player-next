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
 * 用例②：镜像 job needs 质量 job（同 workflow 同 SHA 依赖）。
 * @param content candidate-quality.yml 全文
 */
function caseImageNeedsQuality(content: string): void {
  assert.ok(/needs:\s*\[?[^\n]*quality/.test(content), '镜像 job 缺 needs: 质量 job=RED（须同 workflow 同 SHA 依赖）');
  console.log('PASS: 用例② 镜像 job needs 质量 job');
}

/**
 * 用例③：触发器含候选分支 push、普通 PR 与 manual dispatch；PR 不得进入镜像发布 job。
 * @param content candidate-quality.yml 全文
 */
function caseTriggers(content: string): void {
  assert.ok(content.includes('push:'), '缺 push 触发=RED');
  assert.ok(/^\s{2}pull_request:/m.test(content), '缺普通 pull_request 质量门=RED');
  assert.ok(content.includes('workflow_dispatch'), '缺 manual dispatch 触发=RED');
  const imageStart: number = content.indexOf('\n  image:');
  assert.ok(imageStart >= 0, '缺 image job=RED');
  const imageSection: string = content.slice(imageStart);
  assert.ok(
    imageSection.includes("if: github.event_name != 'pull_request'"),
    'PR 必须显式禁止 image 发布 job=RED',
  );
  console.log('PASS: 用例③ push/pull_request/manual 触发且 PR 不发布镜像');
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
 * 用例④：uses 锁定版本（无浮动引用）。
 * @param content candidate-quality.yml 全文
 */
function caseUsesPinned(content: string): void {
  assert.ok(content.includes('actions/checkout@v4'), 'uses 未锁定 actions/checkout@v4=RED');
  const usesLines: string[] = content.split('\n').filter((l) => l.includes('uses:'));
  assert.ok(usesLines.length >= 2, 'uses 行过少=RED');
  for (const line of usesLines) {
    assert.ok(/uses:\s*\S+@v\d+/.test(line), `uses 未锁定版本=RED：${line.trim()}`);
  }
  console.log('PASS: 用例④ uses 锁定版本');
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
 * 测试入口：顺序执行①-⑦，任一缺失即抛（RED），全过即 GREEN。
 */
async function main(): Promise<void> {
  console.log('--- Testing Candidate Quality Gate Workflow ---');
  const candidate: string = readText(candidateRel);
  const browser: string = readText(browserRel);
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
  console.log('ALL CANDIDATE QUALITY WORKFLOW TESTS PASSED');
}

export default main();
