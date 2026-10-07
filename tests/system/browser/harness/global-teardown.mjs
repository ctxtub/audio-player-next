/**
 * Playwright globalTeardown（任务13 harness）。
 *
 * 读指针 + 持久化 handle 跨进程回收常驻 app/mock 并确认端口释放，
 * 然后删除指针与过程文件；指针缺失即直接通过（setup 未成功时无服务可收）。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertRunOwnership, releaseRunLock, runtimeDir, pointerPath, writeJsonAtomic } from './runtime-state.mjs';

/**
 * globalTeardown：按指针与持久化 handle 回收服务。
 */
async function globalTeardown() {
    if (!existsSync(pointerPath)) {
        console.log('[browser-harness] 无指针文件，无服务可收');
        return;
    }
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
    const runId = pointer.runId;
    if (process.env.BROWSER_RUN_ID !== runId) {
        const blocked = new Error('[browser-harness][BLOCKED] teardown run-id 不匹配，拒绝回收其他运行');
        blocked.code = 'BLOCKED';
        throw blocked;
    }
    assertRunOwnership(runId);
    const { stopAppServerByPorts } = await import('./app-server.mjs');
    const { stopMockServerByPid } = await import('./mock-openai.mjs');
    const appHandlePath = join(runtimeDir, `app-handle-${runId}.json`);
    const cleanupErrors = [];
    try {
        if (!pointer.appStopped && existsSync(appHandlePath)) {
            await stopAppServerByPorts(JSON.parse(readFileSync(appHandlePath, 'utf8')));
        }
        pointer.appStopped = true;
        rmSync(appHandlePath, { force: true });
        writeJsonAtomic(pointerPath, pointer);
    } catch (error) {
        cleanupErrors.push(error);
    }
    try {
        if (!pointer.mockStopped) {
            await stopMockServerByPid(pointer.mockPid, pointer.mockPort);
        }
        pointer.mockStopped = true;
        rmSync(join(runtimeDir, `mock-port-${runId}.json`), { force: true });
        writeJsonAtomic(pointerPath, pointer);
    } catch (error) {
        cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, '[browser-harness][BLOCKED] 回收未完成，保留运行锁与资源记录');
    }
    rmSync(pointerPath, { force: true });
    releaseRunLock(runId);
    console.log(`[browser-harness] down run=${runId}`);
}

export default globalTeardown;
