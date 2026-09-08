import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

/**
 * e2e-db-guard 写库防损坏契约测试（缺陷 #6，测试基建）。
 *
 * 覆盖行为（06-07 实证：写前快照 + 每阶段 integrity_check）：
 * 1. verify 对健康库返回 ok（exit 0）。
 * 2. verify 对损坏库失败（exit 非 0），随后 restore 快照可恢复数据。
 * 3. 共享/错误库一律被拒绝：tmp 沙盒内 `prisma/dev.db` 誘饵（含大写/query/file:/symlink 变体）、
 *    生产库与疑似生产库；全程只用 tmp 路径，绝不 stat/read 真实开发库。
 * 4. 缺失库在建连接前拒绝：check/verify/snapshot/write/restore 对不存在路径失败且不产生文件副作用。
 * 5. 受管 app 占用（库旁锁标记或环境变量锁文件）时 check/write/snapshot/restore 失败而非硬写，解锁后恢复。
 * 6. 无 guard 的并发写不被许可（排他锁下裸写得 SQLITE_BUSY）；guard 写同样拒绝，
 *    释放后串行写成功：单连接 busy_timeout=5000，每阶段 integrity=ok。
 * 7. write 强制备份前置：无快照时 BACKUP_REQUIRED 拒绝，snapshot 后方可写库。
 * 8. 快照 WAL 安全：附带 -wal/-shm 一致拷贝；restore 按快照恢复/清除 sidecar。
 *
 * 隔离约束：全程使用临时目录 DB，禁止触碰 :9301 / :31111 / :38080 /
 * 真实 prisma/dev.db 内容 / 既有 .e2e-runtime 资产；不写任何密钥。
 */

// 中文注释：仓库根目录（仅用于解析被测脚本路径，不读取真实开发库）。
const repoRoot: string = process.cwd();
// 中文注释：被测守卫脚本（仓库跟踪资产）。
const guardScript: string = path.join(repoRoot, 'scripts', 'e2e-db-guard.mjs');
// 中文注释：串行写连接的忙等待毫秒数（与守卫脚本内常量一致）。
const expectedBusyTimeout: string = 'busy_timeout=5000';

/**
 * 建一个含一行数据的临时库。
 * @param dir 临时目录。
 * @param name 文件名。
 * @returns 库文件绝对路径。
 */
async function makeTempDb(dir: string, name: string): Promise<string> {
    const dbPath: string = path.join(dir, name);
    const db = createClient({ url: `file:${dbPath}` });
    try {
        await db.execute('create table probe(id integer primary key, v text)');
        await db.execute({ sql: 'insert into probe(v) values (?)', args: ['origin'] });
    } finally {
        db.close();
    }
    return dbPath;
}

/**
 * 读临时库全部行（只读复核）。
 * @param dbPath 库文件路径。
 * @returns v 列快照。
 */
async function readRows(dbPath: string): Promise<string[]> {
    const db = createClient({ url: `file:${dbPath}` });
    try {
        const rs = await db.execute('select v from probe order by id');
        return rs.rows.map((r) => String(r[0]));
    } finally {
        db.close();
    }
}

/**
 * 取守卫 snapshot 命令末行输出的快照路径。
 * @param dbPath 库文件路径。
 * @param dir 快照目录。
 * @returns 快照文件绝对路径。
 */
function takeSnapshot(dbPath: string, dir: string): string {
    const snapOut: string = execFileSync('node', [guardScript, 'snapshot', dbPath, '--dest', dir], {
        encoding: 'utf8',
    });
    const snapPath: string = snapOut.trim().split('\n').pop() ?? '';
    assert.ok(snapPath.endsWith('.db'), `快照应输出快照路径，实际=${snapOut}`);
    return snapPath;
}

/**
 * 断言守卫命令失败（exit 非 0），返回合并输出供复核。
 * @param sub 子命令。
 * @param rest 剩余参数。
 * @returns 子进程输出。
 */
function expectGuardFail(sub: string, ...rest: string[]): string {
    try {
        execFileSync('node', [guardScript, sub, ...rest], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err: unknown) {
        const caught = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
        const out: string = [String(caught.message ?? err), String(caught.stderr ?? ''), String(caught.stdout ?? '')]
            .join('\n')
            .slice(0, 1200);
        return out;
    }
    assert.fail(`guard ${sub} 应失败却通过，参数=${rest.join(' ')}`);
}

/**
 * 用例 1：健康库 verify 通过，快照只读不改库。
 */
async function caseHealthyVerify(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd6-guard-'));
    try {
        const dbPath: string = await makeTempDb(dir, 'healthy.db');
        const snapPath: string = takeSnapshot(dbPath, dir);
        const verifyOut: string = execFileSync('node', [guardScript, 'verify', dbPath], { encoding: 'utf8' });
        assert.ok(verifyOut.includes('integrity=ok'), `健康库应 integrity=ok，实际=${verifyOut}`);
        assert.deepStrictEqual(await readRows(dbPath), ['origin']);
        const verifySnap: string = execFileSync('node', [guardScript, 'verify', snapPath], { encoding: 'utf8' });
        assert.ok(verifySnap.includes('integrity=ok'), '快照库同样健康');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 用例 2：损坏库 verify 失败，restore 快照后数据恢复。
 */
async function caseCorruptRestore(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd6-guard-'));
    try {
        const dbPath: string = await makeTempDb(dir, 'victim.db');
        const snapPath: string = takeSnapshot(dbPath, dir);
        // 中文注释：页损坏模拟——截断库文件头部（06-07 首轮 GuestChatMessage 页 LOST 的等价破坏）。
        execFileSync('node', ['-e', `require('node:fs').writeFileSync(${JSON.stringify(dbPath)}, Buffer.alloc(512, 0))`]);
        let failed = false;
        try {
            execFileSync('node', [guardScript, 'verify', dbPath], { encoding: 'utf8', stdio: 'pipe' });
        } catch {
            failed = true;
        }
        assert.ok(failed, '损坏库 verify 必须失败');
        execFileSync('node', [guardScript, 'restore', snapPath, dbPath], { encoding: 'utf8' });
        const verifyOut: string = execFileSync('node', [guardScript, 'verify', dbPath], { encoding: 'utf8' });
        assert.ok(verifyOut.includes('integrity=ok'), 'restore 后应恢复健康');
        assert.deepStrictEqual(await readRows(dbPath), ['origin'], 'restore 后数据应回到快照时刻');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 建一个 tmp 沙盒内的共享库誘饵（形如 prisma/dev.db，绝非真实开发库）。
 * @param root 沙盒根目录。
 * @param rel 相对路径（如 prisma/dev.db）。
 * @returns 誘饵绝对路径。
 */
function makeDecoyDb(root: string, rel: string): string {
    const decoy: string = path.join(root, rel);
    mkdirSync(path.dirname(decoy), { recursive: true });
    writeFileSync(decoy, 'decoy-not-real-dev-db');
    return decoy;
}

/**
 * 用例 3：共享/错误库一律被拒绝（tmp 沙盒誘饵 + 变体），誘饵未被触碰。
 * 变体：大写路径、query 参数、file: URL、symlink 指向誘饵、生产库字面量与沙盒形似路径、疑似生产库。
 * 全程只用 tmp 路径，绝不 stat/read 真实 prisma/dev.db。
 */
async function caseForbiddenVariants(): Promise<void> {
    // 中文注释：大小写誘饵必须分属不同沙盒（macOS 临时目录多为大小写不敏感文件系统）。
    const dirLower: string = mkdtempSync(path.join(tmpdir(), 'd6-guard-'));
    const dirUpper: string = mkdtempSync(path.join(tmpdir(), 'd6-guard-'));
    const dirProd: string = mkdtempSync(path.join(tmpdir(), 'd6-guard-'));
    try {
        const decoy: string = makeDecoyDb(path.join(dirLower, 'sandbox'), path.join('prisma', 'dev.db'));
        const before = statSync(decoy);
        const upperDecoy: string = makeDecoyDb(path.join(dirUpper, 'sandbox'), path.join('PRISMA', 'DEV.DB'));
        const prodShaped: string = makeDecoyDb(path.join(dirProd, 'sandbox'), path.join('app', 'data', 'app.db'));
        const prodLike: string = path.join(dirProd, 'prod-backup.db');
        writeFileSync(prodLike, 'decoy');

        // 中文注释：基础誘饵四命令一律 FORBIDDEN。
        const outCheck: string = expectGuardFail('check', decoy);
        assert.ok(outCheck.includes('FORBIDDEN'), `沙盒开发库 check 应 FORBIDDEN，实际=${outCheck}`);
        expectGuardFail('snapshot', decoy);
        expectGuardFail('verify', decoy);
        expectGuardFail('write', decoy, "insert into probe(v) values ('x')");
        // 中文注释：路径解析变体同样 FORBIDDEN（剥 query/fragment、大小写不敏感、file: 前缀、symlink 穿透）。
        const outQuery: string = expectGuardFail('check', `${decoy}?busy_timeout=5000`);
        assert.ok(outQuery.includes('FORBIDDEN'), `query 变体应 FORBIDDEN，实际=${outQuery}`);
        const outUpper: string = expectGuardFail('check', upperDecoy);
        assert.ok(outUpper.includes('FORBIDDEN'), `大写变体应 FORBIDDEN，实际=${outUpper}`);
        const outFile: string = expectGuardFail('check', `file:${decoy}`);
        assert.ok(outFile.includes('FORBIDDEN'), `file: 变体应 FORBIDDEN，实际=${outFile}`);
        const linkPath: string = path.join(dirLower, 'link.db');
        symlinkSync(decoy, linkPath);
        const outLink: string = expectGuardFail('check', linkPath);
        assert.ok(outLink.includes('FORBIDDEN'), `symlink 变体应 FORBIDDEN，实际=${outLink}`);
        // 中文注释：生产库字面量与沙盒形似路径、疑似生产库名一律 FORBIDDEN。
        const outProd: string = expectGuardFail('check', '/app/data/app.db');
        assert.ok(outProd.includes('FORBIDDEN'), `生产库 check 应 FORBIDDEN，实际=${outProd}`);
        expectGuardFail('check', prodShaped);
        expectGuardFail('check', prodLike);
        // 中文注释：誘饵指纹不变，证明拒绝发生在任何读写之前。
        const after = statSync(decoy);
        assert.strictEqual(after.size, before.size, '誘饵体积不得变化');
        assert.strictEqual(after.mtimeMs, before.mtimeMs, '誘饵修改时间不得变化');
    } finally {
        rmSync(dirLower, { recursive: true, force: true });
        rmSync(dirUpper, { recursive: true, force: true });
        rmSync(dirProd, { recursive: true, force: true });
    }
}

/**
 * 用例 4：缺失库在建连接前拒绝，且不产生文件副作用。
 */
async function caseMissingRejects(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd6-guard-'));
    try {
        const dbPath: string = await makeTempDb(dir, 'present.db');
        const snapPath: string = takeSnapshot(dbPath, dir);
        const missing: string = path.join(dir, 'no-such.db');
        const outCheck: string = expectGuardFail('check', missing);
        assert.ok(outCheck.includes('MISSING'), `缺失库 check 应 MISSING，实际=${outCheck}`);
        const outVerify: string = expectGuardFail('verify', missing);
        assert.ok(outVerify.includes('MISSING'), `缺失库 verify 应 MISSING（建连接前拒绝），实际=${outVerify}`);
        const outSnap: string = expectGuardFail('snapshot', missing);
        assert.ok(outSnap.includes('MISSING'), `缺失库 snapshot 应 MISSING，实际=${outSnap}`);
        const outWrite: string = expectGuardFail('write', missing, "insert into probe(v) values ('x')");
        assert.ok(outWrite.includes('MISSING'), `缺失库 write 应 MISSING（建连接前拒绝），实际=${outWrite}`);
        expectGuardFail('restore', path.join(dir, 'no-such-snap.db'), missing);
        const outRestoreDb: string = expectGuardFail('restore', snapPath, missing);
        assert.ok(outRestoreDb.includes('MISSING'), `restore 到缺失库应 MISSING，实际=${outRestoreDb}`);
        // 中文注释：拒绝发生在建连接前，libsql 不得借机创建空库文件（含 sidecar）。
        assert.ok(!existsSync(missing), '缺失库拒绝后不得产生库文件');
        assert.ok(!existsSync(`${missing}-wal`), '缺失库拒绝后不得产生 -wal');
        assert.ok(!existsSync(`${missing}-shm`), '缺失库拒绝后不得产生 -shm');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 用例 5：受管 app 占用时失败而非硬写，解锁后恢复。
 */
async function caseLockRefused(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd6-guard-'));
    const prevEnv: string | undefined = process.env.E2E_GUARD_APP_LOCK;
    try {
        const dbPath: string = await makeTempDb(dir, 'managed.db');
        // 中文注释：库旁锁标记模拟常驻 app 占用（隔离的临时标记，不碰真实端口与资产）。
        writeFileSync(`${dbPath}.lock`, 'managed-app');
        const outCheck: string = expectGuardFail('check', dbPath);
        assert.ok(outCheck.includes('LOCKED'), `占用时 check 应 LOCKED，实际=${outCheck}`);
        const outWrite: string = expectGuardFail('write', dbPath, "insert into probe(v) values ('blocked')");
        assert.ok(outWrite.includes('LOCKED'), `占用时 write 应 LOCKED 而非硬写，实际=${outWrite}`);
        const outSnap: string = expectGuardFail('snapshot', dbPath);
        assert.ok(outSnap.includes('LOCKED'), `占用时 snapshot 应 LOCKED，实际=${outSnap}`);
        assert.deepStrictEqual(await readRows(dbPath), ['origin'], '拒绝写库后数据不得变化');
        // 中文注释：环境变量锁文件同样视为受管占用。
        const envLock: string = path.join(dir, 'app.lock');
        writeFileSync(envLock, 'managed-app');
        process.env.E2E_GUARD_APP_LOCK = envLock;
        rmSync(`${dbPath}.lock`, { force: true });
        expectGuardFail('check', dbPath);
        rmSync(envLock, { force: true });
        delete process.env.E2E_GUARD_APP_LOCK;
        const checkOut: string = execFileSync('node', [guardScript, 'check', dbPath], { encoding: 'utf8' });
        assert.ok(checkOut.includes('guard=ok'), '解锁后 check 应通过');
        // 中文注释：写前先快照（备份前置强制要求，见用例 7）。
        takeSnapshot(dbPath, dir);
        const writeOut: string = execFileSync('node', [guardScript, 'write', dbPath, "insert into probe(v) values ('w1')"], {
            encoding: 'utf8',
        });
        assert.ok(writeOut.includes(expectedBusyTimeout), `串行写应设置 busy_timeout，实际=${writeOut}`);
        assert.ok(writeOut.includes('integrity=ok'), '写后同连接 integrity_check 应 ok');
        assert.deepStrictEqual(await readRows(dbPath), ['origin', 'w1']);
    } finally {
        if (prevEnv === undefined) {
            delete process.env.E2E_GUARD_APP_LOCK;
        } else {
            process.env.E2E_GUARD_APP_LOCK = prevEnv;
        }
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 用例 6：无 guard 并发写不被许可；guard 串行写每阶段 integrity=ok。
 */
async function caseConcurrentBusy(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd6-guard-'));
    try {
        const dbPath: string = await makeTempDb(dir, 'race.db');
        // 中文注释：持排他锁的写者模拟常驻 app 写事务（不提交，保持占用）。
        const holder = createClient({ url: `file:${dbPath}` });
        try {
            await holder.execute('BEGIN EXCLUSIVE');
            await holder.execute({ sql: 'insert into probe(v) values (?)', args: ['held'] });
            // 中文注释：无 guard 的竞争写必须被拒绝（SQLITE_BUSY），证明并发写不被许可。
            const rival = createClient({ url: `file:${dbPath}` });
            try {
                await rival.execute('PRAGMA busy_timeout=0');
                await rival.execute({ sql: 'insert into probe(v) values (?)', args: ['rival'] });
                assert.fail('裸并发写应得 SQLITE_BUSY');
            } catch (err: unknown) {
                const msg: string = err instanceof Error ? err.message : String(err);
                assert.ok(msg.includes('BUSY'), `竞争写应 SQLITE_BUSY，实际=${msg.slice(0, 200)}`);
            } finally {
                rival.close();
            }
            // 中文注释：guard 写同样拒绝硬写，而非排队覆盖。
            const outWrite: string = expectGuardFail('write', dbPath, "insert into probe(v) values ('hard')");
            assert.ok(outWrite.includes('LOCKED'), `锁定时 guard 写应 LOCKED，实际=${outWrite}`);
            // 中文注释：snapshot/restore 同样受排他守卫约束。
            const tmpSnap: string = path.join(dir, 'tmp.snap.db');
            writeFileSync(tmpSnap, 'snap');
            const outSnap: string = expectGuardFail('snapshot', dbPath);
            assert.ok(outSnap.includes('LOCKED'), `锁定时 snapshot 应 LOCKED，实际=${outSnap}`);
            const outRestore: string = expectGuardFail('restore', tmpSnap, dbPath);
            assert.ok(outRestore.includes('LOCKED'), `锁定时 restore 应 LOCKED，实际=${outRestore}`);
            await holder.execute('ROLLBACK');
        } finally {
            holder.close();
        }
        // 中文注释：释放后串行写成功——快照备份→写→每阶段 verify（迁移/seed 范式）。
        const snapPath: string = takeSnapshot(dbPath, dir);
        const stage1: string = execFileSync(
            'node',
            [guardScript, 'write', dbPath, "insert into probe(v) values ('seed-1')"],
            { encoding: 'utf8' },
        );
        assert.ok(stage1.includes(expectedBusyTimeout), '阶段写应使用 busy_timeout 串行约束');
        const verify1: string = execFileSync('node', [guardScript, 'verify', dbPath], { encoding: 'utf8' });
        assert.ok(verify1.includes('integrity=ok'), '阶段 1 后 integrity=ok');
        const stage2: string = execFileSync(
            'node',
            [guardScript, 'write', dbPath, "insert into probe(v) values ('seed-2')"],
            { encoding: 'utf8' },
        );
        assert.ok(stage2.includes('integrity=ok'), '阶段 2 写后 integrity=ok');
        const verify2: string = execFileSync('node', [guardScript, 'verify', snapPath], { encoding: 'utf8' });
        assert.ok(verify2.includes('integrity=ok'), '快照库保持健康可回退');
        assert.deepStrictEqual(await readRows(dbPath), ['origin', 'seed-1', 'seed-2']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 用例 7：write 强制备份前置——无快照时 BACKUP_REQUIRED 拒绝，snapshot 后方可写库。
 */
async function caseBackupPrerequisite(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd6-guard-'));
    try {
        const dbPath: string = await makeTempDb(dir, 'fresh.db');
        const outWrite: string = expectGuardFail('write', dbPath, "insert into probe(v) values ('early')");
        assert.ok(outWrite.includes('BACKUP_REQUIRED'), `无快照写库应 BACKUP_REQUIRED，实际=${outWrite}`);
        assert.deepStrictEqual(await readRows(dbPath), ['origin'], '拒绝写库后数据不得变化');
        takeSnapshot(dbPath, dir);
        const writeOut: string = execFileSync('node', [guardScript, 'write', dbPath, "insert into probe(v) values ('late')"], {
            encoding: 'utf8',
        });
        assert.ok(writeOut.includes('write=ok'), `快照后写库应成功，实际=${writeOut}`);
        assert.deepStrictEqual(await readRows(dbPath), ['origin', 'late']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 用例 8：快照 WAL 安全——附带 -wal/-shm 一致拷贝；restore 按快照恢复/清除 sidecar。
 */
async function caseWalSnapshotRestore(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd6-guard-'));
    try {
        const dbPath: string = await makeTempDb(dir, 'wal.db');
        // 中文注释：WAL 模式 + 关闭自动 checkpoint，使 -wal 稳定存在（快照时另有空闲连接，不持排他锁）。
        const holder = createClient({ url: `file:${dbPath}` });
        let snapPath = '';
        try {
            await holder.execute('PRAGMA journal_mode=WAL');
            await holder.execute('PRAGMA wal_autocheckpoint=0');
            await holder.execute({ sql: 'insert into probe(v) values (?)', args: ['wal-row'] });
            assert.ok(existsSync(`${dbPath}-wal`), '前置条件：WAL 写入后 -wal 应存在');
            snapPath = takeSnapshot(dbPath, dir);
            assert.ok(existsSync(`${snapPath}-wal`), 'WAL 快照必须附带 -wal 一致拷贝');
        } finally {
            holder.close();
        }
        // 中文注释：破坏主库（restore 前移除 sidecar，模拟不一致现场）。
        execFileSync('node', ['-e', `require('node:fs').writeFileSync(${JSON.stringify(dbPath)}, Buffer.alloc(512, 0))`]);
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
        execFileSync('node', [guardScript, 'restore', snapPath, dbPath], {
            encoding: 'utf8',
        });
        assert.ok(existsSync(`${dbPath}-wal`), 'restore 应按快照恢复 -wal');
        const verifyOut: string = execFileSync('node', [guardScript, 'verify', dbPath], { encoding: 'utf8' });
        assert.ok(verifyOut.includes('integrity=ok'), 'WAL restore 后应恢复健康');
        assert.deepStrictEqual(await readRows(dbPath), ['origin', 'wal-row']);
        // 中文注释：无 sidecar 快照回退时，目标库多余 sidecar 必须被清除。
        const plainDir: string = mkdtempSync(path.join(tmpdir(), 'd6-guard-'));
        try {
            const plainDb: string = await makeTempDb(plainDir, 'plain.db');
            const plainSnap: string = takeSnapshot(plainDb, plainDir);
            assert.ok(!existsSync(`${plainSnap}-wal`), '前置条件：回滚日志库快照无 -wal');
            writeFileSync(`${plainDb}-wal`, 'stray-sidecar');
            execFileSync('node', [guardScript, 'restore', plainSnap, plainDb], { encoding: 'utf8' });
            assert.ok(!existsSync(`${plainDb}-wal`), 'restore 应清除快照中不存在的多余 -wal');
            const plainVerify: string = execFileSync('node', [guardScript, 'verify', plainDb], { encoding: 'utf8' });
            assert.ok(plainVerify.includes('integrity=ok'), '清除 sidecar 后应健康');
        } finally {
            rmSync(plainDir, { recursive: true, force: true });
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 测试入口：串行执行 8 个用例。
 */
async function main(): Promise<void> {
    await caseHealthyVerify();
    await caseCorruptRestore();
    await caseForbiddenVariants();
    await caseMissingRejects();
    await caseLockRefused();
    await caseConcurrentBusy();
    await caseBackupPrerequisite();
    await caseWalSnapshotRestore();
}

export default main();
