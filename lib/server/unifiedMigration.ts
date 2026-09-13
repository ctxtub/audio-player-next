/**
 * 访客创作数据迁移服务
 *
 * 仅在注册时，将具名访客的聊天记录、生成历史与提示词历史原子级迁移至新用户。
 */

import { TRPCError } from '@trpc/server';
import { prisma } from '@/lib/db';
import { canonicalizeSourceKind } from '@/lib/playback/legacy';
import { isValidDraftMessageId } from '@/lib/playback/source';
import { mergeRemappedWorkProgress } from '@/lib/playback/progress';

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

            // 如果用户已有同 sourceMessageId 的作品，查询包含 contentHash 以保障幂等安全性
            const existingUserWorks = await tx.storyWork.findMany({
                where: { userId },
                select: { id: true, sourceMessageId: true, contentHash: true },
            });
            const userWorkBySourceMsg = new Map<string, { id: number; contentHash: string }>();
            for (const uw of existingUserWorks) {
                if (uw.sourceMessageId) {
                    userWorkBySourceMsg.set(uw.sourceMessageId, {
                        id: uw.id,
                        contentHash: uw.contentHash ?? '',
                    });
                }
            }

            for (const g of guestStoryWorks) {
                // 若已迁移，直接复用既有映射
                if (existingMap.has(g.id)) {
                    storyWorkIdMap.set(g.id, existingMap.get(g.id)!);
                    continue;
                }

                // 若存在 sourceMessageId 且用户已存在对应作品，必须校验 contentHash
                if (g.sourceMessageId && userWorkBySourceMsg.has(g.sourceMessageId)) {
                    const existing = userWorkBySourceMsg.get(g.sourceMessageId)!;
                    const guestHash = g.contentHash ?? '';
                    if (existing.contentHash === guestHash) {
                        // 同源同 hash：同一作品，建立正确映射，不重复新增
                        storyWorkIdMap.set(g.id, existing.id);
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
                                userStoryWorkId: existing.id,
                            },
                            update: {
                                userStoryWorkId: existing.id,
                            },
                        });
                        continue;
                    } else {
                        // 同源异 hash：拒绝冲突，严禁建立错误 map，严禁覆盖原 User Work
                        throw new TRPCError({
                            code: 'CONFLICT',
                            message: `StoryWork migration conflict: sourceMessageId ${g.sourceMessageId} already exists with differing contentHash (existing: ${existing.contentHash}, incoming: ${guestHash})`,
                        });
                    }
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
                    userWorkBySourceMsg.set(g.sourceMessageId, {
                        id: created.id,
                        contentHash: created.contentHash,
                    });
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
 * 将指定 guestId 的播放状态迁移至指定用户（Anchor + Per-Work Progress，M5-08 §31）。
 *
 * M5-08 copy/remap 语义（同一浏览器身 subject 键切换，不算跨人 merge，M2 no-leak 保持）：
 * 成功迁移的部分以单事务完成 User 侧 upsert/create/idempotent merge（Anchor 先 Progress 后，
 * 每 workId 保持配对）；未映射部分逐项跳过（Guest 行保留，GC 兜底），绝不产生悬空 User 状态。
 * §31.4 GuestStoryPlaybackProgress remap 后 Guest 原记录保留到 Guest GC（GC 删过期
 * GuestStoryWork → FK onDelete: Cascade 清理），本函数绝不删除 Guest Progress 行。
 * 注册后 Guest 侧已迁移的 Anchor 即清除完毕（Anchor 注册后清理不作 blocker，保持现状）；
 * Guest Progress 由 Guest GC 负责最终删除（§47：登录既有账号仍不触发任何迁移/删除，见 login 不调本函数）。
 *
 * - sessionId 原样沿用（不改 session 键域，只改 subject 键；null 由 getAnchor §33 repair）。
 * - M5-03 canonical 锁定：读兼容四值（chat|generation|draft|work，经 canonicalizeSourceKind
 *   收敛；未知 kind 直接 fail-closed），新写只落 canonical draft|work。
 * - Draft Anchor：messageId 原样迁移（chat migration 保持 messageId，§31.1），但
 *   replay-text-* 瞬态 ID 拒绝迁移（fail-closed）。
 * - Work Anchor：借本次 ID map 映射 guestStoryWorkId → userStoryWorkId（§31.2）；
 *   找不到对应映射时 drop Anchor（fail closed，不产生悬空断点，§31.3）。
 * - work sourceId 须为 canonical 十进制 positive int 文本
 *   （String(Number(sourceId)) === sourceId 且 safe int 且 > 0；"001"/"1.5"/"1e3" 等一律拒绝），
 *   非 canonical 一律 fail-closed（不映射、不落库）。
 * - Per-Work Progress（§31.4）：全部 GuestStoryPlaybackProgress 按同一 map 逐行 remap；
 *   User 侧已有同 work 进度时不覆盖，按 max(next) 合并（mergeRemappedWorkProgress）。
 *
 * 返回值（沿用旧契约）：Anchor 迁移成功或任一 Progress 行迁移成功 → true；
 * 无可迁移项（无 guest 行 / 未映射 / 非法）→ false（此时绝无任何写）。
 */
export async function migrateGuestPlaybackProgressToUser(
    guestId: string,
    userId: number,
    storyWorkIdMap?: Map<number, number>
): Promise<boolean> {
    // 合并传入 map（本次 creative 迁移新鲜结果，优先）与持久化 StoryWorkMigration（guest 域）。
    const persistedMappings = await prisma.storyWorkMigration.findMany({
        where: { guestId },
        select: { guestStoryWorkId: true, userStoryWorkId: true },
    });
    const workIdMap = new Map<number, number>();
    for (const r of persistedMappings) {
        workIdMap.set(r.guestStoryWorkId, r.userStoryWorkId);
    }
    if (storyWorkIdMap) {
        for (const [guestWorkId, userWorkId] of storyWorkIdMap) {
            workIdMap.set(guestWorkId, userWorkId);
        }
    }

    const guestAnchor = await prisma.guestPlaybackAnchor.findUnique({
        where: { guestId },
    });
    // Guest Progress 行经 GuestStoryWork → guest 归属（两表 id 序列独立，须先取本 guest
    // 的 work ids 再圈定，绝不按裸 storyWorkId 跨表猜）。
    const guestWorks = await prisma.guestStoryWork.findMany({
        where: { guestId },
        select: { id: true },
    });
    const guestWorkIdSet = new Set(guestWorks.map((w) => w.id));
    const guestProgresses =
        guestWorkIdSet.size === 0
            ? []
            : await prisma.guestStoryPlaybackProgress.findMany({
                  where: { storyWorkId: { in: [...guestWorkIdSet] } },
              });

    // —— Anchor remap 判定（fail-closed：非法/未映射 → null，不写脏行）——
    let remappedAnchor: { sourceKind: 'draft' | 'work'; sourceId: string } | null = null;
    if (guestAnchor) {
        try {
            const canonicalKind = canonicalizeSourceKind(guestAnchor.sourceKind);
            if (canonicalKind === 'draft') {
                if (isValidDraftMessageId(guestAnchor.sourceId)) {
                    remappedAnchor = { sourceKind: 'draft', sourceId: guestAnchor.sourceId };
                }
            } else {
                // fail-closed canonical 文本校验（SQL 等价：String(CAST(sourceId AS INTEGER)) === sourceId AND id > 0）。
                const rawId = guestAnchor.sourceId;
                const numericId = Number(rawId);
                if (
                    typeof rawId === 'string' &&
                    rawId.length > 0 &&
                    Number.isSafeInteger(numericId) &&
                    numericId > 0 &&
                    String(numericId) === rawId
                ) {
                    const userWorkId = workIdMap.get(numericId);
                    if (userWorkId !== undefined) {
                        remappedAnchor = { sourceKind: 'work', sourceId: String(userWorkId) };
                    }
                }
            }
        } catch {
            remappedAnchor = null;
        }
    }

    // —— Progress remap 配对（copy/remap 语义：无映射逐行跳过；有映射的在 User 侧 create/idempotent merge，
    // Guest 侧 Progress 原记录保留到 Guest GC，本函数不删除）——
    const progressRemaps: { guestStoryWorkId: number; userStoryWorkId: number }[] = [];
    for (const p of guestProgresses) {
        const userWorkId = workIdMap.get(p.storyWorkId);
        if (userWorkId === undefined) continue;
        progressRemaps.push({ guestStoryWorkId: p.storyWorkId, userStoryWorkId: userWorkId });
    }

    if (!remappedAnchor && progressRemaps.length === 0) {
        return false;
    }

    await prisma.$transaction(
        async (tx) => {
            // 顺序：Anchor 先，Progress 后（任务 4c）。
            if (guestAnchor && remappedAnchor) {
                const anchorState = guestAnchor.anchorState === 'ended' ? 'ended' : 'ready';
                const anchorData = {
                    sourceKind: remappedAnchor.sourceKind,
                    sourceId: remappedAnchor.sourceId,
                    sessionId: guestAnchor.sessionId,
                    anchorState,
                    title: guestAnchor.title,
                    contentHash: guestAnchor.contentHash,
                    segmentationVersion: guestAnchor.segmentationVersion,
                    lastCompletedParagraphIndex: guestAnchor.lastCompletedParagraphIndex,
                    nextParagraphIndex: guestAnchor.nextParagraphIndex,
                    totalParagraphs: guestAnchor.totalParagraphs,
                    voiceId: guestAnchor.voiceId,
                    speed: guestAnchor.speed,
                    remainingAllowedMs: guestAnchor.remainingAllowedMs,
                    totalAllowedMs: guestAnchor.totalAllowedMs,
                    isOneShot: guestAnchor.isOneShot,
                };
                await tx.userPlaybackAnchor.upsert({
                    where: { userId },
                    create: { userId, ...anchorData },
                    update: anchorData,
                });
            }
            for (const pr of progressRemaps) {
                const guestRow = guestProgresses.find((g) => g.storyWorkId === pr.guestStoryWorkId);
                if (!guestRow) continue;
                const incoming = {
                    contentHash: guestRow.contentHash ?? '',
                    segmentationVersion: guestRow.segmentationVersion ?? 'v1',
                    lastCompletedParagraphIndex: guestRow.lastCompletedParagraphIndex,
                    nextParagraphIndex: guestRow.nextParagraphIndex,
                    totalParagraphs: guestRow.totalParagraphs,
                    completedAt: guestRow.completedAt ? guestRow.completedAt.toISOString() : null,
                    lastPlayedAt: guestRow.lastPlayedAt ? guestRow.lastPlayedAt.toISOString() : null,
                };
                const existing = await tx.storyPlaybackProgress.findUnique({
                    where: { storyWorkId: pr.userStoryWorkId },
                });
                if (!existing) {
                    await tx.storyPlaybackProgress.create({
                        data: {
                            storyWorkId: pr.userStoryWorkId,
                            contentHash: incoming.contentHash,
                            segmentationVersion: incoming.segmentationVersion,
                            lastCompletedParagraphIndex: incoming.lastCompletedParagraphIndex,
                            nextParagraphIndex: incoming.nextParagraphIndex,
                            totalParagraphs: incoming.totalParagraphs,
                            completedAt: guestRow.completedAt ?? null,
                            lastPlayedAt: guestRow.lastPlayedAt ?? new Date(),
                        },
                    });
                } else {
                    // 任务 4g：User 已有同 work 进度 → max(next) 合并，不覆盖。
                    const merged = mergeRemappedWorkProgress(
                        {
                            contentHash: existing.contentHash ?? '',
                            segmentationVersion: existing.segmentationVersion ?? 'v1',
                            lastCompletedParagraphIndex: existing.lastCompletedParagraphIndex,
                            nextParagraphIndex: existing.nextParagraphIndex,
                            totalParagraphs: existing.totalParagraphs,
                            completedAt: existing.completedAt ? existing.completedAt.toISOString() : null,
                            lastPlayedAt: existing.lastPlayedAt ? existing.lastPlayedAt.toISOString() : null,
                        },
                        incoming
                    );
                    await tx.storyPlaybackProgress.update({
                        where: { storyWorkId: pr.userStoryWorkId },
                        data: {
                            contentHash: merged.contentHash,
                            segmentationVersion: merged.segmentationVersion,
                            lastCompletedParagraphIndex: merged.lastCompletedParagraphIndex,
                            nextParagraphIndex: merged.nextParagraphIndex,
                            totalParagraphs: merged.totalParagraphs,
                            completedAt: merged.completedAt ? new Date(merged.completedAt) : null,
                            lastPlayedAt: merged.lastPlayedAt ? new Date(merged.lastPlayedAt) : existing.lastPlayedAt,
                        },
                    });
                }
            }
            // Guest 侧：Anchor 注册后清理（保持现状）；Progress copy/remap 语义下原记录保留到 Guest GC
            //（GC 删过期 GuestStoryWork → FK onDelete: Cascade 清理），此处不删除 Guest Progress 行。
            if (guestAnchor && remappedAnchor) {
                await tx.guestPlaybackAnchor.delete({ where: { guestId } });
            }
        },
        { timeout: 30000 }
    );

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
