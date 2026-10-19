'use client';

/**
 * Collection 卡片（故事库顶层恒为集合 — 横向专辑卡片设计）。
 *
 * - active/favorites 视图：整张卡片为热区（点击跳转 /library/collections/{id}）；
 * - 左侧展示纯矢量 SVG 专辑封面（CollectionCoverArt），中间展示标题、简介与篇章元信息，右侧展示智能播放胶囊按钮；
 * - 智能播放按钮：若当前集合正在播放则可暂停，若有未听完进度则断点续播，否则从头开始播放；
 * - trash 视图：卡片静态不可点，展示恢复/永久删除按钮。
 */

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Star, Trash2, RotateCcw, Play, Pause, BookOpen, Headphones } from 'lucide-react';
import type { StoryCollectionSummaryDTO, CollectionView } from '@/lib/trpc/schemas/collection';
import { useCollectionMutations } from '@/lib/client/collectionMutations';
import {
  formatCollectionWorkCount,
  isCollectionFavorited,
} from '@/lib/client/collectionViewModel';
import { collectionPath } from '@/lib/navigation/storyRoutes';
import { playCollection } from '@/app/services/collectionPlaybackFlow';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import GlassToast from '@/components/ui/GlassToast';
import { CollectionCoverArt } from './CollectionCoverArt';
import styles from './libraryComponents.module.scss';

export interface CollectionCardProps {
  collection: StoryCollectionSummaryDTO;
  view: CollectionView;
}

function formatRelativeDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

export const CollectionCard: React.FC<CollectionCardProps> = ({ collection, view }) => {
  const router = useRouter();
  const mutations = useCollectionMutations();
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isDeletingPermanently, setIsDeletingPermanently] = useState(false);
  const [isStartingPlay, setIsStartingPlay] = useState(false);

  const activeCollectionId = usePlaybackSessionStore((state) => state.collectionId);
  const sessionStatus = usePlaybackSessionStore((state) => state.status);
  const isTransportPlaying = usePlaybackStore((state) => state.isPlaying);

  const isTrash = view === 'trash';
  const favorited = isCollectionFavorited(collection);
  const isCurrentCollection = activeCollectionId === collection.id && sessionStatus !== 'idle';
  const isCurrentCollectionPlaying = isCurrentCollection && isTransportPlaying;
  const hasProgress = Boolean(collection.hasUnfinished) || (isCurrentCollection && sessionStatus !== 'ended');

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

  const handlePlayAction = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStartingPlay || collection.workCount === 0) return;

    if (isCurrentCollectionPlaying) {
      usePlaybackSessionStore.getState().handleExplicitPause();
      usePlaybackStore.getState().pause();
      return;
    }

    setIsStartingPlay(true);
    try {
      await playCollection(collection.id, hasProgress ? 'resume' : 'restart');
    } catch {
      GlassToast.show({ icon: 'fail', content: '暂时无法播放，请重试' });
    } finally {
      setIsStartingPlay(false);
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

  const playButtonLabel = isCurrentCollectionPlaying
    ? '暂停'
    : hasProgress
      ? '继续播放'
      : '播放';

  const PlayIcon = isCurrentCollectionPlaying ? Pause : Play;
  const dateLabel = formatRelativeDate(collection.updatedAt);

  return (
    <article
      className={`${styles.storyCard} ${styles.collectionAlbumCard} ${!isTrash ? styles.clickableCard : ''} ${isCurrentCollection ? styles.collectionCardActive : ''}`}
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
      <div className={styles.albumCardMain}>
        <CollectionCoverArt
          title={collection.title}
          collectionId={collection.id}
          size="md"
          isPlaying={isCurrentCollectionPlaying}
        />

        <div className={styles.albumCardBody}>
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
                    size={17}
                    fill={favorited ? '#f59e0b' : 'none'}
                    stroke={favorited ? '#f59e0b' : 'currentColor'}
                  />
                </button>
              ) : (
                <span className={styles.trashBadge} data-testid="collection-trash-badge">
                  已移入回收站
                </span>
              )}
            </div>
          </div>

          {collection.excerpt ? (
            <p className={styles.cardExcerpt}>{collection.excerpt}</p>
          ) : (
            <p className={styles.cardExcerptMuted}>点击进入故事集查看章节与伴听详情</p>
          )}

          <div className={styles.albumCardFooter}>
            <div className={styles.albumMetaGroup}>
              <span className={styles.workCountPill} data-testid="collection-work-count">
                <BookOpen size={12} aria-hidden="true" />
                <span>{formatCollectionWorkCount(collection.workCount)}</span>
              </span>

              {hasProgress && !isTrash ? (
                <span className={styles.progressTag}>
                  <Headphones size={11} aria-hidden="true" />
                  <span>{isCurrentCollectionPlaying ? '正在伴听' : '有待续播'}</span>
                </span>
              ) : dateLabel ? (
                <span className={styles.dateTag}>{dateLabel}更新</span>
              ) : null}
            </div>

            {!isTrash && collection.workCount > 0 ? (
              <button
                type="button"
                className={`${styles.playBtn} ${isCurrentCollectionPlaying ? styles.playBtnPlaying : ''}`}
                onClick={handlePlayAction}
                disabled={isStartingPlay}
                data-testid={`collection-play-btn-${collection.id}`}
                aria-label={`${playButtonLabel}《${collection.title}》`}
              >
                <PlayIcon
                  size={13}
                  fill={PlayIcon === Play ? 'currentColor' : 'none'}
                  aria-hidden="true"
                />
                <span>{playButtonLabel}</span>
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {isTrash ? (
        <div className={styles.cardActions}>
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
        </div>
      ) : null}

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
