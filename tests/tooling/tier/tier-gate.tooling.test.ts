import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * tier 完整性门 tooling 测试（WS3，TDD：先 RED 后 GREEN）。
 *
 * 覆盖 spec §WS3 验收标准全部条目：
 * 受控 catalog fixture 正负例（全 ACTIVE 通过；PLANNED/BLOCKED/MANUAL/
 * 缺 executable/坏 path/未知 executable 均阻断；空选集阻断 empty-selection；
 * 合法未过期 waiver 放行并标记 WAIVED；过期/缺字段 waiver 阻断；
 * --select 非法值 exit 2；缺 --select exit 2；坏 catalog exit 1）；
 * 真实基线 catalog 断言（--select CANDIDATE/RELEASE 均 PASS、阻断集为空，缺口清单与
 * check-test-catalog.mjs 的缺口交叉一致：门阻断集 ⊆ checker 缺口集）。
 *
 * 口径：只跑 node 子进程 + tmp 写，不触 DB/网络；needs_db=false 叶子套件。
 */

// 中文注释：仓库根（gate/checker 均以 cwd 为 repoRoot 解析相对路径）。
const repoRoot: string = process.cwd();
// 中文注释：被测 gate 绝对路径。
const gateAbs: string = path.join(repoRoot, 'scripts', 'check-tier-gate.mjs');
// 中文注释：交叉一致用的真 checker 绝对路径。
const checkerAbs: string = path.join(repoRoot, 'scripts', 'check-test-catalog.mjs');
// 中文注释：子进程上限毫秒（gate 为纯本地校验，瞬时返回）。
const execTimeoutMs: number = 15000;
// 中文注释：fixture 好 executable 落盘路径（复用真实存在的仓库文件）。
const goodExecPath: string = './tests/unit/identity-session/session-roundtrip.unit.test.ts';
// 中文注释：基线 CANDIDATE/RELEASE P0/P1 门阻断集（销定当前真实缺口；catalog 补测试解阻须同步更新本表）。
// 2026-09-11 tier-gate-test-supplement：5 阻断逐条解阻——
// ① guest-register-3step-migrate-fidelity（补 L2 保真断言升 ACTIVE）、
// ② login-existing-no-leak（新建 L2 升 ACTIVE）、
// ③ logout-dual-cookie-clean-reset（新建 L2 升 ACTIVE）、
// ④ clear-during-generate-no-orphan-audio（新建 L2 升 ACTIVE）、
// ⑤ guest-cold-start-first-screen（新建 L3 升 ACTIVE）。
// 解阻后阻断集为空（门 PASS）；本常量保留 pin 形态，空数组即当前基线。
const baselineBlockedIds: string[] = [];

/**
 * fixture case 行（仅 gate 关心的字段；其余 catalog 字段与门无关故省略）。
 */
interface FixtureCase {
  caseId: string;
  lifecycle: string;
  priority: string;
  tier: string;
  execIds: string[];
}

/**
 * fixture executable 行。
 */
interface FixtureExec {
  id: string;
  execPath: string;
}

/**
 * waiver 条目（缺字段用例故意省略部分键，由调用方传 partial）。
 */
interface FixtureWaiver {
  caseId?: string;
  reason?: string;
  owner?: string;
  issue?: string;
  expiresAt?: string;
}

/**
 * 生成 fixture catalog YAML（两空格缩进子集，与 checker 共用解析器口径一致）。
 * @param cases case 行
 * @param execs executable 行
 * @returns YAML 文本
 */
function emitCatalog(cases: FixtureCase[], execs: FixtureExec[]): string {
  const lines: string[] = ['schema_version: 1', 'cases:'];
  for (const c of cases) {
    lines.push(`  - case_id: ${c.caseId}`);
    lines.push(`    lifecycle_status: ${c.lifecycle}`);
    lines.push(`    priority: ${c.priority}`);
    lines.push(`    ci_tier: ${c.tier}`);
    lines.push(`    executable_ids: [${c.execIds.join(', ')}]`);
  }
  lines.push('executables:');
  for (const e of execs) {
    lines.push(`  - executable_id: ${e.id}`);
    lines.push(`    path: ${e.execPath}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 生成 fixture waivers YAML（空数组即 `[]`；条目为顶层序列）。
 * @param waivers waiver 条目
 * @returns YAML 文本
 */
function emitWaivers(waivers: FixtureWaiver[]): string {
  if (waivers.length === 0) return '[]\n';
  const lines: string[] = [];
  for (const w of waivers) {
    lines.push(`- case_id: ${w.caseId ?? ''}`);
    if (w.reason !== undefined) lines.push(`  reason: ${w.reason}`);
    if (w.owner !== undefined) lines.push(`  owner: ${w.owner}`);
    if (w.issue !== undefined) lines.push(`  issue: ${w.issue}`);
    if (w.expiresAt !== undefined) lines.push(`  expires_at: ${w.expiresAt}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 跑 gate 并返回结果（不抛，由调用方断言退出码与输出）。
 * @param args 传给 gate 的参数表
 * @returns { status, stdout, stderr }
 */
function runGate(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout: string = execFileSync(process.execPath, [gateAbs, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: execTimeoutMs,
    }) as unknown as string;
    return { status: 0, stdout: String(stdout), stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

/**
 * 在沙箱落盘 fixture 并跑 gate（默认 --catalog/--waivers 指向沙箱文件）。
 * @param dir 沙箱目录
 * @param name 用例名（派生文件名）
 * @param catalogYaml catalog 文本
 * @param waiversYaml waivers 文本
 * @param extra gate 额外参数（默认 --select CANDIDATE）
 * @returns gate 结果
 */
function runFixture(
  dir: string,
  name: string,
  catalogYaml: string,
  waiversYaml: string,
  extra: string[] = ['--select', 'CANDIDATE'],
): { status: number; stdout: string; stderr: string } {
  const catalogFile: string = path.join(dir, `${name}.catalog.yaml`);
  const waiversFile: string = path.join(dir, `${name}.waivers.yaml`);
  writeFileSync(catalogFile, catalogYaml, 'utf8');
  writeFileSync(waiversFile, waiversYaml, 'utf8');
  return runGate([...extra, '--catalog', catalogFile, '--waivers', waiversFile]);
}

/**
 * 好 executable 单件（指向真实落盘文件）。
 * @returns fixture executable
 */
function goodExec(): FixtureExec {
  return { id: 'exec-good', execPath: goodExecPath };
}

/**
 * 用例：全 ACTIVE 通过（正例，exit 0 + PASS 行）。
 */
function caseAllActivePass(dir: string): void {
  const yaml: string = emitCatalog(
    [
      { caseId: 'case-active-one', lifecycle: 'ACTIVE', priority: 'P0', tier: 'CANDIDATE', execIds: ['exec-good'] },
      { caseId: 'case-active-two', lifecycle: 'ACTIVE', priority: 'P1', tier: 'CANDIDATE', execIds: ['exec-good'] },
    ],
    [goodExec()],
  );
  const r = runFixture(dir, 'all-active', yaml, emitWaivers([]));
  assert.strictEqual(r.status, 0, `全ACTIVE应 exit 0，实际=${r.status} stdout头=${r.stdout.slice(0, 300)} stderr头=${r.stderr.slice(0, 300)}`);
  assert.ok(r.stdout.includes('TIER-GATE PASS'), `正例 stdout 应含 TIER-GATE PASS，实际头=${r.stdout.slice(0, 300)}`);
  console.log('PASS: 全ACTIVE通过 exit 0');
}

/**
 * 用例：PLANNED/BLOCKED 均阻断（exit 1 + 逐条 case_id + lifecycle 原因）。
 */
function casePlannedBlocked(dir: string): void {
  const yaml: string = emitCatalog(
    [
      { caseId: 'case-planned-x', lifecycle: 'PLANNED', priority: 'P0', tier: 'CANDIDATE', execIds: ['exec-good'] },
      { caseId: 'case-blocked-y', lifecycle: 'BLOCKED', priority: 'P1', tier: 'CANDIDATE', execIds: ['exec-good'] },
    ],
    [goodExec()],
  );
  const r = runFixture(dir, 'planned-blocked', yaml, emitWaivers([]));
  assert.strictEqual(r.status, 1, `PLANNED/BLOCKED应 exit 1，实际=${r.status}`);
  assert.ok(r.stdout.includes('case-planned-x'), '阻断清单应含 case-planned-x');
  assert.ok(r.stdout.includes('case-blocked-y'), '阻断清单应含 case-blocked-y');
  assert.ok(r.stdout.includes('lifecycle:PLANNED'), '阻断原因应含 lifecycle:PLANNED');
  assert.ok(r.stdout.includes('lifecycle:BLOCKED'), '阻断原因应含 lifecycle:BLOCKED');
  console.log('PASS: PLANNED/BLOCKED阻断 exit 1');
}

/**
 * 用例：MANUAL 即使有 executable 也阻断（lifecycle != ACTIVE）。
 */
function caseManualBlocked(dir: string): void {
  const yaml: string = emitCatalog(
    [{ caseId: 'case-manual-z', lifecycle: 'MANUAL', priority: 'P0', tier: 'CANDIDATE', execIds: ['exec-good'] }],
    [goodExec()],
  );
  const r = runFixture(dir, 'manual', yaml, emitWaivers([]));
  assert.strictEqual(r.status, 1, `MANUAL应 exit 1，实际=${r.status}`);
  assert.ok(r.stdout.includes('case-manual-z') && r.stdout.includes('lifecycle:MANUAL'), '阻断清单应含 MANUAL 原因行');
  console.log('PASS: MANUAL阻断 exit 1');
}

/**
 * 用例：ACTIVE 但 executable_ids 为空即阻断。
 */
function caseEmptyExecutableIds(dir: string): void {
  const yaml: string = emitCatalog(
    [{ caseId: 'case-no-exec', lifecycle: 'ACTIVE', priority: 'P0', tier: 'CANDIDATE', execIds: [] }],
    [goodExec()],
  );
  const r = runFixture(dir, 'empty-exec', yaml, emitWaivers([]));
  assert.strictEqual(r.status, 1, `缺executable应 exit 1，实际=${r.status}`);
  assert.ok(r.stdout.includes('case-no-exec') && r.stdout.includes('empty-executable-ids'), '阻断清单应含 empty-executable-ids 原因行');
  console.log('PASS: 缺executable阻断 exit 1');
}

/**
 * 用例：executable path 不落盘即阻断（复用 checker 口径）。
 */
function caseBadPath(dir: string): void {
  const yaml: string = emitCatalog(
    [{ caseId: 'case-bad-path', lifecycle: 'ACTIVE', priority: 'P0', tier: 'CANDIDATE', execIds: ['exec-bad'] }],
    [{ id: 'exec-bad', execPath: './tests/unit/not-exist-fake.unit.test.ts' }],
  );
  const r = runFixture(dir, 'bad-path', yaml, emitWaivers([]));
  assert.strictEqual(r.status, 1, `坏path应 exit 1，实际=${r.status}`);
  assert.ok(r.stdout.includes('case-bad-path') && r.stdout.includes('missing-path:'), '阻断清单应含 missing-path 原因行');
  console.log('PASS: 坏path阻断 exit 1');
}

/**
 * 用例：executable_id 在 executables 缺失即阻断。
 */
function caseUnknownExecutable(dir: string): void {
  const yaml: string = emitCatalog(
    [{ caseId: 'case-ghost-exec', lifecycle: 'ACTIVE', priority: 'P0', tier: 'CANDIDATE', execIds: ['exec-ghost'] }],
    [goodExec()],
  );
  const r = runFixture(dir, 'ghost-exec', yaml, emitWaivers([]));
  assert.strictEqual(r.status, 1, `未知executable应 exit 1，实际=${r.status}`);
  assert.ok(r.stdout.includes('case-ghost-exec') && r.stdout.includes('unknown-executable:exec-ghost'), '阻断清单应含 unknown-executable 原因行');
  console.log('PASS: 未知executable阻断 exit 1');
}

/**
 * 用例：空选集阻断（exit 1 + empty-selection，不是 0 不是 2）。
 */
function caseEmptySelection(dir: string): void {
  const yaml: string = emitCatalog(
    [
      { caseId: 'case-none-tier', lifecycle: 'ACTIVE', priority: 'P0', tier: 'NONE', execIds: ['exec-good'] },
      { caseId: 'case-p2-only', lifecycle: 'ACTIVE', priority: 'P2', tier: 'CANDIDATE', execIds: ['exec-good'] },
    ],
    [goodExec()],
  );
  const r = runFixture(dir, 'empty-selection', yaml, emitWaivers([]));
  assert.strictEqual(r.status, 1, `空选集应 exit 1，实际=${r.status}`);
  assert.ok(r.stdout.includes('empty-selection'), `空选集输出应含 empty-selection，实际头=${r.stdout.slice(0, 300)}`);
  console.log('PASS: 空选集阻断 empty-selection exit 1');
}

/**
 * 用例：合法未过期 waiver 放行并标记 WAIVED（exit 0）。
 */
function caseValidWaiver(dir: string): void {
  const yaml: string = emitCatalog(
    [{ caseId: 'case-planned-w', lifecycle: 'PLANNED', priority: 'P0', tier: 'CANDIDATE', execIds: ['exec-good'] }],
    [goodExec()],
  );
  const waivers: string = emitWaivers([
    { caseId: 'case-planned-w', reason: '排期未到', owner: 'smoke', issue: 'ISSUE-1', expiresAt: '2099-12-31' },
  ]);
  const r = runFixture(dir, 'valid-waiver', yaml, waivers);
  assert.strictEqual(r.status, 0, `合法waiver应 exit 0，实际=${r.status} stdout头=${r.stdout.slice(0, 300)} stderr头=${r.stderr.slice(0, 300)}`);
  assert.ok(r.stdout.includes('case-planned-w') && r.stdout.includes('WAIVED'), '放行输出应标记 WAIVED');
  console.log('PASS: 合法waiver放行并标记 exit 0');
}

/**
 * 用例：expires_at 当天有效（UTC 当天仍放行）。
 */
function caseWaiverExpiresToday(dir: string): void {
  const today: string = new Date().toISOString().slice(0, 10);
  const yaml: string = emitCatalog(
    [{ caseId: 'case-today-w', lifecycle: 'PLANNED', priority: 'P0', tier: 'CANDIDATE', execIds: ['exec-good'] }],
    [goodExec()],
  );
  const waivers: string = emitWaivers([
    { caseId: 'case-today-w', reason: '当天有效', owner: 'smoke', issue: 'ISSUE-T', expiresAt: today },
  ]);
  const r = runFixture(dir, 'today-waiver', yaml, waivers);
  assert.strictEqual(r.status, 0, `当天waiver应 exit 0，实际=${r.status} today=${today}`);
  assert.ok(r.stdout.includes('WAIVED'), '当天 waiver 应标记 WAIVED');
  console.log(`PASS: 当天waiver有效 exit 0（${today}）`);
}

/**
 * 用例：过期 waiver 不得放行（exit 1，无 WAIVED 标记）。
 */
function caseExpiredWaiver(dir: string): void {
  const yaml: string = emitCatalog(
    [{ caseId: 'case-expired-w', lifecycle: 'PLANNED', priority: 'P0', tier: 'CANDIDATE', execIds: ['exec-good'] }],
    [goodExec()],
  );
  const waivers: string = emitWaivers([
    { caseId: 'case-expired-w', reason: '已过期', owner: 'smoke', issue: 'ISSUE-2', expiresAt: '2000-01-01' },
  ]);
  const r = runFixture(dir, 'expired-waiver', yaml, waivers);
  assert.strictEqual(r.status, 1, `过期waiver应 exit 1，实际=${r.status}`);
  assert.ok(r.stdout.includes('case-expired-w'), '过期 waiver 的 case 仍应列入阻断清单');
  assert.ok(!r.stdout.includes('WAIVED'), '过期 waiver 不得标记 WAIVED');
  console.log('PASS: 过期waiver阻断 exit 1');
}

/**
 * 用例：缺字段 waiver 不得放行（exit 1）。
 */
function caseMissingFieldWaiver(dir: string): void {
  const yaml: string = emitCatalog(
    [{ caseId: 'case-bad-w', lifecycle: 'PLANNED', priority: 'P0', tier: 'CANDIDATE', execIds: ['exec-good'] }],
    [goodExec()],
  );
  const waivers: string = emitWaivers([{ caseId: 'case-bad-w', reason: '缺owner', issue: 'ISSUE-3', expiresAt: '2099-12-31' }]);
  const r = runFixture(dir, 'bad-waiver', yaml, waivers);
  assert.strictEqual(r.status, 1, `缺字段waiver应 exit 1，实际=${r.status}`);
  assert.ok(r.stdout.includes('case-bad-w'), '缺字段 waiver 的 case 仍应列入阻断清单');
  assert.ok(!r.stdout.includes('WAIVED'), '缺字段 waiver 不得标记 WAIVED');
  console.log('PASS: 缺字段waiver阻断 exit 1');
}

/**
 * 用例：--select 非法值 exit 2。
 */
function caseIllegalSelect(dir: string): void {
  const yaml: string = emitCatalog(
    [{ caseId: 'case-x', lifecycle: 'ACTIVE', priority: 'P0', tier: 'CANDIDATE', execIds: ['exec-good'] }],
    [goodExec()],
  );
  const catalogFile: string = path.join(dir, 'illegal-select.catalog.yaml');
  writeFileSync(catalogFile, yaml, 'utf8');
  const r = runGate(['--select', 'BOGUS', '--catalog', catalogFile]);
  assert.strictEqual(r.status, 2, `--select非法值应 exit 2，实际=${r.status}`);
  console.log('PASS: 非法--select exit 2');
}

/**
 * 用例：缺 --select exit 2。
 */
function caseMissingSelect(): void {
  const r = runGate([]);
  assert.strictEqual(r.status, 2, `缺--select应 exit 2，实际=${r.status} stdout头=${r.stdout.slice(0, 200)}`);
  console.log('PASS: 缺--select exit 2');
}

/**
 * 用例：坏 catalog（不可解析）fail-closed exit 1。
 */
function caseUnreadableCatalog(dir: string): void {
  const badFile: string = path.join(dir, 'unreadable.catalog.yaml');
  writeFileSync(badFile, '  - broken: [unclosed\n    indent-bad\n', 'utf8');
  const waiversFile: string = path.join(dir, 'unreadable.waivers.yaml');
  writeFileSync(waiversFile, '[]\n', 'utf8');
  const r = runGate(['--select', 'CANDIDATE', '--catalog', badFile, '--waivers', waiversFile]);
  assert.strictEqual(r.status, 1, `坏catalog应 exit 1，实际=${r.status}`);
  assert.ok(r.stdout.includes('catalog-unreadable'), '坏 catalog 应报 catalog-unreadable');
  console.log('PASS: 坏catalog fail-closed exit 1');
}

/**
 * 从 gate 输出提取阻断 case_id 集合（阻断行形如 `<case_id> <reason>`）。
 * @param stdout gate stdout
 * @returns 排序后的 case_id 数组
 */
function extractBlockedIds(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([a-z0-9]+(?:-[a-z0-9]+)*) (lifecycle:|empty-executable-ids|unknown-executable:|missing-path:)/);
    if (m) ids.push(m[1]);
  }
  return [...new Set(ids)].sort();
}

/**
 * 从 checker 输出提取缺口 case_id 集合（缺口行形如 `缺口：<case_id>（…）`）。
 * @param stdout checker stdout
 * @returns 缺口 case_id 数组
 */
function extractCheckerGapIds(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^缺口：([a-z0-9]+(?:-[a-z0-9]+)*)/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/**
 * 用例：真实 catalog 双选择均 PASS（5 阻断已解），且与 checker 缺口交叉一致。
 * 门阻断集 pin 为空；CANDIDATE 与 RELEASE 同构（NIGHTLY 全 P2、RELEASE tier 为空）；
 * checker 缺口 25 项均为门选集之外（P2/NIGHTLY/NONE），门阻断（空）⊆ 缺口恒成立。
 */
function caseRealBaseline(): void {
  const cand = runGate(['--select', 'CANDIDATE']);
  assert.strictEqual(cand.status, 0, `解阻后CANDIDATE应 exit 0，实际=${cand.status} stdout头=${cand.stdout.slice(0, 300)}`);
  assert.ok(cand.stdout.includes('TIER-GATE PASS'), 'CANDIDATE 应输出 TIER-GATE PASS');
  const rel = runGate(['--select', 'RELEASE']);
  assert.strictEqual(rel.status, 0, `解阻后RELEASE应 exit 0，实际=${rel.status}`);
  assert.ok(rel.stdout.includes('TIER-GATE PASS'), 'RELEASE 应输出 TIER-GATE PASS');
  const candIds: string[] = extractBlockedIds(cand.stdout);
  const relIds: string[] = extractBlockedIds(rel.stdout);
  assert.deepStrictEqual(candIds, [...baselineBlockedIds].sort(), `CANDIDATE阻断集应 pin 为空，实际=${JSON.stringify(candIds)}`);
  assert.deepStrictEqual(relIds, [...baselineBlockedIds].sort(), `RELEASE阻断集应 pin 为空，实际=${JSON.stringify(relIds)}`);
  let checkerOut: string = '';
  try {
    checkerOut = execFileSync(process.execPath, [checkerAbs], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 }) as unknown as string;
  } catch (err) {
    assert.fail(`交叉一致要求 checker 本体 exit 0，实际 status=${String((err as { status?: unknown }).status)}`);
  }
  const gapIds: string[] = extractCheckerGapIds(String(checkerOut));
  assert.ok(gapIds.length === 25, `checker缺口数基线应为25（P0-05 config-init-gate-retry 恢复为真实缺口后），实际=${gapIds.length}`);
  for (const id of candIds) {
    assert.ok(gapIds.includes(id), `门阻断 ${id} 应出现在 checker 缺口清单中（交叉一致）`);
  }
  console.log(`PASS: 基线双选择均PASS（阻断${candIds.length}项）且与checker缺口交叉一致（checker缺口${gapIds.length}项，门阻断⊆缺口）`);
}

/**
 * 测试入口：顺序执行全部用例。
 */
async function main(): Promise<void> {
  const dir: string = mkdtempSync(path.join(tmpdir(), 'tier-gate-'));
  try {
    caseAllActivePass(dir);
    casePlannedBlocked(dir);
    caseManualBlocked(dir);
    caseEmptyExecutableIds(dir);
    caseBadPath(dir);
    caseUnknownExecutable(dir);
    caseEmptySelection(dir);
    caseValidWaiver(dir);
    caseWaiverExpiresToday(dir);
    caseExpiredWaiver(dir);
    caseMissingFieldWaiver(dir);
    caseIllegalSelect(dir);
    caseMissingSelect();
    caseUnreadableCatalog(dir);
    caseRealBaseline();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('ALL TIER GATE TESTS PASSED');
}

export default main();
