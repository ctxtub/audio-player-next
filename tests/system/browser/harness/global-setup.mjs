/**
 * Playwright globalSetup。
 *
 * 由 harness 管理服务（不用 Playwright 内建 webServer）：
 * 拉起 detached 常驻 mock + isolation production server（unref 常驻），
 * 将当次 run 地址写入运行时指针文件，供 config/reporter/spec 读取；
 * 回收由 globalTeardown 按持久化 handle 跨进程完成。
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startAppServer, stopAppServer } from './app-server.mjs';
import { acquireRunLock, releaseRunLock, runtimeDir, pointerPath, writeJsonAtomic } from './runtime-state.mjs';

// 中文注释：仓库根（node 运行 cwd；与 reporter/fixtures 同口径，禁用 import.meta）。
const repoRoot = process.cwd();
// 中文注释：harness 目录。
const harnessDir = join(repoRoot, 'tests', 'system', 'browser', 'harness');
/**
 * 生成当次运行标识（UTC 时间 + 随机后缀）。
 * @returns run-id
 */
function makeRunId() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/**
 * 等待文件出现并读 JSON。
 * @param absPath 文件绝对路径
 * @param timeoutMs 超时毫秒
 * @returns 解析后对象
 */
async function waitJsonFile(absPath, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (existsSync(absPath)) {
            try {
                return JSON.parse(readFileSync(absPath, 'utf8'));
            } catch {
                // 中文注释：写一半时重试。
            }
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`[global-setup] 等待文件超时: ${absPath}`);
}

/**
 * 拉起 detached 常驻 mock（setup 进程退出后继续存活）。
 * @param runId 当次运行标识
 * @returns { port, pid, url }
 */
async function spawnResidentMock(runId) {
    const portFile = join(runtimeDir, `mock-port-${runId}.json`);
    const startupLog = join(runtimeDir, `mock-startup-${runId}.log`);
    const startupLogFd = openSync(startupLog, 'a');
    const child = spawn(process.execPath, [join(harnessDir, 'mock-standalone.mjs'), '--port-file', portFile], {
        stdio: ['ignore', startupLogFd, startupLogFd],
        detached: true,
    });
    closeSync(startupLogFd);
    child.unref();
    try {
        const info = await waitJsonFile(portFile);
        rmSync(startupLog, { force: true });
        return { port: info.port, pid: info.pid, url: `http://localhost:${info.port}`, portFile };
    } catch (error) {
        const detail = existsSync(startupLog) ? readFileSync(startupLog, 'utf8').trim() : '';
        rmSync(startupLog, { force: true });
        try {
            child.kill('SIGKILL');
        } catch {
            // 已退出即无需回收。
        }
        rmSync(portFile, { force: true });
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}${detail ? `\n[mock-standalone]\n${detail}` : ''}`);
    }
}

/**
 * globalSetup：拉起常驻 mock + app，写指针与持久化 handle。
 */
async function globalSetup() {
    const runId = process.env.BROWSER_RUN_ID ?? makeRunId();
    process.env.BROWSER_RUN_ID = runId;
    acquireRunLock(runId);
    if (existsSync(pointerPath)) {
        releaseRunLock(runId);
        const blocked = new Error('[browser-harness][BLOCKED] 已有运行指针，必须先按所有权回收旧运行');
        blocked.code = 'BLOCKED';
        throw blocked;
    }
    let mock = null;
    let pointer = { runId };
    let appHandle = null;
    const appHandlePath = join(runtimeDir, `app-handle-${runId}.json`);
    try {
        mock = await spawnResidentMock(runId);
        pointer = {
            runId,
            mockUrl: mock.url,
            mockPort: mock.port,
            mockPid: mock.pid,
            mockMp3Url: `${mock.url}/fixture.mp3`,
        };
        // mock 一旦常驻就立即留下回收证据，不能等 app 构建成功后才写。
        writeJsonAtomic(pointerPath, pointer);
        appHandle = await startAppServer({ mockBaseUrl: `${mock.url}/v1` });
        // 中文注释：持久化 app handle（teardown 跨进程回收用，仅存可序列化字段）。
        writeJsonAtomic(appHandlePath, {
            port: appHandle.port,
            pgid: appHandle.childPid,
            dbFile: appHandle.dbFile,
            runDir: appHandle.runDir,
            snapshotRef: appHandle.snapshotRef,
        });
        writeJsonAtomic(pointerPath, {
            ...pointer,
            appUrl: appHandle.url,
            appPort: appHandle.port,
            commit: appHandle.commit,
        });
    } catch (err) {
        if (!appHandle && err.appHandle) {
            appHandle = err.appHandle;
            writeJsonAtomic(appHandlePath, {
                port: appHandle.port,
                pgid: appHandle.childPid,
                dbFile: appHandle.dbFile,
                runDir: appHandle.runDir,
                snapshotRef: appHandle.snapshotRef,
            });
        }
        const { stopMockServerByPid } = await import('./mock-openai.mjs');
        const cleanupErrors = [];
        try {
            if (appHandle) await stopAppServer(appHandle);
            pointer.appStopped = true;
            rmSync(appHandlePath, { force: true });
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            if (mock) await stopMockServerByPid(mock.pid, mock.port);
            pointer.mockStopped = true;
            if (mock) rmSync(mock.portFile, { force: true });
        } catch (error) {
            cleanupErrors.push(error);
        }
        if (cleanupErrors.length > 0) {
            writeJsonAtomic(pointerPath, pointer);
            throw new AggregateError([err, ...cleanupErrors], '[browser-harness][BLOCKED] 回收未完成，保留运行锁与资源记录');
        }
        rmSync(pointerPath, { force: true });
        releaseRunLock(runId);
        throw err;
    }
    console.log(`[browser-harness] up run=${runId} app=${appHandle.url} mock=${mock.url}`);
}

export default globalSetup;
