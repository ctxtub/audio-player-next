import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 按测试类型拆分执行器契约测试（任务2，Tooling，RED 先行）。
 * 覆盖：①--list JSON（41 套件 id/path/group/needs_db）②--group/--suite 选择
 * ③未知参数与非法值 exit 2④unit 子进程 env 无 DATABASE_URL
 * ⑤unit 文件 import lib/db 扫描命中 exit 3⑥注册表 path 与磁盘一致
 * ⑦.e2e-results/<run-id>/results.jsonl 行结构。
 * exit 2 类直接 execFile 真 runner（参数校验阶段不建库，安全）；
 * 现状 runner 无 --list/--group，①②③⑥⑦断言必然失败=可信 RED；
 * ④⑤对现有 runner 行为断言（现状 unit 也建库/注入 → 失败=RED）。
 */

// 中文注释：仓库根目录（解析 runner 与注册表路径用）。
const repoRoot: string = process.cwd();
// 中文注释：真 runner 相对路径（execFileSync 跑 node scripts/run-tests.mjs）。
const runnerRel: string = path.join('scripts', 'run-tests.mjs');
// 中文注释：RED 阶段防 hanging 上限毫秒（未来 --list/exit2 瞬时退出，超时即 RED）。
const execTimeoutMs: number = 6000;
// 中文注释：预期套件总数（现状 testFiles 41 项，拆分后注册表保持 41）。
const expectedSuiteCount: number = 41;
// 中文注释：允许的 group 枚举（含任务流全部层级，防未来分组被误判）。
const allowedGroups: string[] = ['unit', 'integration', 'contract', 'tooling', 'static', 'legacy', 'e2e', 'browser'];
// 中文注释：已知 tooling 套件 ID（现有 db-guard 套件，拆分后归 tooling 组）。
const knownToolingSuiteId: string = 'runner-database-path-safety';
// 中文注释：已知 tooling 套件路径后缀（注册表 path 断言用）。
const knownToolingPathSuffix: string = 'tests/tooling/db-guard/runner-database-path-safety.tooling.test.ts';

/**
 * 注册表条目形状（任务2 runner 注册表 {id, path, group, needs_db}）。
 */
interface RegistryEntry {
    id: string;
    path: string;
    group: string;
    needs_db: boolean;
}

/**
 * 读取真 runner 源码（静态契约断言用，不执行）。
 * @returns runner 源码文本
 */
function readRunnerSource(): string {
    const abs: string = path.join(repoRoot, runnerRel);
    assert.ok(existsSync(abs), `runner 不存在：${runnerRel}`);
    return readFileSync(abs, 'utf8');
}

/**
 * 直接 exec 真 runner 并返回 stdout（--list 类不断言退出码细节，失败即抛）。
 * @param args 传给 runner 的参数表
 * @returns stdout 文本
 */
function execRunnerStdout(args: string[]): string {
    try {
        const out = execFileSync(process.execPath, [runnerRel, ...args], {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: execTimeoutMs,
            killSignal: 'SIGTERM',
        });
        return String(out);
    } catch (err) {
        const status: unknown = (err as { status?: unknown }).status;
        const code: unknown = (err as { code?: unknown }).code;
        const stdout: string = String((err as { stdout?: unknown }).stdout ?? '');
        const stderr: string = String((err as { stderr?: unknown }).stderr ?? '');
        assert.fail(
            `exec 真 runner 失败 args=${JSON.stringify(args)} status=${String(status)} code=${String(code)} ` +
            `stdout头=${stdout.slice(0, 300)} stderr头=${stderr.slice(0, 300)}`,
        );
    }
}

/**
 * 直接 exec 真 runner 并断言 exit 2（未知参数/非法值，参数校验阶段不建库）。
 * @param args 传给 runner 的参数表
 * @param label 用例标签（失败信息用）
 */
function expectRunnerExit2(args: string[], label: string): void {
    let status: number | null | undefined;
    let code: unknown;
    let stdoutHead: string = '';
    let stderrHead: string = '';
    try {
        execFileSync(process.execPath, [runnerRel, ...args], {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: execTimeoutMs,
            killSignal: 'SIGTERM',
        });
        assert.fail(`${label} 应 exit 2，实际 exit 0：args=${JSON.stringify(args)}`);
    } catch (err) {
        const e = err as { status?: number | null; code?: unknown; stdout?: unknown; stderr?: unknown };
        // 中文注释：assert.fail 抛出的断言错误直接透传（保持“应 exit 2 而 exit 0”的原意）。
        if (e.code === 'ERR_ASSERTION' || /应 exit 2，实际 exit 0/.test(String((e as Error).message))) {
            throw err;
        }
        status = e.status;
        code = e.code;
        stdoutHead = String(e.stdout ?? '').slice(0, 200);
        stderrHead = String(e.stderr ?? '').slice(0, 200);
    }
    assert.strictEqual(
        status,
        2,
        `${label} 应 exit 2，实际 status=${String(status)} code=${String(code)} ` +
        `stdout头=${stdoutHead} stderr头=${stderrHead}`,
    );
    console.log(`PASS: ${label} exit 2`);
}

/**
 * 解析 --list 输出为注册表数组（非 JSON/非数组即 RED）。
 * @param extra --list 之外的过滤参数
 * @returns 注册表条目数组
 */
function listRegistry(extra: string[] = []): RegistryEntry[] {
    const stdout: string = execRunnerStdout(['--list', ...extra]);
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        assert.fail(`--list 应输出纯 JSON，实际头=${stdout.slice(0, 300)} extra=${JSON.stringify(extra)}`);
    }
    assert.ok(Array.isArray(parsed), `--list 应输出 JSON 数组，实际=${typeof parsed}`);
    return parsed as RegistryEntry[];
}

/**
 * 断言单条注册表条目字段完备。
 * @param entry 注册表条目
 * @param index 下标（失败信息用）
 */
function assertRegistryEntryShape(entry: RegistryEntry, index: number): void {
    assert.strictEqual(typeof entry.id, 'string', `条目${index} 缺 id`);
    assert.ok(entry.id.length > 0, `条目${index} id 为空`);
    assert.strictEqual(typeof entry.path, 'string', `条目${index} 缺 path`);
    assert.ok(entry.path.endsWith('.ts'), `条目${index} path 应为 .ts：${entry.path}`);
    assert.strictEqual(typeof entry.group, 'string', `条目${index} 缺 group`);
    assert.ok(allowedGroups.includes(entry.group), `条目${index} group 非法：${entry.group}`);
    assert.strictEqual(typeof entry.needs_db, 'boolean', `条目${index} 缺 needs_db 布尔`);
}

/**
 * 用例①：--list 输出 JSON，41 套件且含 id/path/group/needs_db。
 */
function caseListJson41(): void {
    const entries: RegistryEntry[] = listRegistry();
    assert.strictEqual(entries.length, expectedSuiteCount, `--list 应含 ${expectedSuiteCount} 套件，实际 ${entries.length}`);
    entries.forEach((e, i) => assertRegistryEntryShape(e, i));
    const ids: string[] = entries.map((e) => e.id);
    assert.ok(ids.includes(knownToolingSuiteId), `--list 应含已知 tooling 套件 ${knownToolingSuiteId}`);
    const toolingEntry: RegistryEntry | undefined = entries.find((e) => e.id === knownToolingSuiteId);
    assert.ok(
        toolingEntry !== undefined && toolingEntry.path.endsWith(knownToolingPathSuffix),
        `tooling 套件 path 应以后缀结尾：${knownToolingPathSuffix}`,
    );
    assert.strictEqual(toolingEntry?.group, 'tooling', '已知套件应归 tooling 组');
    console.log('PASS: 用例① --list JSON 41 套件字段完备');
}

/**
 * 用例②：--group tooling / --suite <id> 选择正确（经 --list 过滤子集，不执行）。
 */
function caseGroupSuiteFilter(): void {
    const toolingOnly: RegistryEntry[] = listRegistry(['--group', 'tooling']);
    assert.ok(toolingOnly.length >= 1, '--group tooling 应至少选中 1 套件');
    assert.ok(toolingOnly.length < expectedSuiteCount, '--group tooling 应为真子集（过滤生效）');
    for (const e of toolingOnly) {
        assertRegistryEntryShape(e, 0);
        assert.strictEqual(e.group, 'tooling', `--group tooling 混入非 tooling：${e.id}/${e.group}`);
    }
    assert.ok(
        toolingOnly.some((e) => e.id === knownToolingSuiteId),
        '--group tooling 应含已知 tooling 套件',
    );
    const single: RegistryEntry[] = listRegistry(['--suite', knownToolingSuiteId]);
    assert.strictEqual(single.length, 1, `--suite 应精确选中 1 条，实际 ${single.length}`);
    assert.strictEqual(single[0].id, knownToolingSuiteId, '--suite 选中 ID 不符');
    assertRegistryEntryShape(single[0], 0);
    console.log('PASS: 用例② --group/--suite 选择正确');
}

/**
 * 用例③：未知参数与非法值 exit 2（直接 exec 真 runner）。
 */
function caseUnknownAndIllegalExit2(): void {
    expectRunnerExit2(['--no-such-flag'], '未知参数');
    expectRunnerExit2(['--group', 'no-such-group'], '非法 group');
    expectRunnerExit2(['--suite', 'no-such-suite-id'], '非法 suite');
    expectRunnerExit2(['--group', 'tooling', '--suite', 'test-sec-01'], '空交集');
    console.log('PASS: 用例③ 未知参数与非法值 exit 2');
}

/**
 * 用例④：unit 组子进程 env 无 DATABASE_URL（对现有 runner 行为断言）。
 * 现状 buildControlledEnv 对全组统一注入 → 断言失败=RED。
 */
function caseUnitEnvNoDatabaseUrl(): void {
    const src: string = readRunnerSource();
    assert.ok(src.includes('needs_db'), 'runner 应有 needs_db 注册表（按需建库）');
    const hasUnitStrip: boolean =
        /group\s*===?\s*['"]unit['"]/.test(src) && /delete\s+.*DATABASE_URL/.test(src);
    const hasNeedsDbGuard: boolean =
        /needs_db\s*===?\s*false/.test(src) && /delete\s+.*DATABASE_URL/.test(src);
    assert.ok(
        hasUnitStrip || hasNeedsDbGuard,
        'unit 组应剥离 DATABASE_URL（按 group==unit 或 needs_db==false 删除），现状全组注入=RED',
    );
    console.log('PASS: 用例④ unit env 无 DATABASE_URL');
}

/**
 * 用例⑤：unit 文件 import lib/db 扫描命中 exit 3（静态扫描契约）。
 * 现状 runner 无 lib/db 扫描 → 断言失败=RED。
 */
function caseUnitImportLibDbScanExit3(): void {
    const src: string = readRunnerSource();
    assert.ok(src.includes('lib/db'), 'runner 应含 lib/db 静态扫描（禁 unit 导入）');
    const hasScanExit3: boolean =
        /lib\/db/.test(src) && /(BOOTSTRAP_EXIT_CODE|exit\s*\(\s*3\s*\))/.test(src);
    assert.ok(hasScanExit3, 'unit 命中 lib/db 导入应 exit 3，现状无扫描=RED');
    console.log('PASS: 用例⑤ unit import lib/db 命中 exit 3');
}

/**
 * 用例⑥：注册表 path 与磁盘一致（现状纯字符串数组无 group/needs_db → 失败=RED）。
 */
function caseRegistryPathDiskConsistent(): void {
    const src: string = readRunnerSource();
    assert.ok(src.includes('needs_db') && src.includes('group'), '注册表应含 group/needs_db 字段');
    const quoted: string[] = [...src.matchAll(/['"]((?:\.\/)?tests\/[^'"]+\.ts)['"]/g)].map((m) => m[1]);
    const uniq: string[] = [...new Set(quoted)];
    assert.ok(uniq.length >= expectedSuiteCount, `注册表应至少 ${expectedSuiteCount} 路径，实际 ${uniq.length}`);
    const missing: string[] = uniq.filter((p) => !existsSync(path.join(repoRoot, p.replace(/^\.\//, ''))));
    assert.deepStrictEqual(missing, [], `注册表 path 应全部落盘，缺失：${missing.slice(0, 5).join(',')}`);
    console.log('PASS: 用例⑥ 注册表 path 与磁盘一致');
}

/**
 * 校验单行 results.jsonl 套件级结构（suite 标识 + 状态/退出码）。
 * @param obj 待验行对象
 */
function assertResultsJsonlLine(obj: Record<string, unknown>): void {
    const suite: unknown = obj.suite_id ?? obj.suite ?? obj.id;
    assert.strictEqual(typeof suite, 'string', 'jsonl 行缺 suite 标识（suite_id/suite/id）');
    assert.ok((suite as string).length > 0, 'jsonl 行 suite 标识为空');
    const hasStatus: boolean = typeof obj.status === 'string';
    const hasExit: boolean = typeof obj.exit_code === 'number' || typeof obj.exitCode === 'number';
    assert.ok(hasStatus || hasExit, 'jsonl 行缺 status/exit_code');
    if (hasStatus) {
        assert.ok(
            ['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'FLAKY'].includes(obj.status as string),
            `jsonl 行 status 非法：${String(obj.status)}`,
        );
    }
}

/**
 * 用例⑦：.e2e-results/<run-id>/results.jsonl 行结构（源码契约 + 行校验器）。
 * 现状 runner 不写 results.jsonl → 断言失败=RED。
 */
function caseResultsJsonlStructure(): void {
    const src: string = readRunnerSource();
    assert.ok(src.includes('results.jsonl'), 'runner 应写 results.jsonl');
    assert.ok(src.includes('.e2e-results'), '结果应落 .e2e-results/<run-id>/results.jsonl');
    // 中文注释：行校验器自举（合成样例须过，证明校验器本身可用；RED 来自源码缺失）。
    assertResultsJsonlLine({ suite_id: knownToolingSuiteId, group: 'tooling', status: 'PASS', exit_code: 0 });
    assert.throws(() => assertResultsJsonlLine({ suite_id: '', status: 'PASS' }), /标识为空/);
    assert.throws(() => assertResultsJsonlLine({ suite_id: 'x' }), /缺 status/);
    console.log('PASS: 用例⑦ results.jsonl 行结构');
}

/**
 * 测试入口：顺序执行①-⑦，任一 RED 即抛（jiti/await default 透出非零）。
 */
async function main(): Promise<void> {
    caseListJson41();
    caseGroupSuiteFilter();
    caseUnknownAndIllegalExit2();
    caseUnitEnvNoDatabaseUrl();
    caseUnitImportLibDbScanExit3();
    caseRegistryPathDiskConsistent();
    caseResultsJsonlStructure();
    console.log('ALL RUNNER GROUP SPLIT TESTS PASSED');
}

export default main();
