'use client';

/**
 * Collection 卡片（：故事库顶层恒为集合）。
 *
 * - active/favorites 视图：标题为详情链接（/library/collections/{id}）；
 * - trash 视图：标题纯静态文本（零详情入口，防探测），仅恢复/永久删除；
 * - 收藏切换与删除经 useCollectionMutations（乐观补丁 + 串行 Undo 会话）。
 */

import React, { useState } from 'react';
import Link from 'next/link';
import { Star, Trash2, RotateCcw } from 'lucide-react';
import type { StoryCollectionSummaryDTO } from '@/lib/trpc/schemas/collection';
import type { CollectionView } from '@/lib/trpc/schemas/collection';
import { useCollectionMutations } from '@/lib/client/collectionMutations';
import {
  formatCollectionWorkCount,
  isCollectionFavorited,
} from '@/lib/client/collectionViewModel';
import styles from './libraryComponents.module.scss';

export interface CollectionCardProps {
  collection: StoryCollectionSummaryDTO;
  view: CollectionView;
}

export const CollectionCard: React.FC<CollectionCardProps> = ({ collection, view }) => {
  const mutations = useCollectionMutations();
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isDeletingPermanently, setIsDeletingPermanently] = useState(false);

  const isTrash = view === 'trash';
  const favorited = isCollectionFavorited(collection);

  const handleToggleFavorite = async () => {
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

  const handleMoveToTrash = async () => {
    if (isTrashing) return;
    setIsTrashing(true);
    try {
      await mutations.moveToTrash(collection.id, collection.title);
    } catch (err) {
      console.error('Collection trash failed:', err);
    } finally {
      setIsTrashing(false);
    }
  };

  const handleRestore = async () => {
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

  const handleDeleteForever = async () => {
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
      className={styles.storyCard}
      data-testid={`collection-card-${collection.id}`}
      data-collection-id={collection.id}
    >
      <div className={styles.cardHeader}>
        {isTrash ? (
          <div className={styles.cardTitleStatic} data-testid="collection-title-static">
            <h3 className={styles.cardTitle} data-testid="collection-title">
              {collection.title}
            </h3>
          </div>
        ) : (
          <Link
            href={`/library/collections/${collection.id}`}
            className={styles.cardTitleLink}
            data-testid={`collection-link-${collection.id}`}
          >
            <h3 className={styles.cardTitle} data-testid="collection-title">
              {collection.title}
            </h3>
          </Link>
        )}
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
                size={16}
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

      <div className={styles.cardActions}>
        {!isTrash ? (
          <button
            type="button"
            onClick={handleMoveToTrash}
            disabled={isTrashing}
            data-testid={`collection-trash-btn-${collection.id}`}
            aria-label={`删除作品集《${collection.title}》`}
          >
            <Trash2 size={14} />
            <span>删除</span>
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handleRestore}
              disabled={isRestoring}
              data-testid="collection-restore-btn"
              aria-label={`恢复作品集《${collection.title}》`}
            >
              <RotateCcw size={14} />
              <span>恢复</span>
            </button>
            <button
              type="button"
              onClick={() => setIsDeleteConfirmOpen(true)}
              data-testid="collection-permanent-delete-btn"
              aria-label={`永久删除作品集《${collection.title}》`}
            >
              <Trash2 size={14} />
              <span>永久删除</span>
            </button>
          </>
        )}
      </div>

      {isDeleteConfirmOpen ? (
        <div role="dialog" aria-modal="true" data-testid="collection-delete-confirm">
          <p>永久删除作品集《{collection.title}》及其全部成员？此操作不可撤销。</p>
          <button
            type="button"
            onClick={handleDeleteForever}
            disabled={isDeletingPermanently}
            data-testid="collection-delete-confirm-ok"
          >
            {isDeletingPermanently ? '删除中...' : '永久删除'}
          </button>
          <button
            type="button"
            onClick={() => setIsDeleteConfirmOpen(false)}
            data-testid="collection-delete-confirm-cancel"
          >
            取消
          </button>
        </div>
      ) : null}
    </article>
  );
};

export default CollectionCard;
