'use client';

/**
 * Collection 卡片（故事库顶层恒为集合）。
 *
 * - active/favorites 视图：整张卡片为热区（点击跳转 /library/collections/{id}）；
 * - 仅展示两个交互按钮：右上角「收藏」+ 底部主操作「从头开始」播放；
 * - 不透出继续播放，彻底移除管理按钮；
 * - trash 视图：卡片静态不可点，展示恢复/永久删除按钮。
 */

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Star, Trash2, RotateCcw, Play } from 'lucide-react';
import type { StoryCollectionSummaryDTO } from '@/lib/trpc/schemas/collection';
import type { CollectionView } from '@/lib/trpc/schemas/collection';
import { useCollectionMutations } from '@/lib/client/collectionMutations';
import {
  formatCollectionWorkCount,
  isCollectionFavorited,
} from '@/lib/client/collectionViewModel';
import { collectionPath } from '@/lib/navigation/storyRoutes';
import { playCollection } from '@/app/services/collectionPlaybackFlow';
import GlassToast from '@/components/ui/GlassToast';
import styles from './libraryComponents.module.scss';

export interface CollectionCardProps {
  collection: StoryCollectionSummaryDTO;
  view: CollectionView;
}

export const CollectionCard: React.FC<CollectionCardProps> = ({ collection, view }) => {
  const router = useRouter();
  const mutations = useCollectionMutations();
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isDeletingPermanently, setIsDeletingPermanently] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const isTrash = view === 'trash';
  const favorited = isCollectionFavorited(collection);

  const handleCardClick = () => {
    if (isTrash) return;
    router.push(collectionPath(collection.id));
  };

  const handleToggleFavorite = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTogglingFavorite) return;
    setIsTogglingFavorite(true);
    try {
      await mutations.toggleFavorite(collection.id, !favorited);
    } catch (err) {
      console.error('Collection favorite failed:', err);
    } finally {
      setIsTogglingFavorite(false);
    }
  };

  const handlePlayFromBeginning = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isPlaying || collection.workCount === 0) return;
    setIsPlaying(true);
    try {
      await playCollection(collection.id, 'restart');
    } catch {
      GlassToast.show({ icon: 'fail', content: '暂时无法播放，请重试' });
    } finally {
      setIsPlaying(false);
    }
  };

  const handleRestore = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRestoring) return;
    setIsRestoring(true);
    try {
      await mutations.restore(collection.id);
    } catch (err) {
      console.error('Collection restore failed:', err);
    } finally {
      setIsRestoring(false);
    }
  };

  const handleDeleteForever = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDeletingPermanently) return;
    setIsDeletingPermanently(true);
    try {
      await mutations.deleteForever(collection.id);
      setIsDeleteConfirmOpen(false);
    } catch (err) {
      console.error('Collection permanent delete failed:', err);
    } finally {
      setIsDeletingPermanently(false);
    }
  };

  return (
    <article
      className={`${styles.storyCard} ${!isTrash ? styles.clickableCard : ''}`}
      onClick={handleCardClick}
      role={!isTrash ? 'button' : undefined}
      tabIndex={!isTrash ? 0 : undefined}
      onKeyDown={(e) => {
        if (!isTrash && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          handleCardClick();
        }
      }}
      data-testid={`collection-card-${collection.id}`}
      data-collection-id={collection.id}
    >
      <div className={styles.cardHeader}>
        <div className={styles.cardTitleStatic} data-testid="collection-title-static">
          <h3 className={styles.cardTitle} data-testid="collection-title">
            {collection.title}
          </h3>
        </div>
        <div className={styles.cardHeaderRight}>
          {!isTrash ? (
            <button
              type="button"
              className={styles.favoriteBtn}
              onClick={handleToggleFavorite}
              disabled={isTogglingFavorite}
              aria-label={favorited ? `取消收藏《${collection.title}》` : `收藏《${collection.title}》`}
              data-testid={`collection-favorite-btn-${collection.id}`}
              data-favorited={favorited ? 'true' : 'false'}
              title={favorited ? '取消收藏' : '收藏'}
            >
              <Star
                size={18}
                fill={favorited ? '#f59e0b' : 'none'}
                stroke={favorited ? '#f59e0b' : '#9ca3af'}
              />
            </button>
          ) : (
            <span className={styles.trashBadge} data-testid="collection-trash-badge">
              已移入回收站
            </span>
          )}
        </div>
      </div>

      <p className={styles.cardExcerpt} data-testid="collection-work-count">
        {formatCollectionWorkCount(collection.workCount)}
      </p>

      {collection.excerpt && <p className={styles.cardExcerpt}>{collection.excerpt}</p>}

      <div className={styles.cardActions}>
        {!isTrash ? (
          collection.workCount > 0 ? (
            <button
              type="button"
              className={styles.playBtn}
              onClick={handlePlayFromBeginning}
              disabled={isPlaying}
              data-testid={`collection-play-btn-${collection.id}`}
              aria-label={`从头开始播放《${collection.title}》`}
            >
              <Play size={14} aria-hidden="true" />
              <span>从头开始</span>
            </button>
          ) : null
        ) : (
          <>
            <button
              type="button"
              className={styles.restoreBtn}
              onClick={handleRestore}
              disabled={isRestoring}
              data-testid="collection-restore-btn"
              aria-label={`恢复故事集《${collection.title}》`}
            >
              <RotateCcw size={14} />
              <span>恢复</span>
            </button>
            <button
              type="button"
              className={styles.deletePermanentlyBtn}
              onClick={(e) => {
                e.stopPropagation();
                setIsDeleteConfirmOpen(true);
              }}
              data-testid="collection-permanent-delete-btn"
              aria-label={`永久删除故事集《${collection.title}》`}
            >
              <Trash2 size={14} />
              <span>永久删除</span>
            </button>
          </>
        )}
      </div>

      {isDeleteConfirmOpen ? (
        <div
          className={styles.confirmOverlay}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`collection-delete-title-${collection.id}`}
            data-testid="collection-delete-confirm"
          >
            <h4
              id={`collection-delete-title-${collection.id}`}
              className={styles.confirmTitle}
            >
              永久删除故事集？
            </h4>
            <p className={styles.confirmMessage}>
              《{collection.title}》及其中全部作品将被永久删除，此操作不可撤销。
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  setIsDeleteConfirmOpen(false);
                }}
                data-testid="collection-delete-confirm-cancel"
              >
                取消
              </button>
              <button
                type="button"
                className={styles.dangerBtn}
                onClick={handleDeleteForever}
                disabled={isDeletingPermanently}
                data-testid="collection-delete-confirm-ok"
              >
                {isDeletingPermanently ? '删除中...' : '永久删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
};
