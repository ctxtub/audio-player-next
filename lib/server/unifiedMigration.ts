/**
 * 访客创作数据迁移服务
 *
 * 仅在注册时，将具名访客的聊天记录、生成历史与提示词历史原子级迁移至新用户。
 */

import { prisma } from '@/lib/db';

export interface MigrationResult {
    messagesMigrated: number;
    generationsMigrated: number;
    promptsMigrated: number;
}

/**
 * 将指定 guestId 的全部创作记录（聊天、生成历史、提示词历史）拷贝至指定用户。
 * 保留访客原表记录供回滚/审计，由 30 天 GC 自然清理。
 */
export async function migrateGuestCreativeRecordsToUser(
    guestId: string,
    userId: number
): Promise<MigrationResult> {
    // 1. 聊天会话快照迁移（按 position 升序）
    const guestMessages = await prisma.guestChatMessage.findMany({
        where: { guestId },
        orderBy: { position: 'asc' },
    });
    if (guestMessages.length > 0) {
        await prisma.chatMessage.createMany({
            data: guestMessages.map((m, idx) => ({
                userId,
                position: idx,
                messageId: m.messageId,
                role: m.role,
                content: m.content,
                parts: m.parts,
                agentType: m.agentType,
                createdAt: m.createdAt,
            })),
        });
    }

    // 2. 生成历史迁移（按时间升序插入，最多 100 条）
    const guestGenerations = await prisma.guestGenerationHistory.findMany({
        where: { guestId },
        orderBy: { createdAt: 'asc' },
        take: 100,
    });
    if (guestGenerations.length > 0) {
        await prisma.generationHistory.createMany({
            data: guestGenerations.map((g) => ({
                userId,
                prompt: g.prompt,
                storyText: g.storyText,
                voiceId: g.voiceId,
                createdAt: g.createdAt,
            })),
        });
    }

    // 3. 提示词历史迁移（30 天内活跃，最多 100 条）
    const threshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const guestPrompts = await prisma.guestPromptHistory.findMany({
        where: { guestId, lastUsed: { gte: threshold } },
        orderBy: { lastUsed: 'desc' },
        take: 100,
    });
    if (guestPrompts.length > 0) {
        await prisma.promptHistory.createMany({
            data: guestPrompts.map((p) => ({
                userId,
                prompt: p.prompt,
                lastUsed: p.lastUsed,
                useCount: p.useCount,
            })),
        });
    }

    return {
        messagesMigrated: guestMessages.length,
        generationsMigrated: guestGenerations.length,
        promptsMigrated: guestPrompts.length,
    };
}
