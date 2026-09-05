/**
 * 访客数据垃圾回收 (GC) 服务
 *
 * 清理 30 天未更新的访客配置、聊天消息、生成历史与提示词历史。
 */

import { prisma } from '@/lib/db';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface PurgeResult {
    configsDeleted: number;
    messagesDeleted: number;
    generationsDeleted: number;
    promptsDeleted: number;
    playbackProgressDeleted: number;
}

/**
 * 清理指定截止时间前未更新的访客数据（默认 30 天前）。
 */
export async function purgeExpiredGuestData(cutoffDate?: Date): Promise<PurgeResult> {
    const threshold = cutoffDate ?? new Date(Date.now() - THIRTY_DAYS_MS);

    const [configs, messages, generations, prompts, playback] = await Promise.all([
        prisma.guestConfig.deleteMany({ where: { updatedAt: { lt: threshold } } }),
        prisma.guestChatMessage.deleteMany({ where: { updatedAt: { lt: threshold } } }),
        prisma.guestGenerationHistory.deleteMany({ where: { updatedAt: { lt: threshold } } }),
        prisma.guestPromptHistory.deleteMany({ where: { updatedAt: { lt: threshold } } }),
        prisma.guestPlaybackProgress.deleteMany({ where: { updatedAt: { lt: threshold } } }),
    ]);

    return {
        configsDeleted: configs.count,
        messagesDeleted: messages.count,
        generationsDeleted: generations.count,
        promptsDeleted: prompts.count,
        playbackProgressDeleted: playback.count,
    };
}
