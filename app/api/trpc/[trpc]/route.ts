/**
 * tRPC HTTP Handler
 *
 * App Router 下的 tRPC 请求处理入口。
 */

import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { appRouter } from '@/lib/trpc/routers';
import { createContext } from '@/lib/trpc/context';

/**
 * 处理 tRPC 请求。
 */
const handler = (req: Request) =>
    fetchRequestHandler({
        endpoint: '/api/trpc',
        req,
        router: appRouter,
        createContext,
    });

export { handler as GET, handler as POST };
