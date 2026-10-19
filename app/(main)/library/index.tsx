'use client';

import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Headphones, Play, Pause, ChevronRight } from 'lucide-react';
import { useLibraryFilters } from './useLibraryFilters';
import { useCollectionListInfiniteQuery } from '@/lib/client/collectionQueries';
import { flattenCollectionPages } from '@/lib/client/collectionViewModel';
import { collectionPath } from '@/lib/navigation/storyRoutes';
import { playCollection } from '@/app/services/collectionPlaybackFlow';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import GlassToast from '@/components/ui/GlassToast';
import {
  LibraryToolbar,
  InfiniteScrollSentinel,
  LibraryEmptyState,
  LibraryLoadingSkeleton,
  LibraryErrorState,
  CollectionCard,
  CollectionCoverArt,
} from './components';
import styles from './index.module.scss';

/**
 * 故事库主页列表视图组件（顶层恒为 Collection，支持继续伴听聚光横幅与响应式书架网格）。
 */
const LibraryPage: React.FC = () => {
  const router = useRouter();
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

  const activeCollectionId = usePlaybackSessionStore((state) => state.collectionId);
  const activeWorkTitle = usePlaybackSessionStore((state) => state.workTitle);
  const sessionStatus = usePlaybackSessionStore((state) => state.status);
  const isTransportPlaying = usePlaybackStore((state) => state.isPlaying);
  const [isSpotlightStarting, setIsSpotlightStarting] = useState(false);

  const collections = useMemo(() => {
    if (!data?.pages || data.pages.length === 0) {
      return [];
    }
    return flattenCollectionPages(data.pages);
  }, [data?.pages]);

  const totalWorksCount = useMemo(
    () => collections.reduce((sum, item) => sum + (item.workCount || 0), 0),
    [collections],
  );

  // 继续伴听聚光推荐：优先当前播放会话所属集合，其次最近有未听完进度的集合
  const spotlightCollection = useMemo(() => {
    if (view !== 'active' || q || collections.length === 0) return null;
    if (activeCollectionId && sessionStatus !== 'idle') {
      const matched = collections.find((c) => c.id === activeCollectionId);
      if (matched && matched.workCount > 0) return matched;
    }
    return collections.find((c) => c.hasUnfinished && c.workCount > 0) ?? null;
  }, [view, q, collections, activeCollectionId, sessionStatus]);

  const isSpotlightPlaying =
    Boolean(spotlightCollection) &&
    activeCollectionId === spotlightCollection?.id &&
    isTransportPlaying;

  const handleSpotlightPlay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!spotlightCollection || isSpotlightStarting) return;
    if (isSpotlightPlaying) {
      usePlaybackSessionStore.getState().handleExplicitPause();
      usePlaybackStore.getState().pause();
      return;
    }
    setIsSpotlightStarting(true);
    try {
      await playCollection(spotlightCollection.id, 'resume');
    } catch {
      GlassToast.show({ icon: 'fail', content: '暂时无法播放，请重试' });
    } finally {
      setIsSpotlightStarting(false);
    }
  };

  const hasItems = collections.length > 0;
  const isInitialLoading = isLoading && !hasItems;
  const isInitialError = isError && !hasItems;
  const isEmpty = !isLoading && !isError && !hasItems;

  return (
    <div className={styles.libraryPage} data-testid="library-page">
      {/* 紧凑头部与搜索筛选一体区 */}
      <div className={styles.libraryTopBar}>
        <header className={styles.libraryHero}>
          <div className={styles.heroTitleRow}>
            <h1 className={styles.heroTitle}>故事库</h1>
            {hasItems ? (
              <span className={styles.heroStatsBadge}>
                {collections.length} 个故事集 · {totalWorksCount} 篇
              </span>
            ) : null}
          </div>
          <p className={styles.heroSubtitle}>按故事集收纳你的连续创作与有声伴听</p>
        </header>

        <LibraryToolbar
          view={view}
          draftQ={draftQ}
          onViewChange={setView}
          onDraftQChange={setDraftQ}
          onClearSearch={clearSearch}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
        />
      </div>

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
            {/* 继续伴听聚光卡（仅在全部视图且存在未听完/当前伴听故事集时展示） */}
            {spotlightCollection ? (
              <section
                className={styles.spotlightBanner}
                aria-label="继续伴听"
                data-testid="library-continue-banner"
                onClick={() => router.push(collectionPath(spotlightCollection.id))}
              >
                <CollectionCoverArt
                  title={spotlightCollection.title}
                  collectionId={spotlightCollection.id}
                  size="sm"
                  isPlaying={isSpotlightPlaying}
                />
                <div className={styles.spotlightBody}>
                  <div className={styles.spotlightEyebrow}>
                    <Headphones size={12} aria-hidden="true" />
                    <span>{isSpotlightPlaying ? '正在伴听' : '上次伴听 · 断点续播'}</span>
                  </div>
                  <div className={styles.spotlightTitle}>
                    {spotlightCollection.title}
                  </div>
                  <div className={styles.spotlightSub}>
                    {activeCollectionId === spotlightCollection.id && activeWorkTitle
                      ? `当前篇章：${activeWorkTitle}`
                      : `共 ${spotlightCollection.workCount} 篇故事 · 点击继续收听`}
                  </div>
                </div>
                <div className={styles.spotlightActions}>
                  <button
                    type="button"
                    className={styles.spotlightPlayBtn}
                    onClick={handleSpotlightPlay}
                    disabled={isSpotlightStarting}
                    aria-label={isSpotlightPlaying ? '暂停当前伴听' : '继续伴听上次故事集'}
                  >
                    {isSpotlightPlaying ? (
                      <Pause size={15} aria-hidden="true" />
                    ) : (
                      <Play size={15} fill="currentColor" aria-hidden="true" />
                    )}
                    <span>{isSpotlightPlaying ? '暂停' : '继续听'}</span>
                  </button>
                  <ChevronRight size={16} className={styles.spotlightChevron} aria-hidden="true" />
                </div>
              </section>
            ) : null}

            <div className={styles.collectionsGrid}>
              {collections.map((collection) => (
                <CollectionCard
                  key={collection.id}
                  collection={collection}
                  view={view}
                />
              ))}
            </div>

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
