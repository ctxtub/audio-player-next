/**
 * 生成历史服务层
 *
 * 封装 GenerationHistory 表的查询/记录/删除与 DB↔DTO 映射，记录时裁剪保留最近 N 条。
 */

import { prisma } from '@/lib/db';
import type { GenerationHistoryDTO } from '@/lib/trpc/schemas/generationHistory';

/** 列表返回上限。 */
const LIST_LIMIT = 50;
/** 每用户保留的最大历史条数。 */
const KEEP_LIMIT = 100;

/** GenerationHistory 行中本服务关心的字段子集。 */
type GenerationHistoryRow = {
    id: number;
    prompt: string;
    storyText: string;
    voiceId: string;
    createdAt: Date;
};

/**
 * DB 行 → 前端 DTO。
 */
const toDto = (row: GenerationHistoryRow): GenerationHistoryDTO => ({
    id: row.id,
    prompt: row.prompt,
    storyText: row.storyText,
    voiceId: row.voiceId,
    createdAt: row.createdAt.toISOString(),
});

/**
 * 列出当前用户最近的生成历史（最多 LIST_LIMIT 条，按时间倒序）。
 * @param userId 用户 ID。
 */
export const listGenerationHistory = async (
    userId: number,
): Promise<GenerationHistoryDTO[]> => {
    const rows = await prisma.generationHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
    });
    return rows.map(toDto);
};

/**
 * 记录一次生成；写入后裁剪该用户仅保留最近 KEEP_LIMIT 条。
 * @param userId 用户 ID。
 * @param input 提示词 / 故事正文 / 音色。
 */
export const recordGenerationHistory = async (
    userId: number,
    input: { prompt: string; storyText: string; voiceId?: string },
): Promise<GenerationHistoryDTO> => {
    const created = await prisma.generationHistory.create({
        data: {
            userId,
            prompt: input.prompt,
            storyText: input.storyText,
            voiceId: input.voiceId ?? '',
        },
    });

    // 裁剪：删除超出最近 KEEP_LIMIT 的旧记录
    const keep = await prisma.generationHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: KEEP_LIMIT,
        select: { id: true },
    });
    const keepIds = keep.map((r) => r.id);
    await prisma.generationHistory.deleteMany({
        where: { userId, id: { notIn: keepIds } },
    });

    return toDto(created);
};

/**
 * 删除当前用户的某条生成历史（按 id + userId，避免越权）。
 * @param userId 用户 ID。
 * @param id 记录 ID。
 */
export const removeGenerationHistory = async (userId: number, id: number): Promise<void> => {
    await prisma.generationHistory.deleteMany({ where: { id, userId } });
};
