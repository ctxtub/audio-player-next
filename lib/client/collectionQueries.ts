/**
 * Collection Library React Query 层（）。
 *
 * 镜像 libraryQueries 的 key 规范与 cursor 契约：
 * - cursor 只作 pageParam，绝不写入 query key；
 * - limit 冻结为 DEFAULT_LIBRARY_LIMIT（20），与服务端默认一致。
 */

import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  getCollection,
  listCollections,
  type CollectionListOutput,
  type StoryCollectionDetailDTO,
} from '@/lib/client/collection';
import type { CollectionView } from '@/lib/trpc/schemas/collection';
import { DEFAULT_LIBRARY_LIMIT } from '@/lib/client/libraryQueries';

export interface CollectionListFilters {
  view?: CollectionView;
  query?: string;
}

/**
 * Collection React Query Keys：
 * - all: ['collections']
 * - list: ({ view, query }) => ['collections', 'list', { view, query }]
 * - detail: (id) => ['collections', 'detail', id]
 */
export const collectionKeys = {
  all: ['collections'] as const,
  lists: () => [...collectionKeys.all, 'list'] as const,
  list: (filters: CollectionListFilters = {}) =>
    [
      ...collectionKeys.lists(),
      {
        view: filters.view ?? 'active',
        query: filters.query,
      },
    ] as const,
  details: () => [...collectionKeys.all, 'detail'] as const,
  detail: (id: string) => [...collectionKeys.details(), id] as const,
};

export function collectionListInfiniteQueryOptions(
  filters: CollectionListFilters = {}
) {
  const view: CollectionView = filters.view ?? 'active';
  const query = filters.query;

  return infiniteQueryOptions<
    CollectionListOutput,
    Error,
    InfiniteData<CollectionListOutput, string | undefined>,
    ReturnType<typeof collectionKeys.list>,
    string | undefined
  >({
    queryKey: collectionKeys.list({ view, query }),
    queryFn: async ({ pageParam }) => {
      return listCollections({
        view,
        query,
        cursor: pageParam,
        limit: DEFAULT_LIBRARY_LIMIT,
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

export function collectionDetailQueryOptions(id: string) {
  return queryOptions<
    StoryCollectionDetailDTO,
    Error,
    StoryCollectionDetailDTO,
    ReturnType<typeof collectionKeys.detail>
  >({
    queryKey: collectionKeys.detail(id),
    queryFn: async () => {
      return getCollection(id);
    },
  });
}

export function useCollectionListInfiniteQuery(
  filters: CollectionListFilters = {},
  options?: { enabled?: boolean }
) {
  const queryOpts = collectionListInfiniteQueryOptions(filters);
  return useInfiniteQuery({
    ...queryOpts,
    enabled: options?.enabled,
  });
}

export function useCollectionDetailQuery(
  id: string,
  options?: { enabled?: boolean }
) {
  const queryOpts = collectionDetailQueryOptions(id);
  return useQuery({
    ...queryOpts,
    enabled: options?.enabled ?? (typeof id === 'string' && id.length > 0),
  });
}
