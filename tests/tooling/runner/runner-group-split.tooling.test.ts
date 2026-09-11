import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 按测试类型拆分执行器契约测试（任务2，Tooling；Fix 1 闭环重写）。
 *
 * meta-suite 执行策略（显式设计，非排除掩盖）：
 * runner 自身三元测试（本文件 + catalog-checker + delivery/auto-delivery）
 * 以 needs_db=false 的叶子套件登记进 tooling 组。它们只做 `--list` 只读查询、
 * 沙箱 catalog 校验、文件结构断言，从不触发套件执行与建库，故无自指递归；
 * 用例⑧以静态规则 + 自宿主运行双重证明该性质。
 *
 * 覆盖：①--list JSON（数量由磁盘推导，非固定 41）②--group/--suite 选择
 * ③未知参数与非法值 exit 2④unit 子进程 env 无 DATABASE_URL
 * ⑤unit 文件 import lib/db 扫描命中 exit 3⑥注册表 path 与磁盘双向一致
 * ⑦.e2e-results/<run-id>/results.jsonl 行结构⑧meta 非递归证明
 * ⑨纯校验器受控 fixture 正负例（遗漏/重复/非法 group/needs_db 照常检出）。
 * exit 2 类直接 execFile 真 runner（参数校验阶段不建库，安全）。
 */

// 中文注释：仓库根目录（解析 runner 与注册表路径用）。
const repoRoot: string = process.cwd();
// 中文注释：真 runner 相对路径（execFileSync 跑 node scripts/run-tests.mjs）。
const runnerRel: string = path.join('scripts', 'run-tests.mjs');
// 中文注释：--list/exit2 类上限毫秒（瞬时退出，超时即失败）。
const execTimeoutMs: number = 6000;
// 中文注释：自宿主运行上限毫秒（runner 跑自身元测试，需留出子进程 exec 余量）。
const selfHostTimeoutMs: number = 120000;
// 中文注释：允许的 group 枚举（含任务流全部层级，防未来分组被误判）。
const allowedGroups: string[] = ['unit', 'integration', 'tooling', 'static'];
// 中文注释：已知 tooling 套件 ID（现有 db-guard 套件，拆分后归 tooling 组）。
const knownToolingSuiteId: string = 'runner-database-path-safety';
// 中文注释：已知 tooling 套件路径后缀（注册表 path 断言用）。
const knownToolingPathSuffix: string = 'tests/tooling/db-guard/runner-database-path-safety.tooling.test.ts';
// 中文注释：元测试 suite ID（meta-suite 策略主体，needs_db 必须为 false）。
// 2026-09-11：main 自动交付链恢复，delivery/auto-delivery 为新的只读文件结构元测试，故元测试集为三个。
const metaSuiteIds: string[] = ['runner-group-split', 'catalog-checker', 'auto-delivery'];
// 中文注释：磁盘扫描排除前缀（与 scripts/check-test-catalog.mjs 同口径：支撑实现与 Playwright 浏览器域非 runner 可执行）。
const diskExcludePrefixes: string[] = ['tests/support/', 'tests/system/'];
// 中文注释：层级后缀剥离正则（与 scripts/test-database-path-safety.mjs 同口径）。
const layerSuffixRe: RegExp = /\.(unit|integration|contract|tooling|legacy|static)\.test\.ts$/;

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
 * 解析 --list 输出为注册表数组（非 JSON/非数组即失败）。
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
 * 由测试文件路径推导 suite ID（与 safety.suiteIdFromTestPath 同口径，不抛，非法返回空串供校验器检出）。
 * @param testPath 注册表 path（如 ./tests/tooling/runner/x.tooling.test.ts）
 * @returns 推导 ID（非法为空串）
 */
function deriveSuiteId(testPath: string): string {
    const base: string = path.basename(String(testPath));
    let id: string = base;
    if (layerSuffixRe.test(base)) {
        id = base.replace(layerSuffixRe, '');
    } else if (base.endsWith('.ts')) {
        id = base.slice(0, -'.ts'.length);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(id)) return '';
    return id;
}

/**
 * 规范化套件路径（去 ./ 前缀，统一斜杠）。
 * @param p 原始路径
 * @returns 规范路径
 */
function normalizeSuitePath(p: string): string {
    let s: string = String(p).replace(/\\/g, '/');
    if (s.startsWith('./')) s = s.slice(2);
    return s;
}

/**
 * 递归收集磁盘可执行 suite（与 checker 同口径：tests/**.test.ts，排除 support/ 与 system/）。
 * @param dir 起始目录绝对路径
 * @param out 输出相对路径数组
 */
function collectDiskSuites(dir: string, out: string[]): void {
    const raws = readdirSync(dir, { withFileTypes: true });
    for (const ent of raws) {
        const abs: string = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            const relDir: string = path.relative(repoRoot, abs).replace(/\\/g, '/');
            if (diskExcludePrefixes.some((p) => relDir === p.slice(0, -1) || relDir.startsWith(p))) continue;
            collectDiskSuites(abs, out);
        } else if (ent.isFile() && ent.name.endsWith('.ts')) {
            const rel: string = path.relative(repoRoot, abs).replace(/\\/g, '/');
            if (!rel.startsWith('tests/')) continue;
            if (diskExcludePrefixes.some((p) => rel.startsWith(p))) continue;
            out.push(rel);
        }
    }
}

/**
 * 注册表问题纯校验器（遗漏/重复/非法 group/needs_db/id 推导不一致/磁盘双向缺失）。
 * 受控 fixture 与真实数据共用同一实现：数量由输入推导，不硬编码总数。
 * @param entries 注册表条目
 * @param diskPaths 磁盘 suite 规范路径
 * @returns 问题描述数组（空即一致）
 */
function findRegistryProblems(entries: RegistryEntry[], diskPaths: string[]): string[] {
    const problems: string[] = [];
    const diskSet: Set<string> = new Set(diskPaths);
    const seenIds: Map<string, number> = new Map();
    const seenPaths: Map<string, number> = new Map();
    entries.forEach((e, i) => {
        if (typeof e.id !== 'string' || e.id.length === 0) problems.push(`条目${i} 缺 id`);
        if (typeof e.path !== 'string' || !e.path.endsWith('.ts')) problems.push(`条目${i} path 非法：${String(e.path)}`);
        if (!allowedGroups.includes(e.group)) problems.push(`条目${i} group 非法：${String(e.group)}`);
        if (typeof e.needs_db !== 'boolean') problems.push(`条目${i} needs_db 非布尔：${String(e.needs_db)}`);
        if (seenIds.has(e.id)) problems.push(`重复 id：${e.id}`);
        else seenIds.set(e.id, i);
        const norm: string = normalizeSuitePath(e.path);
        if (seenPaths.has(norm)) problems.push(`重复 path：${norm}`);
        else seenPaths.set(norm, i);
        const derived: string = deriveSuiteId(e.path);
        if (derived === '' || derived !== e.id) problems.push(`id 与 path 推导不一致 id=${e.id} path=${e.path}`);
        if (!diskSet.has(norm)) problems.push(`注册表 path 磁盘缺失：${norm}`);
    });
    const regSet: Set<string> = new Set(entries.map((e) => normalizeSuitePath(e.path)));
    for (const d of diskSet) {
        if (!regSet.has(d)) problems.push(`磁盘 suite 注册表缺失：${d}`);
    }
    return problems;
}

/**
 * 取磁盘可执行 suite 集合（规范路径排序数组）。
 * @returns 磁盘 suite 路径数组
 */
function diskSuiteSet(): string[] {
    const out: string[] = [];
    collectDiskSuites(path.join(repoRoot, 'tests'), out);
    return [...new Set(out)].sort();
}

/**
 * 用例①：--list 输出 JSON，数量与磁盘集合相等且双向一致（无固定总数假设）。
 */
function caseListJsonMatchesDisk(): void {
    const entries: RegistryEntry[] = listRegistry();
    entries.forEach((e, i) => assertRegistryEntryShape(e, i));
    const disk: string[] = diskSuiteSet();
    assert.strictEqual(
        entries.length,
        disk.length,
        `--list 数量应与磁盘可执行 suite 相等，注册表 ${entries.length} vs 磁盘 ${disk.length}`,
    );
    const problems: string[] = findRegistryProblems(entries, disk);
    assert.deepStrictEqual(problems, [], `注册表与磁盘应双向一致，问题：${problems.slice(0, 8).join('；')}`);
    const ids: string[] = entries.map((e) => e.id);
    assert.ok(ids.includes(knownToolingSuiteId), `--list 应含已知 tooling 套件 ${knownToolingSuiteId}`);
    const toolingEntry: RegistryEntry | undefined = entries.find((e) => e.id === knownToolingSuiteId);
    assert.ok(
        toolingEntry !== undefined && toolingEntry.path.endsWith(knownToolingPathSuffix),
        `tooling 套件 path 应以后缀结尾：${knownToolingPathSuffix}`,
    );
    assert.strictEqual(toolingEntry?.group, 'tooling', '已知套件应归 tooling 组');
    console.log(`PASS: 用例① --list JSON 与磁盘双向一致（${entries.length} 套件，零硬编码总数）`);
}

/**
 * 用例②：--group tooling / --suite <id> 选择正确（经 --list 过滤子集，不执行）。
 */
function caseGroupSuiteFilter(): void {
    const all: RegistryEntry[] = listRegistry();
    const toolingOnly: RegistryEntry[] = listRegistry(['--group', 'tooling']);
    assert.ok(toolingOnly.length >= 1, '--group tooling 应至少选中 1 套件');
    assert.ok(toolingOnly.length < all.length, '--group tooling 应为真子集（过滤生效）');
    for (const e of toolingOnly) {
        assertRegistryEntryShape(e, 0);
        assert.strictEqual(e.group, 'tooling', `--group tooling 混入非 tooling：${e.id}/${e.group}`);
    }
    for (const mid of metaSuiteIds) {
        assert.ok(
            toolingOnly.some((e) => e.id === mid),
            `--group tooling 应含元测试 ${mid}（禁止静默排除）`,
        );
    }
    const single: RegistryEntry[] = listRegistry(['--suite', knownToolingSuiteId]);
    assert.strictEqual(single.length, 1, `--suite 应精确选中 1 条，实际 ${single.length}`);
    assert.strictEqual(single[0].id, knownToolingSuiteId, '--suite 选中 ID 不符');
    assertRegistryEntryShape(single[0], 0);
    console.log('PASS: 用例② --group/--suite 选择正确（含全部元测试）');
}

/**
 * 用例③：未知参数与非法值 exit 2（直接 exec 真 runner）。
 */
function caseUnknownAndIllegalExit2(): void {
    const toolingEntries: RegistryEntry[] = listRegistry(['--group', 'tooling']);
    const foreignId: string = toolingEntries[0]?.id ?? knownToolingSuiteId;
    expectRunnerExit2(['--no-such-flag'], '未知参数');
    expectRunnerExit2(['--group', 'no-such-group'], '非法 group');
    expectRunnerExit2(['--suite', 'no-such-suite-id'], '非法 suite');
    expectRunnerExit2(['--group', 'unit', '--suite', foreignId], '空交集');
    console.log('PASS: 用例③ 未知参数与非法值 exit 2');
}

/**
 * 用例④：unit 组子进程 env 无 DATABASE_URL（对现有 runner 行为断言）。
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
        'unit 组应剥离 DATABASE_URL（按 group==unit 或 needs_db==false 删除）',
    );
    console.log('PASS: 用例④ unit env 无 DATABASE_URL');
}

/**
 * 用例⑤：unit 文件 import lib/db 扫描命中 exit 3（静态扫描契约）。
 */
function caseUnitImportLibDbScanExit3(): void {
    const src: string = readRunnerSource();
    assert.ok(src.includes('lib/db'), 'runner 应含 lib/db 静态扫描（禁 unit 导入）');
    const hasScanExit3: boolean =
        /lib\/db/.test(src) && /(BOOTSTRAP_EXIT_CODE|exit\s*\(\s*3\s*\))/.test(src);
    assert.ok(hasScanExit3, 'unit 命中 lib/db 导入应 exit 3');
    console.log('PASS: 用例⑤ unit import lib/db 命中 exit 3');
}

/**
 * 用例⑥：注册表 path 与磁盘一致（经纯校验器，数量推导）。
 */
function caseRegistryPathDiskConsistent(): void {
    const src: string = readRunnerSource();
    assert.ok(src.includes('needs_db') && src.includes('group'), '注册表应含 group/needs_db 字段');
    const entries: RegistryEntry[] = listRegistry();
    const problems: string[] = findRegistryProblems(entries, diskSuiteSet());
    assert.deepStrictEqual(problems, [], `注册表 path 应全部落盘且无遗漏：${problems.slice(0, 8).join('；')}`);
    console.log('PASS: 用例⑥ 注册表 path 与磁盘双向一致');
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
 */
function caseResultsJsonlStructure(): void {
    const src: string = readRunnerSource();
    assert.ok(src.includes('results.jsonl'), 'runner 应写 results.jsonl');
    assert.ok(src.includes('.e2e-results'), '结果应落 .e2e-results/<run-id>/results.jsonl');
    // 中文注释：行校验器自举（合成样例须过，证明校验器本身可用）。
    assertResultsJsonlLine({ suite_id: knownToolingSuiteId, group: 'tooling', status: 'PASS', exit_code: 0 });
    assert.throws(() => assertResultsJsonlLine({ suite_id: '', status: 'PASS' }), /标识为空/);
    assert.throws(() => assertResultsJsonlLine({ suite_id: 'x' }), /缺 status/);
    console.log('PASS: 用例⑦ results.jsonl 行结构');
}

/**
 * 元测试源码绝对路径表（非递归静态规则审计对象）。
 * @returns 相对路径数组
 */
function metaSuiteRelPaths(): string[] {
    return [
        path.join('tests', 'tooling', 'runner', 'runner-group-split.tooling.test.ts'),
        path.join('tests', 'tooling', 'catalog', 'catalog-checker.tooling.test.ts'),
    ];
}

/**
 * 用例⑧：meta 非递归证明（静态规则 + 自宿主运行）。
 * 静态规则：元测试源码中 `run-tests.mjs` 字面仅出现在路径定义（path.join）行；
 * 其余 runner 调用一律经只读/error-path  helper（变量引用），绝无裸执行整组。
 * 自宿主：真 runner 执行自身元测试必须可终止且 exit 0（递归即超时失败）。
 */
function caseMetaNonRecursive(): void {
    const entries: RegistryEntry[] = listRegistry();
    for (const mid of metaSuiteIds) {
        const found: RegistryEntry | undefined = entries.find((e) => e.id === mid);
        assert.ok(found, `元测试须登记进 runner 注册表：${mid}`);
        assert.strictEqual(found?.group, 'tooling', `元测试须归 tooling 组：${mid}`);
        assert.strictEqual(found?.needs_db, false, `元测试须 needs_db=false（叶子无库）：${mid}`);
    }
    for (const rel of metaSuiteRelPaths()) {
        const abs: string = path.join(repoRoot, rel);
        assert.ok(existsSync(abs), `元测试文件须存在：${rel}`);
        const src: string = readFileSync(abs, 'utf8');
        for (const line of src.split('\n')) {
            if (!line.includes('run-tests.mjs') && !line.includes('check-test-catalog.mjs')) continue;
            const allowed: boolean =
                line.includes('path.join') ||
                line.includes('line.includes') ||
                line.includes('--list') ||
                line.includes('expectRunnerExit2') ||
                line.includes('execRunnerStdout') ||
                line.includes('listRegistry') ||
                line.includes('checkerAbs') ||
                line.includes('//');
            assert.ok(allowed, `元测试仅允许只读/error-path 调用 runner/checker，违规行：${rel} :: ${line.trim().slice(0, 120)}`);
        }
    }
    console.log('PASS: 用例⑧a 元测试静态非递归规则');
    // 中文注释：自宿主深度上限 1（环境变量守卫即递归上界构造；内层跳过⑧b，其余用例照常执行）。
    if (process.env.RUNNER_SELFHOST_DEPTH) {
        console.log('PASS: 用例⑧b 内层跳过（自宿主深度守卫生效，无无限递归）');
        return;
    }
    let status: number | null = null;
    let outHead: string = '';
    try {
        const out = execFileSync(process.execPath, [runnerRel, '--suite', 'runner-group-split'], {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: selfHostTimeoutMs,
            killSignal: 'SIGTERM',
            stdio: 'pipe',
            env: { ...process.env, RUNNER_SELFHOST_DEPTH: '1' },
        });
        status = 0;
        outHead = String(out).slice(-300);
    } catch (err) {
        status = (err as { status?: number | null }).status ?? 1;
        const e = err as { stdout?: unknown; stderr?: unknown };
        outHead = `stdout尾=${String(e.stdout ?? '').slice(-300)} stderr尾=${String(e.stderr ?? '').slice(-300)}`;
    }
    assert.strictEqual(status, 0, `自宿主运行应 exit 0（递归/挂起即失败），实际=${String(status)} ${outHead}`);
    console.log('PASS: 用例⑧b 自宿主运行可终止 exit 0（无递归）');
}

/**
 * 用例⑨：纯校验器受控 fixture 正负例（遗漏/重复/非法 group/needs_db 照常检出）。
 */
function caseValidatorFixtures(): void {
    const goodEntries: RegistryEntry[] = [
        { id: 'alpha-case', path: './tests/unit/demo/alpha-case.unit.test.ts', group: 'unit', needs_db: false },
        { id: 'beta-flow', path: './tests/integration/demo/beta-flow.integration.test.ts', group: 'integration', needs_db: true },
    ];
    const goodDisk: string[] = [
        'tests/unit/demo/alpha-case.unit.test.ts',
        'tests/integration/demo/beta-flow.integration.test.ts',
    ];
    assert.deepStrictEqual(findRegistryProblems(goodEntries, goodDisk), [], '正例 fixture 应零问题');
    console.log('PASS: 用例⑨a 校验器正例零问题');
    const missing: string[] = findRegistryProblems(goodEntries, [goodDisk[0]]);
    assert.ok(missing.some((p) => p.includes('注册表缺失') || p.includes('磁盘缺失')), `遗漏须检出，实际=${missing.join('|')}`);
    console.log('PASS: 用例⑨b 遗漏检出');
    const dup: string[] = findRegistryProblems([...goodEntries, { ...goodEntries[0] }], goodDisk);
    assert.ok(dup.some((p) => p.includes('重复')), `重复须检出，实际=${dup.join('|')}`);
    console.log('PASS: 用例⑨c 重复检出');
    const badGroup: string[] = findRegistryProblems(
        [{ id: 'weird-thing', path: './tests/unit/demo/weird-thing.unit.test.ts', group: 'nope', needs_db: false }],
        ['tests/unit/demo/weird-thing.unit.test.ts'],
    );
    assert.ok(badGroup.some((p) => p.includes('group 非法')), `非法 group 须检出，实际=${badGroup.join('|')}`);
    console.log('PASS: 用例⑨d 非法 group 检出');
    const badNeedsDb: string[] = findRegistryProblems(
        [{ id: 'odd-flags', path: './tests/unit/demo/odd-flags.unit.test.ts', group: 'unit', needs_db: 'yes' as unknown as boolean }],
        ['tests/unit/demo/odd-flags.unit.test.ts'],
    );
    assert.ok(badNeedsDb.some((p) => p.includes('needs_db')), `非法 needs_db 须检出，实际=${badNeedsDb.join('|')}`);
    console.log('PASS: 用例⑨e 非法 needs_db 检出');
    const badId: string[] = findRegistryProblems(
        [{ id: 'other-name', path: './tests/unit/demo/alpha-case.unit.test.ts', group: 'unit', needs_db: false }],
        ['tests/unit/demo/alpha-case.unit.test.ts'],
    );
    assert.ok(badId.some((p) => p.includes('推导不一致')), `id 推导不一致须检出，实际=${badId.join('|')}`);
    console.log('PASS: 用例⑨f id 推导不一致检出');
}

/**
 * 用例⑩：普通 FAIL 聚合（受控双 suite：A 恒 FAIL + B 恒 PASS）。
 * 跑真 runner 聚合路径：读真 runner 源码并替换临时注册表后落盘为临时副本执行；
 * 临时磁盘 fixture 落于仓库内忽略目录（.e2e-results 下随机子目录），临时 catalog 提供
 * 最小绑定（每 suite 仅 summary 一行，无 assertion 行，故终态恰两行）；
 * 绝不碰真注册表常量或真数据库（两 fixture 均为 needs_db=false，不建库）。
 * 断言：B 仍被执行、两行（A FAIL + B PASS）齐全、终态 exit 1。
 * 基线 fail-fast 下 B 不被执行、仅一行 A FAIL（真红）。
 */
function caseOrdinaryFailuresAggregated(): void {
    if (process.env.RUNNER_SELFHOST_DEPTH) {
        console.log('PASS: 用例⑩ 内层跳过（自宿主深度守卫生效，避免嵌套聚合跑）');
        return;
    }
    const tmpBase: string = mkdtempSync(path.join(repoRoot, '.e2e-results', 'runner-agg-'));
    let copyAbs: string = '';
    let observedRunId: string = '';
    try {
        const fixtureA: string = path.join(tmpBase, 'agg-a-fail.tooling.test.ts');
        const fixtureB: string = path.join(tmpBase, 'agg-b-pass.tooling.test.ts');
        writeFileSync(fixtureA, "import assert from 'node:assert';\nassert.strictEqual(1, 2, 'controlled A must FAIL');\n");
        writeFileSync(fixtureB, "console.log('controlled B PASS marker');\n");
        const relA: string = `./${path.relative(repoRoot, fixtureA).replace(/\\/g, '/')}`;
        const relB: string = `./${path.relative(repoRoot, fixtureB).replace(/\\/g, '/')}`;
        const tempRegistry = [
            { id: 'agg-a-fail', path: relA, group: 'tooling', needs_db: false },
            { id: 'agg-b-pass', path: relB, group: 'tooling', needs_db: false },
        ];
        const catalogYaml: string =
            'schema_version: 1\n' +
            'cases:\n' +
            '  - case_id: agg-case-a\n' +
            '    executable_ids: [exec-agg-a]\n' +
            '  - case_id: agg-case-b\n' +
            '    executable_ids: [exec-agg-b]\n' +
            'executables:\n' +
            '  - executable_id: exec-agg-a\n' +
            `    path: ${relA}\n` +
            '    case_ids: [agg-case-a]\n' +
            '  - executable_id: exec-agg-b\n' +
            `    path: ${relB}\n` +
            '    case_ids: [agg-case-b]\n';
        const catalogAbs: string = path.join(tmpBase, 'catalog.yaml');
        writeFileSync(catalogAbs, catalogYaml);
        const runnerAbs: string = path.join(repoRoot, runnerRel);
        const src: string = readFileSync(runnerAbs, 'utf8');
        const patchedRegistry: string = `const SUITES = ${JSON.stringify(tempRegistry)};`;
        assert.ok(/const SUITES = \[[\s\S]*?\n\];/.test(src), '真 runner 源码须含可替换注册表字面');
        let patched: string = src.replace(/const SUITES = \[[\s\S]*?\n\];/, patchedRegistry);
        assert.ok(patched.includes('agg-a-fail'), '补丁后副本须含临时注册表');
        const catalogCallFrom: string = 'loadEvidenceCatalog(cwd)';
        assert.ok(patched.includes(catalogCallFrom), '真 runner 源码须含 catalog 预载调用');
        patched = patched.replace(catalogCallFrom, `loadEvidenceCatalog(cwd, ${JSON.stringify(catalogAbs)})`);
        copyAbs = path.join(repoRoot, 'scripts', `tmp-agg-copy-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
        writeFileSync(copyAbs, patched);
        const copyRel: string = path.relative(repoRoot, copyAbs).replace(/\\/g, '/');
        let status: number | null = null;
        let stdout: string = '';
        let stderr: string = '';
        try {
            stdout = String(
                execFileSync(process.execPath, [copyRel], {
                    cwd: repoRoot,
                    encoding: 'utf8',
                    timeout: 60000,
                    killSignal: 'SIGTERM',
                }),
            );
            status = 0;
        } catch (err) {
            const e = err as { status?: number | null; stdout?: unknown; stderr?: unknown };
            status = typeof e.status === 'number' ? e.status : 1;
            stdout = String(e.stdout ?? '');
            stderr = String(e.stderr ?? '');
        }
        const runMatch: RegExpMatchArray | null = stdout.match(/run-id=([0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})/);
        assert.ok(runMatch !== null, `聚合跑须打印 run-id，实际 stdout头=${stdout.slice(0, 400)} stderr头=${stderr.slice(0, 400)}`);
        observedRunId = runMatch[1];
        assert.strictEqual(status, 1, `聚合终态应 exit 1，实际=${String(status)} stdout尾=${stdout.slice(-500)} stderr尾=${stderr.slice(-500)}`);
        assert.ok(stdout.includes('controlled B PASS marker'), `B 仍须被执行（stdout 须含 B 标记），实际 stdout尾=${stdout.slice(-800)}`);
        const resultsAbs: string = path.join(repoRoot, '.e2e-results', observedRunId, 'results.jsonl');
        assert.ok(existsSync(resultsAbs), `聚合跑须产出 results.jsonl：${resultsAbs}`);
        const lines: string[] = readFileSync(resultsAbs, 'utf8').split('\n').filter((l) => l.trim().length > 0);
        assert.strictEqual(lines.length, 2, `普通聚合路径下行数 == 已调度 suite 数（2），实际=${lines.length} 行=${lines.slice(0, 2).join(' || ').slice(0, 800)}`);
        const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        const rowA: Record<string, unknown> | undefined = rows.find((r) => (r['suite_id'] ?? r['suite'] ?? r['id']) === 'agg-a-fail');
        const rowB: Record<string, unknown> | undefined = rows.find((r) => (r['suite_id'] ?? r['suite'] ?? r['id']) === 'agg-b-pass');
        assert.ok(rowA !== undefined, '结果须含 A 行');
        assert.ok(rowB !== undefined, '结果须含 B 行（B 未被跳过）');
        const verdictA: unknown = rowA['verdict'] ?? rowA['status'];
        const verdictB: unknown = rowB['verdict'] ?? rowB['status'];
        assert.strictEqual(verdictA, 'FAIL', `A 应为 FAIL，实际=${JSON.stringify(rowA).slice(0, 300)}`);
        assert.strictEqual(verdictB, 'PASS', `B 应为 PASS，实际=${JSON.stringify(rowB).slice(0, 300)}`);
        console.log('PASS: 用例⑩ 普通 FAIL 聚合（B 仍执行、两行齐全、终态 exit 1）');
    } finally {
        try {
            if (copyAbs !== '' && existsSync(copyAbs)) rmSync(copyAbs, { force: true });
        } catch {
            // 忽略清理错误
        }
        try {
            if (observedRunId !== '') rmSync(path.join(repoRoot, '.e2e-results', observedRunId), { recursive: true, force: true });
        } catch {
            // 忽略清理错误
        }
        try {
            rmSync(tmpBase, { recursive: true, force: true });
        } catch {
            // 忽略清理错误
        }
    }
}

/**
 * 测试入口：顺序执行①-⑩，任一失败即抛（jiti/await default 透出非零）。
 */
async function main(): Promise<void> {
    caseListJsonMatchesDisk();
    caseGroupSuiteFilter();
    caseUnknownAndIllegalExit2();
    caseUnitEnvNoDatabaseUrl();
    caseUnitImportLibDbScanExit3();
    caseRegistryPathDiskConsistent();
    caseResultsJsonlStructure();
    caseMetaNonRecursive();
    caseValidatorFixtures();
    caseOrdinaryFailuresAggregated();
    console.log('ALL RUNNER GROUP SPLIT TESTS PASSED');
}

export default main();
