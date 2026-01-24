/**
 * 认证 Router
 *
 * 处理登录、登出、用户信息查询。
 */

import { cookies } from 'next/headers';

import { router, publicProcedure, TRPCError } from '../init';
import { loginInputSchema } from '../schemas/auth';
import { buildAuthCookie } from '@/utils/authCookie';

/**
 * 登录接口允许的账号白名单。
 */
const AUTHORIZED_USER_WHITELIST: Record<string, string> = {
    test: 'test',
};

export const authRouter = router({
    /**
     * 登录接口。
     */
    login: publicProcedure
        .input(loginInputSchema)
        .mutation(async ({ input }) => {
            const expectedPassword = AUTHORIZED_USER_WHITELIST[input.username];
            if (!expectedPassword || input.password !== expectedPassword) {
                throw new TRPCError({
                    code: 'UNAUTHORIZED',
                    message: '账号或密码错误',
                });
            }

            const cookieStore = await cookies();
            cookieStore.set({
                name: 'auth',
                value: buildAuthCookie(input.username).split('=')[1].split(';')[0],
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                path: '/',
                maxAge: 60 * 60 * 24, // 1 day
            });

            return {
                success: true as const,
                user: { nickname: input.username },
            };
        }),

    /**
     * 登出接口。
     */
    logout: publicProcedure.mutation(async () => {
        const cookieStore = await cookies();
        cookieStore.delete('auth');

        return { success: true as const };
    }),

    /**
     * 获取当前登录状态。
     */
    profile: publicProcedure.mutation(async ({ ctx }) => {
        if (ctx.session) {
            return {
                isLogin: true as const,
                user: { nickname: ctx.session.nickname },
            };
        }

        return { isLogin: false as const };
    }),
});
