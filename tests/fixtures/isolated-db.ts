import fs from 'node:fs';
import path from 'node:path';

/**
 * 隔离库文件名后缀（统一落盘至 `prisma/test-<suite>.db`，命中 `.gitignore` 的 `*.db`，永不入库）。
 */
const ISOLATED_DB_PREFIX = 'test-';

/**
 * 为单元测试准备隔离 SQLite 库并返回可用的 prisma 单例（调用方唯一写库入口）。
 * @param suiteName 用例套件短名（决定库文件名 `prisma/test-<suiteName>.db`）
 * @returns 隔离库绝对路径与已完成 migrate deploy 的 prisma 单例
 */
export async function setupIsolatedDb(suiteName: string): Promise<{
    dbPath: string;
    prisma: typeof import('../../lib/db').prisma;
}> {
    // 中文注释：库路径取自套件名，合成命名，不含任何真实数据与凭据。
    const dbPath = path.resolve(process.cwd(), `prisma/${ISOLATED_DB_PREFIX}${suiteName}.db`);
    process.env.DATABASE_URL = `file:${dbPath}`;
    if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
    }
    const { execSync } = await import('node:child_process');
    execSync(`DATABASE_URL="file:${dbPath}" ./node_modules/.bin/prisma migrate deploy`, {
        stdio: 'pipe',
    });
    const { prisma } = await import('../../lib/db');
    return { dbPath, prisma };
}

/**
 * 按套件名推导隔离库绝对路径（只读观测与清理用，不建连接）。
 * @param suiteName 用例套件短名
 * @returns 隔离库绝对路径
 */
export function isolatedDbPath(suiteName: string): string {
    // 中文注释：纯路径推导，供清理阶段删除文件使用。
    return path.resolve(process.cwd(), `prisma/${ISOLATED_DB_PREFIX}${suiteName}.db`);
}
