/**
 * 提示词历史 Router
 *
 * 当前登录用户的提示词使用历史读写，全部需要认证。
 */

import { router, authedProcedure } from '../init';
import { recordInputSchema, removeInputSchema } from '../schemas/promptHistory';
import {
    listPromptHistory,
    recordPromptHistory,
    removePromptHistory,
} from '@/lib/server/promptHistory';

export const promptHistoryRouter = router({
    /**
     * 列出当前用户的提示词历史（读取时剪除 30 天前的记录）。
     */
    list: authedProcedure.query(async ({ ctx }) => {
        return listPromptHistory(ctx.session.userId);
    }),

    /**
     * 记录一次提示词使用（upsert，次数 +1）。
     */
    record: authedProcedure
        .input(recordInputSchema)
        .mutation(async ({ ctx, input }) => {
            return recordPromptHistory(ctx.session.userId, input.prompt);
        }),

    /**
     * 删除当前用户的某条提示词历史。
     */
    remove: authedProcedure
        .input(removeInputSchema)
        .mutation(async ({ ctx, input }) => {
            await removePromptHistory(ctx.session.userId, input.prompt);
            return { success: true as const };
        }),
});
