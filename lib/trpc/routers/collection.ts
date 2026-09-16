/**
 * StoryCollection tRPC 路由（change-id 2026-09-15-story-collection-continuous-creation T1）。
 *
 * 冻结集合公开 API：list / get / promoteArtifact / rename / setFavorite / softDelete / restore / deleteForever。
 * 全部 guardedProcedure + resolveSubject；写操作挂载内存滑动窗口限流。
 */

import { router, guardedProcedure } from '../init';
import {
  collectionListInputSchema,
  collectionGetInputSchema,
  collectionPromoteInputSchema,
  collectionRenameInputSchema,
  collectionSetFavoriteInputSchema,
  collectionTrashInputSchema,
  collectionRestoreInputSchema,
  collectionDeleteForeverInputSchema,
} from '../schemas/collection';
import {
  listCollectionsForSubject,
  getCollectionForSubject,
  promoteArtifactForSubject,
  renameCollectionForSubject,
  setCollectionFavoriteForSubject,
  softDeleteCollectionForSubject,
  restoreCollectionForSubject,
  deleteForeverCollectionForSubject,
} from '@/lib/server/storyCollection';
import { resolveSubject } from '@/lib/server/subject';
import { enforceProcedureRateLimit } from '@/lib/server/rateLimit';
import { getLibraryRateLimiter, handleLibraryError } from './library';

export const collectionRouter = router({
  list: guardedProcedure.input(collectionListInputSchema).query(async ({ ctx, input }) => {
    try {
      return await listCollectionsForSubject(resolveSubject(ctx), input);
    } catch (error) {
      handleLibraryError(error);
    }
  }),

  get: guardedProcedure.input(collectionGetInputSchema).query(async ({ ctx, input }) => {
    try {
      return await getCollectionForSubject(resolveSubject(ctx), input.id);
    } catch (error) {
      handleLibraryError(error);
    }
  }),

  /**
   * Artifact → Collection/Work 唯一写入口（首作建集 / 同会话追加）。
   */
  promoteArtifact: guardedProcedure
    .input(collectionPromoteInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'collection:promoteArtifact',
          ctx,
          { guestLimit: 30, authedLimit: 60 },
          getLibraryRateLimiter(),
        );
        return await promoteArtifactForSubject(resolveSubject(ctx), input);
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  rename: guardedProcedure
    .input(collectionRenameInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'collection:rename',
          ctx,
          { guestLimit: 60, authedLimit: 120 },
          getLibraryRateLimiter(),
        );
        return await renameCollectionForSubject(resolveSubject(ctx), input.id, input.title);
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  setFavorite: guardedProcedure
    .input(collectionSetFavoriteInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'collection:setFavorite',
          ctx,
          { guestLimit: 60, authedLimit: 120 },
          getLibraryRateLimiter(),
        );
        return await setCollectionFavoriteForSubject(
          resolveSubject(ctx),
          input.id,
          input.favorite,
        );
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  softDelete: guardedProcedure
    .input(collectionTrashInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'collection:softDelete',
          ctx,
          { guestLimit: 60, authedLimit: 120 },
          getLibraryRateLimiter(),
        );
        return await softDeleteCollectionForSubject(resolveSubject(ctx), input.id);
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  restore: guardedProcedure
    .input(collectionRestoreInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'collection:restore',
          ctx,
          { guestLimit: 60, authedLimit: 120 },
          getLibraryRateLimiter(),
        );
        return await restoreCollectionForSubject(resolveSubject(ctx), input.id);
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  deleteForever: guardedProcedure
    .input(collectionDeleteForeverInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'collection:deleteForever',
          ctx,
          { guestLimit: 60, authedLimit: 120 },
          getLibraryRateLimiter(),
        );
        return await deleteForeverCollectionForSubject(resolveSubject(ctx), input.id);
      } catch (error) {
        handleLibraryError(error);
      }
    }),
});
