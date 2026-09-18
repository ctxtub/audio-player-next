/**
 * StoryCollection 服务层（change-id 2026-09-15-story-collection-continuous-creation）。
 *
 * 职责：
 * 1. Promotion：Artifact → Collection/Work 的唯一写入口（产品 §2.1 首作建集、集合内 position、sourceMessageId 幂等）；
 * 2. 集合 CRUD：list/get/rename/setFavorite/softDelete/restore/deleteForever；
 * 3. 搜索命中 Work 时按 Collection 去重（查询以 Collection 行为单位，天然去重）。
 *
 * 关键约束：
 * - User / Guest 严格对称，跨主体统一 NOT_FOUND；
 * - 标题 AI 生成在事务外短超时，失败走确定性回退，绝不阻断入库；
 * - 同一 sourceMessageId + 同 hash 幂等返回既有 Work，不同 hash 为 CONFLICT；
 * - 集合永久删除级联 Work/进度/音频元数据，音频对象经统一 tombstone outbox 清理。
 */

import { prisma } from '@/lib/db';
import { TRPCError } from '@trpc/server';
import type { Subject } from './subject';
import {
  collectionListInputSchema,
  collectionPromoteInputSchema,
  type CollectionListInput,
  type CollectionListOutput,
  type CollectionPromoteInput,
  type StoryCollectionDetailDTO,
  type StoryCollectionSummaryDTO,
} from '@/lib/trpc/schemas/collection';
import type { StoryWorkDetailDTO } from '@/lib/trpc/schemas/library';
import { normalizeQuery } from '@/lib/storyWork/cursor';
import { buildStoryExcerpt, computeStoryContentHash, resolveStoryTitle } from '@/lib/storyWork/metadata';
import {
  getAudioProjectionsForSubject,
  executeStoryCollectionPhysicalDelete,
  toDetailDto,
  toSummaryDto,
  type StoryWorkRow,
} from './storyWork';
import { isUniqueViolation } from './conversation';
import { generateCollectionTitleSafely } from './collectionTitle';
import {
  normalizeCollectionTitle,
  resolveExistingCollectionTitle,
  resolveFirstCollectionTitle,
} from '@/lib/storyCollection/title';
import {
  buildCollectionCursorPredicate,
  decodeCollectionCursor,
  encodeCollectionCursor,
  isCollectionCursorMatchingInput,
} from '@/lib/storyCollection/cursor';
import { createCollectionId } from '@/lib/storyCollection/identity';

/** Promotion 重试上限（并发建集/分配 position 的唯一冲突重试）。 */
const PROMOTE_MAX_ATTEMPTS = 3;

type CollectionSummaryRow = {
  id: string;
  title: string;
  titleSource: string;
  favoritedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { works: number };
};

/** DB 行 → 集合摘要 DTO。 */
export const toCollectionSummaryDto = (
  row: CollectionSummaryRow,
): StoryCollectionSummaryDTO => ({
  id: row.id,
  title: row.title,
  titleSource: normalizeTitleSource(row.titleSource),
  workCount: row._count?.works ?? 0,
  favoritedAt: row.favoritedAt ? row.favoritedAt.toISOString() : null,
  deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** 标题来源收敛为合法枚举（未知值按 fallback）。 */
function normalizeTitleSource(value: string): 'ai' | 'fallback' | 'user' {
  return value === 'ai' || value === 'user' ? value : 'fallback';
}

/** 组装集合列表基础 where（User/Guest 对称）。 */
/**
 * 列出当前主体的作品集（Keyset 分页；搜索命中集内 Work 时按 Collection 去重）。
 */
export async function listCollectionsForSubject(
  subject: Subject,
  rawInput: unknown,
): Promise<CollectionListOutput> {
  const input = collectionListInputSchema.parse(rawInput) as CollectionListInput;
  const query = normalizeQuery(input.query);

  const andFilters: Record<string, unknown>[] = [];
  andFilters.push({ deletedAt: input.view === 'trash' ? { not: null } : null });
  if (input.view === 'favorites') {
    andFilters.push({ favoritedAt: { not: null } });
  }
  if (query.length > 0) {
    andFilters.push({
      OR: [
        { title: { contains: query } },
        {
          works: {
            some: {
              OR: [
                { title: { contains: query } },
                { prompt: { contains: query } },
                { excerpt: { contains: query } },
              ],
            },
          },
        },
      ],
    });
  }

  if (input.cursor) {
    const decoded = decodeCollectionCursor(input.cursor);
    if (!decoded || !isCollectionCursorMatchingInput(decoded, { view: input.view, query })) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: '分页游标无效' });
    }
    andFilters.push(buildCollectionCursorPredicate(decoded));
  }

  const orderBy =
    input.view === 'trash'
      ? [{ deletedAt: 'desc' as const }, { id: 'desc' as const }]
      : [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

  const rows = (await (subject.type === 'user'
    ? prisma.storyCollection.findMany({
        where: { userId: subject.id, AND: andFilters },
        orderBy,
        take: input.limit + 1,
        include: { _count: { select: { works: true } } },
      })
    : prisma.guestStoryCollection.findMany({
        where: { guestId: subject.id, AND: andFilters },
        orderBy,
        take: input.limit + 1,
        include: { _count: { select: { works: true } } },
      }))) as unknown as CollectionSummaryRow[];

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore
    ? encodeCollectionCursor({
        view: input.view,
        query,
        t: (input.view === 'trash' ? last.deletedAt! : last.createdAt).toISOString(),
        id: last.id,
      })
    : null;

  return {
    items: page.map(toCollectionSummaryDto),
    nextCursor,
    hasMore: nextCursor !== null,
  };
}

/**
 * 读取集合详情（按 Work position 升序返回成员）。软删除 / 跨主体统一 NOT_FOUND（fail closed）。
 */
export async function getCollectionForSubject(
  subject: Subject,
  id: string,
): Promise<StoryCollectionDetailDTO> {
  if (subject.type === 'user') {
    const row = await prisma.storyCollection.findFirst({
      where: { id, userId: subject.id, deletedAt: null },
      include: {
        _count: { select: { works: true } },
        works: {
          where: { position: { not: null } },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            voiceId: true,
            title: true,
            excerpt: true,
            contentHash: true,
            favoritedAt: true,
            deletedAt: true,
            createdAt: true,
            updatedAt: true,
            position: true,
          },
        },
      },
    });
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: '作品集不存在' });
    const audio = await getAudioProjectionsForSubject(
      subject,
      row.works.map((w) => w.id),
    );
    return {
      ...toCollectionSummaryDto(row),
      works: row.works.map((w) => ({
        ...toSummaryDto(w, audio.get(w.id)),
        position: w.position ?? 0,
      })),
    };
  }

  const row = await prisma.guestStoryCollection.findFirst({
    where: { id, guestId: subject.id, deletedAt: null },
    include: {
      _count: { select: { works: true } },
      works: {
        where: { position: { not: null } },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          voiceId: true,
          title: true,
          excerpt: true,
          contentHash: true,
          favoritedAt: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
          position: true,
        },
      },
    },
  });
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: '作品集不存在' });
  const audio = await getAudioProjectionsForSubject(
    subject,
    row.works.map((w) => w.id),
  );
  return {
    ...toCollectionSummaryDto(row),
    works: row.works.map((w) => ({
      ...toSummaryDto(w, audio.get(w.id)),
      position: w.position ?? 0,
    })),
  };
}

/**
 * 重命名集合：用户标题永远优先（titleSource=user，自动流程不得覆盖）。
 */
export async function renameCollectionForSubject(
  subject: Subject,
  id: string,
  rawTitle: string,
): Promise<StoryCollectionDetailDTO> {
  const title = normalizeCollectionTitle(rawTitle);
  if (title.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '标题不能为空' });
  }
  const res =
    subject.type === 'user'
      ? await prisma.storyCollection.updateMany({
          where: { id, userId: subject.id, deletedAt: null },
          data: { title, titleSource: 'user' },
        })
      : await prisma.guestStoryCollection.updateMany({
          where: { id, guestId: subject.id, deletedAt: null },
          data: { title, titleSource: 'user' },
        });
  if (res.count === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: '作品集不存在' });
  }
  return getCollectionForSubject(subject, id);
}

/**
 * 集合级收藏 / 取消收藏。
 */
export async function setCollectionFavoriteForSubject(
  subject: Subject,
  id: string,
  favorite: boolean,
): Promise<StoryCollectionDetailDTO> {
  const data = { favoritedAt: favorite ? new Date() : null };
  const res =
    subject.type === 'user'
      ? await prisma.storyCollection.updateMany({
          where: { id, userId: subject.id, deletedAt: null },
          data,
        })
      : await prisma.guestStoryCollection.updateMany({
          where: { id, guestId: subject.id, deletedAt: null },
          data,
        });
  if (res.count === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: '作品集不存在' });
  }
  return getCollectionForSubject(subject, id);
}

/**
 * 软删除集合：集合与其成员 Work 一并进入回收站（集合级生命周期，产品 §3.3）。
 * 幂等：已软删返回成功。
 */
export async function softDeleteCollectionForSubject(
  subject: Subject,
  id: string,
): Promise<{ success: true; id: string }> {
  const now = new Date();
  if (subject.type === 'user') {
    await prisma.$transaction(async (tx) => {
      const current = await tx.storyCollection.findFirst({
        where: { id, userId: subject.id },
        select: { id: true, deletedAt: true },
      });
      if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: '作品集不存在' });
      if (current.deletedAt !== null) return;
      await tx.storyWork.updateMany({
        where: { collectionId: id, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.storyCollection.update({ where: { id }, data: { deletedAt: now } });
    });
    return { success: true, id };
  }
  await prisma.$transaction(async (tx) => {
    const current = await tx.guestStoryCollection.findFirst({
      where: { id, guestId: subject.id },
      select: { id: true, deletedAt: true },
    });
    if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: '作品集不存在' });
    if (current.deletedAt !== null) return;
    await tx.guestStoryWork.updateMany({
      where: { collectionId: id, deletedAt: null },
      data: { deletedAt: now },
    });
    await tx.guestStoryCollection.update({ where: { id }, data: { deletedAt: now } });
  });
  return { success: true, id };
}

/**
 * 从回收站恢复集合及其成员 Work。active 集合调用为 CONFLICT。
 */
export async function restoreCollectionForSubject(
  subject: Subject,
  id: string,
): Promise<StoryCollectionDetailDTO> {
  if (subject.type === 'user') {
    await prisma.$transaction(async (tx) => {
      const current = await tx.storyCollection.findFirst({
        where: { id, userId: subject.id },
        select: { id: true, deletedAt: true },
      });
      if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: '作品集不存在' });
      if (current.deletedAt === null) {
        throw new TRPCError({ code: 'CONFLICT', message: '仅允许恢复回收站中的作品集' });
      }
      await tx.storyWork.updateMany({
        where: { collectionId: id, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
      await tx.storyCollection.update({ where: { id }, data: { deletedAt: null } });
    });
    return getCollectionForSubject(subject, id);
  }
  await prisma.$transaction(async (tx) => {
    const current = await tx.guestStoryCollection.findFirst({
      where: { id, guestId: subject.id },
      select: { id: true, deletedAt: true },
    });
    if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: '作品集不存在' });
    if (current.deletedAt === null) {
      throw new TRPCError({ code: 'CONFLICT', message: '仅允许恢复回收站中的作品集' });
    }
    await tx.guestStoryWork.updateMany({
      where: { collectionId: id, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    await tx.guestStoryCollection.update({ where: { id }, data: { deletedAt: null } });
  });
  return getCollectionForSubject(subject, id);
}

/**
 * 永久删除集合：级联 Work（经 collection-aware 统一物理删除 seam，含音频 tombstone outbox）、
 * 进度与音频元数据。仅允许对回收站中的集合执行；active 为 CONFLICT。
 *
 *  Blocker 1：重验、成员固定、tombstone、成员删除、无 survivor 确认与 Collection 删除
 * 全部收敛在 `executeStoryCollectionPhysicalDelete` 的同一 DB 原子边界内；restore 竞态
 * fail closed，绝不依赖 FK cascade 删除成员。
 */
export async function deleteForeverCollectionForSubject(
  subject: Subject,
  id: string,
): Promise<{ success: true; id: string }> {
  if (subject.type === 'user') {
    await executeStoryCollectionPhysicalDelete({
      target: 'user',
      collectionId: id,
      userId: subject.id,
    });
  } else {
    await executeStoryCollectionPhysicalDelete({
      target: 'guest',
      collectionId: id,
      guestId: subject.id,
    });
  }
  return { success: true, id };
}

/**
 * Promotion：Artifact → Collection/Work 唯一写入口。
 *
 * 顺序（产品 §2.2）：
 * 1. 幂等：同一 sourceMessageId 已存在 → 同 hash 返回既有 Work，不同 hash CONFLICT；
 * 2. 校验会话归属与 active；
 * 3. 集合不存在时事务外短超时生成 AI 标题（失败走确定性回退）；
 * 4. 事务内 upsert 集合 + 分配集合内 position + 创建 Work；
 * 5. 唯一冲突（并发）最多重试 PROMOTE_MAX_ATTEMPTS 次。
 */
export async function promoteArtifactForSubject(
  subject: Subject,
  rawInput: unknown,
): Promise<StoryWorkDetailDTO> {
  const input = collectionPromoteInputSchema.parse(rawInput) as CollectionPromoteInput;
  const voiceId = input.voiceId ?? '';
  const workTitle = resolveStoryTitle({ storyText: input.storyText, prompt: input.prompt });
  const excerpt = buildStoryExcerpt(input.storyText);
  const contentHash = computeStoryContentHash(input.storyText);

  const existing = await findWorkBySourceMessageId(subject, input.sourceMessageId);
  if (existing) {
    if (existing.contentHash && existing.contentHash !== contentHash) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: '同一来源消息已存在不同正文的作品',
      });
    }
    return toDetailDto(existing);
  }

  const conversation = await findConversationForPromotion(subject, input.conversationId);
  if (!conversation) {
    throw new TRPCError({ code: 'NOT_FOUND', message: '会话不存在' });
  }
  if (conversation.state !== 'active') {
    throw new TRPCError({ code: 'CONFLICT', message: '会话已结束，无法继续创作' });
  }

  const existingCollection = await findCollectionByConversationId(subject, input.conversationId);
  const aiTitle = existingCollection
    ? null
    : await generateCollectionTitleSafely({ storyText: input.storyText, prompt: input.prompt });
  const resolvedTitle = existingCollection
    ? resolveExistingCollectionTitle({
        existingTitle: existingCollection.title,
        existingTitleSource: existingCollection.titleSource,
        storyText: input.storyText,
        prompt: input.prompt,
      })
    : resolveFirstCollectionTitle({
        aiTitle,
        storyText: input.storyText,
        prompt: input.prompt,
      });

  for (let attempt = 0; attempt < PROMOTE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await runPromotionTransaction(subject, {
        conversationId: input.conversationId,
        sourceMessageId: input.sourceMessageId,
        voiceId,
        prompt: input.prompt,
        storyText: input.storyText,
        workTitle,
        excerpt,
        contentHash,
        resolvedTitle,
      });
    } catch (error) {
      if (isUniqueViolation(error) && attempt < PROMOTE_MAX_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }
  // 理论不可达（循环内 return 或 throw）。
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '作品入库失败' });
}

type PromotionTransactionInput = {
  conversationId: string;
  sourceMessageId: string;
  voiceId: string;
  prompt: string;
  storyText: string;
  workTitle: string;
  excerpt: string;
  contentHash: string;
  resolvedTitle: { title: string; titleSource: 'ai' | 'fallback' | 'user' };
};

async function runPromotionTransaction(
  subject: Subject,
  input: PromotionTransactionInput,
): Promise<StoryWorkDetailDTO> {
  if (subject.type === 'user') {
    return prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { id: input.conversationId, userId: subject.id },
        select: { id: true, state: true },
      });
      if (!conversation) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '会话不存在' });
      }
      if (conversation.state !== 'active') {
        throw new TRPCError({ code: 'CONFLICT', message: '会话已结束，无法继续创作' });
      }
      const dup = await tx.storyWork.findFirst({
        where: { userId: subject.id, sourceMessageId: input.sourceMessageId },
      });
      if (dup) {
        if (dup.contentHash && dup.contentHash !== input.contentHash) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: '同一来源消息已存在不同正文的作品',
          });
        }
        return toDetailDto(dup);
      }
      let collection = await tx.storyCollection.findUnique({
        where: { conversationId: input.conversationId },
      });
      if (!collection) {
        collection = await tx.storyCollection.create({
          data: {
            id: createCollectionId(),
            userId: subject.id,
            conversationId: input.conversationId,
            title: input.resolvedTitle.title,
            titleSource: input.resolvedTitle.titleSource,
          },
        });
      } else if (collection.deletedAt !== null) {
        throw new TRPCError({ code: 'CONFLICT', message: '作品集已删除，无法继续创作' });
      } else if (collection.title.length === 0 && input.resolvedTitle.title.length > 0) {
        collection = await tx.storyCollection.update({
          where: { id: collection.id },
          data: {
            title: input.resolvedTitle.title,
            titleSource: collection.titleSource === 'user' ? 'user' : input.resolvedTitle.titleSource,
          },
        });
      }
      const aggregate = await tx.storyWork.aggregate({
        where: { collectionId: collection.id },
        _max: { position: true },
      });
      const nextPosition = (aggregate._max.position ?? -1) + 1;
      const created = await tx.storyWork.create({
        data: {
          userId: subject.id,
          collectionId: collection.id,
          position: nextPosition,
          prompt: input.prompt,
          storyText: input.storyText,
          voiceId: input.voiceId,
          title: input.workTitle,
          excerpt: input.excerpt,
          contentHash: input.contentHash,
          sourceMessageId: input.sourceMessageId,
        },
      });
      return toDetailDto(created);
    });
  }

  return prisma.$transaction(async (tx) => {
    const conversation = await tx.guestConversation.findFirst({
      where: { id: input.conversationId, guestId: subject.id },
      select: { id: true, state: true },
    });
    if (!conversation) {
      throw new TRPCError({ code: 'NOT_FOUND', message: '会话不存在' });
    }
    if (conversation.state !== 'active') {
      throw new TRPCError({ code: 'CONFLICT', message: '会话已结束，无法继续创作' });
    }
    const dup = await tx.guestStoryWork.findFirst({
      where: { guestId: subject.id, sourceMessageId: input.sourceMessageId },
    });
    if (dup) {
      if (dup.contentHash && dup.contentHash !== input.contentHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: '同一来源消息已存在不同正文的作品',
        });
      }
      return toDetailDto(dup);
    }
    let collection = await tx.guestStoryCollection.findUnique({
      where: { conversationId: input.conversationId },
    });
    if (!collection) {
      collection = await tx.guestStoryCollection.create({
        data: {
          id: createCollectionId(),
          guestId: subject.id,
          conversationId: input.conversationId,
          title: input.resolvedTitle.title,
          titleSource: input.resolvedTitle.titleSource,
        },
      });
    } else if (collection.deletedAt !== null) {
      throw new TRPCError({ code: 'CONFLICT', message: '作品集已删除，无法继续创作' });
    } else if (collection.title.length === 0 && input.resolvedTitle.title.length > 0) {
      collection = await tx.guestStoryCollection.update({
        where: { id: collection.id },
        data: {
          title: input.resolvedTitle.title,
          titleSource: collection.titleSource === 'user' ? 'user' : input.resolvedTitle.titleSource,
        },
      });
    }
    const aggregate = await tx.guestStoryWork.aggregate({
      where: { collectionId: collection.id },
      _max: { position: true },
    });
    const nextPosition = (aggregate._max.position ?? -1) + 1;
    const created = await tx.guestStoryWork.create({
      data: {
        guestId: subject.id,
        collectionId: collection.id,
        position: nextPosition,
        prompt: input.prompt,
        storyText: input.storyText,
        voiceId: input.voiceId,
        title: input.workTitle,
        excerpt: input.excerpt,
        contentHash: input.contentHash,
        sourceMessageId: input.sourceMessageId,
      },
    });
    return toDetailDto(created);
  });
}

/** 按 sourceMessageId 查既有 Work（User/Guest 对称，返回全量行）。 */
async function findWorkBySourceMessageId(
  subject: Subject,
  sourceMessageId: string,
): Promise<StoryWorkRow | null> {
  if (subject.type === 'user') {
    return prisma.storyWork.findFirst({ where: { userId: subject.id, sourceMessageId } });
  }
  return prisma.guestStoryWork.findFirst({ where: { guestId: subject.id, sourceMessageId } });
}

/** 查会话（promotion 用；不带 collections 关联）。 */
async function findConversationForPromotion(
  subject: Subject,
  conversationId: string,
): Promise<{ id: string; state: string } | null> {
  if (subject.type === 'user') {
    return prisma.conversation.findFirst({
      where: { id: conversationId, userId: subject.id },
      select: { id: true, state: true },
    });
  }
  return prisma.guestConversation.findFirst({
    where: { id: conversationId, guestId: subject.id },
    select: { id: true, state: true },
  });
}

/** 按 conversationId 查集合（User/Guest 对称）。 */
async function findCollectionByConversationId(
  subject: Subject,
  conversationId: string,
): Promise<{ id: string; title: string; titleSource: string; deletedAt: Date | null } | null> {
  if (subject.type === 'user') {
    return prisma.storyCollection.findUnique({
      where: { conversationId },
      select: { id: true, title: true, titleSource: true, deletedAt: true },
    });
  }
  return prisma.guestStoryCollection.findUnique({
    where: { conversationId },
    select: { id: true, title: true, titleSource: true, deletedAt: true },
  });
}
