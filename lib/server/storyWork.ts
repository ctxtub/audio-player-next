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

/**
 * M5-08 Work Trash 状态判定（spec §29.1 / §29.2，产品拍板 M5-P03）。
 *
 * 仅读取 deletedAt 存在信号（select id，不取 title/storyText/voiceId/contentHash），
 * 不重算任何元数据、不触 legacy DTO（§36 边界：M5 不得重算 title/hash）。
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
 * 故事作品入库（Library Create，M2-04）
 *
 * M4 将来调用的正式资产创建服务，负责：
 * 1. 严格校验输入（prompt、storyText、voiceId?、sourceMessageId?、explicit title?）；
 * 2. 文本规范化与元数据派生：统一由 Server 调用 M2-02 canonical 算法生成
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
}

/**
 * 重命名故事作品（M2-05）
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
 * 设置故事作品收藏状态（M2-05）
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
 * 将故事作品移入回收站（软删除，M2-05）
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
 * 从回收站恢复故事作品（M2-05）
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
        id?: number;
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
        id?: number;
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
        id?: number;
        guestId?: string;
        updatedAt: {
          lt: Date;
        };
      };
      testHooks?: StoryWorkMutationTestHooks;
    };

/**
 * StoryWork 物理删除唯一合法底层执行点（Server-Internal Primitive / M8 Audio Seam 唯一挂载点）
 *
 * 架构说明与安全约束：
 * 1. 物理删除唯一执行点：无论是用户主动永久删除、定时回收站清理（purgeExpiredUserTrash），
 *    还是访客数据 GC（purgeExpiredGuestData），对 User/Guest 作品资产的物理删除都必须统一通过本 primitive 执行，
 *    严禁在其他模块直接裸调 prisma.storyWork.delete/deleteMany 或 prisma.guestStoryWork.delete/deleteMany。
 * 2. M8 音频清理唯一挂载点：后续 M8 在执行永久删除时，将在此处使用 DB 事务完成 Audio tombstone 记录与 Work 物理删除，
 *    并在 DB 事务提交后触发外部异步对象存储音频文件清理，保证 Audio tombstone 仅需在此一处维护。
 * 3. 安全规则与显式 Discriminated Contract：
 *    - User 物理删除只能来自 Trash（deletedAt IS NOT NULL）；
 *    - Guest manual delete 只能来自 Trash（deletedAt IS NOT NULL）；
 *    - Guest retention GC 严格按 updatedAt < threshold 清理；
 *    三者最终都经此同一 M8 tombstone seam 唯一挂载点执行。
 *    contract 保持窄契约，绝不接受任意自由 Prisma where，杜绝退化为危险的通用 delete helper。
 */
export async function executeStoryWorkPhysicalDelete(
  options: PhysicalDeleteStoryWorkOptions
): Promise<{ count: number }> {
  if (options.testHooks?.__testBeforeMutationHook) {
    await options.testHooks.__testBeforeMutationHook();
  }

  if (options.target === 'user') {
    // User 作品物理删除仅支持 reason: 'trash'
    const deleteResult = await prisma.storyWork.deleteMany({
      where: {
        ...(options.where.id !== undefined ? { id: options.where.id } : {}),
        ...(options.where.userId !== undefined ? { userId: options.where.userId } : {}),
        deletedAt: options.where.deletedAt,
      },
    });
    return { count: deleteResult.count };
  } else {
    // Guest 作品物理删除：区分 manual trash 与 retention GC
    if (options.reason === 'trash') {
      const deleteResult = await prisma.guestStoryWork.deleteMany({
        where: {
          ...(options.where.id !== undefined ? { id: options.where.id } : {}),
          ...(options.where.guestId !== undefined ? { guestId: options.where.guestId } : {}),
          deletedAt: options.where.deletedAt,
        },
      });
      return { count: deleteResult.count };
    } else {
      // reason === 'retention'
      const deleteResult = await prisma.guestStoryWork.deleteMany({
        where: {
          ...(options.where.id !== undefined ? { id: options.where.id } : {}),
          ...(options.where.guestId !== undefined ? { guestId: options.where.guestId } : {}),
          updatedAt: options.where.updatedAt,
        },
      });
      return { count: deleteResult.count };
    }
  }
}

/**
 * 永久物理删除处于回收站中的作品（Mutation 5/5）
 *
 * 严格语义：
 * 1. 仅允许目标处于回收站（deletedAt !== null）；对 active 作品调用明确以 CONFLICT 拒绝；
 * 2. 物理删除通过统一底层 primitive executeStoryWorkPhysicalDelete 执行（作为 M8 音频清理的唯一 Service Seam 挂载点）；
 *    - 架构说明（M8 Audio Seam）：
 *      永久删除统一收敛于 executeStoryWorkPhysicalDelete，后续 M8 将在基底 primitive 内使用 DB 事务
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


