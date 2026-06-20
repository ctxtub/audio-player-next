/**
 * 配置 Router
 *
 * - get：系统级配置（音色白名单 + 系统默认音色），public。
 * - getMine/updateMine：当前登录用户的个性化配置，authed。
 */

import { z } from 'zod';

import { router, publicProcedure, authedProcedure } from '../init';
import { getTtsConfig } from '@/lib/server/openai';
import { userConfigPatchSchema, userConfigSeedSchema } from '../schemas/config';
import { getOrCreateUserConfig, updateUserConfig } from '@/lib/server/userConfig';

export const configRouter = router({
    /**
     * 获取系统级配置：音色白名单与系统默认音色（与用户无关，来自 env）。
     */
    get: publicProcedure.mutation(() => {
        const { voicesList, voiceId } = getTtsConfig();

        return { voicesList, voiceId };
    }),

    /**
     * 获取当前登录用户的配置；行不存在时用 seed 建行（首次绑定迁移）。
     */
    getMine: authedProcedure
        .input(z.object({ seed: userConfigSeedSchema.optional() }).optional())
        .query(async ({ ctx, input }) => {
            return getOrCreateUserConfig(ctx.session.userId, input?.seed);
        }),

    /**
     * 增量更新当前登录用户的配置。
     */
    updateMine: authedProcedure
        .input(userConfigPatchSchema)
        .mutation(async ({ ctx, input }) => {
            return updateUserConfig(ctx.session.userId, input);
        }),
});
