/** 交付运行的原子状态写入与独占锁；失败时保留明确的资源所有权。 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** harness 运行目录及唯一指针。 */
export const runtimeDir = join(process.cwd(), '.e2e-runtime', 'browser-harness');
export const pointerPath = join(runtimeDir, 'active.json');
const lockDir = join(runtimeDir, 'run.lock');

/** 原子写 JSON，失败时只清理本次临时文件。 */
export function writeJsonAtomic(path, value) {
    const tempPath = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
        renameSync(tempPath, path);
    } finally {
        rmSync(tempPath, { force: true });
    }
}

/** 在任何异步启动前原子占有运行锁；已有锁不覆盖、不自动清理。 */
export function acquireRunLock(runId) {
    mkdirSync(runtimeDir, { recursive: true });
    try {
        mkdirSync(lockDir);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const blocked = new Error('[browser-harness][BLOCKED] 已有运行锁，必须先按所有权回收旧运行');
        blocked.code = 'BLOCKED';
        throw blocked;
    }
    try {
        writeJsonAtomic(join(lockDir, 'owner.json'), { runId, setupPid: process.pid });
    } catch (error) {
        rmSync(lockDir, { recursive: true, force: true });
        throw error;
    }
}

/** 仅在所有自有资源已回收且 run-id 匹配时释放运行锁。 */
export function releaseRunLock(runId) {
    assertRunOwnership(runId);
    rmSync(lockDir, { recursive: true });
}

/** 在执行任何回收动作前核对当前运行锁，拒绝其他 runner 的 teardown。 */
export function assertRunOwnership(runId) {
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    if (!runId || owner.runId !== runId) {
        const blocked = new Error('[browser-harness][BLOCKED] 运行锁所有权不匹配，拒绝回收');
        blocked.code = 'BLOCKED';
        throw blocked;
    }
}
