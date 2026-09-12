'use client';

import React from 'react';
import Link from 'next/link';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { useLibraryDetailQuery } from '@/lib/client/libraryQueries';
import { composeLibraryDetailViewModel } from '@/lib/client/libraryViewModel';
import { StoryDetail } from '@/components/Library/StoryDetail';
import { LibraryUnavailable, isUnavailableError } from '@/components/Library/LibraryUnavailable';
import styles from './index.module.scss';

export interface StoryDetailPageProps {
  id: string;
}

/**
 * 故事详情页客户端 Shell 组件（M3-06）
 *
 * 核心生命周期与状态：
 * 1. loading：展示骨架占位态；
 * 2. unavailable：NOT_FOUND / UNAUTHORIZED / foreign-owned / trashed / 缺失，渲染统一不可用视图（LibraryUnavailable）；
 * 3. error：非不可用的系统级/网络级瞬态异常，展示重试机制；
 * 4. success：由 composeLibraryDetailViewModel 包装注入 progress=null 缝隙，纯只读渲染 StoryDetail。
 *
 * 严格防护与边界约束：
 * - 绝不发起针对回收站视图的列表或额外探测查询；
 * - 纯只读接入，绝不提前引入任何 Rename / Favorite / Trash 等变更操作；
 * - progress 经由 VM seam 严格注入为 null，为 M5 留出干净接入点。
 */
const StoryDetailPage: React.FC<StoryDetailPageProps> = ({ id }) => {
  const numericId = Number.parseInt(id, 10);
  const isValidId = !Number.isNaN(numericId) && numericId > 0;

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
  } = useLibraryDetailQuery(numericId, {
    enabled: isValidId,
  });

  // 非法 ID 直接统一渲染不可用视图
  if (!isValidId) {
    return <LibraryUnavailable />;
  }

  // 1. Loading 状态
  if (isLoading) {
    return (
      <div className={styles.storyDetailPage} data-testid="story-detail-loading">
        <header className={styles.detailHero}>
          <div className={styles.skeletonLabel} />
          <div className={styles.skeletonTitle} />
        </header>
        <main className={styles.detailContent}>
          <div className={styles.skeletonBlock} />
          <div className={styles.skeletonBlock} />
        </main>
      </div>
    );
  }

  // 2. 统一不可用语义（NOT_FOUND / UNAUTHORIZED / foreign / trashed / 不存在）
  if (isError && isUnavailableError(error)) {
    return <LibraryUnavailable />;
  }

  // 3. 通用网络/服务端瞬态异常（展示重试）
  if (isError) {
    return (
      <div className={styles.storyDetailPage} data-testid="story-detail-error">
        <div className={styles.errorContainer}>
          <div className={styles.errorIconWrapper}>
            <AlertCircle size={28} />
          </div>
          <h2 className={styles.errorTitle}>故事详情加载失败</h2>
          <p className={styles.errorMessage}>
            {error instanceof Error ? error.message : '网络或服务异常，请稍后重试'}
          </p>
          <div className={styles.errorActions}>
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => refetch()}
              data-testid="story-detail-retry-btn"
            >
              <RefreshCw size={14} />
              <span>重试</span>
            </button>
            <Link
              href="/library"
              className={styles.backLink}
              data-testid="back-to-library-link"
            >
              返回故事库
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // 数据不存在防御兜底
  if (!data) {
    return <LibraryUnavailable />;
  }

  // 4. 正常详情：经 VM Seam 保持 progress=null 纯只读渲染
  const viewModel = composeLibraryDetailViewModel(data, null);

  return <StoryDetail work={viewModel} />;
};

export default StoryDetailPage;
