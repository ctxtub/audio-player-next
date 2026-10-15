'use client';

import React, { useMemo } from 'react';
import { useLibraryFilters } from './useLibraryFilters';
import { useCollectionListInfiniteQuery } from '@/lib/client/collectionQueries';
import { flattenCollectionPages } from '@/lib/client/collectionViewModel';
import {
  LibraryToolbar,
  InfiniteScrollSentinel,
  LibraryEmptyState,
  LibraryLoadingSkeleton,
  LibraryErrorState,
  CollectionCard,
} from './components';
import styles from './index.module.scss';

/**
 * 故事库主页列表视图组件（顶层恒为 Collection，已移除单篇故事筛选）。
 */
const LibraryPage: React.FC = () => {
  // 1. URL 视图与搜索控制器接入（全部 active | 收藏 favorites | 回收站 trash）
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

  const collectionQuery = useCollectionListInfiniteQuery({ view, query: q });
  const { error, isLoading, isError, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = collectionQuery;
  const data = collectionQuery.data;

  // 2. 数据流水线：打平多页 -> 集合 id 防重
  const collections = useMemo(() => {
    if (!data?.pages || data.pages.length === 0) {
      return [];
    }
    return flattenCollectionPages(data.pages);
  }, [data?.pages]);

  // 3. UI 状态判定
  const hasItems = collections.length > 0;
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
      <main
        className={styles.libraryContent}
        data-testid="library-collections-scroll"
      >
        {/* 初始骨架屏加载状态 */}
        {isInitialLoading ? (
          <LibraryLoadingSkeleton count={6} />
        ) : null}

        {/* 初始全屏错误及重试状态 */}
        {isInitialError ? (
          <LibraryErrorState error={error} onRetry={() => refetch()} />
        ) : null}

        {/* 空状态 */}
        {isEmpty ? (
          <LibraryEmptyState
            view={view}
            scope="collections"
            query={q}
            onClearSearch={clearSearch}
          />
        ) : null}

        {/* 集合列表内容渲染 */}
        {hasItems ? (
          <>
            {collections.map((collection) => (
              <CollectionCard
                key={collection.id}
                collection={collection}
                view={view}
              />
            ))}

            {/* 无限滚动哨兵 */}
            <InfiniteScrollSentinel
              key={JSON.stringify([view, q ?? null])}
              hasNextPage={Boolean(hasNextPage)}
              isFetchingNextPage={isFetchingNextPage}
              onFetchNext={fetchNextPage}
            />

            {/* 终端完结状态 */}
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
