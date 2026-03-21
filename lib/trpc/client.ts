/**
 * tRPC 客户端配置
 *
 * 提供类型安全的 tRPC 客户端实例供浏览器端使用。
 */

import {
    createTRPCClient,
    httpBatchLink,
    httpBatchStreamLink,
    splitLink,
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
 * 需要流式传输的端点路径。
 * 流式端点使用 httpBatchStreamLink，其余使用 httpBatchLink。
 * 注意：流式响应无法写入 Set-Cookie 头，因此需要操作 Cookie 的端点不应使用流式传输。
 */
const STREAMING_PATHS = new Set(['agent.interact']);

/**
 * tRPC 类型安全客户端。
 *
 * 使用 splitLink 将流式端点（agent.interact）和非流式端点分离：
 * - 流式端点 → httpBatchStreamLink（支持 async generator）
 * - 非流式端点 → httpBatchLink（支持 Set-Cookie 等响应头操作）
 */
export const trpc = createTRPCClient<AppRouter>({
    links: [
        splitLink({
            condition: (op) => STREAMING_PATHS.has(op.path),
            true: httpBatchStreamLink({
                url: `${getBaseUrl()}/api/trpc`,
                transformer: superjson,
            }),
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
