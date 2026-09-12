'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Star, Play, Mic, Clock, Trash2, RotateCcw } from 'lucide-react';
import type { LibraryView } from '@/lib/client/library';
import type { LibraryItemViewModel } from '@/lib/client/libraryViewModel';
import { useLibraryMutationsSafe } from '@/lib/client/libraryMutations';
import styles from './libraryComponents.module.scss';

export interface StoryWorkCardProps {
  work: LibraryItemViewModel;
  view: LibraryView;
  onToggleFavorite?: (work: LibraryItemViewModel) => void | Promise<void>;
  onMoveToTrash?: (work: LibraryItemViewModel) => void | Promise<void>;
  onRestore?: (work: LibraryItemViewModel) => void | Promise<void>;
  onDeletePermanently?: (work: LibraryItemViewModel) => void | Promise<void>;
}

/**
 * 格式化展示时间（MM-DD HH:mm）
 */
function formatDisplayDate(dateStr?: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

/**
 * 格式化持续时间毫秒数（分:秒）
 */
function formatDuration(ms?: number | null): string | null {
  if (typeof ms !== 'number' || ms <= 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${seconds > 0 ? `${seconds}秒` : ''}`;
}

/**
 * 故事库作品卡片组件（M3-05 生命周期交互接入）
 *
 * 核心契约：
 * 1. active / favorites 视图：标题渲染为 Link 跳转 /library/[id]；
 * 2. trash 视图：严格禁止渲染 Detail Link（卡片内绝无任何指向 /library/[id] 的 <a> 链接）；
 * 3. 收藏切换：乐观更新，收藏 active 项绝不追加至 favorites 缓存；
 * 4. 移入回收站：无二次确认，触发乐观移除，通过 Undo 句柄支持安全撤销；
 * 5. 恢复：从回收站乐观移除，绝不向 active 列表本地拼接；
 * 6. 永久删除：必须二次确认（未确认前零 RPC），悲观执行。
 */
export const StoryWorkCard: React.FC<StoryWorkCardProps> = ({
  work,
  view,
  onToggleFavorite,
  onMoveToTrash,
  onRestore,
  onDeletePermanently,
}) => {
  const isTrash = view === 'trash';
  const canLinkDetail = !isTrash;

  const mutations = useLibraryMutationsSafe();

  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);
  const [isMovingToTrash, setIsMovingToTrash] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDeletingPermanently, setIsDeletingPermanently] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);

  // 时间展示：trash 视图展示删除时间（兜底创建时间），正常视图展示创建时间
  const displayTime = formatDisplayDate(
    isTrash ? (work.deletedAt ?? work.createdAt) : work.createdAt
  );
  const durationText = formatDuration(work.audio?.durationMs);

  const handleToggleFavorite = async () => {
    try {
      setIsTogglingFavorite(true);
      if (onToggleFavorite) {
        await onToggleFavorite(work);
      } else if (mutations) {
        await mutations.toggleFavorite({
          id: work.id,
          favorite: !work.favoritedAt,
          currentView: view,
        });
      }
    } catch (err) {
      console.error('Toggle favorite failed:', err);
    } finally {
      setIsTogglingFavorite(false);
    }
  };

  const handleMoveToTrash = async () => {
    try {
      setIsMovingToTrash(true);
      if (onMoveToTrash) {
        await onMoveToTrash(work);
      } else if (mutations) {
        await mutations.moveToTrash({
          id: work.id,
          title: work.title,
        });
      }
    } catch (err) {
      console.error('Move to trash failed:', err);
    } finally {
      setIsMovingToTrash(false);
    }
  };

  const handleRestore = async () => {
    try {
      setIsRestoring(true);
      if (onRestore) {
        await onRestore(work);
      } else if (mutations) {
        await mutations.restore({ id: work.id });
      }
    } catch (err) {
      console.error('Restore failed:', err);
    } finally {
      setIsRestoring(false);
    }
  };

  const handleConfirmPermanentDelete = async () => {
    try {
      setIsDeletingPermanently(true);
      if (onDeletePermanently) {
        await onDeletePermanently(work);
      } else if (mutations) {
        await mutations.deletePermanently({
          id: work.id,
          confirmed: true,
        });
      }
      setIsDeleteConfirmOpen(false);
    } catch (err) {
      console.error('Delete permanently failed:', err);
    } finally {
      setIsDeletingPermanently(false);
    }
  };

  return (
    <article
      className={styles.storyCard}
      data-testid={`story-work-card-${work.id}`}
      data-work-id={work.id}
    >
      {/* 头部：标题与状态标记 */}
      <div className={styles.cardHeader}>
        {canLinkDetail ? (
          <Link
            href={`/library/${work.id}`}
            className={styles.cardTitleLink}
            data-testid={`story-card-link-${work.id}`}
          >
            <h3 className={styles.cardTitle}>{work.title}</h3>
          </Link>
        ) : (
          <div
            className={styles.cardTitleStatic}
            data-testid={`story-card-static-${work.id}`}
          >
            <h3 className={styles.cardTitle}>{work.title}</h3>
          </div>
        )}

        <div className={styles.cardHeaderRight}>
          {!isTrash ? (
            <button
              type="button"
              className={styles.favoriteBtn}
              onClick={handleToggleFavorite}
              disabled={isTogglingFavorite}
              aria-label={work.favoritedAt ? `取消收藏《${work.title}》` : `收藏《${work.title}》`}
              data-testid={`story-card-favorite-btn-${work.id}`}
              title={work.favoritedAt ? '取消收藏' : '收藏'}
            >
              <Star
                size={16}
                fill={work.favoritedAt ? '#f59e0b' : 'none'}
                stroke={work.favoritedAt ? '#f59e0b' : '#9ca3af'}
              />
              {work.favoritedAt ? (
                <span
                  className={styles.favoriteStar}
                  aria-label="已收藏"
                  data-testid={`story-card-favorite-icon-${work.id}`}
                />
              ) : null}
            </button>
          ) : (
            <span
              className={styles.trashBadge}
              data-testid={`story-card-trash-badge-${work.id}`}
            >
              已移入回收站
            </span>
          )}
        </div>
      </div>

      {/* 摘要正文 */}
      <p
        className={styles.cardExcerpt}
        data-testid={`story-card-excerpt-${work.id}`}
      >
        {work.excerpt}
      </p>

      {/* 元数据行 */}
      <div className={styles.cardMeta}>
        {work.voiceId ? (
          <span className={styles.metaItem}>
            <Mic size={12} />
            <span>{work.voiceId}</span>
          </span>
        ) : null}

        {durationText ? (
          <>
            <span className={styles.metaDot}>•</span>
            <span className={styles.metaItem}>
              <Clock size={12} />
              <span>{durationText}</span>
            </span>
          </>
        ) : null}

        {displayTime ? (
          <>
            <span className={styles.metaDot}>•</span>
            <span className={styles.metaItem}>{displayTime}</span>
          </>
        ) : null}

        {work.audio?.status === 'preparing' ? (
          <>
            <span className={styles.metaDot}>•</span>
            <span className={styles.audioStatusBadge}>音频准备中</span>
          </>
        ) : null}
      </div>

      {/* 操作区域 */}
      <div className={styles.cardActions}>
        {!isTrash ? (
          <>
            <button
              type="button"
              className={styles.playBtn}
              disabled
              data-testid={`story-card-play-btn-${work.id}`}
              aria-label={`播放 ${work.title}（功能开发中）`}
              title="播放功能将在后续版本开放"
            >
              <Play size={12} fill="currentColor" />
              <span>播放</span>
            </button>
            <button
              type="button"
              className={styles.trashBtn}
              onClick={handleMoveToTrash}
              disabled={isMovingToTrash}
              data-testid={`story-card-trash-btn-${work.id}`}
              aria-label={`将《${work.title}》移入回收站`}
              title="移入回收站"
            >
              <Trash2 size={12} />
              <span>移入回收站</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.restoreBtn}
              onClick={handleRestore}
              disabled={isRestoring}
              data-testid={`story-card-restore-btn-${work.id}`}
              aria-label={`恢复《${work.title}》`}
              title="恢复"
            >
              <RotateCcw size={12} />
              <span>恢复</span>
            </button>
            <button
              type="button"
              className={styles.deletePermanentlyBtn}
              onClick={() => setIsDeleteConfirmOpen(true)}
              data-testid={`story-card-delete-permanently-btn-${work.id}`}
              aria-label={`永久删除《${work.title}》`}
              title="永久删除"
            >
              <Trash2 size={12} />
              <span>永久删除</span>
            </button>
          </>
        )}
      </div>

      {/* 永久删除二次确认模态弹窗 */}
      {isDeleteConfirmOpen ? (
        <div
          className={styles.confirmOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby={`delete-dialog-title-${work.id}`}
          data-testid={`permanent-delete-dialog-${work.id}`}
        >
          <div className={styles.confirmDialog}>
            <h4
              id={`delete-dialog-title-${work.id}`}
              className={styles.confirmTitle}
            >
              永久删除作品
            </h4>
            <p className={styles.confirmMessage}>
              确定要永久删除《{work.title}》吗？此操作将彻底删除该故事作品，无法撤销。
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={() => setIsDeleteConfirmOpen(false)}
                data-testid="permanent-delete-cancel-btn"
              >
                取消
              </button>
              <button
                type="button"
                className={styles.dangerBtn}
                disabled={isDeletingPermanently}
                onClick={handleConfirmPermanentDelete}
                data-testid="permanent-delete-confirm-btn"
              >
                {isDeletingPermanently ? '正在删除...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
};
