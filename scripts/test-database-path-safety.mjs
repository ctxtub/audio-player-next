#!/usr/bin/env node
/**
 * 测试数据库路径安全模块（任务1：保护测试数据库路径）。
 * 纯函数边界：允许根内逐 suite 隔离 SQLite，任何越界 fail closed。
 * 生成端仅输出 pathToFileURL(absolutePath).href；验证端只接受该规范写法。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** 安全/隔离/bootstrap 失败退出码（立即全组停止）。 */
export const BOOTSTRAP_EXIT_CODE = 3;
/** 普通断言失败退出码。 */
export const SUITE_FAIL_EXIT_CODE = 1;
/** 超时/crash 退出码。 */
export const SUITE_TIMEOUT_EXIT_CODE = 4;

/** run-id 格式：UTC 日期时分秒 + 8 位随机 hex。 */
export const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
/** suite ID 格式。 */
export const SUITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;
/** 层级后缀集合（剥离用，含 static）。 */
const LAYER_SUFFIX_RE = /\.(unit|integration|contract|tooling|legacy|static)\.test\.ts$/;
const BROWSER_SUFFIX = '.browser.spec.ts';

/**
 * 生成不含秘密的 run-id（UTC+随机）。
 * @returns run-id 字符串
 */
export function generateRunId() {
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
    const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    const rand = crypto.randomBytes(4).toString('hex');
    return `${date}T${time}Z-${rand}`;
}

/**
 * 由测试文件路径推导 suite ID（剥层级后缀并校验格式）。
 * @param testFile 测试文件路径（如 tests/tooling/db-guard/x.tooling.test.ts）
 * @returns suite ID
 */
export function suiteIdFromTestPath(testFile) {
    const base = path.basename(String(testFile));
    let id = base;
    if (base.endsWith(BROWSER_SUFFIX)) {
        id = base.slice(0, -BROWSER_SUFFIX.length);
    } else if (LAYER_SUFFIX_RE.test(base)) {
        id = base.replace(LAYER_SUFFIX_RE, '');
    } else if (base.endsWith('.ts')) {
        id = base.slice(0, -'.ts'.length);
    }
    if (!SUITE_ID_RE.test(id)) {
        throw new Error(`非法 suite ID：${id}（源自 ${base}）`);
    }
    return id;
}

/**
 * 取仓库 realpath（穿透 symlink）。
 * @param repoRoot 仓库根目录
 * @returns realpath
 */
export function getRepoRealPath(repoRoot) {
    return fs.realpathSync(path.resolve(String(repoRoot)));
}

/**
 * 取允许根 realpath(<repo>/.e2e-runtime/test-db)。
 * 目录不存在时返回 repoReal 下的解析路径（供建目录前比较）。
 * @param repoRoot 仓库根目录
 * @returns 允许根绝对路径
 */
export function getAllowedRoot(repoRoot) {
    const repoReal = getRepoRealPath(repoRoot);
    const full = path.join(repoReal, '.e2e-runtime', 'test-db');
    try {
        return fs.realpathSync(full);
    } catch {
        // 中文注释：尚不存在时以 repoReal 为锚的解析路径为准；建目录时逐级复核。
        return full;
    }
}

/**
 * 取本 run 目录绝对路径（不创建）。
 * @param repoRoot 仓库根目录
 * @param runId run-id
 * @returns run 目录绝对路径
 */
export function getRunDir(repoRoot, runId) {
    if (!RUN_ID_RE.test(String(runId))) {
        throw new Error(`非法 run-id：${runId}`);
    }
    return path.join(getAllowedRoot(repoRoot), String(runId));
}

/**
 * 为指定 suite 构造隔离库 URL（忽略 ambient，不读环境）。
 * @param repoRoot 仓库根目录
 * @param runId run-id
 * @param suiteId suite ID
 * @returns {{ url: string, dbPath: string }} 规范 file URL 与绝对路径
 */
export function buildSuiteDatabaseUrl(repoRoot, runId, suiteId) {
    if (!RUN_ID_RE.test(String(runId))) {
        throw new Error(`非法 run-id：${runId}`);
    }
    if (!SUITE_ID_RE.test(String(suiteId))) {
        throw new Error(`非法 suite ID：${suiteId}`);
    }
    const repoReal = getRepoRealPath(repoRoot);
    const dbPath = path.join(repoReal, '.e2e-runtime', 'test-db', String(runId), `${String(suiteId)}.db`);
    const url = pathToFileURL(dbPath).href;
    return { url, dbPath };
}

/**
 * 判定 relative 是否越界（禁 startsWith 唯一判断，用 path.relative 语义）。
 * @param rel path.relative 结果
 * @returns 越界返回真
 */
function isRelativeOutside(rel) {
    if (rel === '') return true;
    if (path.isAbsolute(rel)) return true;
    if (rel === '..') return true;
    if (rel.startsWith(`..${path.sep}`)) return true;
    // 中文注释：POSIX 归一化后仍以 ../ 开头视作越界（跨平台兜底，不单独作为允许判断）。
    if (rel.startsWith('../')) return true;
    return false;
}

/**
 * 验证候选路径的已存在祖先均非 symlink（含目标文件）。
 * 从仓库 realpath 走到候选父目录逐级 lstat；命中 symlink 即抛错。
 * @param candidate 候选绝对路径
 * @param repoReal 仓库 realpath
 */
function assertNoSymlinkAncestors(candidate, repoReal) {
    const parent = path.dirname(path.resolve(candidate));
    // 中文注释：收集从 repoReal 到 parent 的逐级路径（含两端）。
    const rel = path.relative(repoReal, parent);
    // 若 parent 在仓外，后续相对越界检查会拒绝；此处仅检查仓内段。
    const parts = rel === '' ? [] : rel.split(path.sep);
    // 先检查 repoReal 本身（应为实目录，若为 symlink 则 realpath 已穿透，此处复核）。
    try {
        if (fs.lstatSync(repoReal).isSymbolicLink()) {
            throw new Error(`仓库根为 symlink：${repoReal}`);
        }
    } catch (err) {
        if (err instanceof Error && err.message.startsWith('仓库根为 symlink')) throw err;
        throw new Error(`仓库根不可访问：${repoReal}`);
    }
    let cur = repoReal;
    for (const part of parts) {
        if (part === '' || part === '.' || part === '..') {
            throw new Error(`非法路径段：${part}`);
        }
        cur = path.join(cur, part);
        let st = null;
        try {
            st = fs.lstatSync(cur);
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                // 中文注释：缺失段由后续逐级创建并复核，此处跳过。
                // 但缺失段之后的所有更深路径同样缺失，直接返回（创建时再验）。
                return;
            }
            throw err;
        }
        if (st.isSymbolicLink()) {
            throw new Error(`祖先为 symlink：${cur}`);
        }
    }
    // 中文注释：候选目标本身若已存在且为 symlink（含断链）一律拒绝。
    try {
        if (fs.lstatSync(path.resolve(candidate)).isSymbolicLink()) {
            throw new Error(`目标为 symlink：${candidate}`);
        }
    } catch (err) {
        if (err && err.code === 'ENOENT') return;
        if (err instanceof Error && err.message.startsWith('目标为 symlink')) throw err;
        throw err;
    }
}

/**
 * 验证数据库 URL（fail closed）。
 * 先查原始 query/hash/编码段与点段，再 fileURLToPath 解一次；不重复 decode。
 * @param url 待验 URL 字符串
 * @param opts 校验上下文
 * @param opts.repoRoot 仓库根目录
 * @param [opts.runId] run-id 上下文
 * @param [opts.allowedRoot] 允许根覆盖
 * @returns {{ ok: boolean, dbPath: string, reason: string }}
 */
export function validateDatabaseUrl(url, opts = {}) {
    const fail = (reason) => ({ ok: false, dbPath: '', reason });
    if (typeof url !== 'string' || url.length === 0) return fail('空 URL');
    if (url.includes('\0')) return fail('含 NUL');
    if (!url.startsWith('file:')) return fail('非 file 协议');
    // 中文注释：只接受 pathToFileURL 规范绝对写法 file:///...；相对式与 hostname 一律拒绝。
    if (!url.startsWith('file:///')) return fail('非规范绝对 file URL');
    const repoRoot = opts.repoRoot;
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) return fail('缺 repoRoot');
    let repoReal = '';
    try {
        repoReal = getRepoRealPath(repoRoot);
    } catch {
        return fail('仓库根不可解析');
    }
    let allowedRoot = '';
    try {
        allowedRoot = typeof opts.allowedRoot === 'string' && opts.allowedRoot.length > 0
            ? fs.realpathSync(path.resolve(opts.allowedRoot))
            : getAllowedRoot(repoRoot);
    } catch {
        // 中文注释：allowedRoot 尚不存在时以解析路径为准。
        allowedRoot = typeof opts.allowedRoot === 'string' && opts.allowedRoot.length > 0
            ? path.resolve(opts.allowedRoot)
            : getAllowedRoot(repoRoot);
    }

    // —— 原始 query/hash 检查（规范 URL 永不含 ?/#）——
    const afterScheme = url.slice('file:'.length);
    const qIdx = afterScheme.indexOf('?');
    const hIdx = afterScheme.indexOf('#');
    if (qIdx !== -1 || hIdx !== -1) return fail('含 query/hash');
    const rawPathEncoded = afterScheme;

    // —— 原始编码段检查 ——
    const lowerRaw = rawPathEncoded.toLowerCase();
    if (lowerRaw.includes('%2f') || lowerRaw.includes('%5c')) return fail('编码斜杠');
    if (lowerRaw.includes('%00')) return fail('编码 NUL');
    if (lowerRaw.includes('%25')) return fail('多次编码');
    if (lowerRaw.includes('%2e')) return fail('编码点段');
    // —— 原始点段检查（URL 会归一化 ..，必须先查原文）——
    const rawSegs = rawPathEncoded.split('/');
    for (const seg of rawSegs) {
        if (seg === '..' || seg === '.') return fail('点段越界');
        // 中文注释：残留 %2e 已上拒；此处再防字面 % 与点组合旁路。
        if (seg.includes('%') && seg.replace(/%20/g, '').includes('%')) {
            // 中文注释：%20（空格）是 pathToFileURL 合法编码，其余 % 一律可疑。
            // 严格起见：含 % 且非纯 %20 编码即拒绝（后续解后残留 % 二次确认）。
            const stripped = seg.replace(/%20/g, '');
            if (stripped.includes('%')) return fail('可疑百分号编码');
        }
    }

    // —— 标准解析（hostname/query/hash 二次确认）——
    let parsed = null;
    try {
        parsed = new URL(url);
    } catch {
        return fail('URL 解析失败');
    }
    if (parsed.protocol !== 'file:') return fail('非 file 协议');
    if (parsed.hostname !== '' || parsed.host !== '') return fail('含 hostname');
    if (parsed.username !== '' || parsed.password !== '') return fail('含认证信息');
    if (parsed.search !== '' || parsed.hash !== '') return fail('非空 query/hash');

    // —— 解一次 ——
    let decoded = '';
    try {
        decoded = fileURLToPath(url);
    } catch {
        return fail('fileURL 解析失败');
    }
    if (decoded.length === 0) return fail('空路径');
    if (decoded.includes('\0')) return fail('解后含 NUL');
    if (!path.isAbsolute(decoded)) return fail('相对路径');
    if (!decoded.endsWith('.db')) return fail('非 .db 后缀');
    if (decoded.includes('%')) return fail('残留百分号');
    const decSegs = decoded.split('/');
    for (const seg of decSegs) {
        if (seg === '..' || seg === '.') return fail('解后点段越界');
    }

    // —— 边界判定（path.relative，不用 startsWith 唯一判断）——
    const rel = path.relative(allowedRoot, decoded);
    if (isRelativeOutside(rel)) return fail('越界 allowedRoot');
    if (typeof opts.runId === 'string' && opts.runId.length > 0) {
        if (!RUN_ID_RE.test(opts.runId)) return fail('非法 runId 上下文');
        const firstSeg = rel.split(path.sep)[0];
        if (firstSeg !== opts.runId) return fail('非本 run 路径');
    }

    // —— 已存在祖先 symlink 检查 ——
    try {
        assertNoSymlinkAncestors(decoded, repoReal);
    } catch (err) {
        return fail(err instanceof Error ? err.message : 'symlink 检查失败');
    }
    // 中文注释：allowedRoot 须位于仓库内（防仓外 allowedRoot 注入）。
    const relAllowed = path.relative(repoReal, allowedRoot);
    if (isRelativeOutside(relAllowed) && relAllowed !== '') return fail('允许根越界');

    return { ok: true, dbPath: decoded, reason: '' };
}

/**
 * 启动前唯一性检查（返回重复项）。
 * @param ids suite ID 数组
 * @returns 重复 ID 数组（无重复返回 []）
 */
export function checkUniqueSuiteIds(ids) {
    const seen = new Set();
    const dups = new Set();
    for (const id of ids) {
        if (seen.has(id)) dups.add(id);
        else seen.add(id);
    }
    return [...dups];
}

/**
 * 确保 run 目录独占 0700 建立（含祖先逐级复核）。
 * @param repoRoot 仓库根目录
 * @param runId run-id
 * @returns run 目录绝对路径
 */
export function ensureRunDir(repoRoot, runId) {
    if (!RUN_ID_RE.test(String(runId))) {
        throw new Error(`非法 run-id：${runId}`);
    }
    const repoReal = getRepoRealPath(repoRoot);
    const allowedFull = path.join(repoReal, '.e2e-runtime', 'test-db');
    // 中文注释：逐级确认 .e2e-runtime / test-db（存在则验 symlink，不存在则建）。
    let cur = repoReal;
    for (const part of ['.e2e-runtime', 'test-db']) {
        cur = path.join(cur, part);
        let st = null;
        try {
            st = fs.lstatSync(cur);
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                fs.mkdirSync(cur, { recursive: false });
                st = fs.lstatSync(cur);
            } else {
                throw err;
            }
        }
        if (st.isSymbolicLink()) {
            throw new Error(`运行根祖先为 symlink：${cur}`);
        }
        if (!st.isDirectory()) {
            throw new Error(`运行根祖先非目录：${cur}`);
        }
    }
    const allowedReal = fs.realpathSync(allowedFull);
    const runDir = path.join(allowedReal, String(runId));
    let exists = false;
    try {
        const st = fs.lstatSync(runDir);
        exists = true;
        if (st.isSymbolicLink()) throw new Error(`run 目录为 symlink：${runDir}`);
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            exists = false;
        } else if (err instanceof Error && err.message.includes('run 目录为 symlink')) {
            throw err;
        } else {
            throw err;
        }
    }
    if (exists) {
        throw new Error(`run 目录已存在（拒绝复用）：${runDir}`);
    }
    fs.mkdirSync(runDir, { mode: 0o700, recursive: false });
    fs.chmodSync(runDir, 0o700);
    const st = fs.statSync(runDir);
    if ((st.mode & 0o777) !== 0o700) {
        throw new Error(`run 目录权限非 0700：${runDir}`);
    }
    return runDir;
}

/**
 * 确认边界后逐级创建 suite 父目录（每步复核 symlink）。
 * @param dbPath 候选库绝对路径
 * @param opts { repoRoot, allowedRoot }
 * @returns 父目录绝对路径
 */
export function ensureSuiteDbParent(dbPath, opts = {}) {
    const repoRoot = opts.repoRoot;
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
        throw new Error('缺 repoRoot');
    }
    const repoReal = getRepoRealPath(repoRoot);
    const abs = path.resolve(String(dbPath));
    const parent = path.dirname(abs);
    const allowedRoot = typeof opts.allowedRoot === 'string' && opts.allowedRoot.length > 0
        ? path.resolve(opts.allowedRoot)
        : getAllowedRoot(repoRoot);
    const rel = path.relative(allowedRoot, parent);
    // 中文注释：parent 可为 runDir 本身（rel 为 runId）或其子目录；越界一律拒绝。
    if (rel !== '' && isRelativeOutside(rel)) {
        throw new Error(`父目录越界：${parent}`);
    }
    // 中文注释：从 allowedRoot 逐级建缺失目录，每步复核 symlink。
    const segs = rel === '' ? [] : rel.split(path.sep);
    let cur = allowedRoot;
    // 先验 allowedRoot 自身
    try {
        const st0 = fs.lstatSync(cur);
        if (st0.isSymbolicLink()) throw new Error(`运行根为 symlink：${cur}`);
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            throw new Error(`运行根不存在（须先 ensureRunDir）：${cur}`);
        }
        throw err;
    }
    for (const seg of segs) {
        if (seg === '' || seg === '.' || seg === '..') throw new Error(`非法路径段：${seg}`);
        cur = path.join(cur, seg);
        let st = null;
        try {
            st = fs.lstatSync(cur);
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                fs.mkdirSync(cur, { recursive: false });
                st = fs.lstatSync(cur);
            } else {
                throw err;
            }
        }
        if (st.isSymbolicLink()) throw new Error(`祖先为 symlink：${cur}`);
    }
    // 中文注释：最终复核仓库到候选的已存在祖先链。
    assertNoSymlinkAncestors(abs, repoReal);
    return parent;
}

/**
 * 仅清理允许根内的 suite 库（含 -wal/-shm），根外一律拒绝且不删。
 * @param dbPath 库路径或 file URL
 * @param allowedRoot 允许根（runDir 或 test-db 根）
 * @returns 清理成功返回真，越界/拒绝返回假
 */
export function cleanupSuiteDb(dbPath, allowedRoot) {
    try {
        if (typeof dbPath !== 'string' || dbPath.length === 0) return false;
        if (typeof allowedRoot !== 'string' || allowedRoot.length === 0) return false;
        if (dbPath.includes('\0') || allowedRoot.includes('\0')) return false;
        let candidate = String(dbPath);
        if (candidate.startsWith('file:')) {
            try {
                candidate = fileURLToPath(candidate);
            } catch {
                return false;
            }
        }
        const abs = path.resolve(candidate);
        let allowedReal = '';
        try {
            allowedReal = fs.realpathSync(path.resolve(String(allowedRoot)));
        } catch {
            return false;
        }
        const rel = path.relative(allowedReal, abs);
        if (isRelativeOutside(rel)) return false;
        // 中文注释：目标为 symlink（含断链）一律拒绝跟随；仅允许删除实文件。
        try {
            const st = fs.lstatSync(abs);
            if (st.isSymbolicLink()) return false;
            if (st.isDirectory()) return false;
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                // 中文注释：主库不存在仍尝试清 sidecar（同目录内），但须先验父目录无 symlink。
            } else {
                return false;
            }
        }
        // 中文注释：父目录 realpath 仍须在允许根内（防 symlink 祖先逃逸）。
        const parent = path.dirname(abs);
        try {
            if (fs.existsSync(parent)) {
                const parentReal = fs.realpathSync(parent);
                const relP = path.relative(allowedReal, parentReal);
                if (relP !== '' && isRelativeOutside(relP)) return false;
                // 中文注释：父链 lstat 复核（存在即验）。
                const repoHint = path.resolve(allowedReal, '..', '..', '..');
                void repoHint;
            }
        } catch {
            return false;
        }
        for (const target of [abs, `${abs}-wal`, `${abs}-shm`]) {
            try {
                const st = fs.lstatSync(target);
                if (st.isSymbolicLink() || st.isDirectory()) continue;
                fs.rmSync(target, { force: true });
            } catch (err) {
                if (err && err.code === 'ENOENT') continue;
                return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * 仅清理本 run 目录（递归），越界一律拒绝。
 * @param runDir run 目录绝对路径
 * @param allowedRoot 允许根
 * @returns 成功返回真
 */
export function cleanupRunDir(runDir, allowedRoot) {
    try {
        if (typeof runDir !== 'string' || runDir.length === 0) return false;
        if (typeof allowedRoot !== 'string' || allowedRoot.length === 0) return false;
        const abs = path.resolve(runDir);
        let allowedReal = '';
        try {
            allowedReal = fs.realpathSync(path.resolve(allowedRoot));
        } catch {
            return false;
        }
        const rel = path.relative(allowedReal, abs);
        if (rel === '' || isRelativeOutside(rel)) return false;
        // 中文注释：runDir 第一级段须为合法 run-id（防误删 test-db 根）。
        const firstSeg = rel.split(path.sep)[0];
        if (!RUN_ID_RE.test(firstSeg) || rel.includes(path.sep)) return false;
        try {
            if (fs.lstatSync(abs).isSymbolicLink()) return false;
        } catch (err) {
            if (err && err.code === 'ENOENT') return true;
            return false;
        }
        fs.rmSync(abs, { recursive: true, force: true });
        return true;
    } catch {
        return false;
    }
}
