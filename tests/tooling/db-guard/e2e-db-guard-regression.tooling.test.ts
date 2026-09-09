import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

/**
 * e2e-db-guard 写库单元端到端回归验证（缺陷 #10，最终项，测试基建）。
 *
 * 背景：E2E 写库单元（06-07 seed/gc）曾与常驻 app dev server 并发写同一 SQLite 库，
 * 致 GuestChatMessage 页损坏（LOST）。缺陷 #6 已交付 guard（check→snapshot→write→
 * verify、busy_timeout=5000、单连接、阶段 integrity_check、LOCKED/BACKUP_REQUIRED
 * 拒绝），本测试按 docs/e2e/execution-isolation.md §10 流程，用 guard 对隔离库执行
 * 完整写库单元演练（语义复刻 .e2e-runtime/e2e-06-07-seed.mts 与 e2e-06-07-gc.mts，
 * 不导入应用代码、不启动服务）。
 *
 * 覆盖行为：
 * RED（旧风险基线，永久钉住损坏机制）：
 * 1. 排他锁下裸并发写得 SQLITE_BUSY——证明旧式并发写路径不被许可（损坏风险源）。
 * 2. 同一锁下 guard check/write/snapshot 一律 LOCKED 拒绝——证明 guard 会拦截而非硬写；
 *    释放后 check 恢复 guard=ok。
 * 3. 无快照时 guard write 得 BACKUP_REQUIRED——证明强制备份前置，未备份不得写库。
 * GREEN（§10 完整写库单元演练，Guest* 五表 A/B 组语义）：
 * 4. check→snapshot→串行 seed 写（五表 × A/B 组，一次一条语句，每表一阶段 verify）→
 *    integrity=ok 且 A/B 行齐备（复刻 06-07 seed：A 组 31 天前应被默认 GC 删除，
 *    B 组 1 天前应被默认 GC 保留）。
 * 5. GC 第一阶段 purge（删 A 组，复刻默认 30 天 purge）→verify→仅剩 B 组。
 * 6. GC 第二阶段 purge（删 B 组，复刻显式 cutoff 全清）→verify→前缀零残留。
 * 7. 快照/校验/恢复链路：restore 种子快照后数据回到快照时刻；随后单独损坏→verify
 *    失败→restore→integrity=ok，证明损坏可回退。
 * 8. 共享库形似誘饵（tmp 内 prisma/dev.db）check 得 FORBIDDEN——证明演练绝不触碰真实开发库。
 *
 * 隔离约束：全程仅临时目录隔离库（tmp 沙盒，DDL 自建 Guest* 五表最小列集）；
 * 禁止触碰 :9301 / :31111 / :38080 / 真实 prisma/dev.db / 既有 .e2e-runtime 资产 /
 * 真实 .env*；不写任何密钥（guestId 仅用仓库可见假前缀 g_gcseed_）。
 */

// 中文注释：仓库根目录（仅用于解析被测脚本路径，不读取真实开发库）。
const repoRoot: string = process.cwd();
// 中文注释：被测守卫脚本（仓库跟踪资产，缺陷 #6）。
const guardScript: string = path.join(repoRoot, 'scripts', 'e2e-db-guard.mjs');
// 中文注释：串行写连接的忙等待标记（与守卫脚本内常量一致，串行约束证据）。
const expectedBusyTimeout: string = 'busy_timeout=5000';
// 中文注释：演练用访客假 ID 前缀（仓库可见假数据，与既有 e2e/真实数据零冲突）。
const seedPrefix: string = 'g_gcseed_';
// 中文注释：A 组访客（31 天前行，默认 GC 应删除；复刻 e2e-06-07-seed.mts）。
const guestA: string = 'g_gcseed_a1';
// 中文注释：B 组访客（1 天前行，默认 GC 应保留；复刻 e2e-06-07-seed.mts）。
const guestB: string = 'g_gcseed_b1';
// 中文注释：演练涉及的 Guest* 五表（与 prisma/schema.prisma 表名一致）。
const guestTables: string[] = [
    'GuestConfig',
    'GuestChatMessage',
    'GuestGenerationHistory',
    'GuestPromptHistory',
    'GuestPlaybackProgress',
];

/**
 * 在隔离库上自建 Guest* 五表最小列集（列名与 Prisma 映射一致，仅服务本演练断言）。
 * @param dbPath 隔离库文件路径。
 */
async function buildGuestSchema(dbPath: string): Promise<void> {
    const db = createClient({ url: `file:${dbPath}` });
    try {
        await db.execute(
            'CREATE TABLE "GuestConfig"(id INTEGER PRIMARY KEY AUTOINCREMENT, "guestId" TEXT UNIQUE NOT NULL, "updatedAt" TEXT NOT NULL)',
        );
        await db.execute(
            'CREATE TABLE "GuestChatMessage"(id INTEGER PRIMARY KEY AUTOINCREMENT, "guestId" TEXT NOT NULL, "position" INTEGER NOT NULL, "messageId" TEXT NOT NULL, "role" TEXT NOT NULL, "content" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)',
        );
        await db.execute(
            'CREATE TABLE "GuestGenerationHistory"(id INTEGER PRIMARY KEY AUTOINCREMENT, "guestId" TEXT NOT NULL, "prompt" TEXT NOT NULL, "storyText" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)',
        );
        await db.execute(
            'CREATE TABLE "GuestPromptHistory"(id INTEGER PRIMARY KEY AUTOINCREMENT, "guestId" TEXT NOT NULL, "prompt" TEXT NOT NULL, "lastUsed" TEXT NOT NULL, "useCount" INTEGER DEFAULT 1, "updatedAt" TEXT NOT NULL, UNIQUE("guestId","prompt"))',
        );
        await db.execute(
            'CREATE TABLE "GuestPlaybackProgress"(id INTEGER PRIMARY KEY AUTOINCREMENT, "guestId" TEXT UNIQUE NOT NULL, "sourceType" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "title" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)',
        );
    } finally {
        db.close();
    }
}

/**
 * 统计隔离库五表中本演练前缀行的 guest 分布（只读复核）。
 * @param dbPath 隔离库文件路径。
 * @returns 每表 guestId 列表（已排序）。
 */
async function readSeedGuests(dbPath: string): Promise<Record<string, string[]>> {
    const db = createClient({ url: `file:${dbPath}` });
    try {
        const out: Record<string, string[]> = {};
        for (const table of guestTables) {
            const rs = await db.execute({
                sql: `SELECT "guestId" FROM "${table}" WHERE "guestId" LIKE 'g_gcseed_%' ORDER BY "guestId"`,
                args: [],
            });
            out[table] = rs.rows.map((r) => String(r[0])).sort();
        }
        return out;
    } finally {
        db.close();
    }
}

/**
 * 断言五表 guest 分布与期望一致。
 * @param actual 实际分布。
 * @param expected 期望的每表 guest 列表。
 */
function assertGuestSpread(actual: Record<string, string[]>, expected: string[]): void {
    for (const table of guestTables) {
        assert.deepStrictEqual(actual[table], [...expected].sort(), `${table} 的 seed 行分布不符`);
    }
}

/**
 * 取守卫 snapshot 命令末行输出的快照路径。
 * @param dbPath 隔离库文件路径。
 * @param dir 快照目录（与库同目录，满足备份前置同目录约束）。
 * @returns 快照文件绝对路径。
 */
function takeSnapshot(dbPath: string, dir: string): string {
    const snapOut: string = execFileSync('node', [guardScript, 'snapshot', dbPath, '--dest', dir], {
        encoding: 'utf8',
    });
    const snapPath: string = snapOut.trim().split('\n').pop() ?? '';
    assert.ok(snapPath.endsWith('.db'), `快照应输出快照路径，实际=${snapOut}`);
    assert.ok(snapOut.includes('snapshot='), `快照输出应含 snapshot= 行，实际=${snapOut}`);
    return snapPath;
}

/**
 * 经 guard 执行串行单连接写并断言串行约束与阶段校验证据。
 * @param dbPath 隔离库文件路径。
 * @param sql 单条写 SQL。
 * @returns guard 输出（含 busy_timeout 与 integrity 证据）。
 */
function guardWrite(dbPath: string, sql: string): string {
    const out: string = execFileSync('node', [guardScript, 'write', dbPath, sql], { encoding: 'utf8' });
    assert.ok(out.includes(expectedBusyTimeout), `串行写应设置 busy_timeout，实际=${out}`);
    assert.ok(out.includes('write=ok integrity=ok'), `写后同连接 integrity_check 应 ok，实际=${out}`);
    return out;
}

/**
 * 经 guard 执行阶段校验并断言通过。
 * @param dbPath 隔离库文件路径。
 */
function guardVerify(dbPath: string): void {
    const out: string = execFileSync('node', [guardScript, 'verify', dbPath], { encoding: 'utf8' });
    assert.ok(out.includes('integrity=ok'), `阶段校验应 integrity=ok，实际=${out}`);
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
 * 用例 RED-1：排他锁下裸并发写得 SQLITE_BUSY（旧路径风险），guard 一律 LOCKED 拦截。
 */
async function caseRedConcurrentIntercept(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd10-regress-'));
    try {
        const dbPath: string = path.join(dir, 'race.db');
        await buildGuestSchema(dbPath);
        // 中文注释：持排他锁的写者模拟常驻 app 写事务（不提交，保持占用）。
        const holder = createClient({ url: `file:${dbPath}` });
        try {
            await holder.execute('BEGIN EXCLUSIVE');
            await holder.execute(`INSERT INTO "GuestConfig"("guestId","updatedAt") VALUES ('${seedPrefix}held','now')`);
            // 中文注释：无 guard 的竞争写必须被拒绝（SQLITE_BUSY），钉住旧并发路径的损坏风险。
            const rival = createClient({ url: `file:${dbPath}` });
            try {
                await rival.execute('PRAGMA busy_timeout=0');
                await rival.execute(`INSERT INTO "GuestConfig"("guestId","updatedAt") VALUES ('${seedPrefix}rival','now')`);
                assert.fail('裸并发写应得 SQLITE_BUSY');
            } catch (err: unknown) {
                const msg: string = err instanceof Error ? err.message : String(err);
                assert.ok(msg.includes('BUSY'), `竞争写应 SQLITE_BUSY，实际=${msg.slice(0, 200)}`);
            } finally {
                rival.close();
            }
            // 中文注释：guard 同样拒绝硬写/硬拷，而非排队覆盖（§10 排他守卫）。
            const outCheck: string = expectGuardFail('check', dbPath);
            assert.ok(outCheck.includes('LOCKED'), `锁定时 check 应 LOCKED，实际=${outCheck}`);
            const outWrite: string = expectGuardFail('write', dbPath, 'INSERT INTO "GuestConfig" VALUES (null,\'x\',\'now\')');
            assert.ok(outWrite.includes('LOCKED'), `锁定时 guard 写应 LOCKED，实际=${outWrite}`);
            const outSnap: string = expectGuardFail('snapshot', dbPath);
            assert.ok(outSnap.includes('LOCKED'), `锁定时 snapshot 应 LOCKED，实际=${outSnap}`);
            await holder.execute('ROLLBACK');
        } finally {
            holder.close();
        }
        // 中文注释：释放后准入恢复，证明拒绝源于并发占用而非库损坏。
        const checkOut: string = execFileSync('node', [guardScript, 'check', dbPath], { encoding: 'utf8' });
        assert.ok(checkOut.includes('guard=ok'), `释放后 check 应通过，实际=${checkOut}`);
        guardVerify(dbPath);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 用例 RED-2：无快照时 guard 写得 BACKUP_REQUIRED（强制备份前置）。
 */
async function caseRedBackupRequired(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd10-regress-'));
    try {
        const dbPath: string = path.join(dir, 'fresh.db');
        await buildGuestSchema(dbPath);
        const outWrite: string = expectGuardFail(
            'write',
            dbPath,
            `INSERT INTO "GuestConfig"("guestId","updatedAt") VALUES ('${seedPrefix}early','now')`,
        );
        assert.ok(outWrite.includes('BACKUP_REQUIRED'), `无快照写库应 BACKUP_REQUIRED，实际=${outWrite}`);
        const spread: Record<string, string[]> = await readSeedGuests(dbPath);
        assertGuestSpread(spread, []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 用例 GREEN：§10 完整写库单元演练（seed→GC 两阶段 purge→快照恢复→损坏回退）。
 */
async function caseGreenFullWriteUnit(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd10-regress-'));
    try {
        const dbPath: string = path.join(dir, 'drill.db');
        await buildGuestSchema(dbPath);
        const oldStamp: string = new Date(Date.now() - 31 * 86400e3).toISOString();
        const freshStamp: string = new Date(Date.now() - 1 * 86400e3).toISOString();

        // 中文注释：§10 阶段 1——准入 check（无并发时通过）。
        const checkOut: string = execFileSync('node', [guardScript, 'check', dbPath], { encoding: 'utf8' });
        assert.ok(checkOut.includes('guard=ok'), `无并发时 check 应通过，实际=${checkOut}`);

        // 中文注释：§10 阶段 2——写前 snapshot（空 schema 基线，末行输出快照路径）。
        takeSnapshot(dbPath, dir);

        // 中文注释：§10 阶段 3——串行 seed 写（复刻 06-07 seed：五表 × A/B 组，一次一条语句，每表一阶段 verify）。
        guardWrite(dbPath, `INSERT INTO "GuestConfig"("guestId","updatedAt") VALUES ('${guestA}','${oldStamp}')`);
        guardWrite(dbPath, `INSERT INTO "GuestConfig"("guestId","updatedAt") VALUES ('${guestB}','${freshStamp}')`);
        guardVerify(dbPath);
        guardWrite(
            dbPath,
            `INSERT INTO "GuestChatMessage"("guestId","position","messageId","role","content","updatedAt") VALUES ('${guestA}',0,'${guestA}_m1','user','E2E-06-07 A组聊天','${oldStamp}')`,
        );
        guardWrite(
            dbPath,
            `INSERT INTO "GuestChatMessage"("guestId","position","messageId","role","content","updatedAt") VALUES ('${guestB}',0,'${guestB}_m1','user','E2E-06-07 B组聊天','${freshStamp}')`,
        );
        guardVerify(dbPath);
        guardWrite(
            dbPath,
            `INSERT INTO "GuestGenerationHistory"("guestId","prompt","storyText","updatedAt") VALUES ('${guestA}','E2E-06-07 A组生成提示词','E2E-06-07 A组故事正文','${oldStamp}')`,
        );
        guardWrite(
            dbPath,
            `INSERT INTO "GuestGenerationHistory"("guestId","prompt","storyText","updatedAt") VALUES ('${guestB}','E2E-06-07 B组生成提示词','E2E-06-07 B组故事正文','${freshStamp}')`,
        );
        guardVerify(dbPath);
        guardWrite(
            dbPath,
            `INSERT INTO "GuestPromptHistory"("guestId","prompt","lastUsed","updatedAt") VALUES ('${guestA}','E2E-06-07 A组提示词','${oldStamp}','${oldStamp}')`,
        );
        guardWrite(
            dbPath,
            `INSERT INTO "GuestPromptHistory"("guestId","prompt","lastUsed","updatedAt") VALUES ('${guestB}','E2E-06-07 B组提示词','${freshStamp}','${freshStamp}')`,
        );
        guardVerify(dbPath);
        guardWrite(
            dbPath,
            `INSERT INTO "GuestPlaybackProgress"("guestId","sourceType","sourceId","title","updatedAt") VALUES ('${guestA}','chat','${guestA}_m1','E2E-06-07 A组进度','${oldStamp}')`,
        );
        guardWrite(
            dbPath,
            `INSERT INTO "GuestPlaybackProgress"("guestId","sourceType","sourceId","title","updatedAt") VALUES ('${guestB}','chat','${guestB}_m1','E2E-06-07 B组进度','${freshStamp}')`,
        );
        guardVerify(dbPath);
        assertGuestSpread(await readSeedGuests(dbPath), [guestA, guestB]);

        // 中文注释：种子完成快照（GC 前基线，供恢复链路证明）。
        const seedSnap: string = takeSnapshot(dbPath, dir);

        // 中文注释：GC 第一阶段 purge（复刻默认 30 天 purge：删 31 天前 A 组，保留 1 天前 B 组）。
        for (const table of guestTables) {
            guardWrite(dbPath, `DELETE FROM "${table}" WHERE "guestId"='${guestA}'`);
        }
        guardVerify(dbPath);
        assertGuestSpread(await readSeedGuests(dbPath), [guestB]);

        // 中文注释：GC 第二阶段 purge（复刻显式 cutoff 全清：删剩余 B 组）。
        for (const table of guestTables) {
            guardWrite(dbPath, `DELETE FROM "${table}" WHERE "guestId"='${guestB}'`);
        }
        guardVerify(dbPath);
        assertGuestSpread(await readSeedGuests(dbPath), []);

        // 中文注释：恢复链路——restore 种子快照后数据回到快照时刻（A/B 行齐备且健康）。
        execFileSync('node', [guardScript, 'restore', seedSnap, dbPath], { encoding: 'utf8' });
        guardVerify(dbPath);
        assertGuestSpread(await readSeedGuests(dbPath), [guestA, guestB]);

        // 中文注释：损坏回退——截断库头模拟页损坏（06-07 首轮 GuestChatMessage 页 LOST 的等价破坏），
        // verify 必须失败，随后 restore 同一快照恢复健康与数据。
        execFileSync('node', ['-e', `require('node:fs').writeFileSync(${JSON.stringify(dbPath)}, Buffer.alloc(512, 0))`]);
        const outBroken: string = expectGuardFail('verify', dbPath);
        assert.ok(outBroken.includes('integrity=ERROR'), `损坏库 verify 应失败，实际=${outBroken}`);
        execFileSync('node', [guardScript, 'restore', seedSnap, dbPath], { encoding: 'utf8' });
        guardVerify(dbPath);
        assertGuestSpread(await readSeedGuests(dbPath), [guestA, guestB]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 用例 GUARDRAIL：tmp 内共享库形似誘饵一律 FORBIDDEN（演练绝不触碰真实开发库）。
 */
async function caseGuardrailForbiddenDecoy(): Promise<void> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd10-regress-'));
    try {
        // 中文注释：tmp 沙盒誘饵（形如 prisma/dev.db，绝非真实开发库；全程不 stat 真实库）。
        const decoy: string = path.join(dir, 'sandbox', 'prisma', 'dev.db');
        mkdirSync(path.dirname(decoy), { recursive: true });
        writeFileSync(decoy, 'decoy-not-real-dev-db');
        const before: number = existsSync(decoy) ? 1 : 0;
        const outCheck: string = expectGuardFail('check', decoy);
        assert.ok(outCheck.includes('FORBIDDEN'), `沙盒开发库 check 应 FORBIDDEN，实际=${outCheck}`);
        assert.ok(existsSync(decoy) && before === 1, '誘饵拒绝后不得被删除');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 测试入口：串行执行 RED 基线与 GREEN 演练（同一隔离约束）。
 */
async function main(): Promise<void> {
    await caseRedConcurrentIntercept();
    await caseRedBackupRequired();
    await caseGreenFullWriteUnit();
    await caseGuardrailForbiddenDecoy();
}

export default main();
