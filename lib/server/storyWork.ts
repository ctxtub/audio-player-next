/**
 * StoryWork 服务端读模型服务层（Library Read Service）
 *
 * 提供基于 Subject（登录用户 / 具名访客）的列表查询（List）、详情获取（Get）、
 * Keyset 游标分页（Cursor）、安全检索（Search）与旧数据元数据懒修复（Lazy Backfill）。
 *
 * 遵循严格原则：
 * 1. 所有查询从 Subject 进入，物理隔绝跨租户访问；
 * 2. Keyset 分页（严禁 OFFSET），同一 timestamp 多条靠 id DESC 确定性排序；
 * 3. 游标必须校验 view 与 query 绑定关系，不一致立即拒绝；
 * 4. hasMore 唯一恒等于 (nextCursor !== null)；
 * 5. 搜索严格仅限 title / prompt / excerpt，严禁扫描庞大 storyText；
 * 6. 详情查询仅放行 deletedAt IS NULL，trash / foreign / nonexistent 统一 NOT_FOUND；
 * 7. Legacy 数据懒修复：首次读取当前 Subject 自动修补并持久化，不跨 Subject，二次读取零开销。
 */

import { prisma } from '@/lib/db';
import { TRPCError } from '@trpc/server';
import type { Subject } from '@/lib/server/subject';
import {
  libraryListInputSchema,
  type LibraryListInput,
  type LibraryListOutput,
  type StoryWorkDetailDTO,
  type StoryWorkSummaryDTO,
  createMissingAudioProjection,
} from '@/lib/trpc/schemas/library';
import {
  buildCursorPredicate,
  decodeLibraryCursor,
  encodeLibraryCursor,
  isCursorMatchingInput,
  normalizeQuery,
  type LibraryCursorPayload,
} from '@/lib/storyWork/cursor';
import {
  resolveStoryTitle,
  buildStoryExcerpt,
  computeStoryContentHash,
} from '@/lib/storyWork/metadata';

/** StoryWork DB 行结构（全量字段） */
export type StoryWorkRow = {
  id: number;
  prompt: string;
  storyText: string;
  voiceId: string;
  title: string;
  excerpt: string;
  contentHash: string;
  sourceMessageId: string | null;
  favoritedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** StoryWork 列表摘要行结构（不含庞大正文与 prompt） */
export type StoryWorkSummaryRow = {
  id: number;
  voiceId: string;
  title: string;
  excerpt: string;
  contentHash: string;
  favoritedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * DB 摘要行 → 前端 Summary DTO
 */
export const toSummaryDto = (row: StoryWorkSummaryRow): StoryWorkSummaryDTO => ({
  id: row.id,
  title: row.title,
  excerpt: row.excerpt,
  voiceId: row.voiceId,
  contentHash: row.contentHash,
  favoritedAt: row.favoritedAt ? row.favoritedAt.toISOString() : null,
  deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  audio: createMissingAudioProjection(),
});

/**
 * DB 全量行 → 前端 Detail DTO
 */
export const toDetailDto = (row: StoryWorkRow): StoryWorkDetailDTO => ({
  id: row.id,
  title: row.title,
  excerpt: row.excerpt,
  voiceId: row.voiceId,
  contentHash: row.contentHash,
  favoritedAt: row.favoritedAt ? row.favoritedAt.toISOString() : null,
  deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  audio: createMissingAudioProjection(),
  prompt: row.prompt,
  storyText: row.storyText,
  sourceMessageId: row.sourceMessageId ?? null,
});

/**
 * Legacy 元数据懒修补（Lazy Backfill）：
 * M2-01 引入 title/excerpt/contentHash 后，历史行可能未填充上述字段。
 * 首次读取当前 Subject 时发现未填充数据，立即使用 M2-02 派生算法补齐并持久化。
 * 严格限制在当前 Subject 范围内，绝不跨 Subject；已修复行二次读取不触发写操作。
 *
 * @returns 修复的记录条数
 */
export async function repairLegacyStoryWorksForSubject(
  subject: Subject
): Promise<number> {
  const legacyCondition = {
    OR: [
      { contentHash: '' },
      { title: '' },
      {
        AND: [
          { storyText: { not: '' } },
          { excerpt: '' },
        ],
      },
    ],
  };

  if (subject.type === 'user') {
    const legacyRows = await prisma.storyWork.findMany({
      where: {
        userId: subject.id,
        ...legacyCondition,
      },
      select: {
        id: true,
        title: true,
        prompt: true,
        storyText: true,
        excerpt: true,
        contentHash: true,
      },
    });

    if (legacyRows.length === 0) {
      return 0;
    }

    for (const row of legacyRows) {
      const title =
        row.title && row.title.trim().length > 0
          ? row.title
          : resolveStoryTitle({
              title: row.title,
              storyText: row.storyText,
              prompt: row.prompt,
            });
      const excerpt =
        row.excerpt && row.excerpt.trim().length > 0
          ? row.excerpt
          : buildStoryExcerpt(row.storyText);
      const contentHash =
        row.contentHash && row.contentHash.trim().length > 0
          ? row.contentHash
          : computeStoryContentHash(row.storyText);

      await prisma.storyWork.update({
        where: { id: row.id },
        data: { title, excerpt, contentHash },
      });
    }

    return legacyRows.length;
  }

  // 具名访客主体
  const legacyRows = await prisma.guestStoryWork.findMany({
    where: {
      guestId: subject.id,
      ...legacyCondition,
    },
    select: {
      id: true,
      title: true,
      prompt: true,
      storyText: true,
      excerpt: true,
      contentHash: true,
    },
  });

  if (legacyRows.length === 0) {
    return 0;
  }

  for (const row of legacyRows) {
    const title =
      row.title && row.title.trim().length > 0
        ? row.title
        : resolveStoryTitle({
            title: row.title,
            storyText: row.storyText,
            prompt: row.prompt,
          });
    const excerpt =
      row.excerpt && row.excerpt.trim().length > 0
        ? row.excerpt
        : buildStoryExcerpt(row.storyText);
    const contentHash =
      row.contentHash && row.contentHash.trim().length > 0
        ? row.contentHash
        : computeStoryContentHash(row.storyText);

    await prisma.guestStoryWork.update({
      where: { id: row.id },
      data: { title, excerpt, contentHash },
    });
  }

  return legacyRows.length;
}

/**
 * 分页列出指定主体的故事作品库（Library List）
 *
 * @param subject 身份主体（User / Guest）
 * @param rawInput 查询入参（视图、搜索词、分页游标、单页条数）
 */
export async function listStoryWorksForSubject(
  subject: Subject,
  rawInput?: Partial<LibraryListInput>
): Promise<LibraryListOutput> {
  const parseResult = libraryListInputSchema.safeParse(rawInput ?? {});
  if (!parseResult.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: parseResult.error.issues[0]?.message ?? '参数校验失败',
    });
  }
  const { view, query, cursor, limit } = parseResult.data;

  // 1. 优先修复当前 Subject 的旧元数据（避免搜索因 excerpt 为空漏检）
  await repairLegacyStoryWorksForSubject(subject);

  // 2. 游标反序列化与 view/query 绑定校验
  let decodedCursor: LibraryCursorPayload | null = null;
  if (cursor) {
    decodedCursor = decodeLibraryCursor(cursor);
    if (!decodedCursor || !isCursorMatchingInput(decodedCursor, { view, query })) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '无效或不匹配的分页游标',
      });
    }
  }

  // 3. 构建多维过滤断言（视图隔离 + 严格只搜 title/prompt/excerpt + Keyset 断言）
  const andFilters: Record<string, unknown>[] = [];

  // 视图条件
  if (view === 'trash') {
    andFilters.push({ deletedAt: { not: null } });
  } else if (view === 'favorites') {
    andFilters.push({ deletedAt: null }, { favoritedAt: { not: null } });
  } else {
    // 'active'
    andFilters.push({ deletedAt: null });
  }

  // 搜索关键词条件（严格不得扫描 storyText！）
  const trimmedQuery = normalizeQuery(query);
  if (trimmedQuery.length > 0) {
    andFilters.push({
      OR: [
        { title: { contains: trimmedQuery } },
        { prompt: { contains: trimmedQuery } },
        { excerpt: { contains: trimmedQuery } },
      ],
    });
  }

  // Keyset 游标条件（严禁使用 OFFSET）
  if (decodedCursor) {
    andFilters.push(buildCursorPredicate(decodedCursor));
  }

  // 排序规则：active/favorites 为 createdAt DESC, id DESC；trash 为 deletedAt DESC, id DESC
  const orderBy =
    view === 'trash'
      ? [{ deletedAt: 'desc' as const }, { id: 'desc' as const }]
      : [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

  const selectFields = {
    id: true,
    voiceId: true,
    title: true,
    excerpt: true,
    contentHash: true,
    favoritedAt: true,
    deletedAt: true,
    createdAt: true,
    updatedAt: true,
  };

  // 4. 执行受控查询（take = limit + 1 判定是否存在下页）
  let rawRows: StoryWorkSummaryRow[];
  if (subject.type === 'user') {
    rawRows = await prisma.storyWork.findMany({
      where: {
        userId: subject.id,
        AND: andFilters,
      },
      orderBy,
      take: limit + 1,
      select: selectFields,
    });
  } else {
    rawRows = await prisma.guestStoryWork.findMany({
      where: {
        guestId: subject.id,
        AND: andFilters,
      },
      orderBy,
      take: limit + 1,
      select: selectFields,
    });
  }

  const hasNext = rawRows.length > limit;
  const pageRows = hasNext ? rawRows.slice(0, limit) : rawRows;

  // 5. 派生 nextCursor
  let nextCursor: string | null = null;
  if (hasNext && pageRows.length > 0) {
    const lastRow = pageRows[pageRows.length - 1];
    const timestamp =
      view === 'trash'
        ? (lastRow.deletedAt ?? lastRow.createdAt)
        : lastRow.createdAt;

    nextCursor = encodeLibraryCursor({
      view,
      query,
      timestamp,
      id: lastRow.id,
    });
  }

  // 6. hasMore 必须唯一从 nextCursor 派生（严禁独立计算）
  const hasMore = nextCursor !== null;

  return {
    items: pageRows.map(toSummaryDto),
    nextCursor,
    hasMore,
  };
}

/**
 * 获取指定主体的单条作品详情（Library Get）
 *
 * 严格安全约束：
 * - 仅允许获取 deletedAt IS NULL 的活跃作品；
 * - 不存在、属于其他主体、已被软删除三类场景对外统一抛出 NOT_FOUND（不可区分）；
 * - 自动完成当前 Subject 旧数据懒修复。
 *
 * @param subject 身份主体（User / Guest）
 * @param id 作品 ID
 */
export async function getStoryWorkForSubject(
  subject: Subject,
  id: number
): Promise<StoryWorkDetailDTO> {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '作品不存在',
    });
  }

  // 1. 读取前先完成当前主体的懒修复
  await repairLegacyStoryWorksForSubject(subject);

  // 2. 查询该主体的指定作品（仅允许 deletedAt IS NULL）
  let row: StoryWorkRow | null = null;
  if (subject.type === 'user') {
    row = await prisma.storyWork.findFirst({
      where: {
        id,
        userId: subject.id,
        deletedAt: null,
      },
    });
  } else {
    row = await prisma.guestStoryWork.findFirst({
      where: {
        id,
        guestId: subject.id,
        deletedAt: null,
      },
    });
  }

  // foreign / missing / trash 统一 NOT_FOUND（对外不可区分）
  if (!row) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '作品不存在',
    });
  }

  return toDetailDto(row);
}
