#!/usr/bin/env node
/**
 * E2E 写库单元防损坏守卫（仓库跟踪资产，缺陷 #6）。
 *
 * 背景：06-07 首轮 app dev server 常驻持有 e2e.db 连接时，并发 seed 写曾致页损坏；
 * 续作轮以「写前快照 + 串行单连接 + 每阶段 integrity_check」规避成功。本脚本把其中
 * 可强制的部分固化为标准命令，配合执行隔离规范使用。
 *
 * 用法（DB 路径一律隔离库，严禁 prisma/dev.db 与生产库）：
 *   node scripts/e2e-db-guard.mjs snapshot <db> [--dest dir]  # 写前快照（排他守卫+WAL sidecar），末行输出快照路径
 *   node scripts/e2e-db-guard.mjs verify <db>                 # integrity_check，通过输出 integrity=ok
 *   node scripts/e2e-db-guard.mjs restore <snap> <db>         # 快照回退（排他守卫+sidecar 同步）
 *   node scripts/e2e-db-guard.mjs check <db>                  # 准入检查：共享/错误库拒绝，受管 app 占用拒绝
 *   node scripts/e2e-db-guard.mjs write <db> "<sql>"          # 串行单连接写库（需先 snapshot 备份）
 *
 * 标准流程（详见 docs/e2e/execution-isolation.md §10）：
 *   check → snapshot → write（单连接，PRAGMA busy_timeout=5000）→ verify；
 *   任一阶段 verify 失败即 restore 后中止。
 *
 * 强制约束：
 * - 路径解析先剥离 `file:` 前缀与 query/fragment，再做大小写不敏感规范比较；
 *   已存在路径（含 symlink）经 realpath 穿透后同样禁行，杜绝别名绕过。
 * - 缺失库在建连接前拒绝（check/verify/snapshot/write/restore 一致），libsql
 *   不得借机创建空库文件。
 * - snapshot/restore 与 write 受同一排他守卫约束（锁标记/环境锁/活跃排他锁下 LOCKED 拒绝）。
 * - snapshot 仅在确认无锁后拷贝主库并附带 -wal/-shm；restore 按快照恢复 sidecar，
 *   快照中不存在的 sidecar 在目标库上清除。
 * - write 强制备份前置：目标库同目录无 `.snap-*.db` 快照时 BACKUP_REQUIRED 拒绝。
 *
 * 串行约束说明：Prisma 写库 URL 追加 `?busy_timeout=5000&connection_limit=1`；
 * 本脚本侧以「单 client + PRAGMA busy_timeout=5000 + 一次一条语句」等价串行，
 * 绝不并行打开第二个写连接。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

/** 命令行参数（不含 node 与脚本名）。 */
const args = process.argv.slice(2);
/** 子命令。 */
const cmd = args[0];

/** 写连接等待锁释放的毫秒数（串行约束核心参数）。 */
const BUSY_TIMEOUT_MS = 5000;
/** 生产库绝对路径（Docker 生产路径，隔离库专用流程严禁触碰）。 */
const PROD_DB_PATH = '/app/data/app.db';
/** SQLite WAL 模式边车文件后缀（快照/回退须与主库一致处理）。 */
const SIDECAR_SUFFIXES = ['-wal', '-shm'];

/**
 * 打印用法并以失败退出。
 */
function usage() {
    console.error(
        '用法：node scripts/e2e-db-guard.mjs snapshot <db> [--dest dir] | verify <db> | restore <snap> <db> | check <db> | write <db> "<sql>"',
    );
    process.exit(1);
}

/**
 * 剥离库 URL 的传输层包装，还原待比较的文件系统路径。
 * 去除 `file:` 前缀（大小写不敏感）与 query/fragment（如 `?busy_timeout=…`），
 * 防止别名写法绕过共享/错误库禁行。
 * @param db 库文件路径或 file: URL。
 * @returns 文件系统路径。
 */
function stripDbUrl(db) {
    let raw = String(db).trim().replace(/^file:/i, '');
    const cut = raw.search(/[?#]/);
    if (cut !== -1) {
        raw = raw.slice(0, cut);
    }
    return raw;
}

/**
 * 规范比较键：绝对路径 + 小写 + 斜杠统一，大小写不敏感比对专用（不用于文件操作）。
 * @param p 文件系统路径。
 * @returns 规范比较键。
 */
function canonicalForCompare(p) {
    return path.resolve(p).toLowerCase().replace(/\\/g, '/');
}

/**
 * 判断库路径是否为共享/错误库（开发库与生产库一律拒绝）。
 * 已存在路径（含 symlink）经 realpath 穿透后再判一次，杜绝别名绕过。
 * @param db 库文件路径或 file: URL。
 * @returns 拒绝原因，无问题返回空字符串。
 */
function forbiddenReason(db) {
    const raw = stripDbUrl(db);
    const candidates = [raw];
    try {
        const resolved = realpathSync(raw);
        if (resolved !== raw) {
            candidates.push(resolved);
        }
    } catch {
        // 中文注释：路径不存在或不可解析时仅用字面路径判断；缺失由 assertExists 另行拒绝。
    }
    for (const candidate of candidates) {
        const canon = canonicalForCompare(candidate);
        if (canon === PROD_DB_PATH.toLowerCase() || canon.endsWith('/app/data/app.db')) {
            return `FORBIDDEN 生产库 ${raw}`;
        }
        if (canon.endsWith('/prisma/dev.db') || raw.toLowerCase() === 'prisma/dev.db') {
            return `FORBIDDEN 共享开发库 ${raw}`;
        }
        const base = path.basename(canon);
        if (/^prod.*\.db$/.test(base)) {
            return `FORBIDDEN 疑似生产库 ${raw}`;
        }
    }
    return '';
}

/**
 * 断言库路径可用，被拒绝时直接失败退出（绝不触碰错误库）。
 * @param db 库文件路径。
 */
function assertAllowedDb(db) {
    const reason = forbiddenReason(db);
    if (reason !== '') {
        console.error(`guard=FORBIDDEN ${reason}`);
        process.exit(1);
    }
}

/**
 * 断言库文件存在。所有子命令在创建任何 client 之前调用，
 * 防止 libsql 建连接时顺手创建空库文件。
 * @param db 库文件路径。
 */
function assertExists(db) {
    const fsPath = stripDbUrl(db);
    if (!existsSync(fsPath)) {
        console.error(`guard=MISSING 库文件不存在 ${fsPath}`);
        process.exit(1);
    }
}

/**
 * 查找受管 app 占用标记：库旁 `<db>.lock` 或环境变量指向的锁文件。
 * @param db 库文件路径。
 * @returns 锁文件路径，无占用返回空字符串。
 */
function lockMarker(db) {
    const fsPath = stripDbUrl(db);
    const sibling = `${fsPath}.lock`;
    if (existsSync(sibling)) {
        return sibling;
    }
    const envLock = process.env.E2E_GUARD_APP_LOCK ?? '';
    if (envLock !== '' && existsSync(envLock)) {
        return envLock;
    }
    return '';
}

/**
 * 探测库上是否有活跃写者（受管 app 持排他锁时返回真）。
 * 以 busy_timeout=0 尝试 BEGIN EXCLUSIVE，仅 SQLITE_BUSY 视为被占用；
 * 损坏库等其他错误返回假（损坏由 verify 判定，restore 必须能回退损坏库）。
 * 调用方须先经 assertExists 确保库存在，本函数不处理缺失库。
 * @param db 库文件路径。
 * @returns 被占用返回真。
 */
async function hasActiveWriter(db) {
    const fsPath = stripDbUrl(db);
    let client = null;
    try {
        client = createClient({ url: `file:${fsPath}` });
        await client.execute('PRAGMA busy_timeout=0');
        await client.execute('BEGIN EXCLUSIVE');
        await client.execute('ROLLBACK');
        return false;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return /busy/i.test(msg);
    } finally {
        if (client !== null) {
            client.close();
        }
    }
}

/**
 * 排他守卫：受管标记或活跃排他锁存在时直接失败退出，绝不硬写/硬拷。
 * check/write/snapshot/restore 共用同一守卫。
 * @param db 库文件路径。
 */
async function assertExclusive(db) {
    const marker = lockMarker(db);
    if (marker !== '') {
        console.error(`guard=LOCKED 受管占用 ${marker}`);
        process.exit(1);
    }
    if (await hasActiveWriter(db)) {
        console.error('guard=LOCKED 存在活跃写者，拒绝并发操作');
        process.exit(1);
    }
}

/**
 * 检查目标库同目录是否存在写前快照（`snapshot` 命令产物）。
 * @param db 库文件路径。
 * @returns 存在快照返回真。
 */
function hasBackup(db) {
    const fsPath = stripDbUrl(db);
    const dir = path.dirname(path.resolve(fsPath));
    const base = path.basename(fsPath).replace(/\.db$/i, '');
    let entries = [];
    try {
        entries = readdirSync(dir);
    } catch {
        return false;
    }
    return entries.some((name) => name.startsWith(`${base}.snap-`) && name.endsWith('.db'));
}

/**
 * 强制备份前置：无快照时拒绝写库，要求先执行 snapshot。
 * @param db 库文件路径。
 */
function assertBackup(db) {
    if (!hasBackup(db)) {
        console.error(`guard=BACKUP_REQUIRED 写前须先 snapshot 备份 ${stripDbUrl(db)}`);
        process.exit(1);
    }
}

/**
 * 按快照源同步 sidecar：源存在的 sidecar 拷贝到目标，源不存在的在目标上清除。
 * @param srcFs 源库文件系统路径。
 * @param dstFs 目标库文件系统路径。
 */
function syncSidecars(srcFs, dstFs) {
    for (const suffix of SIDECAR_SUFFIXES) {
        if (existsSync(`${srcFs}${suffix}`)) {
            copyFileSync(`${srcFs}${suffix}`, `${dstFs}${suffix}`);
        } else {
            rmSync(`${dstFs}${suffix}`, { force: true });
        }
    }
}

/**
 * 准入检查：共享/错误库拒绝，缺失库拒绝，受管 app 或活跃写锁占用时拒绝（失败而非硬写）。
 * @param db 库文件路径。
 */
async function doCheck(db) {
    assertAllowedDb(db);
    assertExists(db);
    await assertExclusive(db);
    console.log('guard=ok');
}

/**
 * 写前快照：排他守卫通过（确认无锁）后，复制库文件及 -wal/-shm 并输出快照路径（只读，不改库）。
 * @param db 库文件路径。
 * @param dest 快照目录（缺省与库同目录）。
 * @returns 快照文件路径。
 */
async function doSnapshot(db, dest) {
    assertAllowedDb(db);
    assertExists(db);
    await assertExclusive(db);
    const fsPath = stripDbUrl(db);
    const snapDir = dest ?? path.dirname(path.resolve(fsPath));
    mkdirSync(snapDir, { recursive: true });
    const base = path.basename(fsPath).replace(/\.db$/i, '');
    const snapPath = path.join(snapDir, `${base}.snap-${Date.now()}.db`);
    copyFileSync(fsPath, snapPath);
    syncSidecars(fsPath, snapPath);
    console.log(`snapshot=${snapPath}`);
    console.log(snapPath);
    return snapPath;
}

/**
 * 在已打开的单连接上执行完整性校验。
 * @param client 已打开的 libsql 客户端。
 */
async function verifyOnClient(client) {
    const rs = await client.execute('PRAGMA integrity_check');
    const first = rs.rows.length > 0 ? String(rs.rows[0][0]) : '';
    if (!(rs.rows.length === 1 && first.toLowerCase() === 'ok')) {
        throw new Error(`integrity=CORRUPT rows=${JSON.stringify(rs.rows).slice(0, 500)}`);
    }
}

/**
 * 完整性校验：PRAGMA integrity_check 必须为 ok（缺失库在建连接前拒绝）。
 * @param db 库文件路径。
 */
async function doVerify(db) {
    assertAllowedDb(db);
    assertExists(db);
    const fsPath = stripDbUrl(db);
    let client = null;
    try {
        client = createClient({ url: `file:${fsPath}` });
        await client.execute(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
        await verifyOnClient(client);
        console.log('integrity=ok');
    } catch (err) {
        console.error(`integrity=ERROR ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
        process.exit(1);
    } finally {
        if (client !== null) {
            client.close();
        }
    }
}

/**
 * 快照回退：排他守卫通过后，用快照覆盖目标库并按快照同步 sidecar。
 * @param snap 快照文件路径。
 * @param db 目标库路径。
 */
async function doRestore(snap, db) {
    assertAllowedDb(db);
    const snapFs = stripDbUrl(snap);
    if (!existsSync(snapFs)) {
        console.error(`guard=MISSING 回退失败：快照不存在 ${snapFs}`);
        process.exit(1);
    }
    assertExists(db);
    await assertExclusive(db);
    const fsPath = stripDbUrl(db);
    copyFileSync(snapFs, fsPath);
    syncSidecars(snapFs, fsPath);
    console.log(`restored=${fsPath}`);
}

/**
 * 串行单连接写库：备份前置与排他守卫通过后，仅开一个连接，设置 busy_timeout，
 * 执行一条语句，随即同连接 integrity_check（迁移/seed 每阶段范式）。
 * 锁占用、缺备份或校验失败时直接失败，绝不硬写。
 * @param db 库文件路径。
 * @param sql 单条写 SQL。
 */
async function doWrite(db, sql) {
    assertAllowedDb(db);
    assertExists(db);
    await assertExclusive(db);
    assertBackup(db);
    const fsPath = stripDbUrl(db);
    let client = null;
    try {
        // 中文注释：串行约束——全程只开这一个写连接（等价 connection_limit=1）。
        client = createClient({ url: `file:${fsPath}` });
        await client.execute(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
        const timeoutRs = await client.execute('PRAGMA busy_timeout');
        console.log(`busy_timeout=${String(timeoutRs.rows[0][0])}`);
        await client.execute(sql);
        await verifyOnClient(client);
        console.log('write=ok integrity=ok');
    } catch (err) {
        console.error(`write=ERROR ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
        process.exit(1);
    } finally {
        if (client !== null) {
            client.close();
        }
    }
}

if (cmd === 'snapshot') {
    const db = args[1];
    if (db === undefined || db === '') {
        usage();
    }
    let dest = null;
    const destIdx = args.indexOf('--dest');
    if (destIdx !== -1) {
        dest = args[destIdx + 1];
        if (dest === undefined || dest === '') {
            usage();
        }
    }
    await doSnapshot(db, dest);
} else if (cmd === 'verify') {
    const db = args[1];
    if (db === undefined || db === '') {
        usage();
    }
    await doVerify(db);
} else if (cmd === 'restore') {
    const snap = args[1];
    const db = args[2];
    if (snap === undefined || snap === '' || db === undefined || db === '') {
        usage();
    }
    await doRestore(snap, db);
} else if (cmd === 'check') {
    const db = args[1];
    if (db === undefined || db === '') {
        usage();
    }
    await doCheck(db);
} else if (cmd === 'write') {
    const db = args[1];
    const sql = args[2];
    if (db === undefined || db === '' || sql === undefined || sql === '') {
        usage();
    }
    await doWrite(db, sql);
} else {
    usage();
}
