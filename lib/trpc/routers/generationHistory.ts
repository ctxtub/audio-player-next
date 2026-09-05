/**
 * 生成历史 Router
 *
 * 当前登录用户或具名访客生成的故事历史读写，guarded。
 */

import { router, guardedProcedure } from '../init';
import { recordInputSchema, removeInputSchema } from '../schemas/generationHistory';
import {
    listGenerationHistoryForSubject,
    recordGenerationHistoryForSubject,
    removeGenerationHistoryForSubject,
} from '@/lib/server/generationHistory';
import { resolveSubject } from '@/lib/server/subject';
import { enforceProcedureRateLimit } from '@/lib/server/rateLimit';

export const generationHistoryRouter = router({
    /**
     * 列出当前主体最近的生成历史。
     */
    list: guardedProcedure.query(async ({ ctx }) => {
        return listGenerationHistoryForSubject(resolveSubject(ctx));
    }),

    /**
     * 记录一次生成（写入后裁剪保留最近 100 条）。
     */
    record: guardedProcedure
        .input(recordInputSchema)
        .mutation(async ({ ctx, input }) => {
            enforceProcedureRateLimit('generationHistory:record', ctx, {
                guestLimit: 20,
                authedLimit: 60,
            });
            return recordGenerationHistoryForSubject(resolveSubject(ctx), input);
        }),

    /**
     * 删除当前主体的某条生成历史。
     */
    remove: guardedProcedure
        .input(removeInputSchema)
        .mutation(async ({ ctx, input }) => {
            enforceProcedureRateLimit('generationHistory:remove', ctx, {
                guestLimit: 20,
                authedLimit: 60,
            });
            await removeGenerationHistoryForSubject(resolveSubject(ctx), input.id);
            return { success: true as const };
        }),
});
