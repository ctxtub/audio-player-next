/**
 * Playwright globalSetup（任务13 harness）。
 *
 * 由 harness 管理服务（不用 Playwright 内建 webServer）：
 * 拉起 detached 常驻 mock + isolation production server（unref 常驻），
 * 将当次 run 地址写入运行时指针文件，供 config/reporter/spec 读取；
 * 回收由 globalTeardown 按持久化 handle 跨进程完成。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startAppServer } from './app-server.mjs';

// 中文注释：仓库根（node 运行 cwd；与 reporter/fixtures 同口径，禁用 import.meta）。
const repoRoot = process.cwd();
// 中文注释：harness 目录。
const harnessDir = join(repoRoot, 'tests', 'system', 'browser', 'harness');
// 中文注释：harness 运行时目录（gitignore，不入库）。
const runtimeDir = join(repoRoot, '.e2e-runtime', 'browser-harness');
// 中文注释：当次运行指针文件（跨 globalSetup/用例进程/reporter 的共享通道）。
const pointerPath = join(runtimeDir, 'active.json');

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
    const child = spawn(process.execPath, [join(harnessDir, 'mock-standalone.mjs'), '--port-file', portFile], {
        stdio: 'ignore',
        detached: true,
    });
    child.unref();
    const info = await waitJsonFile(portFile);
    return { port: info.port, pid: info.pid, url: `http://localhost:${info.port}`, portFile };
}

/**
 * globalSetup：拉起常驻 mock + app，写指针与持久化 handle。
 */
async function globalSetup() {
    const runId = process.env.BROWSER_RUN_ID ?? makeRunId();
    process.env.BROWSER_RUN_ID = runId;
    mkdirSync(runtimeDir, { recursive: true });
    const mock = await spawnResidentMock(runId);
    let appHandle = null;
    try {
        appHandle = await startAppServer({ mockBaseUrl: `${mock.url}/v1` });
    } catch (err) {
        const { stopMockServerByPid } = await import('./mock-openai.mjs');
        await stopMockServerByPid(mock.pid, mock.port);
        throw err;
    }
    // 中文注释：持久化 app handle（teardown 跨进程回收用，仅存可序列化字段）。
    writeFileSync(
        join(runtimeDir, `app-handle-${runId}.json`),
        `${JSON.stringify({ port: appHandle.port, pgid: appHandle.childPid, dbFile: appHandle.dbFile }, null, 2)}\n`,
    );
    writeFileSync(
        pointerPath,
        `${JSON.stringify(
            {
                runId,
                appUrl: appHandle.url,
                appPort: appHandle.port,
                mockUrl: mock.url,
                mockPort: mock.port,
                mockPid: mock.pid,
                mockMp3Url: `${mock.url}/fixture.mp3`,
                commit: appHandle.commit,
            },
            null,
            2,
        )}\n`,
    );
    // eslint-disable-next-line no-console
    console.log(`[browser-harness] up run=${runId} app=${appHandle.url} mock=${mock.url}`);
}

export default globalSetup;
