/**
 * Playwright globalTeardown（任务13 harness）。
 *
 * 读指针 + 持久化 handle 跨进程回收常驻 app/mock 并确认端口释放，
 * 然后删除指针与过程文件；指针缺失即直接通过（setup 未成功时无服务可收）。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

// 中文注释：仓库根（node 运行 cwd；与 reporter/fixtures 同口径，禁用 import.meta）。
const repoRoot = process.cwd();
// 中文注释：harness 运行时目录。
const runtimeDir = join(repoRoot, '.e2e-runtime', 'browser-harness');
// 中文注释：当次运行指针文件。
const pointerPath = join(runtimeDir, 'active.json');

/**
 * globalTeardown：按指针与持久化 handle 回收服务。
 */
async function globalTeardown() {
    if (!existsSync(pointerPath)) {
        // eslint-disable-next-line no-console
        console.log('[browser-harness] 无指针文件，无服务可收');
        return;
    }
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
    const runId = pointer.runId;
    const { stopAppServerByPorts } = await import('./app-server.mjs');
    const { stopMockServerByPid } = await import('./mock-openai.mjs');
    const appHandlePath = join(runtimeDir, `app-handle-${runId}.json`);
    if (existsSync(appHandlePath)) {
        await stopAppServerByPorts(JSON.parse(readFileSync(appHandlePath, 'utf8')));
        rmSync(appHandlePath, { force: true });
    }
    await stopMockServerByPid(pointer.mockPid, pointer.mockPort);
    const mockPortFile = join(runtimeDir, `mock-port-${runId}.json`);
    rmSync(mockPortFile, { force: true });
    rmSync(pointerPath, { force: true });
    // eslint-disable-next-line no-console
    console.log(`[browser-harness] down run=${runId}`);
}

export default globalTeardown;
