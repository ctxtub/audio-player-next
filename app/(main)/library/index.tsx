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
 * 故事库主页列表视图组件（M9-C1 T4：顶层恒为 Collection）。
 *
 * 核心数据链契约：
 * 1. useLibraryFilters() -> 获得 canonical { view, q } 及 draftQ / 视图操作；
 * 2. useCollectionListInfiniteQuery() -> 基于 React Query 拉取服务端 Collection 分页流；
 * 3. data.pages.flatMap(page.items) -> 打平 + 集合 id 防重（flattenCollectionPages）；
 * 4. 搜索命中集内 Work 时服务端已按 Collection 去重，UI 不二次聚合；
 * 5. 只做集合级读取与集合级生命周期（重命名/收藏/删除/恢复/永久删除归卡片与详情）。
 */
const LibraryPage: React.FC = () => {
  // 1. URL 视图与搜索控制器接入（与作品库同枚举 active | favorites | trash）
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

  // 2. 无限滚动查询接入（集合分页流）
  const {
    data,
    error,
    isLoading,
    isError,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useCollectionListInfiniteQuery({ view, query: q });

  // 3. 数据流水线：打平多页 -> 集合 id 防重
  const collections = useMemo(() => {
    if (!data?.pages || data.pages.length === 0) {
      return [];
    }
    return flattenCollectionPages(data.pages);
  }, [data?.pages]);

  // 4. UI 状态判定
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

        {/* 4.4 集合列表内容渲染（服务端顺序直出，禁止客户端重排） */}
        {hasItems ? (
          <>
            {collections.map((collection) => (
              <CollectionCard
                key={collection.id}
                collection={collection}
                view={view}
              />
            ))}

            {/* 无限滚动哨兵（三重 Gate 守护与跨 query identity 锁隔离） */}
            <InfiniteScrollSentinel
              key={JSON.stringify([view, q ?? null])}
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
