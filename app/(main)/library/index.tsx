'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useLibraryListInfiniteQuery } from '@/lib/client/libraryQueries';
import { composeLibraryItemViewModel } from '@/lib/client/libraryViewModel';
import { libraryPath } from '@/lib/navigation/storyRoutes';
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
  StoryWorkCard,
} from './components';
import styles from './index.module.scss';

/**
 * 故事库主页列表视图组件（顶层恒为 Collection）。
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

  const searchParams = useSearchParams();
  const isWorks = view !== 'active' && searchParams?.get('type') === 'works';
  const collectionQuery = useCollectionListInfiniteQuery({ view, query: q }, { enabled: !isWorks });
  const workQuery = useLibraryListInfiniteQuery({ view, query: q }, { enabled: isWorks });
  const { error, isLoading, isError, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = isWorks ? workQuery : collectionQuery;
  const data = collectionQuery.data;
  const works = workQuery.data?.pages.flatMap((page) => page.items) ?? [];

  // 3. 数据流水线：打平多页 -> 集合 id 防重
  const collections = useMemo(() => {
    if (!data?.pages || data.pages.length === 0) {
      return [];
    }
    return flattenCollectionPages(data.pages);
  }, [data?.pages]);

  // 4. UI 状态判定
  const hasItems = isWorks ? works.length > 0 : collections.length > 0;
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

      {view !== 'active' && <nav aria-label="管理范围">
        <Link href={libraryPath(view, q)} aria-current={!isWorks ? 'page' : undefined}>故事集</Link>{' · '}
        <Link href={libraryPath(view, q, 'works')} aria-current={isWorks ? 'page' : undefined}>单篇故事</Link>
      </nav>}
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
            scope={isWorks ? 'works' : 'collections'}
            query={q}
            onClearSearch={clearSearch}
          />
        ) : null}

        {/* 4.4 集合列表内容渲染（服务端顺序直出，禁止客户端重排） */}
        {hasItems ? (
          <>
            {isWorks ? works.map((work) => <StoryWorkCard key={work.id} work={composeLibraryItemViewModel(work)} view={view} />) : collections.map((collection) => (
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
