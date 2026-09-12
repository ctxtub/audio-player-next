import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  libraryClient,
  type LibraryListOutput,
  type LibraryView,
  type StoryWorkDetailDTO,
} from '@/lib/client/library';

/** 故事库默认分页大小（契约固定为 20） */
export const DEFAULT_LIBRARY_LIMIT = 20;

export interface LibraryListFilters {
  view?: LibraryView;
  query?: string;
}

/**
 * Library React Query Keys 规范
 *
 * 核心契约：
 * - all: ['library']
 * - lists: () => ['library', 'list']
 * - list: ({ view, query }) => ['library', 'list', { view, query }]
 * - details: () => ['library', 'detail']
 * - detail: (id) => ['library', 'detail', id]
 *
 * 绝对禁止将 cursor 写入 list query key，cursor 仅作为 useInfiniteQuery 的 pageParam 存在。
 */
export const libraryKeys = {
  all: ['library'] as const,
  lists: () => [...libraryKeys.all, 'list'] as const,
  list: (filters: LibraryListFilters = {}) =>
    [
      ...libraryKeys.lists(),
      {
        view: filters.view ?? 'active',
        query: filters.query,
      },
    ] as const,
  details: () => [...libraryKeys.all, 'detail'] as const,
  detail: (id: number) => [...libraryKeys.details(), id] as const,
};

/**
 * 构造作品列表无限滚动查询选项 (Infinite Query Options)
 */
export function libraryListInfiniteQueryOptions(
  filters: LibraryListFilters = {},
  options?: { limit?: number }
) {
  const view: LibraryView = filters.view ?? 'active';
  const query = filters.query;
  const limit = options?.limit ?? DEFAULT_LIBRARY_LIMIT;

  return infiniteQueryOptions<
    LibraryListOutput,
    Error,
    InfiniteData<LibraryListOutput, string | undefined>,
    ReturnType<typeof libraryKeys.list>,
    string | undefined
  >({
    queryKey: libraryKeys.list({ view, query }),
    queryFn: async ({ pageParam }) => {
      return libraryClient.list({
        view,
        query,
        cursor: pageParam,
        limit,
      });
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => {
      return lastPage.hasMore && lastPage.nextCursor != null
        ? lastPage.nextCursor
        : undefined;
    },
  });
}

/**
 * 构造作品详情查询选项 (Detail Query Options)
 */
export function libraryDetailQueryOptions(id: number) {
  return queryOptions<
    StoryWorkDetailDTO,
    Error,
    StoryWorkDetailDTO,
    ReturnType<typeof libraryKeys.detail>
  >({
    queryKey: libraryKeys.detail(id),
    queryFn: async () => {
      return libraryClient.get({ id });
    },
  });
}

/**
 * 作品列表无限滚动 Hook
 */
export function useLibraryListInfiniteQuery(
  filters: LibraryListFilters = {},
  options?: { limit?: number; enabled?: boolean }
) {
  const queryOpts = libraryListInfiniteQueryOptions(filters, { limit: options?.limit });
  return useInfiniteQuery({
    ...queryOpts,
    enabled: options?.enabled,
  });
}

/**
 * 作品详情查询 Hook
 */
export function useLibraryDetailQuery(
  id: number,
  options?: { enabled?: boolean }
) {
  const queryOpts = libraryDetailQueryOptions(id);
  return useQuery({
    ...queryOpts,
    enabled: options?.enabled ?? (typeof id === 'number' && id > 0),
  });
}
