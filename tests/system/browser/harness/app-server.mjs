/**
 * 浏览器测试 production server 启停管理（任务13 harness）。
 *
 * 复用任务12 spike 验证过的方式：隔离快照 git archive → 合成 SESSION_SECRET +
 * 隔离 DB migrate → next start 随机高位端口（31120-31150 范围取空闲）→
 * health 探测就绪；停止时 kill 子进程树并确认端口释放。
 *
 * 全程函数化：export startAppServer()/stopAppServer()。
 * 快照按 commit 完整 SHA 缓存（.e2e-runtime/browser-harness/snapshots/<sha>/），
 * 每次启动仍使用全新隔离 DB 文件；mock 未显式传入时自动拉起自有 mock
 * （OPENAI_BASE_URL 指向它），stop 时一并回收。
 */

import { spawn, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import {
    existsSync,
    mkdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startMockServer, stopMockServer } from './mock-openai.mjs';

// 中文注释：仓库根（node 运行 cwd；harness 全链路要求以仓库根为 cwd 运行）。
const repoRoot = process.cwd();
// 中文注释：harness 运行时根（gitignore 运行时资产，不入库）。
const runtimeRoot = join(repoRoot, '.e2e-runtime', 'browser-harness');
// 中文注释：应用端口可选范围（含，避开 :31111 dev 与 :9301 既有 mock）。
export const APP_PORT_MIN = 31120;
// 中文注释：应用端口可选范围上限（含）。
export const APP_PORT_MAX = 31150;
// 中文注释：health 就绪探测超时毫秒。
const READY_TIMEOUT_MS = 60000;
// 中文注释：停止后端口释放确认超时毫秒。
const RELEASE_TIMEOUT_MS = 15000;

/**
 * 判断 TCP 端口当前是否无监听。
 * @param port 待查端口
 * @returns 空闲返回 true
 */
export function isPortFree(port) {
    return new Promise((resolve) => {
        const sock = createConnection({ host: '127.0.0.1', port });
        sock.once('connect', () => {
            sock.destroy();
            resolve(false);
        });
        sock.once('error', () => {
            sock.destroy();
            resolve(true);
        });
    });
}

/**
 * 在 31120-31150 范围内取第一个空闲端口。
 * @returns 空闲端口号（全满时抛错）
 */
export async function pickAppPort() {
    for (let port = APP_PORT_MIN; port <= APP_PORT_MAX; port += 1) {
        if (await isPortFree(port)) return port;
    }
    throw new Error(`[app-server] ${APP_PORT_MIN}-${APP_PORT_MAX} 无空闲端口`);
}

/**
 * 取当前 commit 短 SHA（日志/错误信息展示用）。
 * @param cwd 仓库根（缺省模块级 repoRoot；测试可传入临时 git 仓）
 * @returns 短 SHA（取不到时回退 'unknown'）
 */
export function currentShortSha(cwd = repoRoot) {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8', timeout: 30000 }).trim();
    } catch {
        return 'unknown';
    }
}

/**
 * 取当前 commit 完整 SHA（快照缓存键；manifest 与日志均记 full SHA）。
 * @param cwd 仓库根（缺省模块级 repoRoot；测试可传入临时 git 仓）
 * @returns full SHA（取不到时回退 'unknown'；调用方须视 'unknown' 为禁止构建）
 */
export function currentFullSha(cwd = repoRoot) {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 30000 }).trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * 构造守卫失败错误（语义固定为 BLOCKED：环境/供给不可证，不得记 FAIL/FLAKY）。
 * @param reason 原因（仅含短 SHA 与 git 状态行，不含任何 secret/环境值）
 * @returns code 为 'BLOCKED' 的 Error（globalSetup 透出后整轮不跑业务断言）
 */
function blockedError(reason) {
    const err = new Error(`[app-server][BLOCKED] ${reason}`);
    err.code = 'BLOCKED';
    return err;
}

/**
 * 短 SHA 脱敏展示（仅 hex 形值取前 7 位；非 hex 形只记长度，不回显原值防 secret 泄露）。
 * @param value 待展示值
 * @returns 短 SHA 或占位
 */
function safeShortSha(value) {
    const s = String(value ?? '').trim();
    return /^[0-9a-fA-F]{4,40}$/.test(s) ? s.slice(0, 7) : `<non-hex:${s.length}>`;
}

/**
 * 错误首行截断（git 子进程 stderr 仅截首行 200 字符，不透传环境/secret）。
 * @param err 原始错误
 * @returns 截断后首行
 */
function shortErr(err) {
    return String(err?.message ?? err).split('\n')[0].slice(0, 200);
}

/**
 * 快照前置守卫（WS4）：脏 tracked 树与 EXPECTED_TARGET_SHA 失配直接抛 BLOCKED。
 *
 * - 脏 tracked 树：`git status --porcelain=v1 --untracked-files=no` 非空即抛；
 *   信息含前 20 行脏文件状态行（仅路径状态，不打印 secrets）；untracked（`??`）不阻断
 *  （archive 天然排除 `.env` 系/`.db/.next/node_modules`）。
 * - EXPECTED_TARGET_SHA 绑定：显式 expectedSha 或环境变量非空时，`git rev-parse HEAD`
 *   （full）必须与其相等（允许短 SHA 前缀等价匹配，规范要求 full；失配信息仅含
 *   expected/actual 短 SHA，不泄露 secrets）。
 *
 * @param options 选项 { expectedSha?, cwd? }（expectedSha 缺省读 EXPECTED_TARGET_SHA；cwd 缺省仓库根）
 * @returns { fullSha, shortSha, expectedSha } 通过证据（full SHA 供快照键/manifest/日志）
 */
export function assertArchivePreconditions({ expectedSha, cwd } = {}) {
    const root = cwd ?? repoRoot;
    const exp = String(expectedSha ?? process.env.EXPECTED_TARGET_SHA ?? '').trim();
    const full = currentFullSha(root);
    if (!full || full === 'unknown') {
        throw blockedError(`拒绝快照：无法解析 HEAD full SHA（cwd=${root}），unknown 禁止构建`);
    }
    let status = '';
    try {
        status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
            cwd: root,
            encoding: 'utf8',
            timeout: 30000,
        });
    } catch (err) {
        throw blockedError(`拒绝快照：git status 探针失败（commit=${safeShortSha(full)}）：${shortErr(err)}`);
    }
    const lines = status
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0);
    if (lines.length > 0) {
        const shown = lines.slice(0, 20).join('\n');
        const more = lines.length > 20 ? `\n... (+${lines.length - 20} more)` : '';
        throw blockedError(`拒绝快照：tracked 工作树脏（commit=${safeShortSha(full)}，${lines.length} 项）：\n${shown}${more}`);
    }
    if (exp !== '') {
        const ok = full === exp || (exp.length < full.length && full.startsWith(exp));
        if (!ok) {
            throw blockedError(`拒绝快照：EXPECTED_TARGET_SHA 失配（expected=${safeShortSha(exp)} actual=${safeShortSha(full)}）`);
        }
    }
    return { fullSha: full, shortSha: full.slice(0, 7), expectedSha: exp };
}

/**
 * 简单目录锁（mkdir 原子性；超时抛错）。
 * @param lockDir 锁目录路径
 * @param timeoutMs 超时毫秒
 */
async function acquireDirLock(lockDir, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            mkdirSync(lockDir);
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    throw new Error(`[app-server] 取快照锁超时: ${lockDir}`);
}

/**
 * 释放目录锁。
 * @param lockDir 锁目录路径
 */
function releaseDirLock(lockDir) {
    rmSync(lockDir, { recursive: true, force: true });
}

/**
 * 在快照内以合成环境执行命令（数组传参，不走 shell）。
 * @param snapshotDir 快照目录
 * @param bin 可执行文件绝对路径
 * @param args 参数表
 * @param env 合成环境
 */
function runInSnapshot(snapshotDir, bin, args, env) {
    execFileSync(bin, args, { cwd: snapshotDir, env, stdio: 'pipe', timeout: 300000 });
}

/**
 * 确保 commit 级隔离快照就绪（含 production build；命中缓存则跳过）。
 * WS4：取锁之前 fast-path 先验守卫、取锁之后锁内复验守卫 + ready marker（防 TOCTOU）；
 * 脏树即使快照已就绪也拒绝复用。快照键为 full SHA（目录名透传 short/full 均兼容，
 * marker 与日志记 full）；sha 缺失/'unknown' 直接抛 BLOCKED，不得回退缓存。
 * @param sha commit SHA（full；short 透传仅作目录兼容）
 * @param env 合成环境（含 SESSION_SECRET/OPENAI_*，DATABASE_URL 另行按库覆写）
 * @param opts 选项 { cwd?, snapshotBase? }（测试注入用；缺省仓库根与运行时 snapshots）
 * @returns 快照目录
 */
export async function ensureSnapshot(sha, env, opts = {}) {
    const root = opts.cwd ?? repoRoot;
    const snapshotsBase = opts.snapshotBase ?? join(runtimeRoot, 'snapshots');
    if (!sha || sha === 'unknown') {
        throw blockedError('拒绝快照：快照键 unknown 禁止构建（不得回退缓存）');
    }
    // 中文注释：fast-path 先验守卫——脏树即使快照已就绪也拒绝复用。
    assertArchivePreconditions({ cwd: root });
    const snapshotDir = join(snapshotsBase, sha);
    const readyMarker = join(snapshotDir, '.snapshot-ready');
    if (existsSync(readyMarker)) return snapshotDir;
    const lockDir = join(snapshotsBase, `${sha}.lock`);
    mkdirSync(snapshotsBase, { recursive: true });
    await acquireDirLock(lockDir);
    try {
        // 中文注释：锁内复验守卫 + ready marker（防 TOCTOU）。
        assertArchivePreconditions({ cwd: root });
        if (existsSync(readyMarker)) return snapshotDir;
            rmSync(snapshotDir, { recursive: true, force: true });
            mkdirSync(snapshotDir, { recursive: true });
            // 中文注释：仅 tracked 文件进快照（.env*/.db/.next/node_modules 天然排除）。
            const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: root, encoding: 'buffer', timeout: 60000, maxBuffer: 512 * 1024 * 1024 });
            await new Promise((resolve, reject) => {
                const proc = spawn('tar', ['-x', '-C', snapshotDir], { stdio: ['pipe', 'pipe', 'pipe'] });
                proc.on('error', reject);
                proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
                proc.stdin.end(archive);
            });
            // 中文注释：node_modules 只读引用回真仓库（不改真实 node_modules）。
            const nmLink = join(snapshotDir, 'node_modules');
            if (!existsSync(nmLink)) symlinkSync(join(repoRoot, 'node_modules'), nmLink);
            const nodeBin = process.execPath;
            const prismaBin = join(snapshotDir, 'node_modules', '.bin', 'prisma');
            const nextBin = join(snapshotDir, 'node_modules', 'next', 'dist', 'bin', 'next');
            // 中文注释：generated client 系 gitignore 生成物，快照内补 generate（任务12 spike 同款）。
            runInSnapshot(snapshotDir, nodeBin, [prismaBin, 'generate'], env);
            // 中文注释：构建期隔离库（与运行时库分离，仅 build 收集页用）。
            const buildDb = join(snapshotDir, 'prisma', 'harness-build.db');
            rmSync(buildDb, { force: true });
            runInSnapshot(snapshotDir, nodeBin, [prismaBin, 'migrate', 'deploy'], { ...env, DATABASE_URL: `file:${buildDb}` });
            runInSnapshot(snapshotDir, nodeBin, [nextBin, 'build'], { ...env, DATABASE_URL: `file:${buildDb}` });
            // 中文注释：marker 与日志记 full SHA（目录名透传 short/full 均兼容）。
            const builtFull = currentFullSha(root);
            writeFileSync(readyMarker, `${builtFull === 'unknown' ? sha : builtFull}\n`);
            return snapshotDir;
        } finally {
            releaseDirLock(lockDir);
        }
}

/**
 * 构造快照子进程合成环境（隔离库 + 合成 secret + 全合成假上游）。
 * @param dbFile 本次启动独占的隔离库文件
 * @param mockBaseUrl mock 上游 baseURL（如 http://localhost:PORT/v1）
 * @returns 合成环境
 */
function buildSnapshotEnv(dbFile, mockBaseUrl) {
    return {
        ...process.env,
        SESSION_SECRET: randomBytes(32).toString('hex'),
        DATABASE_URL: `file:${dbFile}`,
        OPENAI_API_KEY: 'sk-harness-synthetic',
        OPENAI_MODEL_STORY: 'harness-story-model',
        OPENAI_MODEL_AGENT: 'harness-agent-model',
        OPENAI_BASE_URL: mockBaseUrl,
        OPENAI_TTS_MODEL: 'tts-1',
        OPENAI_TTS_DEFAULT_VOICE: 'alloy',
        OPENAI_TTS_VOICE_LIST: JSON.stringify([
            { value: 'alloy', label: 'Alloy', description: '中性、平衡' },
            { value: 'nova', label: 'Nova', description: '女性、活泼' },
            { value: 'shimmer', label: 'Shimmer', description: '女性、温暖' },
        ]),
    };
}

/**
 * 等待 health 就绪（/ 跟随中间件 307 跳转亦视为就绪）。
 * @param url 应用地址
 */
async function waitReady(url) {
    const start = Date.now();
    let lastStatus = 0;
    while (Date.now() - start < READY_TIMEOUT_MS) {
        try {
            const res = await fetch(url, { redirect: 'manual' });
            await res.arrayBuffer();
            lastStatus = res.status;
            if (res.status === 200 || res.status === 307 || res.status === 308) return;
        } catch {
            lastStatus = 0;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`[app-server] health 探测超时: ${url} lastStatus=${lastStatus}`);
}

/**
 * 等待端口释放。
 * @param port 端口
 */
async function waitReleased(port) {
    const start = Date.now();
    while (Date.now() - start < RELEASE_TIMEOUT_MS) {
        if (await isPortFree(port)) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`[app-server] 端口未释放: ${port}`);
}

/**
 * 杀掉子进程树（先 TERM，超时再 KILL；孤儿 next-server 一并按端口兜底）。
 * @param child 子进程
 */
async function killTree(child) {
    if (!child || child.exitCode !== null) return;
    try {
        // 中文注释：detached 子进程组整体 TERM。
        if (child.pid !== undefined) {
            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch {
                child.kill('SIGTERM');
            }
        } else {
            child.kill('SIGTERM');
        }
    } catch {
        // 中文注释：已死即视为完成。
    }
    const start = Date.now();
    while (child.exitCode === null && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 200));
    }
    if (child.exitCode === null) {
        try {
            if (child.pid !== undefined) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {
                    child.kill('SIGKILL');
                }
            } else {
                child.kill('SIGKILL');
            }
        } catch {
            // 中文注释：已死即视为完成。
        }
    }
}

/**
 * 按信号杀进程组（跨进程回收用，无 ChildProcess 对象时）。
 * @param pgid 进程组 id（即 detached 拉起时的 child.pid）
 * @param label 日志标签
 */
async function killPgroup(pgid, label) {
    try {
        process.kill(-pgid, 'SIGTERM');
    } catch {
        try {
            process.kill(pgid, 'SIGTERM');
        } catch {
            // 中文注释：已死即视为完成。
        }
    }
    const start = Date.now();
    while (Date.now() - start < 5000) {
        try {
            process.kill(pgid, 0);
            await new Promise((r) => setTimeout(r, 200));
        } catch {
            return;
        }
    }
    try {
        process.kill(-pgid, 'SIGKILL');
    } catch {
        try {
            process.kill(pgid, 'SIGKILL');
        } catch {
            // 中文注释：已死即视为完成。
        }
    }
    void label;
}

/**
 * 启动隔离 production server。
 * @param options 启动选项 { mockBaseUrl? }（缺省自动拉起自有 mock）
 * @returns 句柄 { port, url, snapshotDir, dbFile, commit, childPid, mockHandle?, ownedMock }
 */
export async function startAppServer(options = {}) {
    // 中文注释：快照键为 HEAD full SHA；unknown 禁止构建，直接抛 BLOCKED（不得回退缓存）。
    const fullSha = currentFullSha();
    if (!fullSha || fullSha === 'unknown') {
        throw blockedError('拒绝启动：无法解析 HEAD full SHA，unknown 禁止构建快照');
    }
    const sha = fullSha;
    let mockHandle = null;
    let ownedMock = false;
    let mockBaseUrl = options.mockBaseUrl;
    if (!mockBaseUrl) {
        mockHandle = await startMockServer();
        ownedMock = true;
        mockBaseUrl = `${mockHandle.url}/v1`;
    }
    const runTag = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
    // 中文注释：快照目录先算出（构建期隔离库落快照内，与运行时库分离）。
    const snapshotDirPreview = join(runtimeRoot, 'snapshots', sha);
    const buildDb = join(snapshotDirPreview, 'prisma', 'harness-build.db');
    // 中文注释：快照构建先行（失败则回收自有 mock，不留孤儿）。
    let snapshotDir;
    try {
        const buildEnv = buildSnapshotEnv(buildDb, mockBaseUrl);
        snapshotDir = await ensureSnapshot(sha, buildEnv);
    } catch (err) {
        if (ownedMock && mockHandle) await stopMockServer(mockHandle);
        throw err;
    }
    const port = await pickAppPort();
    const dbFile = join(snapshotDir, 'prisma', `harness-${port}-${runTag}.db`);
    const env = buildSnapshotEnv(dbFile, mockBaseUrl);
    const nodeBin = process.execPath;
    const nextBin = join(snapshotDir, 'node_modules', 'next', 'dist', 'bin', 'next');
    const prismaBin = join(snapshotDir, 'node_modules', '.bin', 'prisma');
    runInSnapshot(snapshotDir, nodeBin, [prismaBin, 'migrate', 'deploy'], env);
    const child = spawn(nodeBin, [nextBin, 'start', '-p', String(port)], {
        cwd: snapshotDir,
        env,
        stdio: 'ignore',
        detached: true,
    });
    // 中文注释：unref 让服务在拉起进程（globalSetup/自测进程）退出后继续存活，
    // 由 stopAppServer/stopAppServerByPorts 显式回收（跨 globalSetup→用例进程必需）。
    child.unref();
    const url = `http://localhost:${port}`;
    try {
        await waitReady(`${url}/`);
    } catch (err) {
        await killTree(child);
        rmSync(dbFile, { force: true });
        if (ownedMock && mockHandle) await stopMockServer(mockHandle);
        throw err;
    }
    return { port, url, snapshotDir, dbFile, commit: sha, childPid: child.pid ?? null, mockHandle, ownedMock, _child: child };
}

/**
 * 停止 production server：kill 子进程树 → 确认端口释放 → 清理本次隔离库 → 回收自有 mock。
 * @param handle startAppServer 返回的句柄
 */
export async function stopAppServer(handle) {
    if (!handle) return;
    if (handle._child) await killTree(handle._child);
    await waitReleased(handle.port);
    if (handle.dbFile) rmSync(handle.dbFile, { force: true });
    if (handle.ownedMock && handle.mockHandle) await stopMockServer(handle.mockHandle);
}

/**
 * 跨进程停止 production server（globalTeardown 用：按持久化 handle 回收）。
 * @param saved 持久化句柄 { port, pgid, dbFile }
 */
export async function stopAppServerByPorts(saved) {
    if (!saved) return;
    if (typeof saved.pgid === 'number') await killPgroup(saved.pgid, 'app');
    if (typeof saved.port === 'number') await waitReleased(saved.port);
    if (typeof saved.dbFile === 'string' && saved.dbFile.length > 0) rmSync(saved.dbFile, { force: true });
}
