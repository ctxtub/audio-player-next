import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * catalog 校验器 tooling 测试（任务8 STEP-1）。
 * 在沙箱 tmp 造 7 类坏 catalog 逐个断言 checker exit 1 且 stderr 指明原因；
 * 好 catalog（最小合法 4 case 样本，含 1 PLANNED 缺口）断言 exit 0；
 * 另有 L3 surface 覆盖正例（声明覆盖 timeline+state）断言 exit 0。
 * 全程仅 tmp 写 + 只读真实 schema/checker/套件路径，不触 DB/网络。
 */

// 中文注释：仓库根（解析 checker 与 schema 用）。
const repoRoot: string = process.cwd();
// 中文注释：真 checker 绝对路径（子进程跑 node）。
const checkerAbs: string = path.join(repoRoot, 'scripts', 'check-test-catalog.mjs');
// 中文注释：真 schema 绝对路径（沙箱 catalog 共用）。
const schemaAbs: string = path.join(repoRoot, 'tests', 'test-catalog.schema.json');

/**
 * 好 catalog 最小合法样本（4 case：3 ACTIVE + 1 PLANNED 缺口，3 executable 指向真实落盘套件）。
 * @returns YAML 文本
 */
function goodCatalogYaml(): string {
  return [
    'schema_version: 1',
    'cases:',
    '  - case_id: guest-cold-start',
    '    display_name_zh: 访客冷启动首屏渲染',
    '    legacy_aliases: [E2E-01-01]',
    '    journey_id: cold-start',
    '    user_goal: 以访客身份打开首页看到首屏',
    '    priority: P0',
    '    primary_defense: L1',
    '    secondary_defenses: []',
    '    lifecycle_status: ACTIVE',
    '    risk_tags: [smoke]',
    '    spec_path: docs/e2e/01-基础冒烟与页面基线/01-访客冷启动首屏渲染.md',
    '    required_assertions:',
    '      - assertion_id: first-screen-renders',
    '        display_name_zh: 首屏正确渲染',
    '    executable_ids: [guest-cold-start-exec]',
    '    fixtures: []',
    '    ci_tier: CANDIDATE',
    '    owner: smoke',
    '  - case_id: resume-countdown-check',
    '    display_name_zh: 倒计时耗尽一致性',
    '    legacy_aliases: [E2E-03-01]',
    '    journey_id: playback-countdown',
    '    user_goal: 倒计时耗尽时界面与声音一致',
    '    priority: P0',
    '    primary_defense: L2',
    '    secondary_defenses: []',
    '    lifecycle_status: ACTIVE',
    '    risk_tags: [playback]',
    '    spec_path: docs/e2e/03-播放状态与内核一致性/01-倒计时耗尽UI与音频一致性.md',
    '    required_assertions:',
    '      - assertion_id: countdown-ui-audio-consistent',
    '        display_name_zh: 界面与音频一致',
    '    executable_ids: [resume-countdown-exec]',
    '    fixtures: []',
    '    ci_tier: CANDIDATE',
    '    owner: playback',
    '  - case_id: double-submit-guard',
    '    display_name_zh: 快速双发防重',
    '    legacy_aliases: [E2E-02-01]',
    '    journey_id: double-submit',
    '    user_goal: 快速连击只提交一次',
    '    priority: P0',
    '    primary_defense: L2',
    '    secondary_defenses: []',
    '    lifecycle_status: ACTIVE',
    '    risk_tags: [race]',
    '    spec_path: docs/e2e/02-交互并发与竞态防御/01-快速双发防重.md',
    '    required_assertions:',
    '      - assertion_id: single-submit-on-rapid-click',
    '        display_name_zh: 连击只提交一次',
    '    executable_ids: [double-submit-exec]',
    '    fixtures: []',
    '    ci_tier: CANDIDATE',
    '    owner: interaction',
    '  - case_id: planned-future-probe',
    '    display_name_zh: 未来探针占位',
    '    legacy_aliases: [E2E-02-12]',
    '    journey_id: future',
    '    user_goal: 占位未来场景',
    '    priority: P2',
    '    primary_defense: L2',
    '    secondary_defenses: []',
    '    lifecycle_status: PLANNED',
    '    risk_tags: [future]',
    '    spec_path: docs/e2e/02-交互并发与竞态防御/11-播放器选历史切换当前创作.md',
    '    required_assertions:',
    '      - assertion_id: future-assert',
    '        display_name_zh: 未来断言',
    '    executable_ids: []',
    '    fixtures: []',
    '    ci_tier: NONE',
    '    owner: interaction',
    'executables:',
    '  - executable_id: guest-cold-start-exec',
    '    display_name_zh: 访客冷启动执行体',
    '    layer: L1',
    '    path: ./tests/unit/identity-session/session-roundtrip.unit.test.ts',
    '    case_ids: [guest-cold-start]',
    '  - executable_id: resume-countdown-exec',
    '    display_name_zh: 倒计时执行体',
    '    layer: L2',
    '    path: ./tests/integration/playback/resume-countdown.integration.test.ts',
    '    case_ids: [resume-countdown-check]',
    '  - executable_id: double-submit-exec',
    '    display_name_zh: 双发抑制执行体',
    '    layer: L2',
    '    path: ./tests/integration/creation-chat/reject-second-submit-while-streaming.integration.test.ts',
    '    case_ids: [double-submit-guard]',
    '',
  ].join('\n');
}

/**
 * 跑 checker 并返回结果（不抛，由调用方断言）。
 * @param catalogYaml catalog 文本
 * @param dir 沙箱目录
 * @param name 文件名
 * @returns { status, stdout, stderr }
 */
function runChecker(catalogYaml: string, dir: string, name: string): { status: number; stdout: string; stderr: string } {
  const catalogFile: string = path.join(dir, name);
  writeFileSync(catalogFile, catalogYaml, 'utf8');
  try {
    const stdout: string = execFileSync(
      process.execPath,
      [checkerAbs, '--catalog', catalogFile, '--schema', schemaAbs, '--repo-root', repoRoot, '--skip-registry-check'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 15000 },
    ) as unknown as string;
    return { status: 0, stdout: String(stdout), stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

/**
 * 断言坏 catalog 必 exit 1 且 stderr 含预期片段。
 * @param dir 沙箱目录
 * @param name 用例名
 * @param yaml 坏 catalog
 * @param expectStderr 预期 stderr 片段
 * @param label 标签
 */
function expectBad(dir: string, name: string, yaml: string, expectStderr: string, label: string): void {
  const r = runChecker(yaml, dir, name);
  assert.strictEqual(r.status, 1, `${label} 应 exit 1，实际=${r.status} stdout头=${r.stdout.slice(0, 200)}`);
  assert.ok(
    r.stderr.includes(expectStderr),
    `${label} stderr 应含「${expectStderr}」，实际头=${r.stderr.slice(0, 400)}`,
  );
  console.log(`PASS: ${label} exit 1 且 stderr 含「${expectStderr}」`);
}

/**
 * 用例1：缺 case_id。
 */
function caseMissingCaseId(dir: string): void {
  const yaml: string = goodCatalogYaml().replace('  - case_id: guest-cold-start\n', '  - display_name_zh: 缺标识占位\n');
  expectBad(dir, 'bad-1-missing-case-id.yaml', yaml, 'case_id', '坏例1缺case_id');
}

/**
 * 用例2：非法枚举（priority P9）。
 */
function caseIllegalEnum(dir: string): void {
  const yaml: string = goodCatalogYaml().replace('    priority: P0', '    priority: P9');
  expectBad(dir, 'bad-2-illegal-enum.yaml', yaml, '非法枚举', '坏例2非法枚举');
}

/**
 * 用例3：ACTIVE 缺 executable（首 case 置空且删其执行体，反向引用保持一致以孤立 ACTIVE 检查）。
 */
function caseActiveMissingExecutable(dir: string): void {
  let yaml: string = goodCatalogYaml();
  yaml = yaml.replace('    executable_ids: [guest-cold-start-exec]', '    executable_ids: []');
  // 中文注释：删首执行体块，保持其余引用一致，使 schema 与反向引用均通过，只剩 ACTIVE 非空检查应拦。
  yaml = yaml.replace(
    '  - executable_id: guest-cold-start-exec\n    display_name_zh: 访客冷启动执行体\n    layer: L1\n    path: ./tests/unit/identity-session/session-roundtrip.unit.test.ts\n    case_ids: [guest-cold-start]\n',
    '',
  );
  expectBad(dir, 'bad-3-active-no-exec.yaml', yaml, 'ACTIVE', '坏例3ACTIVE缺executable');
}

/**
 * 用例4：executable 重复（两执行体同 ID）。
 */
function caseDuplicateExecutable(dir: string): void {
  const yaml: string = goodCatalogYaml().replace('  - executable_id: resume-countdown-exec', '  - executable_id: guest-cold-start-exec');
  expectBad(dir, 'bad-4-dup-exec.yaml', yaml, '重复', '坏例4executable重复');
}

/**
 * 用例5：path 不存在。
 */
function casePathNotExist(dir: string): void {
  const yaml: string = goodCatalogYaml().replace(
    '    path: ./tests/unit/identity-session/session-roundtrip.unit.test.ts',
    '    path: ./tests/unit/not-exist-fake.unit.test.ts',
  );
  expectBad(dir, 'bad-5-path-missing.yaml', yaml, '不存在', '坏例5path不存在');
}

/**
 * 用例6：case_ids 反向引用断链（执行体指向幽灵 case）。
 */
function caseReverseBroken(dir: string): void {
  const yaml: string = goodCatalogYaml().replace('    case_ids: [guest-cold-start]', '    case_ids: [ghost-case]');
  expectBad(dir, 'bad-6-reverse-broken.yaml', yaml, '反向引用', '坏例6反向引用断链');
}

/**
 * 用例7：L3 executable evidence_surfaces 缺 state（与 evidence-schema 同口径，state 面护栏）。
 * 沙箱单 case（timeline+state）配 L3 执行体仅声明 [audio, timeline, ui]，应 exit 1 且指明 executable/case/缺失 surface。
 */
function caseSurfaceMissing(dir: string): void {
  const yaml: string = surfaceCatalogYaml(true);
  const r = runChecker(yaml, dir, 'bad-7-surface-missing.yaml');
  assert.strictEqual(r.status, 1, `坏例7surface缺失应 exit 1，实际=${r.status} stdout头=${r.stdout.slice(0, 200)}`);
  assert.ok(r.stderr.includes('surface 非法'), `坏例7 stderr 应含「surface 非法」，实际头=${r.stderr.slice(0, 400)}`);
  assert.ok(r.stderr.includes('surface-probe-exec'), `坏例7 stderr 应含 executable surface-probe-exec，实际头=${r.stderr.slice(0, 400)}`);
  assert.ok(r.stderr.includes('surface-probe-case'), `坏例7 stderr 应含 case surface-probe-case，实际头=${r.stderr.slice(0, 400)}`);
  assert.ok(r.stderr.includes('state'), `坏例7 stderr 应含缺失 surface state，实际头=${r.stderr.slice(0, 400)}`);
  console.log('PASS: 坏例7surface缺失 exit 1 且 stderr 含 executable/case/state');
}

/**
 * L3 surface 覆盖沙箱 catalog 生成器（单 case timeline+state，执行体按缺/全声明）。
 * @param missing 缺 state 即坏例，全即正例
 * @returns YAML 文本
 */
function surfaceCatalogYaml(missing: boolean): string {
  const surfaces: string = missing ? '[audio, timeline, ui]' : '[audio, timeline, ui, state]';
  return [
    'schema_version: 1',
    'cases:',
    '  - case_id: surface-probe-case',
    '    display_name_zh: 表面覆盖探针',
    '    legacy_aliases: [E2E-03-03]',
    '    journey_id: playback-kernel',
    '    user_goal: 探针目标',
    '    priority: P0',
    '    primary_defense: L2',
    '    secondary_defenses: [L3]',
    '    lifecycle_status: ACTIVE',
    '    risk_tags: [playback]',
    '    spec_path: docs/e2e/03-播放状态与内核一致性/03-播放中登出立即停声与状态重置.md',
    '    required_assertions:',
    '      - assertion_id: pause-before-unload',
    '        display_name_zh: 停声先于卸载',
    '        surface: timeline',
    '      - assertion_id: state-reset-after-logout',
    '        display_name_zh: 登出后状态重置',
    '        surface: state',
    '    executable_ids: [surface-probe-exec]',
    '    fixtures: []',
    '    ci_tier: CANDIDATE',
    '    owner: playback-kernel',
    'executables:',
    '  - executable_id: surface-probe-exec',
    '    display_name_zh: 探针执行体',
    '    layer: L3',
    '    path: ./tests/system/browser/scenarios/pause-audio-before-logout-unload.spec.ts',
    '    case_ids: [surface-probe-case]',
    `    evidence_surfaces: ${surfaces}`,
    '',
  ].join('\n');
}

/**
 * 正例：L3 surface 全覆盖（timeline+state 均声明）应 exit 0。
 */
function caseSurfaceCovered(dir: string): void {
  const r = runChecker(surfaceCatalogYaml(false), dir, 'good-surface-covered.yaml');
  assert.strictEqual(r.status, 0, `surface正例应 exit 0，实际=${r.status} stderr头=${r.stderr.slice(0, 400)}`);
  assert.ok(r.stdout.includes('CHECK PASS'), `surface正例 stdout 应含 CHECK PASS，实际头=${r.stdout.slice(0, 300)}`);
  console.log('PASS: surface正例全覆盖 exit 0');
}

/**
 * 正例：好 catalog（最小合法 4 case，含 1 PLANNED 缺口）应 exit 0。
 */
function caseGood(dir: string): void {
  const r = runChecker(goodCatalogYaml(), dir, 'good-minimal.yaml');
  assert.strictEqual(r.status, 0, `正例应 exit 0，实际=${r.status} stderr头=${r.stderr.slice(0, 400)}`);
  assert.ok(r.stdout.includes('CHECK PASS'), `正例 stdout 应含 CHECK PASS，实际头=${r.stdout.slice(0, 300)}`);
  assert.ok(r.stdout.includes('原子case数=4'), `正例应报告原子case数=4，实际头=${r.stdout.slice(0, 300)}`);
  console.log('PASS: 正例好catalog exit 0');
}

/**
 * 真实 catalog 门：tests/test-catalog.yaml（含 registry 三方一致）必须 exit 0。
 * 正例 fixture 只证明 checker 逻辑；本用例证明生产 catalog 本体健康（Fix 3.4）。
 * @returns checker stdout（供调用方复核统计口径）
 */
function caseRealCatalog(): string {
  let stdout: string = '';
  try {
    stdout = execFileSync(process.execPath, [checkerAbs], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
    }) as unknown as string;
  } catch (err) {
    const e = err as { status?: unknown; stdout?: unknown; stderr?: unknown };
    assert.fail(
      `真实 catalog 应 exit 0，实际 status=${String(e.status)} stderr头=${String(e.stderr ?? '').slice(0, 500)}`,
    );
  }
  const out: string = String(stdout);
  assert.ok(out.includes('CHECK PASS'), `真实 catalog stdout 应含 CHECK PASS，实际头=${out.slice(0, 300)}`);
  console.log('PASS: 真实 catalog exit 0');
  return out;
}

/**
 * 测试入口：顺序执行 7 坏 + 2 好 + 真实 catalog 门。
 */
async function main(): Promise<void> {
  const dir: string = mkdtempSync(path.join(tmpdir(), 'catalog-checker-'));
  try {
    caseMissingCaseId(dir);
    caseIllegalEnum(dir);
    caseActiveMissingExecutable(dir);
    caseDuplicateExecutable(dir);
    casePathNotExist(dir);
    caseReverseBroken(dir);
    caseSurfaceMissing(dir);
    caseGood(dir);
    caseSurfaceCovered(dir);
    caseRealCatalog();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('ALL CATALOG CHECKER TESTS PASSED');
}

export default main();
