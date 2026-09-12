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
    storyWorkIdMap: Map<number, number>;
}

/**
 * 将指定 guestId 的全部创作记录（聊天、作品历史、提示词历史）拷贝至指定用户。
 * 保留访客原表记录供回滚/审计，由 30 天 GC 自然清理。
 *
 * 关键约束：
 * 1. 彻底取消作品迁移路径的 take:100 限制，支持 150+ 完整迁移；
 * 2. 禁止 createMany 批量操作，必须逐行创建以取得每条作品的新 ID；
 * 3. 状态原样迁移：title / excerpt / contentHash / sourceMessageId / favoritedAt / deletedAt / createdAt 全部保真；
 * 4. 构建并持久化 guestStoryWorkId → userStoryWorkId 映射（记录于 StoryWorkMigration 表）；
 * 5. 具备幂等性，重复调用不产生重复行。
 */
export async function migrateGuestCreativeRecordsToUser(
    guestId: string,
    userId: number
): Promise<MigrationResult> {
    // 1. 聊天会话快照迁移（按 position 升序，幂等防重）
    const guestMessages = await prisma.guestChatMessage.findMany({
        where: { guestId },
        orderBy: { position: 'asc' },
    });
    if (guestMessages.length > 0) {
        const existingMessages = await prisma.chatMessage.findMany({
            where: { userId },
            select: { messageId: true },
        });
        const existingMessageIds = new Set(existingMessages.map((m) => m.messageId));
        const messagesToInsert = guestMessages.filter((m) => !existingMessageIds.has(m.messageId));

        if (messagesToInsert.length > 0) {
            await prisma.chatMessage.createMany({
                data: messagesToInsert.map((m, idx) => ({
                    userId,
                    position: existingMessages.length + idx,
                    messageId: m.messageId,
                    role: m.role,
                    content: m.content,
                    parts: m.parts,
                    agentType: m.agentType,
                    createdAt: m.createdAt,
                })),
            });
        }
    }

    // 2. 作品迁移（按时间与 ID 稳定升序逐条创建，无 take:100 限制，记录 guestStoryWorkId → userStoryWorkId 映射）
    const guestStoryWorks = await prisma.guestStoryWork.findMany({
        where: { guestId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const storyWorkIdMap = new Map<number, number>();

    if (guestStoryWorks.length > 0) {
        await prisma.$transaction(async (tx) => {
            // 先查当前 guestId 与 userId 是否已存在持久化迁移记录（幂等性保障）
            const existingMigrations = await tx.storyWorkMigration.findMany({
                where: { guestId, userId },
            });
            const existingMap = new Map<number, number>(
                existingMigrations.map((m) => [m.guestStoryWorkId, m.userStoryWorkId])
            );

            // 如果用户已有同 sourceMessageId 的作品，防重复并建立映射
            const existingUserWorks = await tx.storyWork.findMany({
                where: { userId },
                select: { id: true, sourceMessageId: true },
            });
            const userWorkBySourceMsg = new Map<string, number>();
            for (const uw of existingUserWorks) {
                if (uw.sourceMessageId) {
                    userWorkBySourceMsg.set(uw.sourceMessageId, uw.id);
                }
            }

            for (const g of guestStoryWorks) {
                // 若已迁移，直接复用既有映射
                if (existingMap.has(g.id)) {
                    storyWorkIdMap.set(g.id, existingMap.get(g.id)!);
                    continue;
                }

                // 若存在 sourceMessageId 且用户已存在对应作品，复用并记录映射
                if (g.sourceMessageId && userWorkBySourceMsg.has(g.sourceMessageId)) {
                    const matchedUserWorkId = userWorkBySourceMsg.get(g.sourceMessageId)!;
                    storyWorkIdMap.set(g.id, matchedUserWorkId);
                    await tx.storyWorkMigration.upsert({
                        where: {
                            guestId_guestStoryWorkId: {
                                guestId,
                                guestStoryWorkId: g.id,
                            },
                        },
                        create: {
                            guestId,
                            userId,
                            guestStoryWorkId: g.id,
                            userStoryWorkId: matchedUserWorkId,
                        },
                        update: {
                            userStoryWorkId: matchedUserWorkId,
                        },
                    });
                    continue;
                }

                // 逐行创建新用户作品（状态原样保持：title/excerpt/contentHash/sourceMessageId/favoritedAt/deletedAt/createdAt 等全部忠实保持）
                const created = await tx.storyWork.create({
                    data: {
                        userId,
                        prompt: g.prompt,
                        storyText: g.storyText,
                        voiceId: g.voiceId ?? '',
                        title: g.title ?? '',
                        excerpt: g.excerpt ?? '',
                        contentHash: g.contentHash ?? '',
                        sourceMessageId: g.sourceMessageId ?? null,
                        favoritedAt: g.favoritedAt ?? null,
                        deletedAt: g.deletedAt ?? null,
                        createdAt: g.createdAt,
                        updatedAt: g.updatedAt ?? g.createdAt,
                    },
                });

                storyWorkIdMap.set(g.id, created.id);
                if (g.sourceMessageId) {
                    userWorkBySourceMsg.set(g.sourceMessageId, created.id);
                }

                // 持久化保存 guestStoryWorkId → userStoryWorkId 映射
                await tx.storyWorkMigration.create({
                    data: {
                        guestId,
                        userId,
                        guestStoryWorkId: g.id,
                        userStoryWorkId: created.id,
                    },
                });
            }
        }, { timeout: 30000 });
    }

    // 3. 提示词历史迁移（30 天内活跃，最多 100 条，upsert 保证幂等）
    const threshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const guestPrompts = await prisma.guestPromptHistory.findMany({
        where: { guestId, lastUsed: { gte: threshold } },
        orderBy: { lastUsed: 'desc' },
        take: 100,
    });
    if (guestPrompts.length > 0) {
        for (const p of guestPrompts) {
            await prisma.promptHistory.upsert({
                where: {
                    userId_prompt: {
                        userId,
                        prompt: p.prompt,
                    },
                },
                create: {
                    userId,
                    prompt: p.prompt,
                    lastUsed: p.lastUsed,
                    useCount: p.useCount,
                },
                update: {
                    lastUsed: p.lastUsed,
                    useCount: p.useCount,
                },
            });
        }
    }

    return {
        messagesMigrated: guestMessages.length,
        generationsMigrated: guestStoryWorks.length,
        promptsMigrated: guestPrompts.length,
        storyWorkIdMap,
    };
}

/**
 * 将指定 guestId 的断点播放进度迁移至指定用户（单行）。
 * 保留访客原表记录供回滚/审计，由 30 天 GC 自然清理。
 *
 * 若 source 为 generation，借本次 ID map 映射 guestStoryWorkId → userStoryWorkId；
 * 找不到对应映射时必须 drop Anchor（fail closed，不产生悬空断点）。
 */
export async function migrateGuestPlaybackProgressToUser(
    guestId: string,
    userId: number,
    storyWorkIdMap?: Map<number, number>
): Promise<boolean> {
    const guestProgress = await prisma.guestPlaybackProgress.findUnique({
        where: { guestId },
    });
    if (!guestProgress) {
        return false;
    }

    let mappedSourceId = guestProgress.sourceId;

    if (guestProgress.sourceType === 'generation') {
        const guestWorkId = Number(guestProgress.sourceId);
        let userWorkId: number | undefined;

        if (!isNaN(guestWorkId)) {
            if (storyWorkIdMap && storyWorkIdMap.has(guestWorkId)) {
                userWorkId = storyWorkIdMap.get(guestWorkId);
            } else {
                // 从持久化迁移记录表中查询映射
                const mapping = await prisma.storyWorkMigration.findUnique({
                    where: {
                        guestId_guestStoryWorkId: {
                            guestId,
                            guestStoryWorkId: guestWorkId,
                        },
                    },
                });
                if (mapping) {
                    userWorkId = mapping.userStoryWorkId;
                }
            }
        }

        if (userWorkId !== undefined) {
            mappedSourceId = String(userWorkId);
        }
    }

    await prisma.userPlaybackProgress.upsert({
        where: { userId },
        create: {
            userId,
            sourceType: guestProgress.sourceType,
            sourceId: mappedSourceId,
            sessionId: guestProgress.sessionId,
            title: guestProgress.title,
            contentHash: guestProgress.contentHash,
            segmentationVersion: guestProgress.segmentationVersion,
            lastCompletedParagraphIndex: guestProgress.lastCompletedParagraphIndex,
            nextParagraphIndex: guestProgress.nextParagraphIndex,
            totalParagraphs: guestProgress.totalParagraphs,
            voiceId: guestProgress.voiceId,
            speed: guestProgress.speed,
            remainingAllowedMs: guestProgress.remainingAllowedMs,
            totalAllowedMs: guestProgress.totalAllowedMs,
            isOneShot: guestProgress.isOneShot,
        },
        update: {
            sourceType: guestProgress.sourceType,
            sourceId: mappedSourceId,
            sessionId: guestProgress.sessionId,
            title: guestProgress.title,
            contentHash: guestProgress.contentHash,
            segmentationVersion: guestProgress.segmentationVersion,
            lastCompletedParagraphIndex: guestProgress.lastCompletedParagraphIndex,
            nextParagraphIndex: guestProgress.nextParagraphIndex,
            totalParagraphs: guestProgress.totalParagraphs,
            voiceId: guestProgress.voiceId,
            speed: guestProgress.speed,
            remainingAllowedMs: guestProgress.remainingAllowedMs,
            totalAllowedMs: guestProgress.totalAllowedMs,
            isOneShot: guestProgress.isOneShot,
        },
    });

    return true;
}

/**
 * 查询指定 guestId 的全量作品迁移映射 Map<guestStoryWorkId, userStoryWorkId>
 */
export async function getStoryWorkIdMapForGuest(
    guestId: string
): Promise<Map<number, number>> {
    const records = await prisma.storyWorkMigration.findMany({
        where: { guestId },
    });
    return new Map(records.map((r) => [r.guestStoryWorkId, r.userStoryWorkId]));
}

/**
 * 根据 guestId 与 guestStoryWorkId 查找对应的 userStoryWorkId
 */
export async function getUserStoryWorkIdByGuestWorkId(
    guestId: string,
    guestStoryWorkId: number
): Promise<number | null> {
    const record = await prisma.storyWorkMigration.findUnique({
        where: {
            guestId_guestStoryWorkId: {
                guestId,
                guestStoryWorkId,
            },
        },
    });
    return record ? record.userStoryWorkId : null;
}
