'use client';

import React from 'react';
import Link from 'next/link';
import { BookOpen, Star, Trash2, Search, Sparkles } from 'lucide-react';
import type { LibraryView } from '@/lib/client/library';
import styles from './libraryComponents.module.scss';

export interface LibraryEmptyStateProps {
  view: LibraryView;
  query?: string;
  onClearSearch?: () => void;
}

/**
 * 故事库空状态组件（支持 active / favorites / trash / search 四种形态）
 */
export const LibraryEmptyState: React.FC<LibraryEmptyStateProps> = ({
  view,
  query,
  onClearSearch,
}) => {
  // 1. 搜索空状态（优先级最高，适用于任意视图下的搜索无匹配）
  if (query) {
    return (
      <div className={styles.emptyContainer} data-testid="library-empty-search">
        <div className={styles.emptyIconWrapper}>
          <Search size={24} />
        </div>
        <h3 className={styles.emptyTitle}>没有找到匹配“{query}”的故事</h3>
        <p className={styles.emptySubtitle}>尝试搜索其他关键词或清除搜索条件</p>
        {onClearSearch ? (
          <button
            type="button"
            className={styles.clearSearchBtnAction}
            onClick={onClearSearch}
            data-testid="clear-search-btn"
          >
            清除搜索
          </button>
        ) : null}
      </div>
    );
  }

  // 2. 收藏视图空状态
  if (view === 'favorites') {
    return (
      <div className={styles.emptyContainer} data-testid="library-empty-favorites">
        <div className={styles.emptyIconWrapper}>
          <Star size={24} />
        </div>
        <h3 className={styles.emptyTitle}>还没有收藏的故事</h3>
        <p className={styles.emptySubtitle}>在故事库中点击收藏，喜欢的作品会保存在这里。</p>
      </div>
    );
  }

  // 3. 回收站视图空状态
  if (view === 'trash') {
    return (
      <div className={styles.emptyContainer} data-testid="library-empty-trash">
        <div className={styles.emptyIconWrapper}>
          <Trash2 size={24} />
        </div>
        <h3 className={styles.emptyTitle}>回收站为空</h3>
        <p className={styles.emptySubtitle}>移入回收站的作品会在 30 天后永久删除。</p>
      </div>
    );
  }

  // 4. 全部（active）视图默认空状态
  return (
    <div className={styles.emptyContainer} data-testid="library-empty-active">
      <div className={styles.emptyIconWrapper}>
        <BookOpen size={24} />
      </div>
      <h3 className={styles.emptyTitle}>还没有故事</h3>
      <p className={styles.emptySubtitle}>完成一次创作后，作品会保存在这里。</p>
      <Link
        href="/chat"
        className={styles.emptyCtaBtn}
        data-testid="empty-cta-create"
      >
        <Sparkles size={14} />
        <span>去创作</span>
      </Link>
    </div>
  );
};
