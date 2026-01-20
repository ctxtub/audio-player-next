/**
 * tRPC 客户端配置
 *
 * 提供类型安全的 tRPC 客户端实例供浏览器端使用。
 */

import {
    createTRPCClient,
    httpBatchLink,
    splitLink,
    httpSubscriptionLink,
} from '@trpc/client';
import superjson from 'superjson';

import type { AppRouter } from './routers';

/**
 * 获取 API 基础 URL。
 */
const getBaseUrl = () => {
    if (typeof window !== 'undefined') {
        // 浏览器环境使用相对路径
        return '';
    }
    // SSR 环境使用绝对路径
    return `http://localhost:${process.env.PORT ?? 3000}`;
};

/**
 * tRPC 类型安全客户端。
 */
export const trpc = createTRPCClient<AppRouter>({
    links: [
        splitLink({
            // 订阅请求使用 SSE 链接
            condition: (op) => op.type === 'subscription',
            true: httpSubscriptionLink({
                url: `${getBaseUrl()}/api/trpc`,
                transformer: superjson,
            }),
            // 其他请求使用批量链接
            false: httpBatchLink({
                url: `${getBaseUrl()}/api/trpc`,
                transformer: superjson,
            }),
        }),
    ],
});

/**
 * 便捷的类型导出。
 */
export type { AppRouter };
