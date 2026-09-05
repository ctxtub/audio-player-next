/**
 * 统一主体定义
 *
 * 表示当前请求的身份主体（已登录用户或具名访客）。
 */

import { TRPCError } from '@trpc/server';
import type { Context } from '@/lib/trpc/context';

export type Subject =
    | { type: 'user'; id: number }
    | { type: 'guest'; id: string };

/**
 * 从 tRPC 上下文中解析身份主体（用户或具名访客）。
 * 未认证主体抛出 UNAUTHORIZED (401)。
 */
export const resolveSubject = (ctx: Context): Subject => {
    if (ctx.session) return { type: 'user', id: ctx.session.userId };
    if (ctx.guestId) return { type: 'guest', id: ctx.guestId };
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '未授权的访问' });
};
