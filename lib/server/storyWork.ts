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
import { cleanupAudioStorageKeys, enqueueAudioDeletionTombstones } from '@/lib/server/audioStorageCleanup';
import type { Subject } from '@/lib/server/subject';
import {
  libraryListInputSchema,
  libraryCreateInputSchema,
  type LibraryListInput,
  type LibraryListOutput,
  type LibraryCreateInput,
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
 *
 *  Library audio projection（spec §12.4/§24）：调用方可传入已查到的
 * Manifest 投影；缺省（mutations/新作品无 Manifest）仍为 missing/null，
 * DTO 结构恒定， 无需处理 null vs missing 双语义。
 */
export const toSummaryDto = (
  row: StoryWorkSummaryRow,
  audio?: StoryWorkSummaryDTO['audio'],
): StoryWorkSummaryDTO => ({
  id: row.id,
  title: row.title,
  excerpt: row.excerpt,
  voiceId: row.voiceId,
  contentHash: row.contentHash,
  favoritedAt: row.favoritedAt ? row.favoritedAt.toISOString() : null,
  deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  audio: audio ?? createMissingAudioProjection(),
});

/**
 * DB 全量行 → 前端 Detail DTO（audio 同上按需注入，缺省 missing）。
 */
export const toDetailDto = (
  row: StoryWorkRow,
  audio?: StoryWorkDetailDTO['audio'],
): StoryWorkDetailDTO => ({
  id: row.id,
  title: row.title,
  excerpt: row.excerpt,
  voiceId: row.voiceId,
  contentHash: row.contentHash,
  favoritedAt: row.favoritedAt ? row.favoritedAt.toISOString() : null,
  deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  audio: audio ?? createMissingAudioProjection(),
  prompt: row.prompt,
  storyText: row.storyText,
  sourceMessageId: row.sourceMessageId ?? null,
});

/**
 *  Manifest 行 → Library audio 投影（spec §12.4 纯函数）。
 *
 * - status = Manifest.status（missing/preparing/ready/failed）；
 * - durationMs = status==='ready' ? totalDurationMs : null（partial 不暴露）；
 * - 无 Manifest（null）→ missing/null。
 */
export function toAudioProjectionFromManifest(
  manifest: { status: string; totalDurationMs: number | null } | null,
): StoryWorkSummaryDTO['audio'] {
  if (!manifest) return createMissingAudioProjection();
  const status =
    manifest.status === 'preparing' ||
    manifest.status === 'ready' ||
    manifest.status === 'failed'
      ? manifest.status
      : ('missing' as const);
  if (status === 'ready' && typeof manifest.totalDurationMs === 'number') {
    return { status, durationMs: manifest.totalDurationMs };
  }
  return { status, durationMs: null };
}

/**
 *  按主体批量读取 Manifest 投影（Library list/get 读路径用）。
 *
 * User → StoryAudioManifest(storyWorkId in ids)；Guest → GuestStoryAudioManifest。
 * 无 Manifest 的 workId 缺席 Map，调用方回落 missing。失败不抛（调用方回落 missing）。
 */
export async function getAudioProjectionsForSubject(
  subject: Subject,
  workIds: number[],
): Promise<Map<number, StoryWorkSummaryDTO['audio']>> {
  const out = new Map<number, StoryWorkSummaryDTO['audio']>();
  const ids = [...new Set(workIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return out;
  try {
    if (subject.type === 'user') {
      const rows = await prisma.storyAudioManifest.findMany({
        where: { storyWorkId: { in: ids } },
        select: { storyWorkId: true, status: true, totalDurationMs: true },
      });
      for (const r of rows) {
        out.set(r.storyWorkId, toAudioProjectionFromManifest(r));
      }
    } else {
      const rows = await prisma.guestStoryAudioManifest.findMany({
        where: { storyWorkId: { in: ids } },
        select: { storyWorkId: true, status: true, totalDurationMs: true },
      });
      for (const r of rows) {
        out.set(r.storyWorkId, toAudioProjectionFromManifest(r));
      }
    }
  } catch {
    // 投影读取失败不阻断列表/详情（回落 missing），由 canonical 播放侧按需重建。
  }
  return out;
}

/**
 * Legacy 元数据懒修补（Lazy Backfill）：
 *  引入 title/excerpt/contentHash 后，历史行可能未填充上述字段。
 * 首次读取当前 Subject 时发现未填充数据，立即使用  派生算法补齐并持久化。
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

  //  Library audio projection enrichment（spec §12.4/§24）：
  // 批量读本页 Manifest（无则 missing），DTO 结构恒定。
  const audioMap = await getAudioProjectionsForSubject(
    subject,
    pageRows.map((r) => r.id),
  );

  return {
    items: pageRows.map((row) =>
      toSummaryDto(row, audioMap.get(row.id) ?? createMissingAudioProjection()),
    ),
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

  //  Library audio projection（spec §12.4）：单条按需 enrichment，无则 missing。
  const audioMap = await getAudioProjectionsForSubject(subject, [row.id]);
  return toDetailDto(row, audioMap.get(row.id) ?? createMissingAudioProjection());
}

/**
 *  Work Trash 状态判定（spec §29.1 / §29.2，产品拍板）。
 *
 * 仅读取 deletedAt 存在信号（select id，不取 title/storyText/voiceId/contentHash），
 * 不重算任何元数据、不触 legacy DTO（§36 边界： 不得重算 title/hash）。
 * missing / foreign / 非法 id 一律返回 false（与 getStoryWorkForSubject 的统一
 * NOT_FOUND 不可区分面一致，调用方按 fail-closed 处理）。
 *
 * @param subject 身份主体（User / Guest）
 * @param id 作品 ID
 */
export async function isStoryWorkTrashedForSubject(
  subject: Subject,
  id: number
): Promise<boolean> {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return false;
  }
  if (subject.type === 'user') {
    const row = await prisma.storyWork.findFirst({
      where: { id, userId: subject.id, deletedAt: { not: null } },
      select: { id: true },
    });
    return row !== null;
  }
  const row = await prisma.guestStoryWork.findFirst({
    where: { id, guestId: subject.id, deletedAt: { not: null } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * 故事作品入库（Library Create，）
 *
 *  将来调用的正式资产创建服务，负责：
 * 1. 严格校验输入（prompt、storyText、voiceId?、sourceMessageId?、explicit title?）；
 * 2. 文本规范化与元数据派生：统一由 Server 调用  canonical 算法生成
 *    resolveStoryTitle / buildStoryExcerpt / computeStoryContentHash，绝不信任调用方传入的 hash/excerpt；
 * 3. 来源消息幂等处理（sourceMessageId 非 null 时）：
 *    - 同 Subject + 同 sourceMessageId + contentHash 一致 → 返回已有 Work（不 INSERT、不新增行）；
 *    - 同 Subject + 同 sourceMessageId + contentHash 不一致 → 抛明确 CONFLICT 领域异常，禁止覆盖旧正文；
 *    - sourceMessageId 为 null → 不参与幂等，允许多次创建独立作品；
 * 4. 彻底废除新 Library 写路径上的任何 KEEP_LIMIT / delete-oldest / take-100 裁剪行为，资产永久保留；
 * 5. User / Guest 两种主体行为严格对称一致。
 *
 * @param subject 身份主体（User / Guest）
 * @param rawInput 创作入参
 */
export async function createStoryWorkForSubject(
  subject: Subject,
  rawInput: LibraryCreateInput | Record<string, unknown>
): Promise<StoryWorkDetailDTO> {
  const parseResult = libraryCreateInputSchema.safeParse(rawInput);
  if (!parseResult.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: parseResult.error.issues[0]?.message ?? '参数校验失败',
    });
  }

  const {
    title: proposedTitle,
    prompt,
    storyText,
    voiceId: rawVoiceId,
    sourceMessageId: rawSourceMessageId,
  } = parseResult.data;

  // 1. 服务端权威派生元数据（严禁信任客户端传入）
  const explicitTitle =
    proposedTitle && proposedTitle.trim().length > 0 ? proposedTitle : undefined;
  const title = resolveStoryTitle({
    proposedTitle: explicitTitle,
    title: explicitTitle,
    storyText,
    prompt,
  });
  const excerpt = buildStoryExcerpt(storyText);
  const contentHash = computeStoryContentHash(storyText);
  const voiceId =
    rawVoiceId && rawVoiceId.trim().length > 0 ? rawVoiceId.trim() : '';
  const sourceMessageId =
    rawSourceMessageId && rawSourceMessageId.trim().length > 0
      ? rawSourceMessageId.trim()
      : null;

  // 2. 来源消息幂等消解（sourceMessageId 非 null 时参与）
  if (sourceMessageId !== null) {
    if (subject.type === 'user') {
      const existing = await prisma.storyWork.findUnique({
        where: {
          userId_sourceMessageId: {
            userId: subject.id,
            sourceMessageId,
          },
        },
      });

      if (existing) {
        if (existing.contentHash === contentHash) {
          return toDetailDto(existing);
        }
        throw new TRPCError({
          code: 'CONFLICT',
          message: '来源消息已绑定不同内容的故事作品，禁止覆盖',
        });
      }
    } else {
      const existing = await prisma.guestStoryWork.findUnique({
        where: {
          guestId_sourceMessageId: {
            guestId: subject.id,
            sourceMessageId,
          },
        },
      });

      if (existing) {
        if (existing.contentHash === contentHash) {
          return toDetailDto(existing);
        }
        throw new TRPCError({
          code: 'CONFLICT',
          message: '来源消息已绑定不同内容的故事作品，禁止覆盖',
        });
      }
    }
  }

  // 3. 执行持久化写入（彻底摒弃旧写路径上的数量裁剪 KEEP_LIMIT）
  if (subject.type === 'user') {
    try {
      const created = await prisma.storyWork.create({
        data: {
          userId: subject.id,
          prompt,
          storyText,
          voiceId,
          title,
          excerpt,
          contentHash,
          sourceMessageId,
        },
      });
      return toDetailDto(created);
    } catch (error) {
      // 并发竞态冲突防御（兜底 UNIQUE 约束碰撞）
      if (
        sourceMessageId !== null &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: unknown }).code === 'P2002'
      ) {
        const existing = await prisma.storyWork.findUnique({
          where: {
            userId_sourceMessageId: {
              userId: subject.id,
              sourceMessageId,
            },
          },
        });
        if (existing) {
          if (existing.contentHash === contentHash) {
            return toDetailDto(existing);
          }
          throw new TRPCError({
            code: 'CONFLICT',
            message: '来源消息已绑定不同内容的故事作品，禁止覆盖',
          });
        }
      }
      throw error;
    }
  } else {
    try {
      const created = await prisma.guestStoryWork.create({
        data: {
          guestId: subject.id,
          prompt,
          storyText,
          voiceId,
          title,
          excerpt,
          contentHash,
          sourceMessageId,
        },
      });
      return toDetailDto(created);
    } catch (error) {
      // 并发竞态冲突防御（兜底 UNIQUE 约束碰撞）
      if (
        sourceMessageId !== null &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: unknown }).code === 'P2002'
      ) {
        const existing = await prisma.guestStoryWork.findUnique({
          where: {
            guestId_sourceMessageId: {
              guestId: subject.id,
              sourceMessageId,
            },
          },
        });
        if (existing) {
          if (existing.contentHash === contentHash) {
            return toDetailDto(existing);
          }
          throw new TRPCError({
            code: 'CONFLICT',
            message: '来源消息已绑定不同内容的故事作品，禁止覆盖',
          });
        }
      }
      throw error;
    }
  }
}

/**
 * 校验作品 ID 有效性（统一 NOT_FOUND 防信息泄露）
 */
function assertValidWorkId(id: unknown): number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '作品不存在',
    });
  }
  return id;
}

/**
 * Mutation 内部测试注入钩子（供并发竞态与时序注入回归，生产调用方严禁传入）
 */
export interface StoryWorkMutationTestHooks {
  /** 在执行原子 SQL 写操作（updateMany / deleteMany）前执行的钩子 */
  __testBeforeMutationHook?: () => Promise<void> | void;
  /**
   *  事务内失败 oracle（仅测试用）：在同一 DB 事务内 tombstone 已记、
   * Work 尚未物理删除时执行；抛错即整事务回滚（Work/Manifest/Segment 全留、
   * tombstone 不残留）。生产调用方严禁传入。
   */
  __testInsideTransactionHook?: () => Promise<void> | void;
}

/**
 * 重命名故事作品（）
 *
 * 严格语义：
 * 1. 仅更新 title 字段（+ updatedAt）；
 * 2. 严禁修改 storyText / contentHash / excerpt，保证作品内容身份不变；
 * 3. 标题经既有 resolveStoryTitle 规范化（仅 title 参与解析）；
 * 4. 施加原子条件写（where deletedAt IS NULL），杜绝 TOCTOU 竞态；
 * 5. 仅放行 active 作品；回收站中、不存在或属于其他主体的作品统一抛出 NOT_FOUND；
 * 6. User / Guest 两表严格同构对称。
 *
 * @param subject 身份主体（User / Guest）
 * @param workId 作品 ID
 * @param newTitle 新标题文本
 * @param testHooks 测试注入钩子（可选，供并发回归测试使用）
 */
export async function renameStoryWorkForSubject(
  subject: Subject,
  workId: number,
  newTitle: string,
  testHooks?: StoryWorkMutationTestHooks
): Promise<StoryWorkDetailDTO> {
  const validId = assertValidWorkId(workId);

  if (typeof newTitle !== 'string' || newTitle.trim().length === 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '标题不能为空',
    });
  }

  // 严格按既有 resolveStoryTitle 语义规范化（仅 title 字段参与）
  const resolvedTitle = resolveStoryTitle({
    proposedTitle: newTitle,
    title: newTitle,
  });

  if (!resolvedTitle || resolvedTitle.trim().length === 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '标题不能为空',
    });
  }

  if (testHooks?.__testBeforeMutationHook) {
    await testHooks.__testBeforeMutationHook();
  }

  if (subject.type === 'user') {
    // 原子条件写：仅更新当前用户且未处于回收站的作品
    const updateRes = await prisma.storyWork.updateMany({
      where: {
        id: validId,
        userId: subject.id,
        deletedAt: null,
      },
      data: {
        title: resolvedTitle,
      },
    });

    if (updateRes.count === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: '作品不存在',
      });
    }

    const updated = await prisma.storyWork.findUnique({
      where: { id: validId },
    });

    if (!updated) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: '作品不存在',
      });
    }

    return toDetailDto(updated);
  } else {
    const updateRes = await prisma.guestStoryWork.updateMany({
      where: {
        id: validId,
        guestId: subject.id,
        deletedAt: null,
      },
      data: {
        title: resolvedTitle,
      },
    });

    if (updateRes.count === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: '作品不存在',
      });
    }

    const updated = await prisma.guestStoryWork.findUnique({
      where: { id: validId },
    });

    if (!updated) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: '作品不存在',
      });
    }

    return toDetailDto(updated);
  }
}

/**
 * 设置故事作品收藏状态（）
 *
 * 严格语义：
 * 1. favoritedAt 为收藏状态唯一 truth（null=未收藏；非 null=已收藏）；不得引入第二个布尔字段；
 * 2. 施加原子条件写，杜绝 TOCTOU 竞态；
 * 3. 仅放行 active 作品；回收站中、不存在或属于其他主体的作品统一抛出 NOT_FOUND；
 * 4. 幂等：若已收藏且入参为 true，保留原 favoritedAt 时间戳；
 * 5. User / Guest 两表严格同构对称。
 *
 * @param subject 身份主体（User / Guest）
 * @param workId 作品 ID
 * @param favorite 是否收藏
 * @param testHooks 测试注入钩子（可选，供并发回归测试使用）
 */
export async function setStoryWorkFavoriteForSubject(
  subject: Subject,
  workId: number,
  favorite: boolean,
  testHooks?: StoryWorkMutationTestHooks
): Promise<StoryWorkDetailDTO> {
  const validId = assertValidWorkId(workId);

  if (typeof favorite !== 'boolean') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '收藏状态必须为布尔值',
    });
  }

  if (testHooks?.__testBeforeMutationHook) {
    await testHooks.__testBeforeMutationHook();
  }

  if (subject.type === 'user') {
    if (favorite) {
      // 1. 尝试原子更新未收藏的活跃作品
      const updateRes = await prisma.storyWork.updateMany({
        where: {
          id: validId,
          userId: subject.id,
          deletedAt: null,
          favoritedAt: null,
        },
        data: {
          favoritedAt: new Date(),
        },
      });

      if (updateRes.count > 0) {
        const updated = await prisma.storyWork.findUnique({
          where: { id: validId },
        });
        if (!updated) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: '作品不存在',
          });
        }
        return toDetailDto(updated);
      }

      // count === 0: 检查是否已是活跃且已收藏（幂等：保持原 favoritedAt）
      const current = await prisma.storyWork.findFirst({
        where: {
          id: validId,
          userId: subject.id,
        },
      });

      if (current && current.deletedAt === null && current.favoritedAt !== null) {
        return toDetailDto(current);
      }

      // 处于回收站、跨主体、不存在统一 NOT_FOUND
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: '作品不存在',
      });
    } else {
      // 取消收藏：原子置空 favoritedAt（仅限活跃作品）
      const updateRes = await prisma.storyWork.updateMany({
        where: {
          id: validId,
          userId: subject.id,
          deletedAt: null,
        },
        data: {
          favoritedAt: null,
        },
      });

      if (updateRes.count === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '作品不存在',
        });
      }

      const updated = await prisma.storyWork.findUnique({
        where: { id: validId },
      });
      if (!updated) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '作品不存在',
        });
      }

      return toDetailDto(updated);
    }
  } else {
    if (favorite) {
      const updateRes = await prisma.guestStoryWork.updateMany({
        where: {
          id: validId,
          guestId: subject.id,
          deletedAt: null,
          favoritedAt: null,
        },
        data: {
          favoritedAt: new Date(),
        },
      });

      if (updateRes.count > 0) {
        const updated = await prisma.guestStoryWork.findUnique({
          where: { id: validId },
        });
        if (!updated) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: '作品不存在',
          });
        }
        return toDetailDto(updated);
      }

      const current = await prisma.guestStoryWork.findFirst({
        where: {
          id: validId,
          guestId: subject.id,
        },
      });

      if (current && current.deletedAt === null && current.favoritedAt !== null) {
        return toDetailDto(current);
      }

      throw new TRPCError({
        code: 'NOT_FOUND',
        message: '作品不存在',
      });
    } else {
      const updateRes = await prisma.guestStoryWork.updateMany({
        where: {
          id: validId,
          guestId: subject.id,
          deletedAt: null,
        },
        data: {
          favoritedAt: null,
        },
      });

      if (updateRes.count === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '作品不存在',
        });
      }

      const updated = await prisma.guestStoryWork.findUnique({
        where: { id: validId },
      });
      if (!updated) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '作品不存在',
        });
      }

      return toDetailDto(updated);
    }
  }
}

/**
 * 将故事作品移入回收站（软删除，）
 *
 * 严格语义：
 * 1. 仅写入 deletedAt = now()，严禁物理删除，数据行必须保留；
 * 2. 施加原子条件写（where deletedAt IS NULL），杜绝 TOCTOU 竞态；
 * 3. 幂等：若已处于回收站中，保持原 deletedAt，不刷新 30 天清理窗口；
 * 4. 不存在或属于其他主体的作品统一抛出 NOT_FOUND；
 * 5. User / Guest 两表严格同构对称。
 *
 * @param subject 身份主体（User / Guest）
 * @param workId 作品 ID
 * @param testHooks 测试注入钩子（可选，供并发回归测试使用）
 */
export async function trashStoryWorkForSubject(
  subject: Subject,
  workId: number,
  testHooks?: StoryWorkMutationTestHooks
): Promise<StoryWorkDetailDTO> {
  const validId = assertValidWorkId(workId);

  if (testHooks?.__testBeforeMutationHook) {
    await testHooks.__testBeforeMutationHook();
  }

  if (subject.type === 'user') {
    // 1. 原子软删除活跃作品
    const updateRes = await prisma.storyWork.updateMany({
      where: {
        id: validId,
        userId: subject.id,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    if (updateRes.count > 0) {
      const updated = await prisma.storyWork.findUnique({
        where: { id: validId },
      });
      if (!updated) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '作品不存在',
        });
      }
      return toDetailDto(updated);
    }

    // count === 0: 检查是否已在回收站（幂等：保留原始 deletedAt）
    const current = await prisma.storyWork.findFirst({
      where: {
        id: validId,
        userId: subject.id,
      },
    });

    if (current && current.deletedAt !== null) {
      return toDetailDto(current);
    }

    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '作品不存在',
    });
  } else {
    const updateRes = await prisma.guestStoryWork.updateMany({
      where: {
        id: validId,
        guestId: subject.id,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    if (updateRes.count > 0) {
      const updated = await prisma.guestStoryWork.findUnique({
        where: { id: validId },
      });
      if (!updated) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '作品不存在',
        });
      }
      return toDetailDto(updated);
    }

    const current = await prisma.guestStoryWork.findFirst({
      where: {
        id: validId,
        guestId: subject.id,
      },
    });

    if (current && current.deletedAt !== null) {
      return toDetailDto(current);
    }

    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '作品不存在',
    });
  }
}

/**
 * 从回收站恢复故事作品（）
 *
 * 严格语义：
 * 1. 仅清空 deletedAt = null，作品重回 active 状态；
 * 2. 施加原子条件写（where deletedAt IS NOT NULL），杜绝 TOCTOU 竞态；
 * 3. 必须保留原 favoritedAt，恢复不影响既有收藏状态；
 * 4. 仅允许处于回收站中的作品（deletedAt !== null）调用；对 active 作品调用抛出 CONFLICT 领域错误；
 * 5. 不存在或属于其他主体的作品统一抛出 NOT_FOUND；
 * 6. User / Guest 两表严格同构对称。
 *
 * @param subject 身份主体（User / Guest）
 * @param workId 作品 ID
 * @param testHooks 测试注入钩子（可选，供并发回归测试使用）
 */
export async function restoreStoryWorkForSubject(
  subject: Subject,
  workId: number,
  testHooks?: StoryWorkMutationTestHooks
): Promise<StoryWorkDetailDTO> {
  const validId = assertValidWorkId(workId);

  if (testHooks?.__testBeforeMutationHook) {
    await testHooks.__testBeforeMutationHook();
  }

  if (subject.type === 'user') {
    // 1. 原子条件写：仅匹配处于回收站中的作品
    const updateRes = await prisma.storyWork.updateMany({
      where: {
        id: validId,
        userId: subject.id,
        deletedAt: { not: null },
      },
      data: {
        deletedAt: null,
      },
    });

    if (updateRes.count > 0) {
      const updated = await prisma.storyWork.findUnique({
        where: { id: validId },
      });
      if (!updated) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '作品不存在',
        });
      }
      return toDetailDto(updated);
    }

    // count === 0: 区分是 active（CONFLICT）还是 不存在/跨主体（NOT_FOUND）
    const current = await prisma.storyWork.findFirst({
      where: {
        id: validId,
        userId: subject.id,
      },
    });

    if (current && current.deletedAt === null) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: '作品未处于回收站中，无需恢复',
      });
    }

    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '作品不存在',
    });
  } else {
    const updateRes = await prisma.guestStoryWork.updateMany({
      where: {
        id: validId,
        guestId: subject.id,
        deletedAt: { not: null },
      },
      data: {
        deletedAt: null,
      },
    });

    if (updateRes.count > 0) {
      const updated = await prisma.guestStoryWork.findUnique({
        where: { id: validId },
      });
      if (!updated) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: '作品不存在',
        });
      }
      return toDetailDto(updated);
    }

    const current = await prisma.guestStoryWork.findFirst({
      where: {
        id: validId,
        guestId: subject.id,
      },
    });

    if (current && current.deletedAt === null) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: '作品未处于回收站中，无需恢复',
      });
    }

    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '作品不存在',
    });
  }
}

/**
 * StoryWork 物理删除参数契约（显式 Discriminated Union 窄契约）
 *
 * 仅允许三类合法物理删除形态：
 * 1. target: 'user',  reason: 'trash'     => 用户永久删除或回收站 30 天清理，仅允许删除 deletedAt IS NOT NULL (且可选 lt: threshold) 的回收站作品；
 * 2. target: 'guest', reason: 'trash'     => 访客手动永久删除，仅允许删除 deletedAt IS NOT NULL 的回收站作品；
 * 3. target: 'guest', reason: 'retention' => 访客 30 天 GC 清理，按 updatedAt < threshold 清理（含 active 与 trash 临时作品）。
 */
export type PhysicalDeleteStoryWorkOptions =
  | {
      target: 'user';
      reason: 'trash';
      where: {
        id?: number | { in: number[] };
        userId?: number;
        deletedAt: {
          not: null;
          lt?: Date;
        };
      };
      testHooks?: StoryWorkMutationTestHooks;
    }
  | {
      target: 'guest';
      reason: 'trash';
      where: {
        id?: number | { in: number[] };
        guestId?: string;
        deletedAt: {
          not: null;
          lt?: Date;
        };
      };
      testHooks?: StoryWorkMutationTestHooks;
    }
  | {
      target: 'guest';
      reason: 'retention';
      where: {
        id?: number | { in: number[] };
        guestId?: string;
        updatedAt: {
          lt: Date;
        };
      };
      testHooks?: StoryWorkMutationTestHooks;
    };

/**
 *  FIXUP：survivor stale-tombstone 收敛窄 helper（fail-closed）。
 *
 * 背景（Blocker 反例链）：事务内 restore 竞态可致 Work B 存活；若 B.storageKey 的
 * tombstone prune 失败被吞（旧 best-effort catch），事务照常 commit → tombstone
 * 持久化残留 → 下一次 bounded cleanup（ 冻结引擎不检查 key 是否被 live
 * Segment 引用，直接 storage.delete(key)）会删除存活 Work 的 canonical object →
 * Canonical corruption（DB Segment=ready / Object=gone）。
 *
 * 因此 survivor 收敛必须 fail-closed：prune 失败即 throw → 整个事务 rollback
 *（Work delete rollback / tombstone upsert rollback / Manifest·Segment 保持 /
 * Object 不动）。COMMIT 后 directed cleanup（cleanupAudioStorageKeys）的
 * best-effort 吞错不受影响——那是已提交后的对象清理，与本事务内收敛正交。
 *
 * 三处分支（User trash / Guest manual / Guest retention）必须一致调用本 helper，
 * 杜绝第二套收敛逻辑。
 */
export function computeCommittedAudioKeys(allKeys: string[], survivorKeys: string[]): string[] {
  if (survivorKeys.length === 0) return [...allKeys];
  const survivorSet = new Set(survivorKeys);
  return allKeys.filter((k) => !survivorSet.has(k));
}

/**
 * 事务内删除存活行误记 tombstone（fail-closed：故意无 try/catch）。
 *
 * 成功时存活 key 的 tombstone 在事务内被删（与外层事务同原子）；失败时 throw
 * 由 Prisma $transaction 回滚整个事务，调用方不得吞错。
 *
 * 注：入参仅需 deleteMany 窄面（不复用  冻结的 AudioDeletionTx，
 * 后者无 deleteMany；冻结文件不动，此处本地声明以保持单向依赖）。
 */
export type SurvivorPruneTx = {
  audioStorageDeletion: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteMany(args: any): Promise<any>;
  };
};

export async function pruneSurvivorAudioTombstones(
  tx: SurvivorPruneTx,
  survivorKeys: string[],
): Promise<void> {
  if (survivorKeys.length === 0) return;
  await tx.audioStorageDeletion.deleteMany({
    where: { storageKey: { in: survivorKeys } },
  });
}

/**
 *  Blocker 1：trash 物理删除的事务内核结果。
 *
 * `remainingIds` 为删除后仍存活的行（restore 竞态 survivor），供 collection seam
 * 判定「是否允许继续删除 Collection」；单 Work primitive 只消费 committedKeys/deletedCount。
 */
type TrashDeleteTxResult = {
  committedKeys: string[];
  deletedCount: number;
  remainingIds: number[];
};

/* eslint-disable @typescript-eslint/no-explicit-any */
/** User trash 事务内核的窄依赖面（不含自由 where，避免退化为通用 delete helper）。 */
type UserTrashDeleteTx = {
  storyWork: {
    findMany(args: any): Promise<Array<{ id: number }>>;
    deleteMany(args: any): Promise<{ count: number }>;
  };
  storyAudioManifest: { findMany(args: any): Promise<Array<{ id: number }>> };
  storyAudioSegment: { findMany(args: any): Promise<Array<{ storageKey: string }>> };
  storyAudioAsset: { findMany(args: any): Promise<Array<{ storageKey: string }>> };
  audioStorageDeletion: { deleteMany(args: any): Promise<unknown> };
};

/** Guest trash 事务内核的窄依赖面（同上）。 */
type GuestTrashDeleteTx = {
  guestStoryWork: {
    findMany(args: any): Promise<Array<{ id: number }>>;
    deleteMany(args: any): Promise<{ count: number }>;
  };
  guestStoryAudioManifest: { findMany(args: any): Promise<Array<{ id: number }>> };
  guestStoryAudioSegment: { findMany(args: any): Promise<Array<{ storageKey: string }>> };
  guestStoryAudioAsset: { findMany(args: any): Promise<Array<{ storageKey: string }>> };
  audioStorageDeletion: { deleteMany(args: any): Promise<unknown> };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * User trash 事务内核（唯一 audio-aware 删除逻辑，单 Work primitive 与 collection seam 共用）。
 *
 * 调用方必须已处于 `prisma.$transaction` 内；本函数不做 $transaction，保证 collection seam
 * 能把「Work 删除 + Collection 删除」收敛在同一原子边界。
 */
async function deleteUserTrashWorksInTx(
  tx: UserTrashDeleteTx,
  where: { id?: number | { in: number[] }; userId?: number; deletedAt: { not: null; lt?: Date } },
  testHooks?: StoryWorkMutationTestHooks,
): Promise<TrashDeleteTxResult> {
  const matched = await tx.storyWork.findMany({ where, select: { id: true } });
  const matchedIds = matched.map((r) => r.id);
  let allKeys: string[] = [];
  if (matchedIds.length > 0) {
    const manifests = await tx.storyAudioManifest.findMany({
      where: { storyWorkId: { in: matchedIds } },
      select: { id: true },
    });
    const manifestIds = manifests.map((r) => r.id);
    if (manifestIds.length > 0) {
      const segments = await tx.storyAudioSegment.findMany({
        where: { manifestId: { in: manifestIds } },
        select: { storageKey: true },
      });
      allKeys = segments.map((s) => s.storageKey);
    }
    //：单轨 Asset 对象同批 tombstone（DB 行随 cascade 消失；旧 Segment 表不物理删除）。
    const assets = await tx.storyAudioAsset.findMany({
      where: { storyWorkId: { in: matchedIds } },
      select: { storageKey: true },
    });
    allKeys = [...allKeys, ...assets.map((a) => a.storageKey)];
    if (allKeys.length > 0) {
      await enqueueAudioDeletionTombstones(
        tx as unknown as Parameters<typeof enqueueAudioDeletionTombstones>[0],
        allKeys,
      );
    }
  }
  if (testHooks?.__testInsideTransactionHook) {
    await testHooks.__testInsideTransactionHook();
  }
  const deleteResult = await tx.storyWork.deleteMany({ where });
  const deletedCount = deleteResult.count;
  if (matchedIds.length === 0) {
    return { committedKeys: [], deletedCount, remainingIds: [] };
  }
  if (deletedCount >= matchedIds.length) {
    return { committedKeys: allKeys, deletedCount, remainingIds: [] };
  }
  // 竞态收敛（ FIXUP fail-closed）：事务内 find 与 delete 之间 restore 导致部分行
  // 未删时，存活行不得被 tombstone 误清；prune 失败即 throw → 全事务 rollback。
  const survivors = await tx.storyWork.findMany({
    where: { id: { in: matchedIds } },
    select: { id: true },
  });
  const remainingIds = survivors.map((r) => r.id);
  if (remainingIds.length === 0 || allKeys.length === 0) {
    return { committedKeys: allKeys.length === 0 ? [] : allKeys, deletedCount, remainingIds };
  }
  const survivorManifests = await tx.storyAudioManifest.findMany({
    where: { storyWorkId: { in: remainingIds } },
    select: { id: true },
  });
  const survivorManifestIds = survivorManifests.map((r) => r.id);
  let survivorKeys: string[] = [];
  if (survivorManifestIds.length > 0) {
    const survivorSegments = await tx.storyAudioSegment.findMany({
      where: { manifestId: { in: survivorManifestIds } },
      select: { storageKey: true },
    });
    survivorKeys = survivorSegments.map((s) => s.storageKey);
  }
  const survivorAssets = await tx.storyAudioAsset.findMany({
    where: { storyWorkId: { in: remainingIds } },
    select: { storageKey: true },
  });
  survivorKeys = [...survivorKeys, ...survivorAssets.map((a) => a.storageKey)];
  if (survivorKeys.length > 0) {
    await pruneSurvivorAudioTombstones(tx, survivorKeys);
    const committedKeys = computeCommittedAudioKeys(allKeys, survivorKeys);
    return { committedKeys, deletedCount, remainingIds };
  }
  return { committedKeys: allKeys, deletedCount, remainingIds };
}

/**
 * Guest trash 事务内核（与 User 分支对称；单 Work primitive 与 collection seam 共用）。
 */
async function deleteGuestTrashWorksInTx(
  tx: GuestTrashDeleteTx,
  where: { id?: number | { in: number[] }; guestId?: string; deletedAt: { not: null; lt?: Date } },
  testHooks?: StoryWorkMutationTestHooks,
): Promise<TrashDeleteTxResult> {
  const matched = await tx.guestStoryWork.findMany({ where, select: { id: true } });
  const matchedIds = matched.map((r) => r.id);
  let allKeys: string[] = [];
  if (matchedIds.length > 0) {
    const manifests = await tx.guestStoryAudioManifest.findMany({
      where: { storyWorkId: { in: matchedIds } },
      select: { id: true },
    });
    const manifestIds = manifests.map((r) => r.id);
    if (manifestIds.length > 0) {
      const segments = await tx.guestStoryAudioSegment.findMany({
        where: { manifestId: { in: manifestIds } },
        select: { storageKey: true },
      });
      allKeys = segments.map((s) => s.storageKey);
    }
    const guestAssets = await tx.guestStoryAudioAsset.findMany({
      where: { storyWorkId: { in: matchedIds } },
      select: { storageKey: true },
    });
    allKeys = [...allKeys, ...guestAssets.map((a) => a.storageKey)];
    if (allKeys.length > 0) {
      await enqueueAudioDeletionTombstones(
        tx as unknown as Parameters<typeof enqueueAudioDeletionTombstones>[0],
        allKeys,
      );
    }
  }
  if (testHooks?.__testInsideTransactionHook) {
    await testHooks.__testInsideTransactionHook();
  }
  const deleteResult = await tx.guestStoryWork.deleteMany({ where });
  const deletedCount = deleteResult.count;
  if (matchedIds.length === 0) {
    return { committedKeys: [], deletedCount, remainingIds: [] };
  }
  if (deletedCount >= matchedIds.length) {
    return { committedKeys: allKeys, deletedCount, remainingIds: [] };
  }
  const survivors = await tx.guestStoryWork.findMany({
    where: { id: { in: matchedIds } },
    select: { id: true },
  });
  const remainingIds = survivors.map((r) => r.id);
  if (remainingIds.length === 0 || allKeys.length === 0) {
    return { committedKeys: allKeys.length === 0 ? [] : allKeys, deletedCount, remainingIds };
  }
  const survivorManifests = await tx.guestStoryAudioManifest.findMany({
    where: { storyWorkId: { in: remainingIds } },
    select: { id: true },
  });
  const survivorManifestIds = survivorManifests.map((r) => r.id);
  let survivorKeys: string[] = [];
  if (survivorManifestIds.length > 0) {
    const survivorSegments = await tx.guestStoryAudioSegment.findMany({
      where: { manifestId: { in: survivorManifestIds } },
      select: { storageKey: true },
    });
    survivorKeys = survivorSegments.map((s) => s.storageKey);
  }
  const survivorGuestAssets = await tx.guestStoryAudioAsset.findMany({
    where: { storyWorkId: { in: remainingIds } },
    select: { storageKey: true },
  });
  survivorKeys = [...survivorKeys, ...survivorGuestAssets.map((a) => a.storageKey)];
  if (survivorKeys.length > 0) {
    await pruneSurvivorAudioTombstones(tx, survivorKeys);
    const committedKeys = computeCommittedAudioKeys(allKeys, survivorKeys);
    return { committedKeys, deletedCount, remainingIds };
  }
  return { committedKeys: allKeys, deletedCount, remainingIds };
}

/**
 * StoryWork 物理删除唯一合法底层执行点（Server-Internal Primitive /  Audio Seam 唯一挂载点）
 *
 * 架构说明与安全约束：
 * 1. 物理删除唯一执行点：无论是用户主动永久删除、定时回收站清理（purgeExpiredUserTrash），
 *    还是访客数据 GC（purgeExpiredGuestData），对 User/Guest 作品资产的物理删除都必须统一通过本 primitive 执行，
 *    严禁在其他模块直接裸调 prisma.storyWork.delete/deleteMany 或 prisma.guestStoryWork.delete/deleteMany。
 * 2.  Audio-aware Physical Delete（spec §28.4/§29/§30）：
 *    同一 DB transaction 内完成「收集 Segment storageKey → UPSERT AudioStorageDeletion
 *（同 key 幂等）→ DELETE StoryWork/GuestStoryWork（Manifest/Segment 靠 FK cascade）
 *    → survivor 收敛（pruneSurvivorAudioTombstones，fail-closed）」；
 *    COMMIT 后 best-effort 调用 05-01 冻结引擎 cleanupAudioStorageKeys 本批 tombstones。
 *    Storage cleanup 失败不得 rollback 已完成的永久删除；失败由 tombstone retry 接管。
 *    禁止先 delete Work → commit → 再查 storageKey（届时 key 已随 cascade 消失）。
 *    Survivor 收敛失败必须 throw → 全事务 rollback（ FIXUP）：
 *     冻结引擎不检查 key 是否被 live Segment 引用，stale-tombstone 残留
 *    会致 bounded cleanup 误删存活 Work 的 canonical object，故事务内 prune 不得 best-effort。
 * 3. 安全规则与显式 Discriminated Contract：
 *    - User 物理删除只能来自 Trash（deletedAt IS NOT NULL）；
 *    - Guest manual delete 只能来自 Trash（deletedAt IS NOT NULL）；
 *    - Guest retention GC 严格按 updatedAt < threshold 清理；
 *    三者最终都经此同一  tombstone seam 唯一挂载点执行。
 *    contract 保持窄契约，绝不接受任意自由 Prisma where，杜绝退化为危险的通用 delete helper。
 * 4. Trash / Restore 零 Audio side effect：本 primitive 之外的 trash/restore 仅写 deletedAt，
 *    不记 tombstone、不调 TTS、不碰 Manifest/Segment/Object（spec §28.2/§28.3，Validation §59）。
 */
export async function executeStoryWorkPhysicalDelete(
  options: PhysicalDeleteStoryWorkOptions
): Promise<{ count: number }> {
  if (options.testHooks?.__testBeforeMutationHook) {
    await options.testHooks.__testBeforeMutationHook();
  }

  let committedKeys: string[] = [];
  let deletedCount = 0;

  if (options.target === 'user') {
    // User 作品物理删除仅支持 reason: 'trash'（audio-aware transaction）
    const where = {
      ...(options.where.id !== undefined ? { id: options.where.id } : {}),
      ...(options.where.userId !== undefined ? { userId: options.where.userId } : {}),
      deletedAt: options.where.deletedAt,
    };
    // 事务内核收敛于 deleteUserTrashWorksInTx（与 collection seam 共用，禁止第二套逻辑）
    const result = await prisma.$transaction((tx) =>
      deleteUserTrashWorksInTx(tx as unknown as UserTrashDeleteTx, where, options.testHooks),
    );
    committedKeys = result.committedKeys;
    deletedCount = result.deletedCount;
  } else if (options.reason === 'trash') {
    // Guest manual trash（audio-aware transaction；与 collection seam 共用内核）
    const where = {
      ...(options.where.id !== undefined ? { id: options.where.id } : {}),
      ...(options.where.guestId !== undefined ? { guestId: options.where.guestId } : {}),
      deletedAt: options.where.deletedAt,
    };
    const result = await prisma.$transaction((tx) =>
      deleteGuestTrashWorksInTx(tx as unknown as GuestTrashDeleteTx, where, options.testHooks),
    );
    committedKeys = result.committedKeys;
    deletedCount = result.deletedCount;
  } else {
    // reason === 'retention'（Guest GC 统一 seam；primitive audio-aware 后自然获得正确 lifecycle）
    const where = {
      ...(options.where.id !== undefined ? { id: options.where.id } : {}),
      ...(options.where.guestId !== undefined ? { guestId: options.where.guestId } : {}),
      updatedAt: options.where.updatedAt,
    };
    await prisma.$transaction(async (tx) => {
      const matched = await tx.guestStoryWork.findMany({
        where,
        select: { id: true },
      });
      const matchedIds = matched.map((r: { id: number }) => r.id);
      let allKeys: string[] = [];
      if (matchedIds.length > 0) {
        const manifests = await tx.guestStoryAudioManifest.findMany({
          where: { storyWorkId: { in: matchedIds } },
          select: { id: true },
        });
        const manifestIds = manifests.map((r: { id: number }) => r.id);
        if (manifestIds.length > 0) {
          const segments = await tx.guestStoryAudioSegment.findMany({
            where: { manifestId: { in: manifestIds } },
            select: { storageKey: true },
          });
          allKeys = segments.map((s: { storageKey: string }) => s.storageKey);
        }
        const retentionAssets = await tx.guestStoryAudioAsset.findMany({
          where: { storyWorkId: { in: matchedIds } },
          select: { storageKey: true },
        });
        allKeys = [...allKeys, ...retentionAssets.map((a: { storageKey: string }) => a.storageKey)];
        if (allKeys.length > 0) {
          await enqueueAudioDeletionTombstones(
            tx as unknown as Parameters<typeof enqueueAudioDeletionTombstones>[0],
            allKeys,
          );
        }
      }
      if (options.testHooks?.__testInsideTransactionHook) {
        await options.testHooks.__testInsideTransactionHook();
      }
      const deleteResult = await tx.guestStoryWork.deleteMany({ where });
      deletedCount = deleteResult.count;
      if (matchedIds.length === 0 || allKeys.length === 0) {
        committedKeys = [];
        return;
      }
      if (deletedCount >= matchedIds.length) {
        committedKeys = allKeys;
        return;
      }
      const survivors = await tx.guestStoryWork.findMany({
        where: { id: { in: matchedIds } },
        select: { id: true },
      });
      if (survivors.length === 0) {
        committedKeys = allKeys;
        return;
      }
      const survivorIds = survivors.map((r: { id: number }) => r.id);
      const survivorManifests = await tx.guestStoryAudioManifest.findMany({
        where: { storyWorkId: { in: survivorIds } },
        select: { id: true },
      });
      const survivorManifestIds = survivorManifests.map((r: { id: number }) => r.id);
      let survivorKeys: string[] = [];
      if (survivorManifestIds.length > 0) {
        const survivorSegments = await tx.guestStoryAudioSegment.findMany({
          where: { manifestId: { in: survivorManifestIds } },
          select: { storageKey: true },
        });
        survivorKeys = survivorSegments.map((s: { storageKey: string }) => s.storageKey);
      }
      const survivorRetentionAssets = await tx.guestStoryAudioAsset.findMany({
        where: { storyWorkId: { in: survivorIds } },
        select: { storageKey: true },
      });
      survivorKeys = [
        ...survivorKeys,
        ...survivorRetentionAssets.map((a: { storageKey: string }) => a.storageKey),
      ];
      if (survivorKeys.length > 0) {
        //  FIXUP fail-closed：prune 失败即 throw → 全事务 rollback。
        await pruneSurvivorAudioTombstones(tx as unknown as SurvivorPruneTx, survivorKeys);
        committedKeys = computeCommittedAudioKeys(allKeys, survivorKeys);
      } else {
        committedKeys = allKeys;
      }
    });
  }

  // COMMIT 后 best-effort cleanup 本批 tombstones（失败吞掉，由 tombstone retry 接管）
  if (committedKeys.length > 0) {
    try {
      await cleanupAudioStorageKeys(committedKeys);
    } catch {
      // best-effort：永久删除已提交，绝不因此抛错回滚。
    }
  }
  return { count: deletedCount };
}

/**
 *  Blocker 1：集合永久删除的 collection-aware physical-delete seam。
 *
 * 唯一语义：在同一 DB 原子边界内完成
 *「重验 Collection 仍属当前主体且仍在 trash → 固定全部成员 → audio tombstone →
 *   删除全部成员（经 deleteUserTrashWorksInTx / deleteGuestTrashWorksInTx，禁止第二套裸删除）→
 *   确认无 survivor → 才删除 Collection」。
 *
 * restore 竞态一律 fail closed：任一成员已恢复（deletedAt IS NULL）→ CONFLICT 并整事务 rollback；
 * 绝不依赖 StoryWork.collection 的 FK cascade 删除成员（那会绕过 audio-aware seam）。
 */
export type PhysicalDeleteStoryCollectionOptions =
  | {
      target: 'user';
      collectionId: string;
      userId: number;
      testHooks?: StoryWorkMutationTestHooks;
    }
  | {
      target: 'guest';
      collectionId: string;
      guestId: string;
      testHooks?: StoryWorkMutationTestHooks;
    };

export async function executeStoryCollectionPhysicalDelete(
  options: PhysicalDeleteStoryCollectionOptions,
): Promise<{ count: number }> {
  let committedKeys: string[] = [];
  let deletedCount = 0;

  await prisma.$transaction(async (tx) => {
    if (options.target === 'user') {
      const collection = await tx.storyCollection.findFirst({
        where: { id: options.collectionId, userId: options.userId },
        select: { id: true, deletedAt: true },
      });
      if (!collection) throw new TRPCError({ code: 'NOT_FOUND', message: '作品集不存在' });
      if (collection.deletedAt === null) {
        throw new TRPCError({ code: 'CONFLICT', message: '仅允许对回收站中的作品集执行永久删除' });
      }
      const members = await tx.storyWork.findMany({
        where: { collectionId: options.collectionId },
        select: { id: true, deletedAt: true },
      });
      if (members.some((m) => m.deletedAt === null)) {
        throw new TRPCError({ code: 'CONFLICT', message: '集合成员已恢复，永久删除已取消' });
      }
      const memberIds = members.map((m) => m.id);
      if (memberIds.length > 0) {
        const result = await deleteUserTrashWorksInTx(
          tx as unknown as UserTrashDeleteTx,
          { userId: options.userId, id: { in: memberIds }, deletedAt: { not: null } },
          options.testHooks,
        );
        committedKeys = result.committedKeys;
        deletedCount = result.deletedCount;
        if (result.remainingIds.length > 0) {
          throw new TRPCError({ code: 'CONFLICT', message: '集合成员已恢复，永久删除已取消' });
        }
      }
      await tx.storyCollection.delete({ where: { id: options.collectionId } });
      return;
    }

    const collection = await tx.guestStoryCollection.findFirst({
      where: { id: options.collectionId, guestId: options.guestId },
      select: { id: true, deletedAt: true },
    });
    if (!collection) throw new TRPCError({ code: 'NOT_FOUND', message: '作品集不存在' });
    if (collection.deletedAt === null) {
      throw new TRPCError({ code: 'CONFLICT', message: '仅允许对回收站中的作品集执行永久删除' });
    }
    const members = await tx.guestStoryWork.findMany({
      where: { collectionId: options.collectionId },
      select: { id: true, deletedAt: true },
    });
    if (members.some((m) => m.deletedAt === null)) {
      throw new TRPCError({ code: 'CONFLICT', message: '集合成员已恢复，永久删除已取消' });
    }
    const memberIds = members.map((m) => m.id);
    if (memberIds.length > 0) {
      const result = await deleteGuestTrashWorksInTx(
        tx as unknown as GuestTrashDeleteTx,
        { guestId: options.guestId, id: { in: memberIds }, deletedAt: { not: null } },
        options.testHooks,
      );
      committedKeys = result.committedKeys;
      deletedCount = result.deletedCount;
      if (result.remainingIds.length > 0) {
        throw new TRPCError({ code: 'CONFLICT', message: '集合成员已恢复，永久删除已取消' });
      }
    }
    await tx.guestStoryCollection.delete({ where: { id: options.collectionId } });
  });

  if (committedKeys.length > 0) {
    try {
      await cleanupAudioStorageKeys(committedKeys);
    } catch {
      // best-effort：集合永久删除已提交，绝不因此抛错回滚。
    }
  }
  return { count: deletedCount };
}

/**
 * 永久物理删除处于回收站中的作品（Mutation 5/5）
 *
 * 严格语义：
 * 1. 仅允许目标处于回收站（deletedAt !== null）；对 active 作品调用明确以 CONFLICT 拒绝；
 * 2. 物理删除通过统一底层 primitive executeStoryWorkPhysicalDelete 执行（作为  音频清理的唯一 Service Seam 挂载点）；
 *    - 架构说明（ Audio Seam）：
 *      永久删除统一收敛于 executeStoryWorkPhysicalDelete，后续  将在基底 primitive 内使用 DB 事务
 *      完成 Audio tombstone 记录与 Work 物理删除，并在 DB 事务提交后触发外部异步对象存储音频文件清理。
 * 3. 并发原子性：在底层 primitive 施加 deletedAt IS NOT NULL 谓词，杜绝 TOCTOU 竞态；
 * 4. 不存在或属于其他主体的作品统一抛出 NOT_FOUND；
 * 5. User / Guest 两表严格同构对称。
 *
 * @param subject 身份主体（User / Guest）
 * @param workId 作品 ID
 * @param testHooks 测试注入钩子（可选，供并发回归测试使用）
 */
export async function permanentlyDeleteStoryWorkForSubject(
  subject: Subject,
  workId: number,
  testHooks?: StoryWorkMutationTestHooks
): Promise<{ success: true; id: number }> {
  const validId = assertValidWorkId(workId);

  if (subject.type === 'user') {
    // 1. 通过统一物理删除 primitive 执行原子删除（仅匹配回收站中的作品：deletedAt IS NOT NULL）
    const deleteRes = await executeStoryWorkPhysicalDelete({
      target: 'user',
      reason: 'trash',
      where: {
        id: validId,
        userId: subject.id,
        deletedAt: { not: null },
      },
      testHooks,
    });

    if (deleteRes.count > 0) {
      return {
        success: true,
        id: validId,
      };
    }

    // count === 0: 区分是 active（CONFLICT）还是 不存在/跨主体/已被删（NOT_FOUND）
    const current = await prisma.storyWork.findFirst({
      where: {
        id: validId,
        userId: subject.id,
      },
    });

    if (current && current.deletedAt === null) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: '仅允许对回收站中的作品执行永久删除',
      });
    }

    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '作品不存在',
    });
  } else {
    // 1. 通过统一物理删除 primitive 执行原子删除（仅匹配回收站中的作品：deletedAt IS NOT NULL）
    const deleteRes = await executeStoryWorkPhysicalDelete({
      target: 'guest',
      reason: 'trash',
      where: {
        id: validId,
        guestId: subject.id,
        deletedAt: { not: null },
      },
      testHooks,
    });

    if (deleteRes.count > 0) {
      return {
        success: true,
        id: validId,
      };
    }

    const current = await prisma.guestStoryWork.findFirst({
      where: {
        id: validId,
        guestId: subject.id,
      },
    });

    if (current && current.deletedAt === null) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: '仅允许对回收站中的作品执行永久删除',
      });
    }

    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '作品不存在',
    });
  }
}


