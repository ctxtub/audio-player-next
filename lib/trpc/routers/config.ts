/**
 * 配置 Router
 *
 * - get：系统级配置（音色白名单 + 系统默认音色），public。
 * - getMine/updateMine：当前登录用户或具名访客的个性化配置，guarded。
 */

import { router, publicProcedure, guardedProcedure, TRPCError } from '../init';
import { getTtsConfig } from '@/lib/server/openai';
import { userConfigPatchSchema } from '../schemas/config';
import { getOrCreateConfig, updateConfig, type ConfigSubject } from '@/lib/server/unifiedConfig';
import { enforceProcedureRateLimit } from '@/lib/server/rateLimit';
import type { Context } from '../context';

/**
 * 从 tRPC 上下文中解析配置主体（用户或具名访客）。
 */
export const resolveSubject = (ctx: Context): ConfigSubject => {
    if (ctx.session) return { type: 'user', id: ctx.session.userId };
    if (ctx.guestId) return { type: 'guest', id: ctx.guestId };
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '未授权的配置访问' });
};

export const configRouter = router({
    /**
     * 获取系统级配置：音色白名单与系统默认音色（与用户无关，来自 env）。
     */
    get: publicProcedure.query(() => {
        const { voicesList, voiceId } = getTtsConfig();

        return { voicesList, voiceId };
    }),

    /**
     * 获取当前主体的个性化配置（登录用户或具名访客）；主体不存在时以系统默认建行。
     */
    getMine: guardedProcedure.query(async ({ ctx }) => {
        return getOrCreateConfig(resolveSubject(ctx));
    }),

    /**
     * 增量更新当前主体的个性化配置（登录用户或具名访客），带滑动窗口限流。
     */
    updateMine: guardedProcedure
        .input(userConfigPatchSchema)
        .mutation(async ({ ctx, input }) => {
            enforceProcedureRateLimit('config:update', ctx, {
                guestLimit: 30,
                authedLimit: 60,
            });
            return updateConfig(resolveSubject(ctx), input);
        }),
});

