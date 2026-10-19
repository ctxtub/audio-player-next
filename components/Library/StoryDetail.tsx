'use client';
import { userFacingError } from '@/lib/client/userFacingError';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Clock,
  Mic,
  Sparkles,
  Pencil,
  Trash2,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
  BookOpen,
  History,
  Headphones,
} from 'lucide-react';
import type { LibraryDetailViewModel } from '@/lib/client/libraryViewModel';
import type { CollectionWorkSummaryDTO } from '@/lib/trpc/schemas/collection';
import { collectionPath, conversationPath, workPath } from '@/lib/navigation/storyRoutes';
import { libraryReturnPath } from './LibraryNavigationMemory';
import { WorkPlaybackButton } from './WorkPlaybackButton';
import { formatPlaybackTime } from '@/lib/playback/formatTime';
import styles from './storyDetail.module.scss';

export interface StoryDetailProps {
  work: LibraryDetailViewModel;
  playbackDurationMs?: number | null;
  collectionWorks?: CollectionWorkSummaryDTO[];
  onRename?: (id: number, newTitle: string) => Promise<void>;
  onToggleFavorite?: (id: number, favorite: boolean) => Promise<void>;
  onMoveToTrash?: (id: number, title: string) => Promise<void>;
}

/**
 * 格式化持续时间（毫秒转为 M:SS）
 */
function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) return '0:00';
  return formatPlaybackTime(Math.floor(durationMs / 1000));
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

const FRIENDLY_VOICE_LABELS: Record<string, string> = {
  'zh-CN-YunxiNeural': '云希 · 温暖男声',
  'zh-CN-XiaoxiaoNeural': '晓晓 · 温柔女声',
  'zh-CN-YunjianNeural': '云健 · 沉稳男声',
  'zh-CN-XiaoyiNeural': '晓伊 · 清甜女声',
  'zh-CN-YunyangNeural': '云扬 · 播音男声',
  'zh-CN-XiaohanNeural': '晓涵 · 柔和女声',
  alloy: 'Alloy · 平衡中性',
  echo: 'Echo · 沉稳男声',
  fable: 'Fable · 叙事音色',
  onyx: 'Onyx · 深沉男声',
  nova: 'Nova · 活力女声',
  shimmer: 'Shimmer · 轻柔女声',
};

function formatFriendlyVoiceName(voiceId?: string): string {
  if (!voiceId) return '默认伴读音色';
  return FRIENDLY_VOICE_LABELS[voiceId] ?? voiceId;
}

/**
 * 故事作品沉浸式阅读与伴听详情组件
 */
export const StoryDetail: React.FC<StoryDetailProps> = ({
  work,
  playbackDurationMs,
  collectionWorks,
  onRename,
  onMoveToTrash,
}) => {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(work.title);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [isMovingToTrash, setIsMovingToTrash] = useState(false);
  const managementRef = useRef<HTMLDetailsElement | null>(null);
  const durationMs = playbackDurationMs ?? work.audio?.durationMs;

  useEffect(() => {
    setTitleDraft(work.title);
  }, [work.title]);

  const chapterNavigation = useMemo(() => {
    if (!collectionWorks || collectionWorks.length === 0) {
      return { index: -1, total: 0, prev: null, next: null };
    }
    const idx = collectionWorks.findIndex((item) => item.id === work.id);
    if (idx === -1) {
      return { index: -1, total: collectionWorks.length, prev: null, next: null };
    }
    return {
      index: idx + 1,
      total: collectionWorks.length,
      prev: idx > 0 ? collectionWorks[idx - 1] : null,
      next: idx < collectionWorks.length - 1 ? collectionWorks[idx + 1] : null,
    };
  }, [collectionWorks, work.id]);

  const handleOpenRename = () => {
    if (managementRef.current) managementRef.current.open = false;
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
      }
      setIsEditingTitle(false);
    } catch (err) {
      setRenameError(userFacingError(err, '重命名失败'));
    } finally {
      setIsRenaming(false);
    }
  };

  const handleMoveToTrash = async () => {
    try {
      setIsMovingToTrash(true);
      if (onMoveToTrash) {
        await onMoveToTrash(work.id, work.title);
      }
    } catch (err) {
      console.error('Move to trash failed:', err);
    } finally {
      setIsMovingToTrash(false);
    }
  };

  const audioStatusText = {
    ready: '语音已就绪',
    preparing: '准备语音中',
    failed: '语音准备失败',
    missing: '播放时准备语音',
  }[work.audio?.status ?? 'missing'];

  return (
    <div
      className={styles.detailContainer}
      data-testid="story-detail-container"
      data-work-id={work.id}
      data-has-progress={work.progress !== null}
    >
      {/* 顶部导航栏：左侧返回故事集/库，右侧查看创作记录 + 管理故事菜单 */}
      <nav className={styles.topNav}>
        <Link
          href={work.collectionId ? collectionPath(work.collectionId) : libraryReturnPath()}
          className={styles.backLink}
          data-testid="back-to-library-link"
        >
          <ArrowLeft size={16} />
          <span>{work.collectionTitle ? `返回《${work.collectionTitle}》` : '返回故事库'}</span>
        </Link>

        <div className={styles.topNavRight}>
          {work.conversationId ? (
            <Link
              className={styles.recordLink}
              href={`${conversationPath(work.conversationId)}${work.sourceMessageId ? `?focusMessage=${encodeURIComponent(work.sourceMessageId)}` : ''}`}
            >
              <History size={14} aria-hidden="true" />
              <span>查看创作记录</span>
            </Link>
          ) : null}

          <details ref={managementRef} className={styles.managementMenu}>
            <summary>
              <MoreHorizontal size={15} aria-hidden="true" />
              <span>管理故事</span>
            </summary>
            <div className={styles.managementActions}>
              <button
                type="button"
                className={styles.renameButton}
                onClick={handleOpenRename}
                data-testid="story-detail-rename-btn"
              >
                <Pencil size={15} />
                <span>重命名</span>
              </button>
              <button
                type="button"
                className={styles.trashBtn}
                onClick={() => {
                  if (window.confirm(`确定要彻底删除《${work.title}》吗？删除后无法恢复。`)) {
                    void handleMoveToTrash();
                  }
                }}
                data-testid="story-detail-trash-btn"
                disabled={isMovingToTrash}
                title="删除故事"
              >
                <Trash2 size={15} />
                <span>{isMovingToTrash ? '删除中...' : '删除故事'}</span>
              </button>
            </div>
          </details>
        </div>
      </nav>

      {/* 紧凑阅读器头部与内嵌伴听控制条 */}
      <header className={styles.detailHero}>
        {chapterNavigation.index > 0 ? (
          <p className={styles.chapterEyebrow}>
            CHAPTER {String(chapterNavigation.index).padStart(2, '0')} / {String(chapterNavigation.total).padStart(2, '0')}
            {work.collectionTitle ? ` · 选自《${work.collectionTitle}》` : ''}
          </p>
        ) : work.collectionTitle ? (
          <p className={styles.chapterEyebrow}>选自故事集《{work.collectionTitle}》</p>
        ) : null}

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
            </div>
          )}
        </div>

        {/* 友好化元数据行 */}
        <div className={styles.metaRow}>
          <span className={styles.metaItem} data-testid="story-detail-voice">
            <Mic size={13} aria-hidden="true" />
            <span>朗读音色：{formatFriendlyVoiceName(work.voiceId)}</span>
          </span>
          <span className={styles.metaItem} data-testid="story-detail-created-at">
            <Clock size={13} aria-hidden="true" />
            <span>{formatDateTime(work.createdAt)}</span>
          </span>
        </div>

        {/* 内嵌伴读音频控制条 */}
        <div className={styles.readerAudioBar}>
          <div className={styles.readerAudioLeft}>
            <WorkPlaybackButton workId={work.id} title={work.title} progress={work.progress} />
            <div className={styles.readerAudioInfo}>
              <span className={styles.readerAudioStatus} data-testid="story-detail-audio-status">
                <Headphones size={13} aria-hidden="true" />
                <span>音频：{audioStatusText}</span>
                {durationMs ? <span> ({formatDuration(durationMs)})</span> : null}
              </span>
            </div>
          </div>

          <svg
            className={styles.readerWaveformSvg}
            viewBox="0 0 120 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            {[6, 12, 8, 16, 20, 10, 14, 18, 8, 15, 22, 12, 9, 17, 13, 7, 14, 19, 11, 8].map((h, idx) => (
              <rect
                key={idx}
                x={idx * 6}
                y={(24 - h) / 2}
                width="3"
                height={h}
                rx="1.5"
                fill="currentColor"
                fillOpacity={idx < 8 ? '0.65' : '0.28'}
              />
            ))}
          </svg>
        </div>
      </header>

      {/* 沉浸式正文内容区 */}
      <section className={styles.textSection} aria-label="故事正文">
        <div className={styles.storyText} data-testid="story-detail-text">
          {work.storyText}
        </div>
      </section>

      {/* 集合内上下章快速切换条 */}
      {work.collectionId && (chapterNavigation.prev || chapterNavigation.next) ? (
        <nav className={styles.chapterSwitcher} aria-label="章节切换">
          {chapterNavigation.prev ? (
            <Link
              href={workPath(chapterNavigation.prev.id, work.collectionId)}
              className={styles.chapterSwitchBtn}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              <div className={styles.chapterSwitchText}>
                <span className={styles.chapterSwitchLabel}>上一章</span>
                <span className={styles.chapterSwitchTitle}>{chapterNavigation.prev.title}</span>
              </div>
            </Link>
          ) : (
            <div className={styles.chapterSwitchPlaceholder} />
          )}

          <Link
            href={collectionPath(work.collectionId)}
            className={styles.chapterDirectoryLink}
            title="查看全部章节目录"
          >
            <BookOpen size={14} aria-hidden="true" />
            <span>目录</span>
          </Link>

          {chapterNavigation.next ? (
            <Link
              href={workPath(chapterNavigation.next.id, work.collectionId)}
              className={`${styles.chapterSwitchBtn} ${styles.chapterSwitchNext}`}
            >
              <div className={styles.chapterSwitchText}>
                <span className={styles.chapterSwitchLabel}>下一章</span>
                <span className={styles.chapterSwitchTitle}>{chapterNavigation.next.title}</span>
              </div>
              <ChevronRight size={16} aria-hidden="true" />
            </Link>
          ) : (
            <div className={styles.chapterSwitchPlaceholder} />
          )}
        </nav>
      ) : null}

      {/* 折叠式简介与原始创作提示词 */}
      <div className={styles.collapsibleMetaGroup}>
        {work.excerpt ? (
          <details className={styles.excerptSection} data-testid="story-detail-excerpt">
            <summary>故事简介</summary>
            <p className={styles.excerptText}>{work.excerpt}</p>
          </details>
        ) : null}

        {work.prompt ? (
          <details className={styles.promptSection}>
            <summary>创作提示词</summary>
            <div className={styles.promptBox} data-testid="story-detail-prompt">
              <div className={styles.promptHeading}>
                <Sparkles size={14} aria-hidden="true" />
                <span>原始生成提示词</span>
              </div>
              {work.prompt}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
};

export default StoryDetail;
