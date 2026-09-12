/**
 * Library (StoryWork) tRPC 路由模块
 *
 * 冻结 M2-06 公开 API，向客户端与 M3 Facade 暴露 8 个统一 Procedure：
 * - list: 游标分页查询故事列表（active/favorites/trash 视图 + 搜索）
 * - get: 单个故事详情查询
 * - create: 故事创作入库与来源消息幂等防重
 * - rename: 重命名故事标题
 * - setFavorite: 收藏 / 取消收藏切换
 * - trash: 移入回收站（软删除）
 * - restore: 从回收站恢复
 * - permanentDelete: 永久删除（物理删除，仅限回收站中作品）
 *
 * 契约规范：
 * 1. 严格全量通过 guardedProcedure + resolveSubject，租户物理隔离；
 * 2. 入参全量经 lib/trpc/schemas/library.ts 校验，出参全量返回 DTO，严禁直接暴露 Prisma 模型；
 * 3. 错误码契约：BAD_REQUEST、NOT_FOUND、CONFLICT 原样透出；任何底层 Prisma 或未知异常
 *    统一收口为 INTERNAL_SERVER_ERROR，严禁向上泄漏数据库细节；
 * 4. 写操作速率限制：所有 6 个变更类 Procedure（create 及状态变更）挂载基于内存滑动窗口的限流；
 * 5. 绝不向公网契约透出内部测试接缝。
 */

import { router, guardedProcedure, TRPCError } from '../init';
import {
  libraryListInputSchema,
  libraryGetInputSchema,
  libraryCreateInputSchema,
  libraryRenameInputSchema,
  librarySetFavoriteInputSchema,
  libraryTrashInputSchema,
  libraryRestoreInputSchema,
  libraryDeletePermanentlyInputSchema,
} from '../schemas/library';
import {
  listStoryWorksForSubject,
  getStoryWorkForSubject,
  createStoryWorkForSubject,
  renameStoryWorkForSubject,
  setStoryWorkFavoriteForSubject,
  trashStoryWorkForSubject,
  restoreStoryWorkForSubject,
  permanentlyDeleteStoryWorkForSubject,
} from '@/lib/server/storyWork';
import { resolveSubject } from '@/lib/server/subject';
import {
  enforceProcedureRateLimit,
  defaultRateLimiter,
  SlidingWindowRateLimiter,
  type ProcedureRateLimitOptions,
} from '@/lib/server/rateLimit';

/**
 * 变更操作速率限制配置
 */
export const LIBRARY_RATE_LIMITS = {
  create: {
    guestLimit: 30,
    authedLimit: 60,
  },
  rename: {
    guestLimit: 60,
    authedLimit: 120,
  },
  setFavorite: {
    guestLimit: 60,
    authedLimit: 120,
  },
  trash: {
    guestLimit: 60,
    authedLimit: 120,
  },
  restore: {
    guestLimit: 60,
    authedLimit: 120,
  },
  permanentDelete: {
    guestLimit: 60,
    authedLimit: 120,
  },
} as const satisfies Record<string, ProcedureRateLimitOptions>;

let activeRateLimiter: SlidingWindowRateLimiter = defaultRateLimiter;

/**
 * 注入自定义限流器（主要用于单元/集成测试模拟可确定性限流）
 */
export const setLibraryRateLimiter = (limiter: SlidingWindowRateLimiter): void => {
  activeRateLimiter = limiter;
};

/**
 * 重置限流器至全局默认并清理滑动窗口记录
 */
export const resetLibraryRateLimiter = (): void => {
  activeRateLimiter = defaultRateLimiter;
  defaultRateLimiter.reset();
};

/**
 * 获取当前使用的限流器实例
 */
export const getLibraryRateLimiter = (): SlidingWindowRateLimiter => activeRateLimiter;

/**
 * 统一错误拦截与脱敏
 *
 * 1. 业务层显式抛出的 TRPCError（BAD_REQUEST / NOT_FOUND / CONFLICT / UNAUTHORIZED / TOO_MANY_REQUESTS）原样透出；
 * 2. 防卫性脱敏：若 TRPCError message 含有底层 Prisma 报错特征，阻断并转为安全文案；
 * 3. 未知异常、数据库原生异常（Prisma Client、SQLite 等）统一转为 INTERNAL_SERVER_ERROR，
 *    杜绝向客户端泄漏任何表结构、字段名或 P2002/P2025 等底层细节。
 */
export function handleLibraryError(error: unknown): never {
  if (error instanceof TRPCError) {
    if (
      typeof error.message === 'string' &&
      (error.message.includes('prisma') ||
        error.message.includes('Prisma') ||
        /P2\d{3}/.test(error.message))
    ) {
      console.error('[libraryRouter] 拦截到底层 Prisma 特征错误并脱敏:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: '内部服务错误，请稍后重试',
      });
    }
    throw error;
  }

  console.error('[libraryRouter] 捕获未处理底层异常:', error);
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: '内部服务错误，请稍后重试',
  });
}

/**
 * Library Public tRPC 路由
 */
export const libraryRouter = router({
  /**
   * 故事列表分页查询
   */
  list: guardedProcedure
    .input(libraryListInputSchema.optional())
    .query(async ({ ctx, input }) => {
      try {
        const subject = resolveSubject(ctx);
        return await listStoryWorksForSubject(subject, input ?? {});
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  /**
   * 单个故事详情查询
   */
  get: guardedProcedure
    .input(libraryGetInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        const subject = resolveSubject(ctx);
        return await getStoryWorkForSubject(subject, input.id);
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  /**
   * 创作入库（来源消息幂等）
   */
  create: guardedProcedure
    .input(libraryCreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'library:create',
          ctx,
          LIBRARY_RATE_LIMITS.create,
          getLibraryRateLimiter()
        );
        const subject = resolveSubject(ctx);
        return await createStoryWorkForSubject(subject, input);
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  /**
   * 重命名故事标题
   */
  rename: guardedProcedure
    .input(libraryRenameInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'library:rename',
          ctx,
          LIBRARY_RATE_LIMITS.rename,
          getLibraryRateLimiter()
        );
        const subject = resolveSubject(ctx);
        return await renameStoryWorkForSubject(subject, input.id, input.title);
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  /**
   * 收藏/取消收藏切换
   */
  setFavorite: guardedProcedure
    .input(librarySetFavoriteInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'library:setFavorite',
          ctx,
          LIBRARY_RATE_LIMITS.setFavorite,
          getLibraryRateLimiter()
        );
        const subject = resolveSubject(ctx);
        return await setStoryWorkFavoriteForSubject(subject, input.id, input.favorite);
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  /**
   * 移入回收站（软删除）
   */
  trash: guardedProcedure
    .input(libraryTrashInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'library:trash',
          ctx,
          LIBRARY_RATE_LIMITS.trash,
          getLibraryRateLimiter()
        );
        const subject = resolveSubject(ctx);
        return await trashStoryWorkForSubject(subject, input.id);
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  /**
   * 从回收站恢复
   */
  restore: guardedProcedure
    .input(libraryRestoreInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'library:restore',
          ctx,
          LIBRARY_RATE_LIMITS.restore,
          getLibraryRateLimiter()
        );
        const subject = resolveSubject(ctx);
        return await restoreStoryWorkForSubject(subject, input.id);
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  /**
   * 永久删除（物理删除，仅限回收站中作品）
   */
  permanentDelete: guardedProcedure
    .input(libraryDeletePermanentlyInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'library:permanentDelete',
          ctx,
          LIBRARY_RATE_LIMITS.permanentDelete,
          getLibraryRateLimiter()
        );
        const subject = resolveSubject(ctx);
        return await permanentlyDeleteStoryWorkForSubject(subject, input.id);
      } catch (error) {
        handleLibraryError(error);
      }
    }),
});
