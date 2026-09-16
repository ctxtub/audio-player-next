'use client';

/**
 * Collection 详情页客户端 Shell（M9-C1 T4）。
 *
 * - 头部：返回、标题、重命名、收藏、删除（集合级生命周期）；
 * - 成员：按服务端 position 升序直出（areMemberPositionsOrdered 复核），逐 Work 播放；
 * - 软删除集合 fail closed：服务端 get 拒绝 → 统一不可用视图；
 * - 删除成功后自动导航回 /library（Undo 跨路由留存于 layout provider）。
 */

import React, { useContext, useState } from 'react';
import Link from 'next/link';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { AlertCircle, RefreshCw, Star, Trash2, Play } from 'lucide-react';
import { useCollectionDetailQuery } from '@/lib/client/collectionQueries';
import { useCollectionMutations } from '@/lib/client/collectionMutations';
import {
  areMemberPositionsOrdered,
  formatCollectionWorkCount,
} from '@/lib/client/collectionViewModel';
import { playWorkFromHistory } from '@/app/services/playbackSessionFlow';
import { LibraryUnavailable, isUnavailableError } from '@/components/Library/LibraryUnavailable';
import styles from '../../[id]/index.module.scss';

export interface CollectionDetailPageProps {
  id: string;
}

const CollectionDetailPage: React.FC<CollectionDetailPageProps> = ({ id }) => {
  const isValidId = typeof id === 'string' && id.length > 0 && id.length <= 64;
  const router = useContext(AppRouterContext);
  const mutations = useCollectionMutations();

  const [isRenaming, setIsRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);

  const { data, isLoading, isError, error, refetch } = useCollectionDetailQuery(id, {
    enabled: isValidId,
  });

  if (!isValidId) {
    return <LibraryUnavailable />;
  }

  if (isLoading) {
    return (
      <div className={styles.storyDetailPage} data-testid="collection-detail-loading">
        <header className={styles.detailHero}>
          <div className={styles.skeletonLabel} />
          <div className={styles.skeletonTitle} />
        </header>
      </div>
    );
  }

  if (isError && isUnavailableError(error)) {
    return <LibraryUnavailable />;
  }

  if (isError) {
    return (
      <div className={styles.storyDetailPage} data-testid="collection-detail-error">
        <div className={styles.errorContainer}>
          <div className={styles.errorIconWrapper}>
            <AlertCircle size={28} />
          </div>
          <h2 className={styles.errorTitle}>作品集加载失败</h2>
          <p className={styles.errorMessage}>
            {error instanceof Error ? error.message : '网络或服务异常，请稍后重试'}
          </p>
          <div className={styles.errorActions}>
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => refetch()}
              data-testid="collection-detail-retry-btn"
            >
              <RefreshCw size={14} />
              <span>重试</span>
            </button>
            <Link href="/library" className={styles.backLink} data-testid="collection-back-btn">
              返回故事库
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return <LibraryUnavailable />;
  }

  const favorited = data.favoritedAt != null;
  const membersOrdered = areMemberPositionsOrdered(data.works);

  const handleSaveRename = async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await mutations.rename(data.id, draftTitle, data.title);
      setIsRenaming(false);
    } catch (err) {
      console.error('Collection rename failed:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleFavorite = async () => {
    if (isTogglingFavorite) return;
    setIsTogglingFavorite(true);
    try {
      await mutations.toggleFavorite(data.id, !favorited);
    } catch (err) {
      console.error('Collection favorite failed:', err);
    } finally {
      setIsTogglingFavorite(false);
    }
  };

  const handleDelete = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      await mutations.moveToTrash(data.id, data.title);
      if (router) router.push('/library');
    } catch (err) {
      console.error('Collection delete failed:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  const handlePlayWork = async (workId: number) => {
    try {
      await playWorkFromHistory(workId);
    } catch (err) {
      console.error('Collection member play failed:', err);
    }
  };

  return (
    <div className={styles.storyDetailPage} data-testid="collection-detail-page">
      <header className={styles.detailHero}>
        <Link href="/library" className={styles.backLink} data-testid="collection-back-btn">
          返回故事库
        </Link>
        {isRenaming ? (
          <div>
            <input
              aria-label="集合标题"
              data-testid="collection-rename-input"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              maxLength={60}
            />
            <button
              type="button"
              data-testid="collection-rename-save"
              disabled={isSaving}
              onClick={handleSaveRename}
            >
              {isSaving ? '保存中...' : '保存'}
            </button>
            <button
              type="button"
              data-testid="collection-rename-cancel"
              onClick={() => setIsRenaming(false)}
            >
              取消
            </button>
          </div>
        ) : (
          <h1 className={styles.detailTitle} data-testid="collection-title">
            {data.title}
          </h1>
        )}
        <p data-testid="collection-work-count">{formatCollectionWorkCount(data.workCount)}</p>
        <div>
          {!isRenaming ? (
            <button
              type="button"
              data-testid="collection-rename-btn"
              onClick={() => {
                setDraftTitle(data.title);
                setIsRenaming(true);
              }}
            >
              重命名
            </button>
          ) : null}
          <button
            type="button"
            data-testid="collection-favorite-btn"
            data-favorited={favorited ? 'true' : 'false'}
            disabled={isTogglingFavorite}
            onClick={handleToggleFavorite}
            aria-label={favorited ? '取消收藏' : '收藏'}
          >
            <Star size={16} fill={favorited ? '#f59e0b' : 'none'} />
            {favorited ? '已收藏' : '收藏'}
          </button>
          <button
            type="button"
            data-testid="collection-delete-btn"
            disabled={isDeleting}
            onClick={handleDelete}
          >
            <Trash2 size={14} />
            删除作品集
          </button>
        </div>
      </header>

      <main data-testid="collection-members">
        {!membersOrdered ? (
          <p data-testid="collection-order-warning">成员顺序异常，请刷新重试</p>
        ) : null}
        {data.works.map((work) => (
          <article
            key={work.id}
            data-testid={`member-work-${work.id}`}
            data-position={work.position}
          >
            <h3 data-testid={`member-title-${work.id}`}>{work.title}</h3>
            <button
              type="button"
              data-testid={`member-play-${work.id}`}
              onClick={() => handlePlayWork(work.id)}
              aria-label={`播放${work.title}`}
            >
              <Play size={14} />
              播放
            </button>
          </article>
        ))}
      </main>
    </div>
  );
};

export default CollectionDetailPage;
