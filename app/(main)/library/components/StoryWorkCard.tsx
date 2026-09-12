'use client';

import React from 'react';
import Link from 'next/link';
import { Star, Play, Mic, Clock } from 'lucide-react';
import type { LibraryView } from '@/lib/client/library';
import type { LibraryItemViewModel } from '@/lib/client/libraryViewModel';
import styles from './libraryComponents.module.scss';

export interface StoryWorkCardProps {
  work: LibraryItemViewModel;
  view: LibraryView;
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
 * 故事库作品卡片组件
 *
 * 核心边界：
 * 1. active / favorites 视图：标题渲染为 Link 跳转 /library/[id]；
 * 2. trash 视图：严格禁止渲染 Detail Link（卡片不生成任何指向 /library/[id] 的链接）；
 * 3. 只做读取渲染，严禁提前接入收藏/删除/恢复/物理删除等 Mutation（归 M3-05/07）。
 */
export const StoryWorkCard: React.FC<StoryWorkCardProps> = ({ work, view }) => {
  const isTrash = view === 'trash';
  const canLinkDetail = !isTrash;

  // 时间展示：trash 视图展示删除时间（兜底创建时间），正常视图展示创建时间
  const displayTime = formatDisplayDate(
    isTrash ? (work.deletedAt ?? work.createdAt) : work.createdAt
  );
  const durationText = formatDuration(work.audio?.durationMs);

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
          {work.favoritedAt ? (
            <span
              className={styles.favoriteStar}
              aria-label="已收藏"
              data-testid={`story-card-favorite-icon-${work.id}`}
            >
              <Star size={16} fill="#f59e0b" stroke="#f59e0b" />
            </span>
          ) : null}

          {isTrash ? (
            <span
              className={styles.trashBadge}
              data-testid={`story-card-trash-badge-${work.id}`}
            >
              已移入回收站
            </span>
          ) : null}
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

      {/* 操作区域（读取期占位，不触发任何 mutation；回收站不提供播放，正常视图置灰等待 M5 接入） */}
      {!isTrash ? (
        <div className={styles.cardActions}>
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
        </div>
      ) : null}
    </article>
  );
};
