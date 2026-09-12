'use client';

import React from 'react';
import styles from './libraryComponents.module.scss';

export interface LibraryLoadingSkeletonProps {
  count?: number;
}

/**
 * 故事库加载骨架屏组件（默认展示 6 张卡片）
 */
export const LibraryLoadingSkeleton: React.FC<LibraryLoadingSkeletonProps> = ({
  count = 6,
}) => {
  const cards = Array.from({ length: count }, (_, idx) => idx);

  return (
    <div
      className={styles.cardList}
      data-testid="library-loading-skeleton"
      aria-label="故事库内容加载中"
    >
      {cards.map((id) => (
        <div key={id} className={styles.skeletonCard} data-testid={`skeleton-card-${id}`}>
          <div className={`${styles.skeletonLine} ${styles.skeletonLineTitle}`} />
          <div className={`${styles.skeletonLine} ${styles.skeletonLineExcerpt1}`} />
          <div className={`${styles.skeletonLine} ${styles.skeletonLineExcerpt2}`} />
          <div className={`${styles.skeletonLine} ${styles.skeletonLineMeta}`} />
        </div>
      ))}
    </div>
  );
};
