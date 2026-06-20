/**
 * 聊天会话 Router
 *
 * 当前登录用户的单会话读取与快照保存，全部需要认证。
 */

import { router, authedProcedure } from '../init';
import { saveConversationInputSchema } from '../schemas/chatConversation';
import { getConversation, saveConversation } from '@/lib/server/chatConversation';

export const chatConversationRouter = router({
    /**
     * 读取当前用户的会话消息。
     */
    getConversation: authedProcedure.query(async ({ ctx }) => {
        return getConversation(ctx.session.userId);
    }),

    /**
     * 快照保存当前用户的会话（整条替换，空数组即清空）。
     */
    saveConversation: authedProcedure
        .input(saveConversationInputSchema)
        .mutation(async ({ ctx, input }) => {
            await saveConversation(ctx.session.userId, input.messages);
            return { success: true as const };
        }),
});
