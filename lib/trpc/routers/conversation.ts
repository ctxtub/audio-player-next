/**
 * Conversation tRPC 路由（change-id 2026-09-15-story-collection-continuous-creation）。
 *
 * getActive / get / createNew / saveSnapshot / close；全部 guardedProcedure + resolveSubject。
 * 与既有 chat.getConversation / saveConversation（legacy 单快照路径）并存，互不影响（expand 阶段回退 read flag）。
 */

import { router, guardedProcedure } from '../init';
import {
  conversationIdInputSchema,
  conversationCreateNewInputSchema,
  conversationSaveSnapshotInputSchema,
} from '../schemas/conversation';
import {
  getActiveConversationForSubject,
  getConversationForSubject,
  getConversationMessagesForSubject,
  createNewConversationForSubject,
  saveConversationSnapshotForSubject,
  closeConversationForSubject,
} from '@/lib/server/conversation';
import { resolveSubject } from '@/lib/server/subject';
import { enforceProcedureRateLimit } from '@/lib/server/rateLimit';
import { handleLibraryError } from './library';

export const conversationRouter = router({
  /**
   * 读取当前主体的 active 会话（无则 null）。
   */
  getActive: guardedProcedure.query(async ({ ctx }) => {
    return getActiveConversationForSubject(resolveSubject(ctx));
  }),

  /**
   * 读取当前主体拥有的指定会话。
   */
  get: guardedProcedure.input(conversationIdInputSchema).query(async ({ ctx, input }) => {
    try {
      return await getConversationForSubject(resolveSubject(ctx), input.id);
    } catch (error) {
      handleLibraryError(error);
    }
  }),

  /**
   * 读取指定会话的消息（会话级读路径，仅本会话）。
   */
  getMessages: guardedProcedure.input(conversationIdInputSchema).query(async ({ ctx, input }) => {
    try {
      return await getConversationMessagesForSubject(resolveSubject(ctx), input.id);
    } catch (error) {
      handleLibraryError(error);
    }
  }),

  /**
   * 新建创作：关闭旧 active 会话并创建新 UUID（expectedOldId 不匹配即 CONFLICT）。
   */
  createNew: guardedProcedure
    .input(conversationCreateNewInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit(
          'conversation:createNew',
          ctx,
          { guestLimit: 20, authedLimit: 60 },
        );
        return await createNewConversationForSubject(resolveSubject(ctx), input.expectedOldId);
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  /**
   * 以快照替换指定会话的消息（仅本会话，不跨会话删除）。
   */
  saveSnapshot: guardedProcedure
    .input(conversationSaveSnapshotInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        enforceProcedureRateLimit('conversation:saveSnapshot', ctx, {
          guestLimit: 20,
          authedLimit: 60,
        });
        await saveConversationSnapshotForSubject(
          resolveSubject(ctx),
          input.conversationId,
          input.messages,
          input.baseMessageIds !== undefined
            ? { expectedMessageIds: input.baseMessageIds }
            : undefined,
        );
        return { success: true as const };
      } catch (error) {
        handleLibraryError(error);
      }
    }),

  /**
   * 关闭指定会话（幂等）。
   */
  close: guardedProcedure.input(conversationIdInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await closeConversationForSubject(resolveSubject(ctx), input.id);
    } catch (error) {
      handleLibraryError(error);
    }
  }),
});
