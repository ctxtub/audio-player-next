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
 * WS2 共享解析辅助（F2–F7 锁定用，不引入 YAML 依赖）。
 * - 注释行（# 开头）不计入权限/并发计数，避免头注 packages:write 干扰。
 * - job 切分按顶层 `  <job>:` 头切分（同文件 fan-in 断言用）。
 */
function stripCommentLines(workflow: string): string {
  return workflow
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * 统计非注释行中 `packages: write` 出现次数（写入能力 job 计数）。
 */
function countJobWritePermissions(workflow: string): number {
  return (stripCommentLines(workflow).match(/packages:\s*write/g) || []).length;
}

/**
 * 按顶层 job 名切分 section（同文件断言用）。
 * @param workflow docker-push.yml 全文
 * @param jobName 顶层 job 名
 */
function extractJobSection(workflow: string, jobName: string): string {
  const lines: string[] = workflow.split('\n');
  const startIdx: number = lines.findIndex((l) => new RegExp(`^  ${jobName}:\\s*$`).test(l));
  assert.ok(startIdx >= 0, `缺 job ${jobName}=RED`);
  let endIdx: number = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

/**
 * 取 promote-latest job 的 `if:` 行（F4 双输入耦合唯一真相源）。
 */
function getPromoteIfLine(workflow: string): string {
  const section: string = extractJobSection(workflow, 'promote-latest');
  const line: string | undefined = section.split('\n').find((l) => /^\s*if:/.test(l));
  assert.ok(line !== undefined, 'WS2: promote-latest 缺 if 运行条件=RED');
  return line as string;
}

/**
 * 判定晋升门是否同时含源非空判断与 promote_latest == true（F4 谓词）。
 * 真负例：仅一侧必须返回 false。
 */
function isPromoteGateValid(ifLine: string): boolean {
  const hasSourceNonEmpty: boolean =
    (ifLine.includes('source_digest') || ifLine.includes('source_ref')) &&
    (ifLine.includes("!= ''") || ifLine.includes('!= ""'));
  const hasPromoteTrue: boolean = ifLine.includes('promote_latest') && ifLine.includes('== true');
  const hasAnd: boolean = ifLine.includes('&&');
  return hasSourceNonEmpty && hasPromoteTrue && hasAnd;
}

/**
 * 判定 Verify 段是否含 digest + revision/source label 回读（F3 谓词）。
 */
function hasOciLabelReadBack(section: string): boolean {
  return (
    section.includes('imagetools inspect') &&
    section.includes('--format') &&
    section.includes('org.opencontainers.image.revision') &&
    section.includes('org.opencontainers.image.source')
  );
}

/**
 * 用例⑨：发布链路收敛 WS2——单串行写入路径锁定（F2 + F5）。
 * - 全仓恰两个写入能力 job（docker-push.yml:docker-push 构建推送 + promote-latest retag 晋升），共享同一串行组；candidate/browser/nightly 均无。
 * - 三处 concurrency 均为 image-publisher-global 且 cancel-in-progress: false（顶层 + 两发布 job）。
 * - promote-latest needs docker-push（串行）；docker-push needs 恰含 [quality, tier-gate, browser-smoke]（fan-in，无回退）。
 * - 三门与发布者同文件；docker-push 为唯一构建发布者（promote 仅 imagetools create，无 buildx build）。
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
  // F2 集合锁定：恰两个（禁止回退为 >=1）。
  const publisherCount: number = countJobWritePermissions(dockerPush);
  assert.strictEqual(publisherCount, 2, `WS2: docker-push 写入能力 job 必须恰两个（docker-push + promote-latest）=RED，实测 ${publisherCount}`);
  const dockerPushSection: string = extractJobSection(dockerPush, 'docker-push');
  const promoteSection: string = extractJobSection(dockerPush, 'promote-latest');
  assert.ok(/packages:\s*write/.test(dockerPushSection), 'WS2: docker-push job 必须含 packages:write=RED');
  assert.ok(/packages:\s*write/.test(promoteSection), 'WS2: promote-latest job 必须含 packages:write（retag 需 registry 写）=RED');
  // F2 真负例 fixture：第三个写权限必须被拒（集合锁定谓词在错误实现下会红）。
  const threePublisherFixture: string = `${stripCommentLines(dockerPush)}\n  evil-publisher:\n    permissions:\n      packages: write\n`;
  assert.strictEqual(
    countJobWritePermissions(threePublisherFixture),
    3,
    'WS2 真负例前置：三写 fixture 计数必须为 3（否则负例无效）=RED',
  );
  assert.ok(
    countJobWritePermissions(threePublisherFixture) !== 2,
    'WS2 真负例：第三个 packages:write 必须使 ===2 变红=RED（集合锁定有效）',
  );
  // 三处串行组一致（顶层 + 两发布 job）。
  const codeOnly: string = stripCommentLines(dockerPush);
  assert.strictEqual(
    (codeOnly.match(/image-publisher-global/g) || []).length,
    3,
    'WS2: image-publisher-global 必须恰三处（顶层 + docker-push + promote-latest）=RED',
  );
  assert.strictEqual(
    (codeOnly.match(/cancel-in-progress:\s*false/g) || []).length,
    3,
    'WS2: cancel-in-progress: false 必须恰三处（顶层 + docker-push + promote-latest）=RED',
  );
  assert.ok(dockerPushSection.includes('image-publisher-global'), 'WS2: docker-push job 缺串行组=RED');
  assert.ok(promoteSection.includes('image-publisher-global'), 'WS2: promote-latest job 缺串行组=RED');
  // 串行：promote-latest needs docker-push。
  assert.ok(/needs:\s*\[docker-push\]/.test(promoteSection), 'WS2: promote-latest 必须 needs: [docker-push]（串行）=RED');
  // F5 fan-in：docker-push needs 恰含三者（去掉仅含 quality 回退）；三门与发布者同文件。
  assert.ok(
    /needs:\s*\[quality,\s*tier-gate,\s*browser-smoke\]/.test(dockerPushSection),
    'WS2: docker-push 的 needs 必须恰含 [quality, tier-gate, browser-smoke]（fan-in，无回退）=RED',
  );
  for (const job of ['quality', 'tier-gate', 'browser-smoke', 'docker-push']) {
    assert.ok(new RegExp(`^  ${job}:\\s*$`, 'm').test(dockerPush), `WS2: ${job} 必须与发布者同文件（docker-push.yml）=RED`);
  }
  // docker-push 为唯一构建发布者：promote 仅 retag，无 build。
  assert.ok(
    dockerPushSection.includes('push-ghcr.sh') || dockerPushSection.includes('buildx build'),
    'WS2: docker-push 必须为构建发布者（含 push-ghcr.sh/buildx build）=RED',
  );
  assert.ok(promoteSection.includes('imagetools create'), 'WS2: promote-latest 必须含 imagetools create=RED');
  assert.ok(!promoteSection.includes('buildx build'), 'WS2: promote-latest 不得含 buildx build（retag-only）=RED');
  console.log('PASS: 用例⑨ 单串行写入路径（恰两写 + 三处串行 + fan-in）');
}

/**
 * 用例⑩：latest 仅显式晋升——retag-only + 双输入缺一即拒（解析 if 行）+ OCI 回读（F3 + F4）。
 * - 晋升 step 含 imagetools create（无重构建）且 promote-latest job 的 if 行同时含源非空判断与 promote_latest == true。
 * - 两条真负例：if 仅 promote_latest==true 必拒；if 仅源非空必拒。
 * - Verify 含 imagetools inspect --format 取 revision/source label 并失配 exit 1；缺 label 比对即红。
 * @param dockerPush docker-push.yml 全文
 */
function casePromoteRetagOnly(dockerPush: string): void {
  assert.ok(dockerPush.includes('imagetools create'), 'WS2: 晋升 step 缺 imagetools create（无重构建 retag）=RED');
  assert.ok(dockerPush.includes('imagetools inspect'), 'WS2: 晋升后缺 imagetools inspect 回读=RED');
  // 双显式输入缺一不可：文件必须同时出现 source_digest/source_ref 与 promote_latest，且晋升 if 同时约束两者。
  assert.ok(dockerPush.includes('source_digest') || dockerPush.includes('source_ref'), 'WS2: 晋升缺 source_digest/source_ref 输入=RED');
  assert.ok(dockerPush.includes('promote_latest'), 'WS2: 晋升缺 promote_latest 输入=RED');
  // F4：解析 promote-latest job 的 if 行（非邻近字符串），同时含源非空与 promote_latest == true。
  const ifLine: string = getPromoteIfLine(dockerPush);
  assert.ok(
    ifLine.includes('source_digest') || ifLine.includes('source_ref'),
    `WS2: promote-latest 的 if 行必须含源输入非空判断=RED，实测 ${ifLine.trim()}`,
  );
  assert.ok(
    ifLine.includes("!= ''") || ifLine.includes('!= ""'),
    `WS2: promote-latest 的 if 行必须含源非空判断（!= ''）=RED，实测 ${ifLine.trim()}`,
  );
  assert.ok(ifLine.includes('promote_latest'), `WS2: promote-latest 的 if 行必须含 promote_latest=RED，实测 ${ifLine.trim()}`);
  assert.ok(ifLine.includes('== true'), `WS2: promote-latest 的 if 行必须含 promote_latest == true=RED，实测 ${ifLine.trim()}`);
  assert.ok(ifLine.includes('&&'), `WS2: promote-latest 的 if 行必须以 && 耦合双输入=RED，实测 ${ifLine.trim()}`);
  assert.ok(isPromoteGateValid(ifLine), 'WS2: promote-latest job 条件必须同时要求源 digest/ref 非空且 promote_latest==true=RED（缺一即拒）');
  // F4 两条真负例（谓词在错误实现下必须红）。
  const onlyPromoteIf: string = 'if: ${{ inputs.promote_latest == true }}';
  assert.ok(!isPromoteGateValid(onlyPromoteIf), 'WS2 真负例：if 仅 promote_latest==true 必须被拒=RED（缺源非空）');
  const onlySourceIf: string = "if: ${{ (inputs.source_digest != '' || inputs.source_ref != '') }}";
  assert.ok(!isPromoteGateValid(onlySourceIf), 'WS2 真负例：if 仅源非空必须被拒=RED（缺 promote_latest==true）');
  // F3：Verify 必须含 revision/source label 比对（--format 取 label），失配 exit 1。
  const promoteSection: string = extractJobSection(dockerPush, 'promote-latest');
  assert.ok(hasOciLabelReadBack(promoteSection), 'WS2: Verify 缺 revision/source label 比对（须 imagetools inspect --format 取 label）=RED');
  assert.ok(promoteSection.includes('org.opencontainers.image.revision'), 'WS2: Verify 缺 revision label 比对=RED');
  assert.ok(promoteSection.includes('org.opencontainers.image.source'), 'WS2: Verify 缺 source label 比对=RED');
  assert.ok(promoteSection.includes('exit 1'), 'WS2: 回读失配必须 exit 1=RED');
  // F3 真负例：仅 digest grep、无 label 比对的 Verify 必须被拒。
  const noLabelFixture: string = 'docker buildx imagetools inspect "${IMAGE}:latest"\nACTUAL="$(docker buildx imagetools inspect x --format \'{{json .}}\')"\necho "${ACTUAL}" | grep -q "${SOURCE_DIGEST}"';
  assert.ok(!hasOciLabelReadBack(noLabelFixture), 'WS2 真负例：缺 label 比对的 Verify 必须被拒=RED');
  console.log('PASS: 用例⑩ latest 仅显式双输入无重构建 retag + OCI 回读');
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
 * 用例⑫（F6）：tier_select 语义锁定。
 * - dispatch 输入 tier_select 缺省 RELEASE，options 含 CANDIDATE 与 RELEASE。
 * - tag 分支硬编码 --select RELEASE；dispatch 分支以 inputs.tier_select || 'RELEASE' 回退。
 * @param dockerPush docker-push.yml 全文
 */
function caseTierSelectSemantics(dockerPush: string): void {
  assert.ok(dockerPush.includes('tier_select'), 'WS2: 缺 tier_select 输入=RED');
  assert.ok(dockerPush.includes("default: 'RELEASE'"), "WS2: tier_select 必须 default: 'RELEASE'=RED");
  assert.ok(dockerPush.includes('- CANDIDATE'), 'WS2: tier_select options 必须含 CANDIDATE=RED');
  assert.ok(dockerPush.includes('- RELEASE'), 'WS2: tier_select options 必须含 RELEASE=RED');
  assert.ok(
    dockerPush.includes('node scripts/check-tier-gate.mjs --select RELEASE'),
    'WS2: tag 分支必须硬编码 --select RELEASE=RED',
  );
  assert.ok(
    dockerPush.includes("inputs.tier_select || 'RELEASE'"),
    "WS2: dispatch 分支必须以 inputs.tier_select || 'RELEASE' 回退=RED",
  );
  console.log('PASS: 用例⑫ tier_select 缺省 RELEASE + tag 硬编码 RELEASE');
}

/**
 * 用例⑬（F7）：secret 扫描首步 + 工件白名单/黑名单 + 留存锁定。
 * - quality 首个 step 为有界 secret 扫描（tracked-only）。
 * - upload-artifact 白名单路径精确（5 件），黑名单（.env 星号/DB/secret）永不上传，retention-days: 30 精确。
 * @param dockerPush docker-push.yml 全文
 */
function caseSecretScanFirstAndArtifacts(dockerPush: string): void {
  const qualitySection: string = extractJobSection(dockerPush, 'quality');
  const stepNames: string[] = qualitySection
    .split('\n')
    .filter((l) => /^\s*- name:/.test(l));
  assert.ok(stepNames.length >= 1, 'WS2: quality 缺 steps=RED');
  assert.ok(
    stepNames[0].includes('Secret scan'),
    `WS2: quality 首个 step 必须为 secret 扫描=RED，实测 ${stepNames[0].trim()}`,
  );
  assert.ok(qualitySection.includes('git grep'), 'WS2: secret 扫描必须用 git grep（tracked-only 有界）=RED');
  assert.ok(qualitySection.includes('tracked only'), 'WS2: secret 扫描必须声明 tracked only 有界=RED');
  // 工件块：以 upload-artifact 起至 retention-days 止为真相源。
  const uploadIdx: number = dockerPush.indexOf('upload-artifact');
  assert.ok(uploadIdx >= 0, 'WS2: 缺 upload-artifact=RED');
  const retentionIdx: number = dockerPush.indexOf('retention-days: 30', uploadIdx);
  assert.ok(retentionIdx >= 0, 'WS2: 工件缺 retention-days: 30 精确=RED');
  const uploadBlock: string = dockerPush.slice(uploadIdx, retentionIdx);
  for (const artifact of ['results.jsonl', 'manifest.json', 'summary.log', 'p0-smoke.png', 'digest.txt']) {
    assert.ok(uploadBlock.includes(artifact), `WS2: 工件白名单缺 ${artifact}=RED`);
  }
  assert.ok(!uploadBlock.includes('.env'), 'WS2: 工件黑名单：.env* 永不上传=RED');
  assert.ok(!uploadBlock.includes('.db'), 'WS2: 工件黑名单：DB 永不上传=RED');
  assert.ok(!uploadBlock.toLowerCase().includes('secret'), 'WS2: 工件黑名单：secret 永不上传=RED');
  assert.ok(/retention-days:\s*30\b/.test(dockerPush), 'WS2: retention-days 必须精确为 30=RED');
  console.log('PASS: 用例⑬ secret 首步 + 工件白/黑名单 + 留存 30');
}

/**
 * 测试入口：顺序执行①-⑬，任一缺失即抛（RED），全过即 GREEN。
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
  caseTierSelectSemantics(dockerPush);
  caseSecretScanFirstAndArtifacts(dockerPush);
  console.log('ALL CANDIDATE QUALITY WORKFLOW TESTS PASSED');
}

export default main();
