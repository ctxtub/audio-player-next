import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 隔离库文件名后缀（历史命名保留，任务1 后不再用于新建路径）。
 */
const ISOLATED_DB_PREFIX = 'test-';
void ISOLATED_DB_PREFIX;

/**
 * 取 runner 注入的受控库路径（fail closed，不 fallback）。
 * @returns 受控库绝对路径
 */
function getControlledDbPath(): string {
    // 中文注释：受控上下文来自 runner 逐 suite 注入的 DATABASE_URL + 显式标记。
    const url = process.env.DATABASE_URL ?? '';
    if (url.length === 0) {
        throw new Error('安全错误：缺少受控 DATABASE_URL，须经 runner 启动，不得裸跑');
    }
    if (!url.startsWith('file:')) {
        throw new Error('安全错误：受控 DATABASE_URL 必须为 file: SQLite URL');
    }
    if (url.includes('dev.db') || url.includes('app.db')) {
        throw new Error('安全错误：拒绝指向开发/生产库的 DATABASE_URL');
    }
    if (url.includes('?') || url.includes('#')) {
        throw new Error('安全错误：受控 URL 不得含 query/hash');
    }
    if (!url.includes('.e2e-runtime/test-db/') || !url.endsWith('.db')) {
        throw new Error('安全错误：受控 URL 不在允许根内');
    }
    let dbPath = '';
    try {
        dbPath = fileURLToPath(url);
    } catch {
        throw new Error('安全错误：受控 URL 非规范 file URL');
    }
    if (!fs.existsSync(dbPath)) {
        throw new Error(`安全错误：受控库不存在（runner 应先迁移）：${dbPath.slice(-60)}`);
    }
    return dbPath;
}

/**
 * 复用本 suite 已迁移的受控库（不再另建/删库/迁移/切换 URL）。
 * @param suiteName 用例套件短名（兼容保留，实际复用受控路径）
 * @returns 受控库绝对路径与 prisma 单例
 */
export async function setupIsolatedDb(suiteName: string): Promise<{
    dbPath: string;
    prisma: typeof import('../../../lib/db').prisma;
}> {
    // 中文注释：suiteName 仅为兼容参数，不再决定路径；runner 已逐 suite 隔离迁移。
    void suiteName;
    const dbPath = getControlledDbPath();
    const { prisma } = await import('../../../lib/db');
    return { dbPath, prisma };
}

/**
 * 返回同一受控路径（只读观测用，不建连接）。
 * @param suiteName 用例套件短名（兼容保留）
 * @returns 受控库绝对路径
 */
export function isolatedDbPath(suiteName: string): string {
    // 中文注释：保持 API，统一返回 runner 受控路径。
    void suiteName;
    return getControlledDbPath();
}
