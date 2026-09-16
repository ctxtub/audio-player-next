/**
 * Collection Mutations（）。
 *
 * 集合级重命名/收藏/软删除/恢复/永久删除：
 * - 乐观补丁作用于全部集合列表无限缓存 + 对应详情缓存；
 * - 严禁凭猜测向另一无限列表插入项（opaque cursor 守卫）；
 * - settle 后失效列表与详情，由服务端 DTO 对齐；
 * - moveToTrash 挂接 CollectionUndoProvider 串行撤销会话。
 */

'use client';

import { useCallback } from 'react';
import {
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import {
  deleteCollectionForever,
  renameCollection,
  restoreCollection,
  setCollectionFavorite,
  softDeleteCollection,
  type CollectionListOutput,
  type StoryCollectionDetailDTO,
  type StoryCollectionSummaryDTO,
} from '@/lib/client/collection';
import { collectionKeys } from '@/lib/client/collectionQueries';
import { useCollectionUndo } from '@/components/Library/CollectionUndoProvider';

type CollectionInfinite = InfiniteData<CollectionListOutput, string | undefined>;

function patchSummaryInInfinite(
  data: CollectionInfinite,
  id: string,
  patch: Partial<StoryCollectionSummaryDTO>,
): CollectionInfinite {
  let changed = false;
  const newPages = data.pages.map((page) => {
    let pageChanged = false;
    const newItems = page.items.map((item) => {
      if (item.id === id) {
        pageChanged = true;
        changed = true;
        return { ...item, ...patch };
      }
      return item;
    });
    if (!pageChanged) return page;
    return { ...page, items: newItems };
  });
  if (!changed) return data;
  return { ...data, pages: newPages, pageParams: [...data.pageParams] };
}

function removeFromInfinite(data: CollectionInfinite, id: string): CollectionInfinite {
  let changed = false;
  const newPages = data.pages.map((page) => {
    const filtered = page.items.filter((item) => item.id !== id);
    if (filtered.length !== page.items.length) changed = true;
    return { ...page, items: filtered };
  });
  if (!changed) return data;
  return { ...data, pages: newPages, pageParams: [...data.pageParams] };
}

function snapshotLists(queryClient: QueryClient): Array<[QueryKey, unknown]> {
  const entries = queryClient.getQueriesData<CollectionInfinite>({
    queryKey: collectionKeys.lists(),
  });
  return entries.map(([key, data]) => [key, data]);
}

function restoreSnapshot(
  queryClient: QueryClient,
  snapshot: Array<[QueryKey, unknown]>,
): void {
  for (const [key, data] of snapshot) {
    queryClient.setQueryData<CollectionInfinite | undefined>(key, data as CollectionInfinite);
  }
}

function applyToLists(
  queryClient: QueryClient,
  fn: (data: CollectionInfinite) => CollectionInfinite,
): void {
  const entries = queryClient.getQueriesData<CollectionInfinite>({
    queryKey: collectionKeys.lists(),
  });
  for (const [key, data] of entries) {
    if (data) queryClient.setQueryData(key, fn(data));
  }
}

function patchDetail(
  queryClient: QueryClient,
  id: string,
  patch: Partial<StoryCollectionDetailDTO>,
): void {
  queryClient.setQueryData<StoryCollectionDetailDTO | undefined>(
    collectionKeys.detail(id),
    (prev) => (prev ? { ...prev, ...patch } : prev),
  );
}

async function invalidateCollection(
  queryClient: QueryClient,
  id: string,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: collectionKeys.lists() });
  await queryClient.invalidateQueries({ queryKey: collectionKeys.detail(id) });
}

export interface CollectionMutations {
  rename: (id: string, title: string, prevTitle: string) => Promise<void>;
  toggleFavorite: (id: string, favorite: boolean) => Promise<void>;
  moveToTrash: (id: string, title: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  deleteForever: (id: string) => Promise<void>;
}

export function useCollectionMutations(): CollectionMutations {
  const queryClient = useQueryClient();
  const undo = useCollectionUndo();

  const rename = useCallback<CollectionMutations['rename']>(
    async (id, title, prevTitle) => {
      const next = title.trim();
      if (next.length === 0 || next === prevTitle) return;
      const snapshot = snapshotLists(queryClient);
      const prevDetail = queryClient.getQueryData<StoryCollectionDetailDTO>(
        collectionKeys.detail(id),
      );
      applyToLists(queryClient, (data) =>
        patchSummaryInInfinite(data, id, { title: next }),
      );
      patchDetail(queryClient, id, { title: next });
      try {
        await renameCollection(id, next);
      } catch (err) {
        restoreSnapshot(queryClient, snapshot);
        if (prevDetail) queryClient.setQueryData(collectionKeys.detail(id), prevDetail);
        throw err;
      } finally {
        await invalidateCollection(queryClient, id);
      }
    },
    [queryClient],
  );

  const toggleFavorite = useCallback<CollectionMutations['toggleFavorite']>(
    async (id, favorite) => {
      const snapshot = snapshotLists(queryClient);
      const favoritedAt = favorite ? new Date().toISOString() : null;
      applyToLists(queryClient, (data) => {
        return patchSummaryInInfinite(data, id, { favoritedAt });
      });
      patchDetail(queryClient, id, { favoritedAt });
      // favorites 视图取消收藏 → 从该视图精确移除（禁止插入他视图）。
      const favEntries = queryClient.getQueriesData<CollectionInfinite>({
        queryKey: collectionKeys.list({ view: 'favorites' }),
      });
      if (!favorite) {
        for (const [key, data] of favEntries) {
          if (data) queryClient.setQueryData(key, removeFromInfinite(data, id));
        }
      }
      try {
        await setCollectionFavorite(id, favorite);
      } catch (err) {
        restoreSnapshot(queryClient, snapshot);
        throw err;
      } finally {
        await invalidateCollection(queryClient, id);
      }
    },
    [queryClient],
  );

  const moveToTrash = useCallback<CollectionMutations['moveToTrash']>(
    async (id, title) => {
      const snapshot = snapshotLists(queryClient);
      applyToLists(queryClient, (data) => removeFromInfinite(data, id));
      const movePromise = (async () => {
        try {
          await softDeleteCollection(id);
        } catch (err) {
          restoreSnapshot(queryClient, snapshot);
          throw err;
        } finally {
          await invalidateCollection(queryClient, id);
        }
      })();
      // 挂接串行撤销会话（move 失败时 provider 自动关闭不展示）。
      undo.showUndo({ collectionId: id, collectionTitle: title, movePromise });
      await movePromise;
    },
    [queryClient, undo],
  );

  const restore = useCallback<CollectionMutations['restore']>(
    async (id) => {
      await restoreCollection(id);
      await invalidateCollection(queryClient, id);
    },
    [queryClient],
  );

  const deleteForever = useCallback<CollectionMutations['deleteForever']>(
    async (id) => {
      await deleteCollectionForever(id);
      await invalidateCollection(queryClient, id);
    },
    [queryClient],
  );

  return { rename, toggleFavorite, moveToTrash, restore, deleteForever };
}
