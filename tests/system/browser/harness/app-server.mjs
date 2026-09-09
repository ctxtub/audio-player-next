/**
 * 浏览器测试 production server 启停管理（任务13 harness）。
 *
 * 复用任务12 spike 验证过的方式：隔离快照 git archive → 合成 SESSION_SECRET +
 * 隔离 DB migrate → next start 随机高位端口（31120-31150 范围取空闲）→
 * health 探测就绪；停止时 kill 子进程树并确认端口释放。
 *
 * 全程函数化：export startAppServer()/stopAppServer()。
 * 快照按 commit 短 SHA 缓存（.e2e-runtime/browser-harness/snapshots/<sha>/），
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
 * 取当前 commit 短 SHA（快照缓存键）。
 * @returns 短 SHA（取不到时回退 'unknown'）
 */
function currentShortSha() {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
        return 'unknown';
    }
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
 * @param sha commit 短 SHA
 * @param env 合成环境（含 SESSION_SECRET/OPENAI_*，DATABASE_URL 另行按库覆写）
 * @returns 快照目录
 */
async function ensureSnapshot(sha, env) {
    const snapshotDir = join(runtimeRoot, 'snapshots', sha);
    const readyMarker = join(snapshotDir, '.snapshot-ready');
    if (existsSync(readyMarker)) return snapshotDir;
    const lockDir = join(runtimeRoot, 'snapshots', `${sha}.lock`);
    mkdirSync(join(runtimeRoot, 'snapshots'), { recursive: true });
    await acquireDirLock(lockDir);
    try {
        if (existsSync(readyMarker)) return snapshotDir;
            rmSync(snapshotDir, { recursive: true, force: true });
            mkdirSync(snapshotDir, { recursive: true });
            // 中文注释：仅 tracked 文件进快照（.env*/.db/.next/node_modules 天然排除）。
            const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: repoRoot, encoding: 'buffer', timeout: 60000, maxBuffer: 512 * 1024 * 1024 });
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
            writeFileSync(readyMarker, `${sha}\n`);
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
    const sha = currentShortSha();
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
