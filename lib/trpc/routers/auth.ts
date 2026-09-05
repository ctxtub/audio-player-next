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
import { encodeSession, assertSessionSecret, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session';

const GUEST_COOKIE = 'guest';
const GUEST_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

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
        .mutation(async ({ ctx, input }) => {
            // 前置校验：确保会话密钥有效，避免后续因签名异常残留孤儿用户
            assertSessionSecret();

            let createdUserId: number | null = null;
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
                createdUserId = user.id;

                // 访客注册时配置迁移：若存在 guestId 且有 GuestConfig，将个性化偏好拷贝至新 UserConfig
                if (ctx.guestId) {
                    const guestConfig = await prisma.guestConfig.findUnique({
                        where: { guestId: ctx.guestId },
                    });
                    if (guestConfig) {
                        await prisma.userConfig.create({
                            data: {
                                userId: user.id,
                                playDurationMinutes: guestConfig.playDurationMinutes,
                                voiceId: guestConfig.voiceId,
                                speed: guestConfig.speed,
                                floatingPlayerEnabled: guestConfig.floatingPlayerEnabled,
                                themeMode: guestConfig.themeMode,
                            },
                        });
                    }
                }

                await setAuthCookie(user.id, user.nickname ?? user.username);

                return {
                    success: true as const,
                    user: {
                        nickname: user.nickname ?? user.username,
                        username: user.username,
                    },
                };
            } catch (error) {
                // 回滚机制：若已写入数据库但后续 Cookie/签名/配置设置失败，删除已建用户
                if (createdUserId !== null) {
                    try {
                        await prisma.user.delete({ where: { id: createdUserId } });
                    } catch (rollbackError) {
                        console.error('Failed to rollback orphaned user:', rollbackError);
                    }
                }
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
                    user: {
                        nickname: user.nickname ?? user.username,
                        username: user.username,
                    },
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
        const guestId = `g_${crypto.randomUUID()}`;
        cookieStore.set({
            name: GUEST_COOKIE,
            value: guestId,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: GUEST_COOKIE_MAX_AGE,
        });

        // 概率淘汰：2% 概率异步触发清理 30 天未更新的访客配置
        if (Math.random() < 0.02) {
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            prisma.guestConfig.deleteMany({
                where: { updatedAt: { lt: thirtyDaysAgo } },
            }).catch((err: unknown) => console.warn('[GC] GuestConfig purge failed', err));
        }

        return { success: true as const, guestId };
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
     * 获取当前登录状态（含访客模式），并作为登录态唯一可信源。
     * Cookie 续签已移至 Next.js middleware 统一处理。
     */
    profile: publicProcedure.query(async ({ ctx }) => {
        if (ctx.session) {
            const dbUser = await prisma.user.findUnique({
                where: { id: ctx.session.userId },
                select: { username: true },
            });
            // 会话指向已删除/不存在用户（被删 / 库重置）→ 会话失效。
            // 清 stale cookie（避免 middleware 每次请求续签复活），并以失效标记告知客户端跳转登录。
            if (!dbUser) {
                const cookieStore = await cookies();
                cookieStore.delete(SESSION_COOKIE);
                const guestVal = cookieStore.get(GUEST_COOKIE)?.value;
                const isGuest = !!guestVal && (guestVal.startsWith('g_') || guestVal === '1');
                return {
                    isLogin: false as const,
                    isGuest,
                    sessionInvalidated: true as const,
                };
            }
            return {
                isLogin: true as const,
                isGuest: false as const,
                user: { nickname: ctx.session.nickname, username: dbUser.username ?? '' },
            };
        }

        return {
            isLogin: false as const,
            isGuest: ctx.isGuest,
        };
    }),
});

