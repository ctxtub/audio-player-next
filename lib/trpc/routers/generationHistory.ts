/**
 * 生成历史 Router
 *
 * 当前登录用户生成的故事历史读写，全部需要认证。
 */

import { router, authedProcedure } from '../init';
import { recordInputSchema, removeInputSchema } from '../schemas/generationHistory';
import {
    listGenerationHistory,
    recordGenerationHistory,
    removeGenerationHistory,
} from '@/lib/server/generationHistory';

export const generationHistoryRouter = router({
    /**
     * 列出当前用户最近的生成历史。
     */
    list: authedProcedure.query(async ({ ctx }) => {
        return listGenerationHistory(ctx.session.userId);
    }),

    /**
     * 记录一次生成（写入后裁剪保留最近 100 条）。
     */
    record: authedProcedure
        .input(recordInputSchema)
        .mutation(async ({ ctx, input }) => {
            return recordGenerationHistory(ctx.session.userId, input);
        }),

    /**
     * 删除当前用户的某条生成历史。
     */
    remove: authedProcedure
        .input(removeInputSchema)
        .mutation(async ({ ctx, input }) => {
            await removeGenerationHistory(ctx.session.userId, input.id);
            return { success: true as const };
        }),
});
