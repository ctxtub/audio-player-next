/**
 * Library (StoryWork) Mutations
 *
 * M3-05 统一列表生命周期变更模块：
 * 统一管理乐观缓存补丁 (optimistic cache patch)、异常回滚 (snapshot rollback)、
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
// 核心变更算子 (Functional Mutation Operators)
// ==========================================

export interface ToggleFavoriteOptions {
  id: number;
  favorite: boolean;
  currentView?: LibraryView;
}

/**
 * 收藏 / 取消收藏切换：
 * - 乐观：取消在途查询 → 截取快照 → patch 当前 item favoritedAt（若在 favorites 视图且取消收藏则从列表移除）
 * - 收藏 active item 时严格禁止直接 append 到已有 favorites 缓存；
 * - 失败：快照回滚；
 * - 成功：reconcile 服务端 DTO；
 * - 完结：invalidate 相关列表与详情。
 */
export async function mutateToggleFavorite(
  queryClient: QueryClient,
  options: ToggleFavoriteOptions
): Promise<StoryWorkDetailDTO> {
  const { id, favorite, currentView } = options;

  // 1. 取消在途列表与详情查询
  await queryClient.cancelQueries({ queryKey: libraryKeys.lists() });
  await queryClient.cancelQueries({ queryKey: libraryKeys.detail(id) });

  // 2. 截取快照
  const previousLists = queryClient.getQueriesData<
    InfiniteData<LibraryListOutput, string | undefined>
  >({ queryKey: libraryKeys.lists() });
  const previousDetail = queryClient.getQueryData<StoryWorkDetailDTO>(
    libraryKeys.detail(id)
  );

  // 3. 乐观更新
  const optimisticFavoritedAt = favorite ? new Date().toISOString() : null;

  queryClient.setQueriesData<InfiniteData<LibraryListOutput, string | undefined>>(
    { queryKey: libraryKeys.lists() },
    (oldData) => {
      if (!oldData) return oldData;
      return patchItemFavoriteInInfiniteData(
        oldData,
        id,
        optimisticFavoritedAt,
        currentView === 'favorites'
      );
    }
  );

  if (previousDetail) {
    queryClient.setQueryData<StoryWorkDetailDTO>(libraryKeys.detail(id), {
      ...previousDetail,
      favoritedAt: optimisticFavoritedAt,
    });
  }

  // 4. 发起 RPC
  try {
    const updated = await libraryClient.setFavorite({ id, favorite });

    // onSuccess: 服务端 DTO 对齐
    queryClient.setQueriesData<InfiniteData<LibraryListOutput, string | undefined>>(
      { queryKey: libraryKeys.lists() },
      (oldData) => {
        if (!oldData) return oldData;
        return reconcileItemInInfiniteData(oldData, updated);
      }
    );
    queryClient.setQueryData<StoryWorkDetailDTO>(libraryKeys.detail(id), updated);

    return updated;
  } catch (error) {
    // onError: 回滚快照
    for (const [queryKey, oldData] of previousLists) {
      queryClient.setQueryData(queryKey, oldData);
    }
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
  }) => void;
  onMoveFailed?: (error: unknown) => void;
}

/**
 * 移入回收站：
 * - 无二次确认；
 * - 乐观：从 active/favorites 已加载缓存移除（绝不凭猜测追加到 trash 列表）；
 * - 注册 Undo 句柄并提供在途 movePromise，保障 move pending 时点击 Undo 严格串行；
 * - 成功：展示 Undo；invalidate 受影响列表与详情；
 * - 失败：快照回滚；不展示 Undo；
 * - Undo 成功后不要 splice 回 active，invalidate active/favorites/trash。
 */
export async function mutateMoveToTrash(
  queryClient: QueryClient,
  options: MoveToTrashOptions
): Promise<StoryWorkDetailDTO> {
  const { id, workTitle = '故事作品', onUndoRegistered, onMoveFailed } = options;

  // 1. 取消在途列表与详情查询
  await queryClient.cancelQueries({ queryKey: libraryKeys.lists() });
  await queryClient.cancelQueries({ queryKey: libraryKeys.detail(id) });

  // 2. 截取快照
  const previousLists = queryClient.getQueriesData<
    InfiniteData<LibraryListOutput, string | undefined>
  >({ queryKey: libraryKeys.lists() });
  const previousDetail = queryClient.getQueryData<StoryWorkDetailDTO>(
    libraryKeys.detail(id)
  );

  // 3. 乐观从已加载列表移除（保护 opaque cursor，绝不插入 trash 列表）
  queryClient.setQueriesData<InfiniteData<LibraryListOutput, string | undefined>>(
    { queryKey: libraryKeys.lists() },
    (oldData) => {
      if (!oldData) return oldData;
      return removeItemFromInfiniteData(oldData, id);
    }
  );

  // 4. 发起 RPC
  const movePromise = libraryClient.moveToTrash({ id });

  // 5. 注册 Undo 句柄（提供在途 movePromise 用于后续串行保证）
  if (onUndoRegistered) {
    onUndoRegistered({
      workId: id,
      workTitle,
      movePromise,
    });
  }

  try {
    const result = await movePromise;
    // 成功后失效受影响列表（active, favorites, trash）与详情
    await queryClient.invalidateQueries({ queryKey: libraryKeys.lists() });
    await queryClient.invalidateQueries({ queryKey: libraryKeys.detail(id) });
    return result;
  } catch (error) {
    // 失败回滚
    for (const [queryKey, oldData] of previousLists) {
      queryClient.setQueryData(queryKey, oldData);
    }
    if (previousDetail !== undefined) {
      queryClient.setQueryData(libraryKeys.detail(id), previousDetail);
    }
    onMoveFailed?.(error);
    throw error;
  }
}

export interface RestoreOptions {
  id: number;
}

/**
 * 从回收站恢复：
 * - 无确认；
 * - 乐观：从 trash 列表中移除；
 * - 绝不在本地向 active 列表 append；
 * - 成功：invalidate active/favorites/trash；
 * - 失败：快照回滚。
 */
export async function mutateRestore(
  queryClient: QueryClient,
  options: RestoreOptions
): Promise<StoryWorkDetailDTO> {
  const { id } = options;

  // 1. 取消在途列表与详情查询
  await queryClient.cancelQueries({ queryKey: libraryKeys.lists() });
  await queryClient.cancelQueries({ queryKey: libraryKeys.detail(id) });

  // 2. 截取快照
  const previousLists = queryClient.getQueriesData<
    InfiniteData<LibraryListOutput, string | undefined>
  >({ queryKey: libraryKeys.lists() });
  const previousDetail = queryClient.getQueryData<StoryWorkDetailDTO>(
    libraryKeys.detail(id)
  );

  // 3. 乐观从回收站列表移除（绝不本地 append 到 active 列表！）
  queryClient.setQueriesData<InfiniteData<LibraryListOutput, string | undefined>>(
    { queryKey: libraryKeys.lists() },
    (oldData) => {
      if (!oldData) return oldData;
      return removeItemFromInfiniteData(oldData, id);
    }
  );

  // 4. 发起 RPC
  try {
    const result = await libraryClient.restore({ id });
    // 成功后失效 active/favorites/trash 与详情
    await queryClient.invalidateQueries({ queryKey: libraryKeys.lists() });
    await queryClient.invalidateQueries({ queryKey: libraryKeys.detail(id) });
    return result;
  } catch (error) {
    // 失败回滚
    for (const [queryKey, oldData] of previousLists) {
      queryClient.setQueryData(queryKey, oldData);
    }
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
  queryClient.setQueriesData<InfiniteData<LibraryListOutput, string | undefined>>(
    { queryKey: libraryKeys.lists() },
    (oldData) => {
      if (!oldData) return oldData;
      return removeItemFromInfiniteData(oldData, id);
    }
  );

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
    (options: { id: number; title: string }) =>
      mutateMoveToTrash(queryClient, {
        id: options.id,
        workTitle: options.title,
        onUndoRegistered: (session) => {
          undo.showUndo({
            workId: session.workId,
            workTitle: session.workTitle,
            movePromise: session.movePromise,
          });
        },
        onMoveFailed: () => {
          undo.dismissUndo();
        },
      }),
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
      return mutateMoveToTrash(queryClient, {
        id: options.id,
        workTitle: options.title,
        onUndoRegistered: (session) => {
          undo.showUndo({
            workId: session.workId,
            workTitle: session.workTitle,
            movePromise: session.movePromise,
          });
        },
        onMoveFailed: () => {
          undo.dismissUndo();
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
