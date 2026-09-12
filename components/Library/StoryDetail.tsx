'use client';

import React, { useState, useEffect, useContext } from 'react';
import Link from 'next/link';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  ArrowLeft,
  Clock,
  Mic,
  FileText,
  Hash,
  Bookmark,
  Sparkles,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { LibraryDetailViewModel } from '@/lib/client/libraryViewModel';
import { useLibraryMutationsSafe } from '@/lib/client/libraryMutations';
import styles from './storyDetail.module.scss';

export interface StoryDetailProps {
  work: LibraryDetailViewModel;
  onRename?: (id: number, newTitle: string) => Promise<void>;
  onToggleFavorite?: (id: number, favorite: boolean) => Promise<void>;
  onMoveToTrash?: (id: number, title: string) => Promise<void>;
}

/**
 * 格式化持续时间（毫秒转为分:秒）
 */
function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) return '0:00';
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * 格式化日期时间
 */
function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

/**
 * 故事作品详情展示与变更组件（M3-07）
 *
 * 核心边界规范：
 * 1. 仅暴露 Rename / Favorite / Move to Trash 操作；
 * 2. 严禁暴露 Restore / Permanent Delete（回收站作品不可进入详情）；
 * 3. 字段保真：严格仅读取 StoryWorkDetail 已有字段，绝不跨越读取生成历史、播放进度或音频内部表；
 * 4. 播放进度缝隙：严格保持 work.progress === null（等待 M5 进度系统接入）。
 */
export const StoryDetail: React.FC<StoryDetailProps> = ({
  work,
  onRename,
  onToggleFavorite,
  onMoveToTrash,
}) => {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(work.title);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);
  const [isMovingToTrash, setIsMovingToTrash] = useState(false);

  const router = useContext(AppRouterContext);

  const mutations = useLibraryMutationsSafe();

  useEffect(() => {
    setTitleDraft(work.title);
  }, [work.title]);

  const handleOpenRename = () => {
    setTitleDraft(work.title);
    setRenameError(null);
    setIsEditingTitle(true);
  };

  const handleCancelRename = () => {
    setTitleDraft(work.title);
    setRenameError(null);
    setIsEditingTitle(false);
  };

  const handleSaveRename = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }
    const trimmed = titleDraft.trim();
    if (!trimmed) {
      setRenameError('标题不能为空');
      return;
    }
    if (trimmed === work.title) {
      setIsEditingTitle(false);
      return;
    }

    try {
      setIsRenaming(true);
      setRenameError(null);
      if (onRename) {
        await onRename(work.id, trimmed);
      } else if (mutations) {
        await mutations.rename({ id: work.id, title: trimmed });
      }
      setIsEditingTitle(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : '重命名失败');
    } finally {
      setIsRenaming(false);
    }
  };

  const handleToggleFavorite = async () => {
    try {
      setIsTogglingFavorite(true);
      const nextFavorite = !work.favoritedAt;
      if (onToggleFavorite) {
        await onToggleFavorite(work.id, nextFavorite);
      } else if (mutations) {
        await mutations.toggleFavorite({ id: work.id, favorite: nextFavorite });
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
        await onMoveToTrash(work.id, work.title);
      } else if (mutations) {
        await mutations.moveToTrash({ id: work.id, title: work.title });
        if (router) {
          router.push('/library');
        }
      }
    } catch (err) {
      console.error('Move to trash failed:', err);
      // 失败时留在详情页且数据由 mutation engine 局部 rollback
    } finally {
      setIsMovingToTrash(false);
    }
  };

  return (
    <div
      className={styles.detailContainer}
      data-testid="story-detail-container"
      data-work-id={work.id}
      data-has-progress={work.progress !== null}
    >
      {/* 顶部导航与返回 */}
      <nav className={styles.topNav}>
        <Link
          href="/library"
          className={styles.backLink}
          data-testid="back-to-library-link"
        >
          <ArrowLeft size={16} />
          <span>返回故事库</span>
        </Link>
        <span className={styles.idBadge} data-testid="story-detail-id">
          #{work.id}
        </span>
      </nav>

      {/* 标题与元信息 Hero */}
      <header className={styles.detailHero}>
        <div className={styles.titleRow}>
          {isEditingTitle ? (
            <form
              className={styles.renameForm}
              onSubmit={handleSaveRename}
              data-testid="story-detail-rename-form"
            >
              <input
                className={styles.renameInput}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                data-testid="story-detail-rename-input"
                autoFocus
                maxLength={100}
                disabled={isRenaming}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    handleCancelRename();
                  }
                }}
              />
              <div className={styles.renameActions}>
                <button
                  type="submit"
                  className={styles.saveRenameBtn}
                  data-testid="story-detail-rename-save-btn"
                  disabled={isRenaming || !titleDraft.trim()}
                >
                  {isRenaming ? '保存中...' : '保存'}
                </button>
                <button
                  type="button"
                  className={styles.cancelRenameBtn}
                  onClick={handleCancelRename}
                  data-testid="story-detail-rename-cancel-btn"
                  disabled={isRenaming}
                >
                  取消
                </button>
              </div>
              {renameError ? (
                <span className={styles.renameError} data-testid="story-detail-rename-error">
                  {renameError}
                </span>
              ) : null}
            </form>
          ) : (
            <div className={styles.titleWrapper}>
              <h1 className={styles.title} data-testid="story-detail-title">
                {work.title}
              </h1>
              {work.favoritedAt ? (
                <span
                  className={styles.favoriteBadge}
                  data-testid="story-detail-favorite-badge"
                  title={`收藏于 ${formatDateTime(work.favoritedAt)}`}
                >
                  <Bookmark size={14} />
                  <span>已收藏</span>
                </span>
              ) : null}
              <button
                type="button"
                className={styles.renameButton}
                onClick={handleOpenRename}
                data-testid="story-detail-rename-btn"
                title="重命名故事标题"
              >
                <Pencil size={15} />
                <span>重命名</span>
              </button>
            </div>
          )}

          <div className={styles.actionsGroup}>
            <button
              type="button"
              className={work.favoritedAt ? styles.favoriteBtnActive : styles.favoriteBtn}
              onClick={handleToggleFavorite}
              data-testid="story-detail-favorite-btn"
              disabled={isTogglingFavorite}
              title={work.favoritedAt ? '取消收藏' : '添加收藏'}
            >
              <Bookmark size={15} />
              <span>{work.favoritedAt ? '已收藏' : '收藏'}</span>
            </button>
            <button
              type="button"
              className={styles.trashBtn}
              onClick={handleMoveToTrash}
              data-testid="story-detail-trash-btn"
              disabled={isMovingToTrash}
              title="移入回收站"
            >
              <Trash2 size={15} />
              <span>{isMovingToTrash ? '处理中...' : '移入回收站'}</span>
            </button>
          </div>
        </div>

        {/* 元数据标签组 */}
        <div className={styles.metaRow}>
          <span className={styles.metaItem} data-testid="story-detail-created-at">
            <Clock size={14} />
            <span>创建于 {formatDateTime(work.createdAt)}</span>
          </span>
          <span className={styles.metaItem} data-testid="story-detail-voice">
            <Mic size={14} />
            <span>音色: {work.voiceId}</span>
          </span>
          <span className={styles.metaItem} data-testid="story-detail-audio-status">
            <span>音频: {work.audio?.status ?? 'none'}</span>
            {work.audio?.durationMs ? (
              <span> ({formatDuration(work.audio.durationMs)})</span>
            ) : null}
          </span>
          <span className={styles.metaItem} data-testid="story-detail-hash">
            <Hash size={14} />
            <span>Hash: {work.contentHash ? work.contentHash.slice(0, 10) : 'none'}</span>
          </span>
        </div>
      </header>

      {/* 摘要与导读 */}
      {work.excerpt ? (
        <section className={styles.excerptSection} data-testid="story-detail-excerpt">
          <p className={styles.excerptText}>{work.excerpt}</p>
        </section>
      ) : null}

      {/* 正文内容区 */}
      <section className={styles.textSection}>
        <h2 className={styles.sectionHeading}>
          <FileText size={18} />
          <span>故事正文</span>
        </h2>
        <div className={styles.storyText} data-testid="story-detail-text">
          {work.storyText}
        </div>
      </section>

      {/* 原始生成提示词 Prompt */}
      {work.prompt ? (
        <section className={styles.promptSection}>
          <h2 className={styles.sectionHeading}>
            <Sparkles size={18} />
            <span>创作提示词</span>
          </h2>
          <div className={styles.promptBox} data-testid="story-detail-prompt">
            {work.prompt}
          </div>
        </section>
      ) : null}

      {/* 消息来源追踪 */}
      {work.sourceMessageId ? (
        <footer className={styles.footerInfo} data-testid="story-detail-source-message">
          <span>来源对话消息: {work.sourceMessageId}</span>
        </footer>
      ) : null}
    </div>
  );
};

export default StoryDetail;
