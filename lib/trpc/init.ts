/**
 * tRPC 初始化模块
 *
 * 创建 tRPC 实例，导出 router、procedure 和 caller 工厂。
 */

import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import type { Context } from './context';

/**
 * tRPC 实例，配置 superjson 序列化器支持 Date、Map 等复杂类型。
 */
const t = initTRPC.context<Context>().create({
    transformer: superjson,
});

/**
 * 创建 router 的工厂函数。
 */
export const router = t.router;

/**
 * 公开 procedure，无需认证即可调用。
 */
export const publicProcedure = t.procedure;



/**
 * 中间件：校验用户已登录。
 */
export const authedProcedure = t.procedure.use(async ({ ctx, next }) => {
    if (!ctx.session) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: '请先登录' });
    }
    return next({ ctx: { ...ctx, session: ctx.session } });
});

/**
 * 创建 caller 工厂，用于服务端直接调用与测试。
 */
export const createCallerFactory = t.createCallerFactory;

export { TRPCError };
