'use client';

import React, { useMemo } from 'react';
import { useLibraryFilters } from './useLibraryFilters';
import { useLibraryListInfiniteQuery } from '@/lib/client/libraryQueries';
import {
  composeLibraryItemListViewModel,
  groupStoryWorksByTime,
} from '@/lib/client/libraryViewModel';
import {
  LibraryToolbar,
  LibraryTimeGroup,
  InfiniteScrollSentinel,
  LibraryEmptyState,
  LibraryLoadingSkeleton,
  LibraryErrorState,
} from './components';
import styles from './index.module.scss';

/**
 * 故事库主页列表视图组件（M3-04 列表读取 UI）
 *
 * 核心数据链契约：
 * 1. useLibraryFilters() -> 获得 canonical { view, q } 及 draftQ / 视图操作；
 * 2. useLibraryListInfiniteQuery() -> 基于 React Query 拉取服务端 StoryWork 分页流；
 * 3. data.pages.flatMap(page.items) -> 在内存中打平全部已加载项，并执行 id 防重；
 * 4. composeLibraryItemListViewModel(...) -> 合成稳定列表项展示模型；
 * 5. groupStoryWorksByTime(...) -> flatten 后统一时间分组，严格禁止逐页分页分组；
 * 6. 只做读取 UI，绝不在此阶段执行任何修改（收藏/删除/恢复/物理删除归 M3-05/07）。
 */
const LibraryPage: React.FC = () => {
  // 1. URL 视图与搜索控制器接入
  const {
    view,
    q,
    draftQ,
    setDraftQ,
    setView,
    clearSearch,
    onCompositionStart,
    onCompositionEnd,
  } = useLibraryFilters();

  // 2. 无限滚动查询接入
  const {
    data,
    error,
    isLoading,
    isError,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useLibraryListInfiniteQuery({ view, query: q });

  // 3. 数据流水线：打平多页 -> 防重 -> 包装 ViewModel -> 统一时间分组
  const { viewModels, timeGroups } = useMemo(() => {
    if (!data?.pages || data.pages.length === 0) {
      return { viewModels: [], timeGroups: [] };
    }

    // 跨页打平
    const rawItems = data.pages.flatMap((page) => page.items);

    // 基于 StoryWork.id 防御性去重
    const seen = new Set<number>();
    const uniqueItems = [];
    for (const item of rawItems) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        uniqueItems.push(item);
      }
    }

    // 转换 ViewModel
    const vms = composeLibraryItemListViewModel(uniqueItems);

    // 所有页打平后统一按时间分组（active/favorites 依据 createdAt，trash 依据 deletedAt）
    const groups = groupStoryWorksByTime(vms, view);

    return { viewModels: vms, timeGroups: groups };
  }, [data?.pages, view]);

  // 4. UI 状态判定
  const hasItems = viewModels.length > 0;
  const isInitialLoading = isLoading && !hasItems;
  const isInitialError = isError && !hasItems;
  const isEmpty = !isLoading && !isError && !hasItems;

  return (
    <div className={styles.libraryPage} data-testid="library-page">
      {/* 头部标题区 */}
      <header className={styles.libraryHero}>
        <p className={styles.heroLabel}>Story Library</p>
        <h1 className={styles.heroTitle}>故事库</h1>
      </header>

      {/* 搜索与视图工具栏 */}
      <LibraryToolbar
        view={view}
        draftQ={draftQ}
        onViewChange={setView}
        onDraftQChange={setDraftQ}
        onClearSearch={clearSearch}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
      />

      {/* 内容区域状态渲染 */}
      <main className={styles.libraryContent} data-testid="library-main-content">
        {/* 4.1 初始骨架屏加载状态 */}
        {isInitialLoading ? (
          <LibraryLoadingSkeleton count={6} />
        ) : null}

        {/* 4.2 初始全屏错误及重试状态 */}
        {isInitialError ? (
          <LibraryErrorState error={error} onRetry={() => refetch()} />
        ) : null}

        {/* 4.3 各类型空状态 */}
        {isEmpty ? (
          <LibraryEmptyState
            view={view}
            query={q}
            onClearSearch={clearSearch}
          />
        ) : null}

        {/* 4.4 列表内容渲染 */}
        {hasItems ? (
          <>
            {timeGroups.map((group) => (
              <LibraryTimeGroup key={group.label} group={group} view={view} />
            ))}

            {/* 无限滚动哨兵（三重 Gate 守护） */}
            <InfiniteScrollSentinel
              hasNextPage={Boolean(hasNextPage)}
              isFetchingNextPage={isFetchingNextPage}
              onFetchNext={fetchNextPage}
            />

            {/* 终端完结状态（已无更多） */}
            {!hasNextPage ? (
              <div
                className={styles.terminalNoMore}
                data-testid="terminal-no-more"
              >
                — 没有更多了 —
              </div>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
};

export default LibraryPage;
