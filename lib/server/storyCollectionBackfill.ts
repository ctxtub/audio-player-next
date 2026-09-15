/**
 * StoryCollection 可重复 backfill（change-id 2026-09-15-story-collection-continuous-creation T1）。
 *
 * expand → backfill 阶段的数据搬运：
 * 1. 现有 Chat 快照进入一个 legacy Conversation（每主体一个，确定性 id，可重复执行）；
 * 2. 旧 Work 默认「一 Work 一 Collection」；
 * 3. 只有可靠证据（sourceMessageId 命中同主体 ChatMessage 且该消息已属某 Conversation）才合并进该会话的集合，
 *    **禁止按时间猜测合并**（产品 §12 / 技术方案 §7.3）。
 *
 * 幂等保证：
 * - 会话 / 集合 id 由稳定业务键派生（deriveDeterministicId）；
 * - 集合另有 unique(conversationId) 约束；
 * - 只处理 collectionId 为空或 position 为空的 Work；重跑为空操作。
 */

import { prisma } from '@/lib/db';
import type { Subject } from './subject';
import { deriveDeterministicId } from '@/lib/storyCollection/identity';
import { buildCollectionFallbackTitle } from '@/lib/storyCollection/title';
import { isUniqueViolation } from './conversation';

export type StoryCollectionBackfillCounts = {
  conversationsCreated: number;
  collectionsCreated: number;
  worksAttached: number;
  worksGroupedByChat: number;
  worksIndividual: number;
  chatMessagesAssigned: number;
  conflictsReused: number;
};

const emptyCounts = (): StoryCollectionBackfillCounts => ({
  conversationsCreated: 0,
  collectionsCreated: 0,
  worksAttached: 0,
  worksGroupedByChat: 0,
  worksIndividual: 0,
  chatMessagesAssigned: 0,
  conflictsReused: 0,
});

/**
 * 单主体 backfill（User / Guest 对称）。
 */
export async function backfillStoryCollectionsForSubject(
  subject: Subject,
): Promise<StoryCollectionBackfillCounts> {
  return subject.type === 'user'
    ? backfillUser(subject.id)
    : backfillGuest(subject.id);
}

/**
 * 全局 backfill：遍历所有 User 与出现过的 Guest。
 */
export async function runStoryCollectionBackfill(): Promise<StoryCollectionBackfillCounts> {
  const counts = emptyCounts();
  const users = await prisma.user.findMany({ select: { id: true } });
  for (const user of users) {
    mergeCounts(counts, await backfillUser(user.id));
  }
  const guestIds = new Set<string>();
  for (const row of await prisma.guestChatMessage.findMany({
    select: { guestId: true },
    distinct: ['guestId'],
  })) {
    guestIds.add(row.guestId);
  }
  for (const row of await prisma.guestStoryWork.findMany({
    select: { guestId: true },
    distinct: ['guestId'],
  })) {
    guestIds.add(row.guestId);
  }
  for (const guestId of guestIds) {
    mergeCounts(counts, await backfillGuest(guestId));
  }
  return counts;
}

function mergeCounts(
  target: StoryCollectionBackfillCounts,
  source: StoryCollectionBackfillCounts,
): void {
  target.conversationsCreated += source.conversationsCreated;
  target.collectionsCreated += source.collectionsCreated;
  target.worksAttached += source.worksAttached;
  target.worksGroupedByChat += source.worksGroupedByChat;
  target.worksIndividual += source.worksIndividual;
  target.chatMessagesAssigned += source.chatMessagesAssigned;
  target.conflictsReused += source.conflictsReused;
}

async function backfillUser(userId: number): Promise<StoryCollectionBackfillCounts> {
  const counts = emptyCounts();

  // 1. 现有 Chat 快照 → legacy Conversation（仅处理尚未归属会话的消息）
  const unassignedMessages = await prisma.chatMessage.findMany({
    where: { userId, conversationId: null },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  if (unassignedMessages.length > 0) {
    const legacyConversationId = deriveDeterministicId('legacy-conversation', `user:${userId}`);
    const existing = await prisma.conversation.findUnique({ where: { id: legacyConversationId } });
    if (!existing) {
      await prisma.conversation.create({
        data: { id: legacyConversationId, userId, state: 'closed' },
      });
      counts.conversationsCreated += 1;
    }
    const maxPosition = await prisma.chatMessage.aggregate({
      where: { conversationId: legacyConversationId },
      _max: { position: true },
    });
    let position = (maxPosition._max.position ?? -1) + 1;
    const seenMessageIds = new Set<string>();
    for (const message of unassignedMessages) {
      if (seenMessageIds.has(message.messageId)) continue;
      seenMessageIds.add(message.messageId);
      await prisma.chatMessage.update({
        where: { id: message.id },
        data: { conversationId: legacyConversationId, position },
      });
      position += 1;
      counts.chatMessagesAssigned += 1;
    }
  }

  // 2. 旧 Work → Collection（默认一 Work 一 Collection；仅可靠证据合并）
  const works = await prisma.storyWork.findMany({
    where: { userId, OR: [{ collectionId: null }, { position: null }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const work of works) {
    let conversationId: string | null = null;
    let grouped = false;
    if (work.sourceMessageId) {
      const message = await prisma.chatMessage.findFirst({
        where: {
          userId,
          messageId: work.sourceMessageId,
          conversationId: { not: null },
        },
        select: { conversationId: true },
      });
      if (message?.conversationId) {
        conversationId = message.conversationId;
        grouped = true;
      }
    }
    if (!conversationId) {
      conversationId = deriveDeterministicId(
        'legacy-work-conversation',
        `user:${userId}:work:${work.id}`,
      );
    }
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) {
      await prisma.conversation.create({
        data: { id: conversationId, userId, state: 'closed' },
      });
      counts.conversationsCreated += 1;
    }
    let collection = await prisma.storyCollection.findUnique({
      where: { conversationId },
      select: { id: true },
    });
    if (!collection) {
      const fallback = buildCollectionFallbackTitle({
        storyText: work.storyText,
        prompt: work.prompt,
      });
      collection = await prisma.storyCollection.create({
        data: {
          id: deriveDeterministicId('legacy-collection', `user:${userId}:conv:${conversationId}`),
          userId,
          conversationId,
          title: fallback.title,
          titleSource: fallback.titleSource,
        },
        select: { id: true },
      });
      counts.collectionsCreated += 1;
    }
    const maxPosition = await prisma.storyWork.aggregate({
      where: { collectionId: collection.id },
      _max: { position: true },
    });
    const position = (maxPosition._max.position ?? -1) + 1;
    try {
      await prisma.storyWork.update({
        where: { id: work.id },
        data: { collectionId: collection.id, position },
      });
      counts.worksAttached += 1;
      if (grouped) counts.worksGroupedByChat += 1;
      else counts.worksIndividual += 1;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const again = await prisma.storyWork.findUnique({
          where: { id: work.id },
          select: { collectionId: true },
        });
        if (again?.collectionId) {
          counts.conflictsReused += 1;
          continue;
        }
      }
      throw error;
    }
  }

  return counts;
}

async function backfillGuest(guestId: string): Promise<StoryCollectionBackfillCounts> {
  const counts = emptyCounts();

  const unassignedMessages = await prisma.guestChatMessage.findMany({
    where: { guestId, conversationId: null },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  if (unassignedMessages.length > 0) {
    const legacyConversationId = deriveDeterministicId('legacy-conversation', `guest:${guestId}`);
    const existing = await prisma.guestConversation.findUnique({
      where: { id: legacyConversationId },
    });
    if (!existing) {
      await prisma.guestConversation.create({
        data: { id: legacyConversationId, guestId, state: 'closed' },
      });
      counts.conversationsCreated += 1;
    }
    const maxPosition = await prisma.guestChatMessage.aggregate({
      where: { conversationId: legacyConversationId },
      _max: { position: true },
    });
    let position = (maxPosition._max.position ?? -1) + 1;
    const seenMessageIds = new Set<string>();
    for (const message of unassignedMessages) {
      if (seenMessageIds.has(message.messageId)) continue;
      seenMessageIds.add(message.messageId);
      await prisma.guestChatMessage.update({
        where: { id: message.id },
        data: { conversationId: legacyConversationId, position },
      });
      position += 1;
      counts.chatMessagesAssigned += 1;
    }
  }

  const works = await prisma.guestStoryWork.findMany({
    where: { guestId, OR: [{ collectionId: null }, { position: null }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const work of works) {
    let conversationId: string | null = null;
    let grouped = false;
    if (work.sourceMessageId) {
      const message = await prisma.guestChatMessage.findFirst({
        where: {
          guestId,
          messageId: work.sourceMessageId,
          conversationId: { not: null },
        },
        select: { conversationId: true },
      });
      if (message?.conversationId) {
        conversationId = message.conversationId;
        grouped = true;
      }
    }
    if (!conversationId) {
      conversationId = deriveDeterministicId(
        'legacy-work-conversation',
        `guest:${guestId}:work:${work.id}`,
      );
    }
    const conversation = await prisma.guestConversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      await prisma.guestConversation.create({
        data: { id: conversationId, guestId, state: 'closed' },
      });
      counts.conversationsCreated += 1;
    }
    let collection = await prisma.guestStoryCollection.findUnique({
      where: { conversationId },
      select: { id: true },
    });
    if (!collection) {
      const fallback = buildCollectionFallbackTitle({
        storyText: work.storyText,
        prompt: work.prompt,
      });
      collection = await prisma.guestStoryCollection.create({
        data: {
          id: deriveDeterministicId('legacy-collection', `guest:${guestId}:conv:${conversationId}`),
          guestId,
          conversationId,
          title: fallback.title,
          titleSource: fallback.titleSource,
        },
        select: { id: true },
      });
      counts.collectionsCreated += 1;
    }
    const maxPosition = await prisma.guestStoryWork.aggregate({
      where: { collectionId: collection.id },
      _max: { position: true },
    });
    const position = (maxPosition._max.position ?? -1) + 1;
    try {
      await prisma.guestStoryWork.update({
        where: { id: work.id },
        data: { collectionId: collection.id, position },
      });
      counts.worksAttached += 1;
      if (grouped) counts.worksGroupedByChat += 1;
      else counts.worksIndividual += 1;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const again = await prisma.guestStoryWork.findUnique({
          where: { id: work.id },
          select: { collectionId: true },
        });
        if (again?.collectionId) {
          counts.conflictsReused += 1;
          continue;
        }
      }
      throw error;
    }
  }

  return counts;
}

/** 迁移守恒证据快照（只读；用于 evidence 脚本与测试）。 */
export type StoryCollectionMigrationState = {
  userConversations: number;
  guestConversations: number;
  userCollections: number;
  guestCollections: number;
  userWorksTotal: number;
  guestWorksTotal: number;
  userWorksAttached: number;
  guestWorksAttached: number;
  userWorksOrphaned: number;
  guestWorksOrphaned: number;
  userWorksPositionless: number;
  guestWorksPositionless: number;
};

/**
 * 采集迁移前后计数与孤儿数（只读，永不写库）。
 * 孤儿定义：collectionId 非空但对应 Collection 不存在。
 */
export async function measureStoryCollectionMigrationState(): Promise<StoryCollectionMigrationState> {
  const [
    userConversations,
    guestConversations,
    userCollections,
    guestCollections,
    userWorksTotal,
    guestWorksTotal,
    userWorks,
    guestWorks,
  ] = await Promise.all([
    prisma.conversation.count(),
    prisma.guestConversation.count(),
    prisma.storyCollection.count(),
    prisma.guestStoryCollection.count(),
    prisma.storyWork.count(),
    prisma.guestStoryWork.count(),
    prisma.storyWork.findMany({ select: { collectionId: true, position: true } }),
    prisma.guestStoryWork.findMany({ select: { collectionId: true, position: true } }),
  ]);

  const userCollectionIds = new Set(
    (
      await prisma.storyCollection.findMany({ select: { id: true } })
    ).map((c) => c.id),
  );
  const guestCollectionIds = new Set(
    (
      await prisma.guestStoryCollection.findMany({ select: { id: true } })
    ).map((c) => c.id),
  );

  const userOrphaned = userWorks.filter(
    (w) => w.collectionId !== null && !userCollectionIds.has(w.collectionId),
  ).length;
  const guestOrphaned = guestWorks.filter(
    (w) => w.collectionId !== null && !guestCollectionIds.has(w.collectionId),
  ).length;
  const userPositionless = userWorks.filter(
    (w) => w.collectionId !== null && w.position === null,
  ).length;
  const guestPositionless = guestWorks.filter(
    (w) => w.collectionId !== null && w.position === null,
  ).length;

  return {
    userConversations,
    guestConversations,
    userCollections,
    guestCollections,
    userWorksTotal,
    guestWorksTotal,
    userWorksAttached: userWorks.filter((w) => w.collectionId !== null).length,
    guestWorksAttached: guestWorks.filter((w) => w.collectionId !== null).length,
    userWorksOrphaned: userOrphaned,
    guestWorksOrphaned: guestOrphaned,
    userWorksPositionless: userPositionless,
    guestWorksPositionless: guestPositionless,
  };
}
