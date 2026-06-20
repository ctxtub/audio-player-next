/**
 * 提示词历史服务层
 *
 * 封装 PromptHistory 表的查询/记录/删除与 DB↔DTO 映射，并在读取时剪除过期记录。
 */

import { prisma } from '@/lib/db';
import type { PromptHistoryDTO } from '@/lib/trpc/schemas/promptHistory';

/** 历史有效期：30 天（毫秒）。 */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** PromptHistory 行中本服务关心的字段子集。 */
type PromptHistoryRow = {
    prompt: string;
    lastUsed: Date;
    useCount: number;
};

/**
 * DB 行 → 前端 DTO（lastUsed 转 ISO 字符串）。
 */
const toDto = (row: PromptHistoryRow): PromptHistoryDTO => ({
    prompt: row.prompt,
    lastUsed: row.lastUsed.toISOString(),
    useCount: row.useCount,
});

/**
 * 列出当前用户的提示词历史；读取时先剪除超过 30 天的记录。
 * @param userId 用户 ID。
 */
export const listPromptHistory = async (userId: number): Promise<PromptHistoryDTO[]> => {
    const threshold = new Date(Date.now() - THIRTY_DAYS_MS);
    await prisma.promptHistory.deleteMany({
        where: { userId, lastUsed: { lt: threshold } },
    });
    const rows = await prisma.promptHistory.findMany({
        where: { userId },
        orderBy: { lastUsed: 'desc' },
    });
    return rows.map(toDto);
};

/**
 * 记录一次提示词使用：存在则次数 +1、刷新时间；否则新建。
 * @param userId 用户 ID。
 * @param prompt 提示词原文。
 */
export const recordPromptHistory = async (
    userId: number,
    prompt: string,
): Promise<PromptHistoryDTO> => {
    const now = new Date();
    const row = await prisma.promptHistory.upsert({
        where: { userId_prompt: { userId, prompt } },
        update: { useCount: { increment: 1 }, lastUsed: now },
        create: { userId, prompt, lastUsed: now, useCount: 1 },
    });
    return toDto(row);
};

/**
 * 删除当前用户的某条提示词历史（不存在不报错）。
 * @param userId 用户 ID。
 * @param prompt 提示词原文。
 */
export const removePromptHistory = async (userId: number, prompt: string): Promise<void> => {
    await prisma.promptHistory.deleteMany({ where: { userId, prompt } });
};
