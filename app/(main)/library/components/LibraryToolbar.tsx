'use client';

import React from 'react';
import { Search, X } from 'lucide-react';
import type { LibraryView } from '@/lib/client/library';
import styles from './libraryComponents.module.scss';

export interface LibraryToolbarProps {
  view: LibraryView;
  draftQ: string;
  onViewChange: (view: LibraryView) => void;
  onDraftQChange: (q: string) => void;
  onClearSearch: () => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: (e?: React.CompositionEvent<HTMLInputElement>) => void;
}

/**
 * 故事库工具栏（搜索框 + 视图切换器）
 */
export const LibraryToolbar: React.FC<LibraryToolbarProps> = ({
  view,
  draftQ,
  onViewChange,
  onDraftQChange,
  onClearSearch,
  onCompositionStart,
  onCompositionEnd,
}) => {
  return (
    <div className={styles.toolbar} data-testid="library-toolbar">
      {/* 搜索栏 */}
      <div className={styles.searchBar}>
        <span className={styles.searchIcon}>
          <Search size={16} />
        </span>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="搜索故事..."
          maxLength={100}
          value={draftQ}
          onChange={(e) => onDraftQChange(e.target.value)}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          data-testid="library-search-input"
        />
        {draftQ ? (
          <button
            type="button"
            className={styles.clearSearchBtn}
            onClick={onClearSearch}
            aria-label="清空搜索"
            data-testid="library-search-clear-btn"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      {/* 视图切换器：全部 / 收藏 / 回收站 */}
      <div className={styles.viewTabs} role="tablist" aria-label="故事库视图筛选">
        <div className={styles.tabGroup}>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'active'}
            className={`${styles.tabBtn} ${view === 'active' ? styles.tabBtnActive : ''}`}
            onClick={() => onViewChange('active')}
            data-testid="view-tab-active"
          >
            全部
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'favorites'}
            className={`${styles.tabBtn} ${view === 'favorites' ? styles.tabBtnActive : ''}`}
            onClick={() => onViewChange('favorites')}
            data-testid="view-tab-favorites"
          >
            收藏
          </button>
        </div>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'trash'}
          className={`${styles.tabBtn} ${styles.trashTabBtn} ${view === 'trash' ? styles.trashTabBtnActive : ''}`}
          onClick={() => onViewChange('trash')}
          data-testid="view-tab-trash"
        >
          回收站
        </button>
      </div>
    </div>
  );
};
