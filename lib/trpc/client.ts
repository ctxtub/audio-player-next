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
    type TRPCLink,
} from '@trpc/client';
import { observable } from '@trpc/server/observable';
import superjson from 'superjson';

import type { AppRouter } from './routers';

/**
 * 会话失效守卫 link：捕获非 auth.* 路径的 UNAUTHORIZED（运行中会话失效），
 * 触发统一登出闭环（动态导入 sessionGuard，避免与 authStore 形成静态依赖环）。
 * 置于链首以包裹全部下游 link（流式与非流式）。
 */
const sessionGuardLink: TRPCLink<AppRouter> = () => {
    return ({ next, op }) =>
        observable((observer) => {
            const subscription = next(op).subscribe({
                next: (value) => observer.next(value),
                error: (err) => {
                    if (err.data?.code === 'UNAUTHORIZED' && !op.path.startsWith('auth.')) {
                        void import('@/lib/client/sessionGuard').then((m) =>
                            m.maybeHandleSessionInvalidation()
                        );
                    }
                    observer.error(err);
                },
                complete: () => observer.complete(),
            });
            return () => subscription.unsubscribe();
        });
};

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
        sessionGuardLink,
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
