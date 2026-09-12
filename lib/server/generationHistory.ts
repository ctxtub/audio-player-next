/**
 * 生成历史服务层（Legacy generationHistory 兼容服务）
 *
 * 衔接 /player 的旧版生成历史读写链至 StoryWork 新体系：
 * 1. 列表读取：保留最近 LIST_LIMIT (50) 条展示兼容语义（非数据保留上限），过滤已软删除（deletedAt != null）记录；
 * 2. 写入：统一走 createStoryWorkForSubject(..., sourceMessageId: null) 兼容路径，
 *    不参与来源消息幂等、允许可重复创建独立作品，彻底退出写链裁剪与数量淘汰；
 * 3. 删除：统一走 trashStoryWorkForSubject（移入回收站软删除、当前阶段不立即物理删除；后续由统一 Trash 生命周期清理）。
 */

import { prisma } from '@/lib/db';
import { TRPCError } from '@trpc/server';
import type { Subject } from './subject';
import {
    createStoryWorkForSubject,
    trashStoryWorkForSubject,
} from './storyWork';
import type { GenerationHistoryDTO } from '@/lib/trpc/schemas/generationHistory';

/** 列表返回上限（展示兼容语义，不承担数据保留职责）。 */
const LIST_LIMIT = 50;

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
 * 列出当前用户最近的生成历史（最多 LIST_LIMIT 条，按时间倒序，仅活跃未软删记录）。
 * @param userId 用户 ID。
 */
export const listGenerationHistory = async (
    userId: number,
): Promise<GenerationHistoryDTO[]> => {
    const rows = await prisma.storyWork.findMany({
        where: { userId, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LIST_LIMIT,
    });
    return rows.map(toDto);
};

/**
 * 列出当前主体（用户或具名访客）最近的生成历史（最多 LIST_LIMIT 条，按时间倒序，仅活跃未软删记录）。
 */
export const listGenerationHistoryForSubject = async (
    subject: Subject
): Promise<GenerationHistoryDTO[]> => {
    if (subject.type === 'user') {
        return listGenerationHistory(subject.id);
    }
    const rows = await prisma.guestStoryWork.findMany({
        where: { guestId: subject.id, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LIST_LIMIT,
    });
    return rows.map(toDto);
};

/**
 * 记录一次生成（兼容写入：委托 createStoryWorkForSubject，sourceMessageId 为 null，永不裁剪）。
 * @param userId 用户 ID。
 * @param input 提示词 / 故事正文 / 音色。
 */
export const recordGenerationHistory = async (
    userId: number,
    input: { prompt: string; storyText: string; voiceId?: string },
): Promise<GenerationHistoryDTO> => {
    return recordGenerationHistoryForSubject({ type: 'user', id: userId }, input);
};

/**
 * 记录一次生成（兼容写入：委托 createStoryWorkForSubject，sourceMessageId 为 null，永不裁剪）。
 */
export const recordGenerationHistoryForSubject = async (
    subject: Subject,
    input: { prompt: string; storyText: string; voiceId?: string }
): Promise<GenerationHistoryDTO> => {
    const detail = await createStoryWorkForSubject(subject, {
        prompt: input.prompt,
        storyText: input.storyText,
        voiceId: input.voiceId ?? '',
        sourceMessageId: null,
    });

    return {
        id: detail.id,
        prompt: detail.prompt,
        storyText: detail.storyText,
        voiceId: detail.voiceId,
        createdAt: detail.createdAt,
    };
};

/**
 * 删除当前用户的某条生成历史（从物理 delete 改为 moveToTrash 软删，数据保留）。
 * @param userId 用户 ID。
 * @param id 记录 ID。
 */
export const removeGenerationHistory = async (userId: number, id: number): Promise<void> => {
    return removeGenerationHistoryForSubject({ type: 'user', id: userId }, id);
};

/**
 * 删除当前主体的某条生成历史（从物理 delete 改为 moveToTrash 软删，数据保留）。
 */
export const removeGenerationHistoryForSubject = async (
    subject: Subject,
    id: number
): Promise<void> => {
    try {
        await trashStoryWorkForSubject(subject, id);
    } catch (error) {
        // 兼容旧语义：对于不存在或不属于当前主体的记录，静默忽略不抛异常
        if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
            return;
        }
        throw error;
    }
};
