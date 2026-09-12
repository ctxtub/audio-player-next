/**
 * Library (StoryWork) Mutations
 *
 * M3-05 统一列表生命周期变更模块：
 * 统一管理乐观缓存补丁 (optimistic cache patch)、局部逆向回滚 (journal inverse patch)、
 * 服务端 DTO 对齐 (server reconciliation) 与查询失效 (invalidation)。
 *
 * 核心缓存不变性约束 (Cache Invariants)：
 * 1. 允许 patch / remove 当前各页中已加载的真实 item；
 * 2. 严禁凭客户端猜测将 item 插入/追加到另一个无限分页列表（保护 opaque cursor 核心）；
 * 3. 严格保持各页 nextCursor、hasMore 及 data.pageParams 完整保真；
 * 4. 严禁引入全局客户端持久 store，纯粹基于 React Query 与 Context 状态驱动。
 */

import { useCallback, useContext } from 'react';
import {
  QueryClientContext,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import {
  libraryClient,
  type LibraryListOutput,
  type LibraryView,
  type StoryWorkDetailDTO,
  type StoryWorkSummaryDTO,
  type LibraryDeletePermanentlyOutput,
} from '@/lib/client/library';
import { libraryKeys } from '@/lib/client/libraryQueries';
import { useLibraryUndo } from '@/components/Library/LibraryUndoProvider';

/**
 * 从 InfiniteData 的各页 items 中移除指定 ID 的作品。
 * 严格保持各页 nextCursor、hasMore 及 data.pageParams 绝对不变。
 */
export function removeItemFromInfiniteData(
  data: InfiniteData<LibraryListOutput, string | undefined>,
  id: number
): InfiniteData<LibraryListOutput, string | undefined> {
  let changed = false;
  const newPages = data.pages.map((page) => {
    const filteredItems = page.items.filter((item) => item.id !== id);
    if (filteredItems.length !== page.items.length) {
      changed = true;
    }
    return {
      ...page,
      items: filteredItems,
    };
  });

  if (!changed) {
    return data;
  }

  return {
    ...data,
    pages: newPages,
    pageParams: [...data.pageParams],
  };
}

/**
 * 在 InfiniteData 中更新指定 ID 作品的收藏状态。
 * 如果处于 favorites 视图且 favoritedAt 为 null，则将该项从当前已加载列表中移除。
 * 严格禁止向另一个无限列表追加未存在项（保护 opaque cursor 契约）。
 */
export function patchItemFavoriteInInfiniteData(
  data: InfiniteData<LibraryListOutput, string | undefined>,
  id: number,
  favoritedAt: string | null,
  isFavoritesView: boolean = false
): InfiniteData<LibraryListOutput, string | undefined> {
  // 如果在 favorites 视图下被取消收藏，则从列表中移除
  if (isFavoritesView && !favoritedAt) {
    return removeItemFromInfiniteData(data, id);
  }

  let changed = false;
  const newPages = data.pages.map((page) => {
    let pageChanged = false;
    const newItems = page.items.map((item) => {
      if (item.id === id) {
        pageChanged = true;
        changed = true;
        return {
          ...item,
          favoritedAt,
          updatedAt: new Date().toISOString(),
        };
      }
      return item;
    });

    if (!pageChanged) {
      return page;
    }

    return {
      ...page,
      items: newItems,
    };
  });

  if (!changed) {
    return data;
  }

  return {
    ...data,
    pages: newPages,
    pageParams: [...data.pageParams],
  };
}

/**
 * 在 InfiniteData 中用服务端最新返回的 DTO 对齐已存在项。
 * 严格只更新已存在的项，绝不向列表 append 新项。
 */
export function reconcileItemInInfiniteData(
  data: InfiniteData<LibraryListOutput, string | undefined>,
  dto: StoryWorkDetailDTO | StoryWorkSummaryDTO
): InfiniteData<LibraryListOutput, string | undefined> {
  let changed = false;
  const newPages = data.pages.map((page) => {
    let pageChanged = false;
    const newItems = page.items.map((item) => {
      if (item.id === dto.id) {
        pageChanged = true;
        changed = true;
        return {
          ...item,
          title: dto.title,
          excerpt: dto.excerpt,
          voiceId: dto.voiceId,
          contentHash: dto.contentHash,
          favoritedAt: dto.favoritedAt,
          deletedAt: dto.deletedAt,
          createdAt: dto.createdAt,
          updatedAt: dto.updatedAt,
          audio: dto.audio,
        };
      }
      return item;
    });

    if (!pageChanged) {
      return page;
    }

    return {
      ...page,
      items: newItems,
    };
  });

  if (!changed) {
    return data;
  }

  return {
    ...data,
    pages: newPages,
    pageParams: [...data.pageParams],
  };
}

// ==========================================
// View-aware 变更规划与局部回滚日志系统 (Journal-based Inverse Patch)
// ==========================================

export type ListMutationAction =
  | { type: 'patch_favorite'; favoritedAt: string | null }
  | { type: 'remove' }
  | { type: 'none' };

/**
 * 根据 queryKey 自身声明的 view 决定对该 list query 应用何种变更（按视图隔离）：
 * - Favorite=true：active→patch existing；favorites→patch existing only（绝不 append）；trash→untouched
 * - Favorite=false：active→patch favoritedAt=null；favorites→remove existing；trash→untouched
 * - MoveToTrash：active/favorites→remove existing；trash→untouched
 * - Restore：trash→remove existing；active/favorites→untouched
 */
export function determineListMutationAction(
  view: LibraryView,
  operation:
    | { kind: 'favorite'; favorite: boolean; favoritedAt: string | null }
    | { kind: 'trash' }
    | { kind: 'restore' }
): ListMutationAction {
  if (operation.kind === 'trash') {
    if (view === 'active' || view === 'favorites') {
      return { type: 'remove' };
    }
    return { type: 'none' };
  }

  if (operation.kind === 'restore') {
    if (view === 'trash') {
      return { type: 'remove' };
    }
    return { type: 'none' };
  }

  if (operation.kind === 'favorite') {
    if (view === 'trash') {
      return { type: 'none' };
    }
    if (operation.favorite) {
      return { type: 'patch_favorite', favoritedAt: operation.favoritedAt };
    } else {
      if (view === 'favorites') {
        return { type: 'remove' };
      }
      return { type: 'patch_favorite', favoritedAt: null };
    }
  }

  return { type: 'none' };
}

/**
 * M2 冻结作品列表稳定排序比较器 (Deterministic Stable Sort Comparator)
 * - active / favorites: createdAt DESC, id DESC
 * - trash: deletedAt DESC, id DESC
 */
export function compareStoryWorkItems(
  a: StoryWorkSummaryDTO,
  b: StoryWorkSummaryDTO,
  view: LibraryView
): number {
  if (view === 'trash') {
    const timeA = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
    const timeB = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
    if (timeA !== timeB) {
      return timeB - timeA;
    }
    return b.id - a.id;
  }

  const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (timeA !== timeB) {
    return timeB - timeA;
  }
  return b.id - a.id;
}

export interface MutationJournalEntry {
  queryKey: readonly unknown[];
  view: LibraryView;
  pageIndex: number;
  itemIndex: number;
  type: 'removed' | 'patched';
  originalItem: StoryWorkSummaryDTO;
}

export type MutationJournal = MutationJournalEntry[];

/**
 * 应用 view-aware 乐观更新并生成局部逆向回滚补丁日志 (Journal)：
 * - 绝不整份覆盖 snapshot；
 * - 仅记录并修改命中 targetId 的具体页面与位置；
 * - 绝对保持 nextCursor, hasMore, pageParams 原样不变。
 */
export function applyOptimisticMutationToQueries(
  queryClient: QueryClient,
  targetId: number,
  operation:
    | { kind: 'favorite'; favorite: boolean; favoritedAt: string | null }
    | { kind: 'trash' }
    | { kind: 'restore' }
): MutationJournal {
  const journal: MutationJournal = [];
  const listQueries = queryClient.getQueriesData<
    InfiniteData<LibraryListOutput, string | undefined>
  >({ queryKey: libraryKeys.lists() });

  for (const [queryKey, oldData] of listQueries) {
    if (!oldData || !oldData.pages || oldData.pages.length === 0) {
      continue;
    }

    // 从每个 query key 自身读取对应的视图契约 ['library','list',{view,query}]
    const filter = queryKey[2] as { view?: LibraryView; query?: string } | undefined;
    const view: LibraryView = filter?.view ?? 'active';

    const action = determineListMutationAction(view, operation);
    if (action.type === 'none') {
      continue;
    }

    let queryChanged = false;
    const newPages = oldData.pages.map((page, pageIndex) => {
      const itemIndex = page.items.findIndex((item) => item.id === targetId);
      if (itemIndex === -1) {
        return page;
      }

      queryChanged = true;
      const originalItem = { ...page.items[itemIndex] };

      if (action.type === 'remove') {
        journal.push({
          queryKey,
          view,
          pageIndex,
          itemIndex,
          type: 'removed',
          originalItem,
        });

        return {
          ...page,
          items: page.items.filter((item) => item.id !== targetId),
        };
      }

      if (action.type === 'patch_favorite') {
        journal.push({
          queryKey,
          view,
          pageIndex,
          itemIndex,
          type: 'patched',
          originalItem,
        });

        const newItems = [...page.items];
        newItems[itemIndex] = {
          ...originalItem,
          favoritedAt: action.favoritedAt,
          updatedAt: new Date().toISOString(),
        };

        return {
          ...page,
          items: newItems,
        };
      }

      return page;
    });

    if (queryChanged) {
      queryClient.setQueryData(queryKey, {
        ...oldData,
        pages: newPages,
        pageParams: [...oldData.pageParams],
      });
    }
  }

  return journal;
}

/**
 * 执行局部逆向回滚补丁 (Mutation-local Inverse Patch)：
 * - 仅恢复被本 mutation 修改过的特定 item；
 * - 恢复 removed 项时基于 M2 冻结比较器（createdAt/deletedAt DESC, id DESC）执行稳定排序；
 * - 绝不覆盖 mutation 期间并发产生的其他项变更；
 * - 绝不改动 pageParams / nextCursor / hasMore。
 */
export function rollbackMutationJournal(
  queryClient: QueryClient,
  journal: MutationJournal
): void {
  const entriesByQuery = new Map<
    string,
    { queryKey: readonly unknown[]; entries: MutationJournalEntry[] }
  >();

  for (const entry of journal) {
    const keyString = JSON.stringify(entry.queryKey);
    let group = entriesByQuery.get(keyString);
    if (!group) {
      group = { queryKey: entry.queryKey, entries: [] };
      entriesByQuery.set(keyString, group);
    }
    group.entries.push(entry);
  }

  for (const { queryKey, entries } of entriesByQuery.values()) {
    const currentData = queryClient.getQueryData<
      InfiniteData<LibraryListOutput, string | undefined>
    >(queryKey);

    if (!currentData || !currentData.pages) {
      continue;
    }

    let queryChanged = false;
    const newPages = currentData.pages.map((page, pageIndex) => {
      const pageEntries = entries.filter((e) => e.pageIndex === pageIndex);
      if (pageEntries.length === 0) {
        return page;
      }

      queryChanged = true;
      const newItems = [...page.items];
      let hasRestoredRemoved = false;

      for (const entry of pageEntries) {
        if (entry.type === 'removed') {
          const existingIdx = newItems.findIndex((it) => it.id === entry.originalItem.id);
          if (existingIdx === -1) {
            newItems.push(entry.originalItem);
            hasRestoredRemoved = true;
          }
        } else if (entry.type === 'patched') {
          const existingIdx = newItems.findIndex((it) => it.id === entry.originalItem.id);
          if (existingIdx !== -1) {
            newItems[existingIdx] = {
              ...newItems[existingIdx],
              favoritedAt: entry.originalItem.favoritedAt,
              updatedAt: entry.originalItem.updatedAt,
            };
          }
        }
      }

      if (hasRestoredRemoved) {
        const view = pageEntries[0]?.view ?? 'active';
        newItems.sort((a, b) => compareStoryWorkItems(a, b, view));
      }

      return {
        ...page,
        items: newItems,
      };
    });

    if (queryChanged) {
      queryClient.setQueryData(queryKey, {
        ...currentData,
        pages: newPages,
        pageParams: [...currentData.pageParams],
      });
    }
  }
}

// ==========================================
// 核心变更算子 (Functional Mutation Operators)
// ==========================================

export interface ToggleFavoriteOptions {
  id: number;
  favorite: boolean;
}

/**
 * 收藏 / 取消收藏切换：
 * - 采用 view-aware 变更规划与局部回滚机制；
 * - 失败：仅对受影响的特定 item 进行逆向局部回滚，绝不覆盖整份缓存；
 * - 成功：reconcile 服务端 DTO 并统一 invalidate。
 */
export async function mutateToggleFavorite(
  queryClient: QueryClient,
  options: ToggleFavoriteOptions
): Promise<StoryWorkDetailDTO> {
  const { id, favorite } = options;

  // 1. 取消在途列表与详情查询
  await queryClient.cancelQueries({ queryKey: libraryKeys.lists() });
  await queryClient.cancelQueries({ queryKey: libraryKeys.detail(id) });

  // 2. 截取详情快照（单个对象安全回滚）
  const previousDetail = queryClient.getQueryData<StoryWorkDetailDTO>(
    libraryKeys.detail(id)
  );

  // 3. 应用 view-aware 乐观更新并生成局部日志
  const optimisticFavoritedAt = favorite ? new Date().toISOString() : null;
  const journal = applyOptimisticMutationToQueries(queryClient, id, {
    kind: 'favorite',
    favorite,
    favoritedAt: optimisticFavoritedAt,
  });

  if (previousDetail) {
    queryClient.setQueryData<StoryWorkDetailDTO>(libraryKeys.detail(id), {
      ...previousDetail,
      favoritedAt: optimisticFavoritedAt,
    });
  }

  // 4. 发起 RPC
  try {
    const updated = await libraryClient.setFavorite({ id, favorite });

    // onSuccess: 服务端 DTO 对齐已存在项
    const listQueries = queryClient.getQueriesData<
      InfiniteData<LibraryListOutput, string | undefined>
    >({ queryKey: libraryKeys.lists() });

    for (const [queryKey, oldData] of listQueries) {
      if (oldData) {
        queryClient.setQueryData(queryKey, reconcileItemInInfiniteData(oldData, updated));
      }
    }
    queryClient.setQueryData<StoryWorkDetailDTO>(libraryKeys.detail(id), updated);

    return updated;
  } catch (error) {
    // onError: 执行局部逆向回滚
    rollbackMutationJournal(queryClient, journal);
    if (previousDetail !== undefined) {
      queryClient.setQueryData(libraryKeys.detail(id), previousDetail);
    }
    throw error;
  } finally {
    // onSettled: 失效相关列表与详情缓存
    await queryClient.invalidateQueries({ queryKey: libraryKeys.lists() });
    await queryClient.invalidateQueries({ queryKey: libraryKeys.detail(id) });
  }
}

export interface MoveToTrashOptions {
  id: number;
  workTitle?: string;
  onUndoRegistered?: (session: {
    workId: number;
    workTitle: string;
    movePromise: Promise<StoryWorkDetailDTO>;
  }) => number | void;
  onMoveFailed?: (error: unknown, token?: number) => void;
}

/**
 * 移入回收站：
 * - 采用 view-aware 变更规划与局部回滚机制；
 * - 注册 Undo 句柄并捕获 token，失败时 token-aware 清理；
 * - 失败时执行局部逆向回滚，绝不冲掉并发的其他 item 操作。
 */
export async function mutateMoveToTrash(
  queryClient: QueryClient,
  options: MoveToTrashOptions
): Promise<StoryWorkDetailDTO> {
  const { id, workTitle = '故事作品', onUndoRegistered, onMoveFailed } = options;

  // 1. 取消在途列表与详情查询
  await queryClient.cancelQueries({ queryKey: libraryKeys.lists() });
  await queryClient.cancelQueries({ queryKey: libraryKeys.detail(id) });

  // 2. 截取详情快照
  const previousDetail = queryClient.getQueryData<StoryWorkDetailDTO>(
    libraryKeys.detail(id)
  );

  // 3. 应用 view-aware 乐观更新并生成局部日志
  const journal = applyOptimisticMutationToQueries(queryClient, id, {
    kind: 'trash',
  });

  // 4. 发起 RPC
  const movePromise = libraryClient.moveToTrash({ id });

  // 5. 注册 Undo 句柄并保存 token
  let registeredToken: number | undefined;
  if (onUndoRegistered) {
    const res = onUndoRegistered({
      workId: id,
      workTitle,
      movePromise,
    });
    if (typeof res === 'number') {
      registeredToken = res;
    }
  }

  try {
    const result = await movePromise;
    // 成功后失效受影响列表与详情
    await queryClient.invalidateQueries({ queryKey: libraryKeys.lists() });
    await queryClient.invalidateQueries({ queryKey: libraryKeys.detail(id) });
    return result;
  } catch (error) {
    // 局部逆向回滚
    rollbackMutationJournal(queryClient, journal);
    if (previousDetail !== undefined) {
      queryClient.setQueryData(libraryKeys.detail(id), previousDetail);
    }
    // 携带 token 通知失败，防止清除新 session
    onMoveFailed?.(error, registeredToken);
    throw error;
  }
}

export interface RestoreOptions {
  id: number;
}

/**
 * 从回收站恢复：
 * - 采用 view-aware 变更规划与局部回滚机制（与 Move/Favorite 复用同一套局部回滚算子）；
 * - 绝不在本地向 active/favorites 列表 append；
 * - 失败时局部回滚。
 */
export async function mutateRestore(
  queryClient: QueryClient,
  options: RestoreOptions
): Promise<StoryWorkDetailDTO> {
  const { id } = options;

  // 1. 取消在途列表与详情查询
  await queryClient.cancelQueries({ queryKey: libraryKeys.lists() });
  await queryClient.cancelQueries({ queryKey: libraryKeys.detail(id) });

  // 2. 截取详情快照
  const previousDetail = queryClient.getQueryData<StoryWorkDetailDTO>(
    libraryKeys.detail(id)
  );

  // 3. 应用 view-aware 乐观更新并生成局部日志
  const journal = applyOptimisticMutationToQueries(queryClient, id, {
    kind: 'restore',
  });

  // 4. 发起 RPC
  try {
    const result = await libraryClient.restore({ id });
    await queryClient.invalidateQueries({ queryKey: libraryKeys.lists() });
    await queryClient.invalidateQueries({ queryKey: libraryKeys.detail(id) });
    return result;
  } catch (error) {
    // 局部逆向回滚
    rollbackMutationJournal(queryClient, journal);
    if (previousDetail !== undefined) {
      queryClient.setQueryData(libraryKeys.detail(id), previousDetail);
    }
    throw error;
  }
}

export interface DeletePermanentlyOptions {
  id: number;
  confirmed: boolean;
}

/**
 * 永久删除：
 * - 必须二次确认（未确认前严格零 RPC）；
 * - 悲观执行（confirm → request → success 后 remove + invalidate）；
 * - 无 Undo；
 * - 不做危险 optimistic 删除。
 */
export async function mutateDeletePermanently(
  queryClient: QueryClient,
  options: DeletePermanentlyOptions
): Promise<LibraryDeletePermanentlyOutput> {
  const { id, confirmed } = options;

  // 未确认时严格执行零 RPC
  if (!confirmed) {
    throw new Error('永久删除操作必须经过二次确认');
  }

  // 悲观删除：先发 RPC，成功后再移除缓存与失效
  const result = await libraryClient.deletePermanently({ id });

  // 成功后从已加载列表中移除
  const listQueries = queryClient.getQueriesData<
    InfiniteData<LibraryListOutput, string | undefined>
  >({ queryKey: libraryKeys.lists() });

  for (const [queryKey, oldData] of listQueries) {
    if (oldData) {
      queryClient.setQueryData(queryKey, removeItemFromInfiniteData(oldData, id));
    }
  }

  await queryClient.invalidateQueries({ queryKey: libraryKeys.lists() });
  queryClient.removeQueries({ queryKey: libraryKeys.detail(id) });

  return result;
}

// ==========================================
// React Hooks 包装
// ==========================================

export interface LibraryMutations {
  toggleFavorite: (options: ToggleFavoriteOptions) => Promise<StoryWorkDetailDTO>;
  moveToTrash: (options: { id: number; title: string }) => Promise<StoryWorkDetailDTO>;
  restore: (options: RestoreOptions) => Promise<StoryWorkDetailDTO>;
  deletePermanently: (
    options: DeletePermanentlyOptions
  ) => Promise<LibraryDeletePermanentlyOutput>;
}

/**
 * 故事库生命周期操作 Hook
 */
export function useLibraryMutations(): LibraryMutations {
  const queryClient = useContext(QueryClientContext);
  if (!queryClient) {
    throw new Error('No QueryClient set, use QueryClientProvider to set one');
  }
  const undo = useLibraryUndo();

  const toggleFavorite = useCallback(
    (options: ToggleFavoriteOptions) => mutateToggleFavorite(queryClient, options),
    [queryClient]
  );

  const moveToTrash = useCallback(
    (options: { id: number; title: string }) => {
      let registeredToken: number | undefined;
      return mutateMoveToTrash(queryClient, {
        id: options.id,
        workTitle: options.title,
        onUndoRegistered: (session) => {
          registeredToken = undo.showUndo({
            workId: session.workId,
            workTitle: session.workTitle,
            movePromise: session.movePromise,
          });
          return registeredToken;
        },
        onMoveFailed: (_error, token) => {
          const tokenToDismiss = token ?? registeredToken;
          if (typeof tokenToDismiss === 'number') {
            undo.dismissUndo(tokenToDismiss);
          }
        },
      });
    },
    [queryClient, undo]
  );

  const restore = useCallback(
    (options: RestoreOptions) => mutateRestore(queryClient, options),
    [queryClient]
  );

  const deletePermanently = useCallback(
    (options: DeletePermanentlyOptions) =>
      mutateDeletePermanently(queryClient, options),
    [queryClient]
  );

  return {
    toggleFavorite,
    moveToTrash,
    restore,
    deletePermanently,
  };
}

/**
 * 安全版本 Hook（在无 QueryClientProvider 时返回 null 兜底，绝不在 hook 内部使用 try/catch 违背 rules-of-hooks）
 */
export function useLibraryMutationsSafe(): LibraryMutations | null {
  const queryClient = useContext(QueryClientContext);
  const undo = useLibraryUndo();

  const toggleFavorite = useCallback(
    (options: ToggleFavoriteOptions) => {
      if (!queryClient) throw new Error('QueryClient is required for library mutations');
      return mutateToggleFavorite(queryClient, options);
    },
    [queryClient]
  );

  const moveToTrash = useCallback(
    (options: { id: number; title: string }) => {
      if (!queryClient) throw new Error('QueryClient is required for library mutations');
      let registeredToken: number | undefined;
      return mutateMoveToTrash(queryClient, {
        id: options.id,
        workTitle: options.title,
        onUndoRegistered: (session) => {
          registeredToken = undo.showUndo({
            workId: session.workId,
            workTitle: session.workTitle,
            movePromise: session.movePromise,
          });
          return registeredToken;
        },
        onMoveFailed: (_error, token) => {
          const tokenToDismiss = token ?? registeredToken;
          if (typeof tokenToDismiss === 'number') {
            undo.dismissUndo(tokenToDismiss);
          }
        },
      });
    },
    [queryClient, undo]
  );

  const restore = useCallback(
    (options: RestoreOptions) => {
      if (!queryClient) throw new Error('QueryClient is required for library mutations');
      return mutateRestore(queryClient, options);
    },
    [queryClient]
  );

  const deletePermanently = useCallback(
    (options: DeletePermanentlyOptions) => {
      if (!queryClient) throw new Error('QueryClient is required for library mutations');
      return mutateDeletePermanently(queryClient, options);
    },
    [queryClient]
  );

  if (!queryClient) {
    return null;
  }

  return {
    toggleFavorite,
    moveToTrash,
    restore,
    deletePermanently,
  };
}
