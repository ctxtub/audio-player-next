'use client';

import React, { useEffect, useRef, useCallback } from 'react';
import styles from './libraryComponents.module.scss';

export interface InfiniteScrollSentinelProps {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onFetchNext: () => Promise<unknown> | void;
}

/**
 * 无限滚动哨兵组件 (Infinite Scroll Sentinel)
 *
 * 核心保障：
 * 1. 三重 Gate 判定：hasNextPage && !isFetchingNextPage && sentinel.isIntersecting；
 * 2. 内存锁防护：使用 isCallingRef 防并发，绝不同时触发两次 fetchNextPage；
 * 3. 容错回退：无 IntersectionObserver 或自动触发受阻时，提供手动「加载更多」按钮备选。
 */
export const InfiniteScrollSentinel: React.FC<InfiniteScrollSentinelProps> = ({
  hasNextPage,
  isFetchingNextPage,
  onFetchNext,
}) => {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const isCallingRef = useRef(false);

  const triggerFetch = useCallback(() => {
    // 严格三重 Gate 守卫
    if (hasNextPage && !isFetchingNextPage && !isCallingRef.current) {
      isCallingRef.current = true;
      try {
        const res = onFetchNext();
        if (res && typeof (res as Promise<unknown>).finally === 'function') {
          (res as Promise<unknown>).finally(() => {
            isCallingRef.current = false;
          });
        } else {
          isCallingRef.current = false;
        }
      } catch {
        isCallingRef.current = false;
      }
    }
  }, [hasNextPage, isFetchingNextPage, onFetchNext]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          triggerFetch();
        }
      },
      { rootMargin: '600px 0px' }
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [triggerFetch]);

  // 如果没有下一页且没有处于在途拉取，哨兵不渲染交互内容（外部负责渲染 terminal no-more）
  if (!hasNextPage && !isFetchingNextPage) {
    return null;
  }

  return (
    <div
      ref={sentinelRef}
      className={styles.sentinel}
      data-testid="infinite-scroll-sentinel"
    >
      {isFetchingNextPage ? (
        <div className={styles.loadingNext} data-testid="next-page-loading">
          <span className={styles.spinner} />
          <span>正在加载更多故事...</span>
        </div>
      ) : hasNextPage ? (
        <button
          type="button"
          className={styles.manualLoadButton}
          onClick={triggerFetch}
          disabled={isFetchingNextPage}
          data-testid="manual-load-more-btn"
        >
          加载更多
        </button>
      ) : null}
    </div>
  );
};
