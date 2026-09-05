/**
 * 聊天会话 Router
 *
 * 当前登录用户或具名访客的单会话读取与快照保存，guarded。
 */

import { router, guardedProcedure } from '../init';
import { saveConversationInputSchema } from '../schemas/chatConversation';
import {
    getConversationForSubject,
    saveConversationForSubject,
} from '@/lib/server/chatConversation';
import { resolveSubject } from '@/lib/server/subject';
import { enforceProcedureRateLimit } from '@/lib/server/rateLimit';

export const chatConversationRouter = router({
    /**
     * 读取当前主体（登录用户或具名访客）的会话消息。
     */
    getConversation: guardedProcedure.query(async ({ ctx }) => {
        return getConversationForSubject(resolveSubject(ctx));
    }),

    /**
     * 快照保存当前主体（登录用户或具名访客）的会话（整条替换，空数组即清空）。
     */
    saveConversation: guardedProcedure
        .input(saveConversationInputSchema)
        .mutation(async ({ ctx, input }) => {
            enforceProcedureRateLimit('chat:save', ctx, {
                guestLimit: 20,
                authedLimit: 60,
            });
            await saveConversationForSubject(resolveSubject(ctx), input.messages);
            return { success: true as const };
        }),
});
