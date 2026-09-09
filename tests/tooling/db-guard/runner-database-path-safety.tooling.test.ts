import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as safety from '../../../scripts/test-database-path-safety.mjs';

/**
 * runner 数据库路径安全契约测试（任务1，Tooling）。
 * 覆盖 13 项边界：拒绝越界/编码/query/非 file/symlink，接受合法隔离路径，
 * 两 suite 不同库，ambient 不透传，bootstrap exit 3，清理不删根外，相对 file 拒绝。
 * 全程仅 tmp 沙箱 + 只读指纹真实 prisma/dev.db（绝不创建/写连接/迁移）。
 */

// 中文注释：仓库根目录（仅解析允许根，不写真实库）。
const repoRoot: string = process.cwd();
// 中文注释：固定合成 run-id（格式与生成器一致，专供路径断言）。
const fixedRunId: string = '20260909T105219Z-fea26406';
// 中文注释：保存进入时的 ambient，供用例 10 临时覆盖后恢复。
const savedAmbient: string | undefined = process.env.DATABASE_URL;

/**
 * 只读记录 prisma/dev.db 指纹（存在状态/mtime/size/hash）。
 */
function fingerprintDevDb(): { exists: boolean; mtimeMs: number; size: number; sha256: string } {
    const p = path.join(repoRoot, 'prisma', 'dev.db');
    if (!existsSync(p)) {
        return { exists: false, mtimeMs: 0, size: 0, sha256: '' };
    }
    const st = statSync(p);
    const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size, sha256: hash };
}

/**
 * 用例 1：file:prisma/dev.db 被拒绝。
 */
function caseRelativeDevDb(): void {
    const r = safety.validateDatabaseUrl('file:prisma/dev.db', { repoRoot });
    assert.strictEqual(r.ok, false, 'file:prisma/dev.db 应被拒绝');
    console.log('PASS: 用例1 file:prisma/dev.db 拒绝');
}

/**
 * 用例 2：仓外绝对路径被拒绝。
 */
function caseOutsideAbsolute(): void {
    const dir: string = mkdtempSync(path.join(tmpdir(), 't1-outside-'));
    try {
        const outside: string = path.join(dir, 'outside.db');
        writeFileSync(outside, 'sentinel');
        const r = safety.validateDatabaseUrl(pathToFileURL(outside).href, { repoRoot });
        assert.strictEqual(r.ok, false, '仓外绝对路径应被拒绝');
        assert.ok(existsSync(outside), '拒绝后哨兵文件不得被删');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    console.log('PASS: 用例2 仓外绝对路径拒绝');
}

/**
 * 用例 3：../ 越界被拒绝。
 */
function caseDotDotTraversal(): void {
    const base: string = pathToFileURL(path.join(repoRoot, '.e2e-runtime', 'test-db')).href;
    const evil: string = `${base}/${fixedRunId}/../evil.db`;
    const r = safety.validateDatabaseUrl(evil, { repoRoot });
    assert.strictEqual(r.ok, false, '../ 越界应被拒绝');
    console.log('PASS: 用例3 ../ 越界拒绝');
}

/**
 * 用例 4：百分号编码后的 .. 被拒绝。
 */
function caseEncodedDotDot(): void {
    const base: string = pathToFileURL(path.join(repoRoot, '.e2e-runtime', 'test-db')).href;
    for (const evil of [`${base}/%2e%2e/evil.db`, `${base}/%2E%2E/evil.db`, `${base}/%252e.db`]) {
        const r = safety.validateDatabaseUrl(evil, { repoRoot });
        assert.strictEqual(r.ok, false, `编码 .. 应被拒绝：${evil.slice(-30)}`);
    }
    console.log('PASS: 用例4 编码 .. 拒绝');
}

/**
 * 用例 5：query/hash 被拒绝。
 */
function caseQueryHash(): void {
    const legal: string = safety.buildSuiteDatabaseUrl(repoRoot, fixedRunId, 'dummy-suite').url;
    assert.strictEqual(safety.validateDatabaseUrl(`${legal}?x=1`, { repoRoot }).ok, false, 'query 应被拒绝');
    assert.strictEqual(safety.validateDatabaseUrl(`${legal}#h`, { repoRoot }).ok, false, 'hash 应被拒绝');
    assert.strictEqual(safety.validateDatabaseUrl(`${legal}?x=1#h`, { repoRoot }).ok, false, 'query+hash 应被拒绝');
    console.log('PASS: 用例5 query/hash 拒绝');
}

/**
 * 用例 6：https:/libsql: 被拒绝。
 */
function caseNonFileScheme(): void {
    assert.strictEqual(safety.validateDatabaseUrl('https://example.com/x.db', { repoRoot }).ok, false);
    assert.strictEqual(safety.validateDatabaseUrl('libsql://example.com/x.db', { repoRoot }).ok, false);
    console.log('PASS: 用例6 https/libsql 拒绝');
}

/**
 * 用例 7：symlink 祖先逃逸被拒绝。
 */
function caseSymlinkAncestor(): void {
    const fakeRepo: string = mkdtempSync(path.join(tmpdir(), 't1-fakerepo-'));
    try {
        const allowed: string = path.join(fakeRepo, '.e2e-runtime', 'test-db');
        mkdirSync(allowed, { recursive: true });
        const allowedReal: string = safety.getAllowedRoot(fakeRepo);
        const runDir: string = safety.ensureRunDir(fakeRepo, fixedRunId);
        const outsideDir: string = mkdtempSync(path.join(tmpdir(), 't1-evil-'));
        try {
            const link: string = path.join(runDir, 'link');
            symlinkSync(outsideDir, link);
            assert.ok(lstatSync(link).isSymbolicLink(), '前置：symlink 应存在');
            const evilUrl: string = pathToFileURL(path.join(link, 'evil.db')).href;
            const r = safety.validateDatabaseUrl(evilUrl, { repoRoot: fakeRepo, runId: fixedRunId });
            assert.strictEqual(r.ok, false, 'symlink 祖先逃逸应被拒绝');
            // 中文注释：目标文件 symlink 同样拒绝。
            const realDb: string = path.join(runDir, 'real.db');
            writeFileSync(realDb, 'x');
            const linkFile: string = path.join(runDir, 'linkfile.db');
            try {
                symlinkSync(realDb, linkFile);
            } catch {
                // 已存在则跳过
            }
            if (existsSync(linkFile) || (() => { try { lstatSync(linkFile); return true; } catch { return false; } })()) {
                const r2 = safety.validateDatabaseUrl(pathToFileURL(linkFile).href, { repoRoot: fakeRepo, runId: fixedRunId });
                assert.strictEqual(r2.ok, false, 'symlink 目标文件应被拒绝');
                rmSync(linkFile, { force: true });
            }
            void allowedReal;
        } finally {
            rmSync(outsideDir, { recursive: true, force: true });
        }
    } finally {
        rmSync(fakeRepo, { recursive: true, force: true });
    }
    console.log('PASS: 用例7 symlink 逃逸拒绝');
}

/**
 * 用例 8：合法 .e2e-runtime/test-db/<run>/<suite>.db 被接受。
 */
function caseLegalAccept(): void {
    const built = safety.buildSuiteDatabaseUrl(repoRoot, fixedRunId, 'dummy-suite');
    assert.ok(built.url.startsWith('file:///'), '生成端须为规范绝对 file URL');
    const r = safety.validateDatabaseUrl(built.url, { repoRoot, runId: fixedRunId });
    assert.strictEqual(r.ok, true, `合法路径应被接受：${r.reason}`);
    assert.strictEqual(r.dbPath, built.dbPath, '解后路径应一致');
    console.log('PASS: 用例8 合法路径接受');
}

/**
 * 用例 9：两个 suite 得到不同 DB。
 */
function caseTwoSuitesDiffer(): void {
    const a = safety.buildSuiteDatabaseUrl(repoRoot, fixedRunId, 'suite-a');
    const b = safety.buildSuiteDatabaseUrl(repoRoot, fixedRunId, 'suite-b');
    assert.notStrictEqual(a.url, b.url, '两 suite URL 应不同');
    assert.notStrictEqual(a.dbPath, b.dbPath, '两 suite 路径应不同');
    assert.ok(a.url.includes('suite-a') && b.url.includes('suite-b'), '路径应含各自 suite ID');
    console.log('PASS: 用例9 两 suite 不同 DB');
}

/**
 * 用例 10：ambient DATABASE_URL 不会成为子 suite URL。
 */
function caseAmbientIsolation(): void {
    process.env.DATABASE_URL = 'file:/tmp/ambient-evil.db';
    try {
        const built = safety.buildSuiteDatabaseUrl(repoRoot, fixedRunId, 'suite-a');
        assert.ok(!built.url.includes('ambient-evil'), 'ambient 不得透传为子 URL');
        assert.ok(built.url.includes('.e2e-runtime/test-db'), '受控 URL 应在允许根内');
    } finally {
        if (savedAmbient === undefined) {
            delete process.env.DATABASE_URL;
        } else {
            process.env.DATABASE_URL = savedAmbient;
        }
    }
    console.log('PASS: 用例10 ambient 不透传');
}

/**
 * 用例 11：bootstrap 失败映射 exit 3（含 timeout 4）。
 */
function caseExitCodes(): void {
    assert.strictEqual(safety.BOOTSTRAP_EXIT_CODE, 3, 'bootstrap 应为 exit 3');
    assert.strictEqual(safety.SUITE_TIMEOUT_EXIT_CODE, 4, 'timeout 应为 exit 4');
    assert.strictEqual(safety.SUITE_FAIL_EXIT_CODE, 1, '普通失败应为 exit 1');
    assert.ok(safety.RUN_ID_RE.test(fixedRunId), 'run-id 样例应合规');
    assert.ok(safety.RUN_ID_RE.test(safety.generateRunId()), '生成 run-id 应合规');
    console.log('PASS: 用例11 exit 3/4 映射');
}

/**
 * 用例 12：清理函数不会删除 allowed 根外文件。
 */
function caseCleanupConfined(): void {
    const fakeRepo: string = mkdtempSync(path.join(tmpdir(), 't1-clean-'));
    try {
        mkdirSync(path.join(fakeRepo, '.e2e-runtime', 'test-db'), { recursive: true });
        const runDir: string = safety.ensureRunDir(fakeRepo, fixedRunId);
        const outsideDir: string = mkdtempSync(path.join(tmpdir(), 't1-victim-'));
        try {
            const victim: string = path.join(outsideDir, 'victim.db');
            writeFileSync(victim, 'sentinel');
            const ret: boolean = safety.cleanupSuiteDb(victim, runDir);
            assert.strictEqual(ret, false, '根外清理应返回 false');
            assert.ok(existsSync(victim), '根外文件不得被删');
            assert.strictEqual(readFileSync(victim, 'utf8'), 'sentinel', '哨兵内容不得变化');
            // 中文注释：根内清理应成功。
            const inner: string = path.join(runDir, 'inner.db');
            writeFileSync(inner, 'x');
            writeFileSync(`${inner}-wal`, 'w');
            assert.strictEqual(safety.cleanupSuiteDb(inner, runDir), true, '根内应清理成功');
            assert.ok(!existsSync(inner) && !existsSync(`${inner}-wal`), '根内文件应被清理');
        } finally {
            rmSync(outsideDir, { recursive: true, force: true });
        }
    } finally {
        rmSync(fakeRepo, { recursive: true, force: true });
    }
    console.log('PASS: 用例12 清理不删根外');
}

/**
 * 用例 13：pathToFileURL 规范式之外的 file 写法一律拒绝。
 */
function caseNonCanonicalFile(): void {
    assert.strictEqual(safety.validateDatabaseUrl('file:prisma/x.db', { repoRoot }).ok, false, '相对式应拒绝');
    assert.strictEqual(safety.validateDatabaseUrl('file:./prisma/dev.db', { repoRoot }).ok, false, '相对式应拒绝');
    assert.strictEqual(safety.validateDatabaseUrl('file:/tmp/x.sqlite', { repoRoot }).ok, false, '非 .db 应拒绝');
    console.log('PASS: 用例13 非规范 file 拒绝');
}

/**
 * 用例 14（附加）：suite ID 推导与唯一性。
 */
function caseSuiteId(): void {
    assert.strictEqual(
        safety.suiteIdFromTestPath('./tests/tooling/db-guard/runner-database-path-safety.tooling.test.ts'),
        'runner-database-path-safety',
    );
    assert.strictEqual(safety.suiteIdFromTestPath('./tests/test-sec-01.ts'), 'test-sec-01');
    assert.throws(() => safety.suiteIdFromTestPath('./Bad_Name.ts'), /非法 suite ID/);
    assert.deepStrictEqual(safety.checkUniqueSuiteIds(['a', 'b', 'a']), ['a']);
    assert.deepStrictEqual(safety.checkUniqueSuiteIds(['a', 'b']), []);
    console.log('PASS: 用例14 suite ID 推导与唯一性');
}

/**
 * 测试入口：先记 dev.db 指纹，跑全用例后再比对（只读，绝不写库）。
 */
async function main(): Promise<void> {
    const before = fingerprintDevDb();
    caseRelativeDevDb();
    caseOutsideAbsolute();
    caseDotDotTraversal();
    caseEncodedDotDot();
    caseQueryHash();
    caseNonFileScheme();
    caseSymlinkAncestor();
    caseLegalAccept();
    caseTwoSuitesDiffer();
    caseAmbientIsolation();
    caseExitCodes();
    caseCleanupConfined();
    caseNonCanonicalFile();
    caseSuiteId();
    const after = fingerprintDevDb();
    assert.deepStrictEqual(after, before, 'prisma/dev.db 指纹前后必须一致（只读）');
    // 中文注释：恢复 ambient（防用例 10 残留影响后续套件）。
    if (savedAmbient === undefined) {
        delete process.env.DATABASE_URL;
    } else {
        process.env.DATABASE_URL = savedAmbient;
    }
    console.log('ALL RUNNER DATABASE PATH SAFETY TESTS PASSED');
}

export default main();
