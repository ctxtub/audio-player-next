import { QueryClient, QueryClientConfig } from '@tanstack/react-query';

export interface IdentityFingerprintInput {
  initialized: boolean;
  isLogin: boolean;
  isGuest: boolean;
  username: string;
}

/**
 * 计算身份指纹。
 * 严格仅由 initialized, isLogin, isGuest, username 四个字段组成。
 * 严禁使用 nickname / loading / error 等展示态或过程态字段作为身份信号。
 */
export function computeIdentityFingerprint(input: IdentityFingerprintInput): string {
  return `${input.initialized ? '1' : '0'}:${input.isLogin ? '1' : '0'}:${input.isGuest ? '1' : '0'}:${input.username}`;
}

/**
 * 身份切换时清空整个 QueryClient。
 * 
 * 核心安全机制：
 * 1. 首先调用 cancelQueries()，立即同步标记并取消所有在途查询，中止 fetcher/retryer；
 * 2. 调用 clear()，彻底清空 QueryCache 与 MutationCache；
 * 3. 严禁使用 invalidateQueries()（invalidateQueries 会保留 stale 缓存，导致旧身份数据在短时间内可被同步读取泄漏）。
 */
export function clearQueryClientForIdentityTransition(queryClient: QueryClient): Promise<void> {
  const cancelPromise = queryClient.cancelQueries();
  queryClient.clear();
  return cancelPromise;
}

/**
 * 创建标准 QueryClient 实例。
 */
export function createQueryClient(config?: QueryClientConfig): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        gcTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: false,
      },
      ...config?.defaultOptions,
    },
    ...config,
  });
}

let browserQueryClient: QueryClient | undefined = undefined;

/**
 * 获取或创建 QueryClient 实例（单例模式，客户端复用，服务端按需创建）。
 */
export function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    return createQueryClient();
  }
  if (!browserQueryClient) {
    browserQueryClient = createQueryClient();
  }
  return browserQueryClient;
}
