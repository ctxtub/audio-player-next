import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * 证据 schema v1 tooling 测试（WS5/C5，TDD：先 RED 后 GREEN）。
 *
 * 覆盖 spec §WS5 全部验收标准：
 * 1. v1 JSON Schema 正负例：缺 assertion_id / surface 与 catalog 不一致 /
 *    非法 verdict / 缺 evidence_path 全部被拒；
 * 2. Node 样例行与浏览器样例行用同一校验器（scripts/evidence-schema.mjs）
 *    做 join 断言：错配 case_id/executable_id/assertion_id、
 *    executable_id 不在该 case 的 executable_ids、surface 不一致 → 全拒；
 * 3. 真实 reporter 接线：bound 的 L3 scenario 产出可 join 行；
 *    无绑定的 smoke spec 产出 BLOCKED(reason=no-catalog-binding) 且不编造 case_id；
 * 4. CLI --check 正负例（exit 0 / 非零）；
 * 5. 真实 catalog 抽查：至少一条 case 可 join 到 executable 与 assertion。
 *
 * 口径：只跑 node 子进程 + tmp 写 + 只读真实 catalog，不触 DB/网络/浏览器；
 * needs_db=false 叶子套件。
 */

// 中文注释：仓库根（validator/schema/catalog 均以 cwd 为仓库根解析）。
const repoRoot: string = process.cwd();
// 中文注释：被测 validator 与 schema 文档绝对路径。
const validatorAbs: string = path.join(repoRoot, 'scripts', 'evidence-schema.mjs');
const schemaAbs: string = path.join(repoRoot, 'docs', 'testing', 'execution', 'evidence-schema.v1.json');
// 中文注释：harness 目录（reporter 接线用例用）。
const harnessDir: string = path.join(repoRoot, 'tests', 'system', 'browser', 'harness');
// 中文注释：子进程上限毫秒（validator 为纯本地校验，瞬时返回）。
const execTimeoutMs: number = 15000;

// 中文注释：Node 正例三元组（真实 catalog：guest-identity-cookie-upgrade ×
// exec-guest-cookie-authorization(L2) × guest-row-persisted(surface=db)）。
const nodeGood = {
    schema_version: 1,
    kind: 'assertion',
    run_id: 'tooling-evidence-run',
    case_id: 'guest-identity-cookie-upgrade',
    executable_id: 'exec-guest-cookie-authorization',
    assertion_id: 'guest-row-persisted',
    surface: 'db',
    verdict: 'PASS',
    evidence_path: '.e2e-results/tooling-evidence-run/guest-cookie-authorization',
};

// 中文注释：浏览器正例三元组（真实 catalog：streaming-resubmit-mutex ×
// exec-l3-reject-second-submit-while-streaming(L3) ×
// second-submit-rejected-while-streaming(surface=ui，被 evidence_surfaces [ui, network] 覆盖)）。
const browserGood = {
    schema_version: 1,
    kind: 'assertion',
    run_id: 'tooling-evidence-run',
    case_id: 'streaming-resubmit-mutex',
    executable_id: 'exec-l3-reject-second-submit-while-streaming',
    assertion_id: 'second-submit-rejected-while-streaming',
    surface: 'ui',
    verdict: 'PASS',
    evidence_path: '.e2e-results/browser/tooling-evidence-run/streaming-resubmit-mutex/chromium',
    browser: 'chromium',
};

/** validator 模块形态（GREEN 定稿接口；RED 空壳缺正例能力）。 */
interface EvidenceValidator {
    validateRow: (row: unknown, catalog?: unknown) => { ok: boolean; errors: string[] };
    loadEvidenceCatalog: (root?: string) => unknown;
}

/**
 * 动态导入被测 validator（每次现取，避免跨用例缓存干扰）。
 */
async function loadValidator(): Promise<EvidenceValidator> {
    const mod = (await import(validatorAbs)) as unknown as Record<string, unknown>;
    assert.strictEqual(typeof mod['validateRow'], 'function', 'validator 必须导出 validateRow');
    assert.strictEqual(typeof mod['loadEvidenceCatalog'], 'function', 'validator 必须导出 loadEvidenceCatalog');
    return mod as unknown as EvidenceValidator;
}

/**
 * 用例 1：schema 文档结构（v1 字段清单齐全，旧字段保留为可选透传）。
 */
async function caseSchemaDoc(): Promise<void> {
    const raw: string = readFileSync(schemaAbs, 'utf8');
    const doc = JSON.parse(raw) as Record<string, unknown>;
    assert.strictEqual(doc['version'], 1, 'schema 文档 version 须为 1');
    const props = doc['properties'] as Record<string, unknown>;
    for (const key of [
        'schema_version',
        'kind',
        'run_id',
        'case_id',
        'executable_id',
        'assertion_id',
        'surface',
        'verdict',
        'evidence_path',
    ]) {
        assert.ok(props && key in props, `schema 文档缺字段声明：${key}`);
    }
    const required = doc['required'] as unknown;
    assert.ok(Array.isArray(required) && (required as unknown[]).includes('schema_version'), 'schema 文档必须声明 schema_version 必填');
    const legacy = (doc['legacy_passthrough'] ?? doc['legacyPassthrough'] ?? []) as unknown;
    assert.ok(
        Array.isArray(legacy) && (legacy as unknown[]).includes('suite_id') && (legacy as unknown[]).includes('exit_code'),
        'schema 文档必须声明旧字段 suite_id/exit_code 为可选透传（不得删除）',
    );
    console.log('PASS: schema 文档结构合法（v1 字段 + 旧字段透传声明）');
}

/**
 * 用例 2：Node 正例行通过同一校验器。
 */
async function caseNodeGood(): Promise<void> {
    const v: EvidenceValidator = await loadValidator();
    const catalog: unknown = v.loadEvidenceCatalog(repoRoot);
    const res = v.validateRow({ ...nodeGood }, catalog);
    assert.strictEqual(res.ok, true, `Node 正例行应通过，实际 errors=${JSON.stringify(res.errors)}`);
    console.log('PASS: Node 正例行通过校验');
}

/**
 * 用例 3：浏览器正例行通过同一校验器（与用例 2 同一模块实例口径）。
 */
async function caseBrowserGood(): Promise<void> {
    const v: EvidenceValidator = await loadValidator();
    const catalog: unknown = v.loadEvidenceCatalog(repoRoot);
    const res = v.validateRow({ ...browserGood }, catalog);
    assert.strictEqual(res.ok, true, `浏览器正例行应通过，实际 errors=${JSON.stringify(res.errors)}`);
    console.log('PASS: 浏览器正例行通过校验');
}

/**
 * 负例表（spec §WS5 验收：全部被拒）。
 * 每个条目：名义 + 改动函数 + 期望的错误关键字子串。
 */
const negativeCases: Array<{ name: string; mutate: (row: Record<string, unknown>) => void; want: string }> = [
    {
        name: 'missing-assertion-id',
        mutate: (r) => {
            delete r['assertion_id'];
        },
        want: 'assertion_id',
    },
    {
        name: 'surface-mismatch',
        mutate: (r) => {
            r['surface'] = 'ui';
        },
        want: 'surface',
    },
    {
        name: 'illegal-verdict',
        mutate: (r) => {
            r['verdict'] = 'PASSED';
        },
        want: 'verdict',
    },
    {
        name: 'missing-evidence-path',
        mutate: (r) => {
            delete r['evidence_path'];
        },
        want: 'evidence_path',
    },
    {
        name: 'assertion-from-other-case',
        mutate: (r) => {
            // 中文注释：single-submit-on-burst 属于 rapid-double-submit-guard，不属于 streaming-resubmit-mutex。
            r['case_id'] = 'streaming-resubmit-mutex';
            r['executable_id'] = 'exec-l3-reject-second-submit-while-streaming';
            r['assertion_id'] = 'single-submit-on-burst';
            r['surface'] = 'network';
        },
        want: 'assertion_id',
    },
    {
        name: 'executable-not-in-case',
        mutate: (r) => {
            // 中文注释：exec-session-roundtrip 只绑定 anon-guest-route-guard-open-redirect，不在 guest-identity-cookie-upgrade。
            r['case_id'] = 'guest-identity-cookie-upgrade';
            r['executable_id'] = 'exec-session-roundtrip';
            r['assertion_id'] = 'guest-row-persisted';
            r['surface'] = 'db';
        },
        want: 'executable_id',
    },
    {
        name: 'unknown-case',
        mutate: (r) => {
            r['case_id'] = 'no-such-case-in-catalog';
        },
        want: 'case_id',
    },
    {
        name: 'missing-schema-version',
        mutate: (r) => {
            delete r['schema_version'];
        },
        want: 'schema_version',
    },
];

/**
 * 用例 4：v1 负例在 Node 行与浏览器行上用同一校验器全部被拒。
 */
async function caseNegatives(): Promise<void> {
    const v: EvidenceValidator = await loadValidator();
    const catalog: unknown = v.loadEvidenceCatalog(repoRoot);
    for (const n of negativeCases) {
        for (const [label, base] of [
            ['node', nodeGood],
            ['browser', browserGood],
        ] as const) {
            const row: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
            // 中文注释：browser 基行 surface 为 ui；surface-mismatch 负例统一改成非法值 audio-does-not-match。
            if (n.name === 'surface-mismatch') {
                row['surface'] = 'audio-does-not-match';
            } else {
                n.mutate(row);
            }
            const res = v.validateRow(row, catalog);
            assert.strictEqual(res.ok, false, `负例 ${n.name}（${label} 行）应被拒`);
            assert.ok(
                res.errors.some((e) => e.includes(n.want)),
                `负例 ${n.name}（${label} 行）错误须提及 ${n.want}，实际=${JSON.stringify(res.errors)}`,
            );
        }
    }
    console.log(`PASS: ${negativeCases.length} 负例 × Node/浏览器双行全部被同一校验器拒绝`);
}

/**
 * 用例 5：真实 reporter 接线——bound 的 L3 scenario 产出可 join 行。
 * 用伪造 test/result 直调 reporter（含真实 location.file），行须过同一校验器，
 * 且 executable_id/case_id/assertion 须 join 到 catalog。
 */
async function caseReporterBoundJoin(): Promise<void> {
    const v: EvidenceValidator = await loadValidator();
    const catalog: unknown = v.loadEvidenceCatalog(repoRoot);
    const mod = (await import(path.join(harnessDir, 'jsonl-reporter.ts'))) as unknown as Record<string, unknown>;
    assert.strictEqual(typeof mod['default'], 'function', 'jsonl-reporter 须默认导出 Reporter 类');
    const Reporter = mod['default'] as new (opts?: { resultsRoot?: string; runId?: string }) => {
        onBegin?: (config: unknown, suite: unknown) => void;
        onTestEnd?: (test: unknown, result: unknown) => void;
    };
    const tmpRoot: string = mkdtempSync(path.join(repoRoot, '.e2e-results', 'tooling-bound-'));
    const runId = 'tooling-bound-run';
    try {
        const reporter = new Reporter({ resultsRoot: tmpRoot, runId });
        reporter.onBegin?.({}, { title: 'root' });
        const specAbs: string = path.join(repoRoot, 'tests', 'system', 'browser', 'scenarios', 'reject-second-submit-while-streaming.spec.ts');
        reporter.onTestEnd?.(
            {
                title: '流式中第二次提交被拒',
                titlePath: () => ['chromium', 'reject-second-submit-while-streaming.spec.ts', '流式中第二次提交被拒'],
                outcome: () => 'expected',
                location: { file: specAbs, line: 16, column: 1 },
            },
            { status: 'passed', duration: 4321, retry: 0 },
        );
        const text: string = readFileSync(path.join(tmpRoot, runId, 'results.jsonl'), 'utf8');
        const rows = text
            .split('\n')
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l) as Record<string, unknown>);
        assert.ok(rows.length >= 1, 'bound scenario 须至少产出一行');
        let joined = 0;
        for (const row of rows) {
            const res = v.validateRow(row, catalog);
            assert.strictEqual(res.ok, true, `reporter 行须过校验，实际 errors=${JSON.stringify(res.errors)} 行=${JSON.stringify(row)}`);
            if (row['kind'] === 'assertion' && row['executable_id'] === 'exec-l3-reject-second-submit-while-streaming') {
                joined += 1;
            }
        }
        assert.ok(joined >= 1, '至少一行须 join 到 exec-l3-reject-second-submit-while-streaming');
        console.log(`PASS: reporter 对 bound scenario 产出 ${rows.length} 行且全部过校验（join ${joined} 行）`);
    } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
}

/**
 * 用例 6：无绑定 spec（smoke.spec.ts）必须记 BLOCKED(reason=no-catalog-binding)，
 * 且不得编造 case_id / 不得伪造 PASS。
 */
async function caseReporterUnboundBlocked(): Promise<void> {
    const v: EvidenceValidator = await loadValidator();
    const catalog: unknown = v.loadEvidenceCatalog(repoRoot);
    const mod = (await import(path.join(harnessDir, 'jsonl-reporter.ts'))) as unknown as Record<string, unknown>;
    const Reporter = mod['default'] as new (opts?: { resultsRoot?: string; runId?: string }) => {
        onBegin?: (config: unknown, suite: unknown) => void;
        onTestEnd?: (test: unknown, result: unknown) => void;
    };
    const tmpRoot: string = mkdtempSync(path.join(repoRoot, '.e2e-results', 'tooling-unbound-'));
    const runId = 'tooling-unbound-run';
    try {
        const reporter = new Reporter({ resultsRoot: tmpRoot, runId });
        reporter.onBegin?.({}, { title: 'root' });
        const specAbs: string = path.join(repoRoot, 'tests', 'system', 'browser', 'smoke.spec.ts');
        reporter.onTestEnd?.(
            {
                title: 'production 首屏 200 可达',
                titlePath: () => ['chromium', 'smoke.spec.ts', 'production 首屏 200 可达'],
                outcome: () => 'expected',
                location: { file: specAbs, line: 17, column: 1 },
            },
            { status: 'passed', duration: 375, retry: 0 },
        );
        const text: string = readFileSync(path.join(tmpRoot, runId, 'results.jsonl'), 'utf8');
        const rows = text
            .split('\n')
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l) as Record<string, unknown>);
        assert.strictEqual(rows.length, 1, '无绑定 spec 单用例须恰产出一行');
        const row = rows[0] as Record<string, unknown>;
        assert.strictEqual(row['verdict'], 'BLOCKED', '无绑定行必须记 BLOCKED（即使测试本身 passed）');
        assert.strictEqual(row['reason'], 'no-catalog-binding', '无绑定行必须注明 reason=no-catalog-binding');
        assert.ok(!('case_id' in row) || row['case_id'] === undefined || row['case_id'] === null, '无绑定行不得编造 case_id');
        const res = v.validateRow(row, catalog);
        assert.strictEqual(res.ok, true, `BLOCKED 行本身须过校验，实际 errors=${JSON.stringify(res.errors)}`);
        console.log('PASS: 无绑定 spec 诚实记 BLOCKED(no-catalog-binding) 且行合法');
    } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
}

/**
 * 跑 --check 子进程并返回结果（不抛，由调用方断言）。
 */
function runCheck(args: string[]): { status: number; stdout: string; stderr: string } {
    try {
        const stdout = execFileSync(process.execPath, [validatorAbs, ...args], {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: execTimeoutMs,
        }) as unknown as string;
        return { status: 0, stdout: String(stdout), stderr: '' };
    } catch (err) {
        const e = err as { status?: unknown; stdout?: unknown; stderr?: unknown };
        return {
            status: typeof e.status === 'number' ? e.status : 1,
            stdout: String(e.stdout ?? ''),
            stderr: String(e.stderr ?? ''),
        };
    }
}

/**
 * 用例 7：CLI --check 正例 exit 0、负例非零。
 */
async function caseCliCheck(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'evidence-cli-'));
    try {
        const goodFile: string = path.join(dir, 'good.jsonl');
        writeFileSync(
            goodFile,
            `${JSON.stringify({ ...nodeGood })}\n${JSON.stringify({
                schema_version: 1,
                kind: 'summary',
                run_id: 'tooling-evidence-run',
                verdict: 'PASS',
                evidence_path: '.e2e-results/tooling-evidence-run/guest-cookie-authorization',
                case_ids: ['guest-identity-cookie-upgrade'],
            })}\n`,
        );
        const good = runCheck(['--check', goodFile]);
        assert.strictEqual(good.status, 0, `--check 正例应 exit 0，实际=${good.status} stderr=${good.stderr.slice(0, 300)}`);
        const badFile: string = path.join(dir, 'bad.jsonl');
        writeFileSync(badFile, `${JSON.stringify({ ...nodeGood, surface: 'audio-does-not-match' })}\n`);
        const bad = runCheck(['--check', badFile]);
        assert.notStrictEqual(bad.status, 0, '--check 负例（surface 错配）应非零退出');
        console.log('PASS: CLI --check 正例 exit 0 / 负例非零');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 用例 8：真实 catalog 抽查——guest-identity-cookie-upgrade 可 join 到
 * executable 与 assertion（Node 侧实证锚点）。
 */
async function caseRealCatalogSpot(): Promise<void> {
    const v: EvidenceValidator = await loadValidator();
    const catalog = v.loadEvidenceCatalog(repoRoot) as unknown as {
        cases: Map<string, { executable_ids: string[]; required_assertions: Array<{ assertion_id: string; surface: string }> }>;
        executables: Map<string, { case_ids: string[]; layer: string }>;
    };
    const c = catalog.cases.get('guest-identity-cookie-upgrade');
    assert.ok(c, 'catalog 须含 guest-identity-cookie-upgrade');
    assert.ok(c.executable_ids.includes('exec-guest-cookie-authorization'), 'case 须绑定 exec-guest-cookie-authorization');
    assert.ok(
        c.required_assertions.some((a) => a.assertion_id === 'guest-row-persisted' && a.surface === 'db'),
        'case 须含 assertion guest-row-persisted(surface=db)',
    );
    const e = catalog.executables.get('exec-guest-cookie-authorization');
    assert.ok(e && e.case_ids.includes('guest-identity-cookie-upgrade'), 'executable 反向须含该 case');
    console.log('PASS: 真实 catalog 抽查 join 成立（guest-identity-cookie-upgrade ↔ exec-guest-cookie-authorization ↔ guest-row-persisted）');
}

/**
 * 测试入口：顺序执行全部用例。
 */
async function main(): Promise<void> {
    await caseSchemaDoc();
    await caseNodeGood();
    await caseBrowserGood();
    await caseNegatives();
    await caseReporterBoundJoin();
    await caseReporterUnboundBlocked();
    await caseCliCheck();
    await caseRealCatalogSpot();
}

export default main();
