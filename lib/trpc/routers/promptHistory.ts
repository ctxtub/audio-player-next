/**
 * 提示词历史 Router
 *
 * 当前登录用户或具名访客的提示词使用历史读写，guarded。
 */

import { router, guardedProcedure } from '../init';
import { recordInputSchema, removeInputSchema } from '../schemas/promptHistory';
import {
    listPromptHistoryForSubject,
    recordPromptHistoryForSubject,
    removePromptHistoryForSubject,
} from '@/lib/server/promptHistory';
import { resolveSubject } from '@/lib/server/subject';
import { enforceProcedureRateLimit } from '@/lib/server/rateLimit';

export const promptHistoryRouter = router({
    /**
     * 列出当前主体的提示词历史（读取时剪除 30 天前的记录）。
     */
    list: guardedProcedure.query(async ({ ctx }) => {
        return listPromptHistoryForSubject(resolveSubject(ctx));
    }),

    /**
     * 记录一次提示词使用（upsert，次数 +1）。
     */
    record: guardedProcedure
        .input(recordInputSchema)
        .mutation(async ({ ctx, input }) => {
            enforceProcedureRateLimit('promptHistory:record', ctx, {
                guestLimit: 30,
                authedLimit: 60,
            });
            return recordPromptHistoryForSubject(resolveSubject(ctx), input.prompt);
        }),

    /**
     * 删除当前主体的某条提示词历史。
     */
    remove: guardedProcedure
        .input(removeInputSchema)
        .mutation(async ({ ctx, input }) => {
            enforceProcedureRateLimit('promptHistory:remove', ctx, {
                guestLimit: 30,
                authedLimit: 60,
            });
            await removePromptHistoryForSubject(resolveSubject(ctx), input.prompt);
            return { success: true as const };
        }),
});
