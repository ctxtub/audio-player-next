import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 治理文档对齐 tooling 测试（WS7/C7，TDD：先 RED 后 GREEN）。
 *
 * 覆盖 spec §WS7 全部验收标准（C7 范围；C8 将复用扩展 agent-collaboration.md
 * 三路由断言，见文末 C8 EXTENSION POINT）：
 * 1. `docs/testing/**`、`docs/engineering/**` 无 DSH 时代政策残留
 *   （`DSH|STARTED_MOCK|mock.pid|:9301|10800|503/429`；白名单仅本变更
 *    spec/plan 与 `docs/archive/**`）；
 * 2. `isolation.md` 含 harness 真相锚点
 *   （`31120-31150`、`active.json`、`app-handle-`、`ownedMock`）；
 * 3. `maintenance.md` 为 catalog 驱动（无 `E2E-XX-YY` 主编号、无手工总数，
 *    以 `case_id`/`yarn test:static`/`lifecycle_status` 为准）；
 * 4. 任务 manifest schema + 结项 schema 样例经专用 Tooling 校验器
 *    （D5 已决：独立 suite，不并入 `check-test-catalog.mjs`）正负例全过；
 * 5. `evidence.md` 含 CI 工件白名单/黑名单/脱敏规则与 `retention-days: 30` 指针；
 * 6. `artifacts-and-retention.md` 含三落点索引。
 *
 * 口径：只读仓库 tracked 文档 + 内存 schema 校验，不触 DB/网络/浏览器；
 * needs_db=false 叶子套件。
 */

// 中文注释：仓库根（全部文档路径均以 cwd 为仓库根解析）。
const repoRoot: string = process.cwd();
// 中文注释：被测文档绝对路径。
const isolationAbs: string = path.join(repoRoot, 'docs', 'testing', 'execution', 'isolation.md');
const maintenanceAbs: string = path.join(repoRoot, 'docs', 'testing', 'execution', 'maintenance.md');
const evidenceAbs: string = path.join(repoRoot, 'docs', 'testing', 'execution', 'evidence.md');
const artifactsAbs: string = path.join(repoRoot, 'docs', 'engineering', 'artifacts-and-retention.md');

// 中文注释：DSH 时代政策关键词（spec §WS7 验收：current-state 文档零命中）。
const legacyPolicyRe: RegExp = /DSH|STARTED_MOCK|mock\.pid|:9301|10800|503\/429/;
// 中文注释：扫描白名单前缀（本变更 spec/plan 与 archive 索引；扫描根为
// docs/testing 与 docs/engineering 时本就落在根外，此处防御性保留）。
const scanAllowPrefixes: string[] = ['docs/specs/', 'docs/plans/', 'docs/archive/'];
// 中文注释：C7 范围精确例外——agent-collaboration.md 首节 WS8 路由句（C8 所有，
// WS8 将其强化为 Hermes/DSH/long-task-supervision 三路由；本句是路由指针，
// 不是 DSH Worker 调度/超时/退避/PID 政策，见 spec §WS7 决策 5）。
// 允许的是整句精确匹配，文件内其余任何关键词命中仍失败。
const agentCollabRoutingLine: string =
    '本文件定义项目无关具体模型的协作协议；Hermes/DSH 的调用、恢复和监督技巧放在本地 skill，不在仓库复制。';

/**
 * 递归收集目录下全部 .md 文件（相对仓库根，斜杠统一）。
 */
function collectMdFiles(dirAbs: string, out: string[]): void {
    for (const ent of readdirSync(dirAbs, { withFileTypes: true })) {
        const abs: string = path.join(dirAbs, ent.name);
        if (ent.isDirectory()) {
            collectMdFiles(abs, out);
        } else if (ent.isFile() && ent.name.endsWith('.md')) {
            out.push(path.relative(repoRoot, abs).replace(/\\/g, '/'));
        }
    }
}

/**
 * 对单文件做关键词扫描，返回命中行（行号 + 行文本）。
 * 白名单前缀文件跳过；agent-collaboration.md 的路由句精确行跳过。
 */
function scanFile(rel: string): Array<{ line: number; text: string }> {
    if (scanAllowPrefixes.some((p) => rel === p || rel.startsWith(p))) return [];
    const raw: string = readFileSync(path.join(repoRoot, rel), 'utf8');
    const hits: Array<{ line: number; text: string }> = [];
    raw.split('\n').forEach((ln, idx) => {
        if (!legacyPolicyRe.test(ln)) return;
        if (rel === 'docs/engineering/agent-collaboration.md' && ln.trim() === agentCollabRoutingLine) return;
        hits.push({ line: idx + 1, text: ln.slice(0, 200) });
    });
    return hits;
}

/**
 * 用例 1：docs/testing/** 无 DSH 时代政策残留（严格零命中，无例外）。
 */
async function caseNoLegacyPolicyTesting(): Promise<void> {
    const files: string[] = [];
    collectMdFiles(path.join(repoRoot, 'docs', 'testing'), files);
    assert.ok(files.length > 0, 'docs/testing 下须有被扫描文档');
    const bad: string[] = [];
    for (const rel of files) {
        for (const h of scanFile(rel)) bad.push(`${rel}:${h.line}: ${h.text}`);
    }
    assert.strictEqual(bad.length, 0, `docs/testing/** 须零命中 DSH 政策关键词，实际:\n${bad.join('\n')}`);
    console.log(`PASS: docs/testing/** 无政策残留（扫描 ${files.length} 文件）`);
}

/**
 * 用例 2：docs/engineering/** 无 DSH 时代政策残留
 *（唯一例外：agent-collaboration.md 的 WS8 路由句精确行，C8 所有）。
 */
async function caseNoLegacyPolicyEngineering(): Promise<void> {
    const files: string[] = [];
    collectMdFiles(path.join(repoRoot, 'docs', 'engineering'), files);
    assert.ok(files.length > 0, 'docs/engineering 下须有被扫描文档');
    const bad: string[] = [];
    for (const rel of files) {
        for (const h of scanFile(rel)) bad.push(`${rel}:${h.line}: ${h.text}`);
    }
    assert.strictEqual(bad.length, 0, `docs/engineering/** 除路由句外须零命中，实际:\n${bad.join('\n')}`);
    console.log(`PASS: docs/engineering/** 无政策残留（扫描 ${files.length} 文件，路由句除外）`);
}

/**
 * 用例 3：isolation.md 含 harness 真相锚点。
 */
async function caseIsolationHarnessAnchors(): Promise<void> {
    const raw: string = readFileSync(isolationAbs, 'utf8');
    for (const anchor of ['31120-31150', 'active.json', 'app-handle-', 'ownedMock']) {
        assert.ok(raw.includes(anchor), `isolation.md 须含 harness 真相锚点：${anchor}`);
    }
    // 中文注释：harness 真相纵深（快照/指针/守卫/所有权与实现同口径）。
    for (const anchor of ['git archive HEAD', 'mock-port-', 'EXPECTED_TARGET_SHA', 'git status']) {
        assert.ok(raw.includes(anchor), `isolation.md 须含 harness 纵深锚点：${anchor}`);
    }
    console.log('PASS: isolation.md 含 harness 真相锚点（端口/指针/所有权/快照守卫）');
}

/**
 * 用例 4：maintenance.md 为 catalog 驱动。
 */
async function caseMaintenanceCatalogDriven(): Promise<void> {
    const raw: string = readFileSync(maintenanceAbs, 'utf8');
    // 中文注释：旧具体编号（E2E-01- 这类两位数字实例）不得作主编号；
    // 字面占位 E2E-XX-YY 仅允许出现在退役声明句中，此处直接禁具体实例。
    assert.ok(!/E2E-\d{2}-/.test(raw), 'maintenance.md 不得以 E2E-XX-YY 具体实例作主编号');
    // 中文注释：文档内禁手工总数（数字 + 个父/个原子这类手维护计数）。
    assert.ok(!/\d+\s*个(父|原子)/.test(raw), 'maintenance.md 不得含手工总数');
    // 中文注释：身份/数量/调度三权威口径齐全。
    for (const anchor of ['case_id', 'legacy_aliases', 'yarn test:static', 'lifecycle_status', 'executable_ids', 'ci_tier', 'MANUAL']) {
        assert.ok(raw.includes(anchor), `maintenance.md 须含 catalog 驱动锚点：${anchor}`);
    }
    console.log('PASS: maintenance.md 为 catalog 驱动（case_id 身份 + checker 计数 + tier 调度）');
}

// ---------------------------------------------------------------------------
// D5 专用校验器（形态固定为专用 Tooling 校验测试，不并入 check-test-catalog.mjs）。
// 任务 manifest schema 落 evidence.md 作规范正文，artifacts-and-retention.md 作索引。
// ---------------------------------------------------------------------------

/** 任务 manifest handover 所有权段。 */
interface ManifestOwnership {
    pids: string;
    ports: string;
    db: string;
}
/** 任务 manifest handover 段。 */
interface ManifestHandover {
    commit_sha: string;
    changed_files: string[];
    commands: Array<{ command: string; exit_code: number }>;
    not_run: string[];
    ownership: ManifestOwnership;
    recovery: string;
}
/** 任务 manifest（D5 schema）。 */
interface TaskManifest {
    change_id: string;
    role: string;
    workspace: string;
    branch: string;
    base_sha: string;
    target_sha: string;
    authorized_paths: string[];
    forbidden_actions: string[];
    required_reads: string[];
    evidence_dir: string;
    handover: ManifestHandover;
}
/** 结项文档 front-matter（D5 schema）。 */
interface CloseoutDoc {
    status: string;
    base_sha: string;
    result: string;
    entrypoints: string[];
    known_non_blocking: string[];
    conclusion_boundary: string;
}

/** 校验结果。 */
interface CheckResult {
    ok: boolean;
    errors: string[];
}

function isNonEmptyString(v: unknown): boolean {
    return typeof v === 'string' && v.length > 0;
}

/**
 * D5 任务 manifest 专用校验器。
 */
function validateTaskManifest(obj: unknown): CheckResult {
    const errors: string[] = [];
    const m = obj as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return { ok: false, errors: ['manifest 须为对象'] };
    for (const k of [
        'change_id',
        'role',
        'workspace',
        'branch',
        'base_sha',
        'target_sha',
        'authorized_paths',
        'forbidden_actions',
        'required_reads',
        'evidence_dir',
        'handover',
    ]) {
        if (!(k in m) || m[k] === undefined || m[k] === null) errors.push(`缺字段：${k}`);
    }
    if ('authorized_paths' in m && (!Array.isArray(m['authorized_paths']) || (m['authorized_paths'] as unknown[]).length === 0)) {
        errors.push('authorized_paths 须为非空数组');
    }
    if ('evidence_dir' in m && !isNonEmptyString(m['evidence_dir'])) errors.push('evidence_dir 须为 run-id 真实路径非空字符串');
    const h = m['handover'] as Record<string, unknown> | undefined;
    if (h && typeof h === 'object') {
        for (const k of ['commit_sha', 'changed_files', 'commands', 'not_run', 'ownership', 'recovery']) {
            if (!(k in h) || h[k] === undefined || h[k] === null) errors.push(`handover 缺字段：${k}`);
        }
        const cmds = h['commands'] as unknown;
        if ('commands' in h && (!Array.isArray(cmds) || !(cmds as Array<Record<string, unknown>>).every((c) => isNonEmptyString(c['command']) && typeof c['exit_code'] === 'number'))) {
            errors.push('handover.commands 须为 {command, exit_code} 数组');
        }
        const own = h['ownership'] as Record<string, unknown> | undefined;
        if (own && typeof own === 'object') {
            for (const k of ['pids', 'ports', 'db']) {
                if (!(k in own)) errors.push(`handover.ownership 缺字段：${k}`);
            }
        }
    } else if ('handover' in m) {
        errors.push('handover 须为对象');
    }
    return { ok: errors.length === 0, errors };
}

/**
 * D5 结项文档专用校验器。
 */
function validateCloseout(obj: unknown): CheckResult {
    const errors: string[] = [];
    const m = obj as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return { ok: false, errors: ['closeout 须为对象'] };
    for (const k of ['status', 'base_sha', 'result', 'entrypoints', 'known_non_blocking', 'conclusion_boundary']) {
        if (!(k in m) || m[k] === undefined || m[k] === null || m[k] === '') errors.push(`缺字段：${k}`);
    }
    if ('conclusion_boundary' in m && typeof m['conclusion_boundary'] === 'string' && !(m['conclusion_boundary'] as string).includes('APPROVE')) {
        errors.push('conclusion_boundary 须声明技术 APPROVE ≠ 发布授权边界');
    }
    return { ok: errors.length === 0, errors };
}

// 中文注释：受控正例 manifest（字段齐全，须通过）。
const goodManifest: TaskManifest = {
    change_id: 'governance-hardening-20260910',
    role: 'Implementer',
    workspace: '<repo-root>',
    branch: 'chore/test-architecture-rebuild',
    base_sha: '2f4910fe8f178bcf164406b6d16a9afa48820557',
    target_sha: '2f4910fe8f178bcf164406b6d16a9afa48820557',
    authorized_paths: ['docs/testing/execution/isolation.md'],
    forbidden_actions: ['push', 'merge', 'deploy'],
    required_reads: ['docs/specs/2026-09-10-governance-and-release-hardening.md'],
    evidence_dir: '.agent-runs/governance-hardening-20260910/impl-c7',
    handover: {
        commit_sha: '2f4910fe8f178bcf164406b6d16a9afa48820557',
        changed_files: ['docs/testing/execution/isolation.md'],
        commands: [{ command: 'yarn test:static', exit_code: 0 }],
        not_run: ['yarn test:browser:smoke'],
        ownership: { pids: 'none', ports: 'none', db: 'untouched' },
        recovery: 'git rev-parse HEAD',
    },
};

// 中文注释：受控正例结项（字段齐全，须通过）。
const goodCloseout: CloseoutDoc = {
    status: 'DONE',
    base_sha: '2f4910fe8f178bcf164406b6d16a9afa48820557',
    result: 'WS7 acceptance PASS',
    entrypoints: ['docs/testing/README.md'],
    known_non_blocking: ['分支保护配置 NOT_RUN'],
    conclusion_boundary: '技术 APPROVE ≠ 发布授权',
};

/**
 * 用例 5：任务 manifest schema 落点 + 专用校验器正负例。
 */
async function caseTaskManifestSchema(): Promise<void> {
    const raw: string = readFileSync(evidenceAbs, 'utf8');
    for (const anchor of [
        'change_id',
        'role',
        'workspace',
        'branch',
        'base_sha',
        'target_sha',
        'authorized_paths',
        'forbidden_actions',
        'required_reads',
        'evidence_dir',
        'handover',
    ]) {
        assert.ok(raw.includes(anchor), `evidence.md 任务 manifest 规范正文须含字段：${anchor}`);
    }
    const good = validateTaskManifest(goodManifest);
    assert.strictEqual(good.ok, true, `manifest 正例须通过，实际 errors=${JSON.stringify(good.errors)}`);
    const missing = validateTaskManifest({ ...goodManifest, handover: undefined } as unknown as Record<string, unknown>);
    assert.strictEqual(missing.ok, false, 'manifest 缺 handover 负例须被拒');
    const missingOwner = validateTaskManifest({
        ...goodManifest,
        handover: { ...goodManifest.handover, ownership: { pids: 'x' } },
    });
    assert.strictEqual(missingOwner.ok, false, 'manifest 缺 ownership 子字段负例须被拒');
    console.log('PASS: 任务 manifest 规范落点 + 校验器正例通过/缺字段负例被拒');
}

/**
 * 用例 6：结项 schema 落点 + 专用校验器正负例。
 */
async function caseCloseoutSchema(): Promise<void> {
    const raw: string = readFileSync(evidenceAbs, 'utf8');
    assert.ok(raw.includes('docs/changes/YYYY-MM-DD-<topic>.md'), 'evidence.md 须声明结项路径范式');
    for (const anchor of ['status', 'base_sha', 'result', 'entrypoints', 'known_non_blocking', 'conclusion_boundary']) {
        assert.ok(raw.includes(anchor), `evidence.md 结项规范正文须含字段：${anchor}`);
    }
    const good = validateCloseout(goodCloseout);
    assert.strictEqual(good.ok, true, `结项正例须通过，实际 errors=${JSON.stringify(good.errors)}`);
    const missing = validateCloseout({ ...goodCloseout, conclusion_boundary: undefined } as unknown as Record<string, unknown>);
    assert.strictEqual(missing.ok, false, '结项缺 conclusion_boundary 负例须被拒');
    console.log('PASS: 结项 schema 规范落点 + 校验器正例通过/缺字段负例被拒');
}

/**
 * 用例 7：evidence.md 补 CI 工件节（白名单/黑名单/脱敏 + retention-days: 30 指针）。
 */
async function caseCiArtifactsSection(): Promise<void> {
    const raw: string = readFileSync(evidenceAbs, 'utf8');
    for (const anchor of ['results.jsonl', 'manifest.json', '.env', 'retention-days', '30']) {
        assert.ok(raw.includes(anchor), `evidence.md CI 工件节须含：${anchor}`);
    }
    assert.ok(raw.includes('脱敏'), 'evidence.md CI 工件节须含脱敏规则');
    console.log('PASS: evidence.md 含 CI 工件白名单/黑名单/脱敏 + retention-days: 30');
}

/**
 * 用例 8：artifacts-and-retention.md 补三落点索引。
 */
async function caseArtifactsIndex(): Promise<void> {
    const raw: string = readFileSync(artifactsAbs, 'utf8');
    assert.ok(statSync(artifactsAbs).isFile(), 'artifacts-and-retention.md 须存在');
    for (const anchor of ['evidence.md', 'manifest', 'closeout', 'retention-days']) {
        assert.ok(raw.toLowerCase().includes(anchor.toLowerCase()), `artifacts-and-retention.md 索引须含：${anchor}`);
    }
    console.log('PASS: artifacts-and-retention.md 含任务 manifest/结项/CI 工件三落点索引');
}

// ---------------------------------------------------------------------------
// C8 EXTENSION POINT（WS8 仓库侧）：agent-collaboration.md 三路由断言扩展位。
// C7 只覆盖 WS7 范围；C8 在此追加 Hermes / DSH / long-task-supervision
// 三条显式路由断言（仓库内禁操作细节，只断言路由句存在）。
// ---------------------------------------------------------------------------

/**
 * C8 预留位：当前 suite 在 C7 范围内为 no-op（仅声明扩展契约，不做断言）。
 */
async function caseAgentCollaborationRoutesReservedForC8(): Promise<void> {
    console.log('SKIP: agent-collaboration.md 三路由断言为 C8 扩展位（C7 只覆盖 WS7 范围）');
}

/**
 * 测试入口：顺序执行全部用例（C8 在入口尾部追加新段落函数即可）。
 */
async function main(): Promise<void> {
    await caseNoLegacyPolicyTesting();
    await caseNoLegacyPolicyEngineering();
    await caseIsolationHarnessAnchors();
    await caseMaintenanceCatalogDriven();
    await caseTaskManifestSchema();
    await caseCloseoutSchema();
    await caseCiArtifactsSection();
    await caseArtifactsIndex();
    await caseAgentCollaborationRoutesReservedForC8();
}

export default main();
