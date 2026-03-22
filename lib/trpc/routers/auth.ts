/**
 * 认证 Router
 *
 * 处理注册、登录、登出、用户信息查询。
 */

import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';

import { router, publicProcedure, TRPCError } from '../init';
import { loginInputSchema, registerInputSchema } from '../schemas/auth';
import { prisma } from '@/lib/db';
import { encodeSession, decodeSession, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session';

const GUEST_COOKIE = 'guest';

/**
 * 写入登录态 Cookie。
 */
const setAuthCookie = async (userId: number, nickname: string) => {
    const cookieStore = await cookies();
    cookieStore.set({
        name: SESSION_COOKIE,
        value: encodeSession(userId, nickname),
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE,
    });
};

export const authRouter = router({
    /**
     * 注册接口。
     */
    register: publicProcedure
        .input(registerInputSchema)
        .mutation(async ({ input }) => {
            try {
                const existing = await prisma.user.findUnique({
                    where: { username: input.username },
                });
                if (existing) {
                    throw new TRPCError({
                        code: 'CONFLICT',
                        message: '用户名已存在',
                    });
                }

                const hashedPassword = await bcrypt.hash(input.password, 10);
                const user = await prisma.user.create({
                    data: {
                        username: input.username,
                        password: hashedPassword,
                        nickname: input.nickname ?? input.username,
                    },
                });

                await setAuthCookie(user.id, user.nickname ?? user.username);

                return {
                    success: true as const,
                    user: { nickname: user.nickname ?? user.username },
                };
            } catch (error) {
                if (error instanceof TRPCError) throw error;
                throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '注册失败，请稍后重试' });
            }
        }),

    /**
     * 登录接口。
     */
    login: publicProcedure
        .input(loginInputSchema)
        .mutation(async ({ input }) => {
            try {
                const user = await prisma.user.findUnique({
                    where: { username: input.username },
                });

                if (!user || !(await bcrypt.compare(input.password, user.password))) {
                    throw new TRPCError({
                        code: 'UNAUTHORIZED',
                        message: '账号或密码错误',
                    });
                }

                await setAuthCookie(user.id, user.nickname ?? user.username);

                return {
                    success: true as const,
                    user: { nickname: user.nickname ?? user.username },
                };
            } catch (error) {
                if (error instanceof TRPCError) throw error;
                throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '登录失败，请稍后重试' });
            }
        }),

    /**
     * 登出接口。
     */
    logout: publicProcedure.mutation(async () => {
        const cookieStore = await cookies();
        cookieStore.delete(SESSION_COOKIE);
        cookieStore.delete(GUEST_COOKIE);

        return { success: true as const };
    }),

    /**
     * 进入访客模式。
     */
    enterGuestMode: publicProcedure.mutation(async () => {
        const cookieStore = await cookies();
        /** 不设 maxAge，使其成为 session cookie，浏览器关闭即过期 */
        cookieStore.set({
            name: GUEST_COOKIE,
            value: '1',
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
        });

        return { success: true as const };
    }),

    /**
     * 退出访客模式。
     */
    exitGuestMode: publicProcedure.mutation(async () => {
        const cookieStore = await cookies();
        cookieStore.delete(GUEST_COOKIE);

        return { success: true as const };
    }),

    /**
     * 获取当前登录状态（含访客模式）。
     * Cookie 续签已移至 Next.js middleware 统一处理。
     */
    profile: publicProcedure.query(async ({ ctx }) => {
        if (ctx.session) {
            return {
                isLogin: true as const,
                isGuest: false as const,
                user: { nickname: ctx.session.nickname },
            };
        }

        const cookieStore = await cookies();
        const isGuest = cookieStore.get(GUEST_COOKIE)?.value === '1';

        return {
            isLogin: false as const,
            isGuest,
        };
    }),
});
