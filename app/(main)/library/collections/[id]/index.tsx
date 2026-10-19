'use client';

import { userFacingError } from '@/lib/client/userFacingError';
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { libraryReturnPath } from '@/components/Library/LibraryNavigationMemory';
import { ConversationSwitchConfirmation } from '@/components/Library/ConversationSwitchConfirmation';
import { useConversationResume } from '@/components/Library/useConversationResume';
import { conversationPath, workPath } from '@/lib/navigation/storyRoutes';
import { playCollection } from '@/app/services/collectionPlaybackFlow';
import { formatPlaybackTime } from '@/lib/playback/formatTime';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  AlertCircle,
  BookOpen,
  ChevronLeft,
  History,
  LoaderCircle,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { useCollectionDetailQuery } from '@/lib/client/collectionQueries';
import { useCollectionMutations } from '@/lib/client/collectionMutations';
import {
  areMemberPositionsOrdered,
  formatCollectionWorkCount,
} from '@/lib/client/collectionViewModel';
import { playStoryWork } from '@/app/services/playbackSessionFlow';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { LibraryUnavailable, isUnavailableError } from '@/components/Library/LibraryUnavailable';
import GlassToast from '@/components/ui/GlassToast';
import { CollectionCoverArt } from '../../components/CollectionCoverArt';
import styles from './index.module.scss';

export interface CollectionDetailPageProps {
  id: string;
}

const CollectionDetailPage: React.FC<CollectionDetailPageProps> = ({ id }) => {
  const resumeFlow = useConversationResume();
  const isValidId = typeof id === 'string' && id.length > 0 && id.length <= 64;
  const router = useContext(AppRouterContext);
  const searchParams = useSearchParams();
  const focusWork = searchParams?.get('focusWork');
  const mutations = useCollectionMutations();

  const [isRenaming, setIsRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isTogglingFavorite, setIsTogglingFavorite] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);

  const [startingWorkId, setStartingWorkId] = useState<number | null>(null);
  const playRequestSeqRef = useRef(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const currentWorkId = usePlaybackSessionStore((state) =>
    state.source?.kind === 'work' ? state.source.workId : null,
  );
  const playbackStatus = usePlaybackSessionStore((state) => state.status);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const currentTime = usePlaybackStore((state) => state.currentTime);
  const duration = usePlaybackStore((state) => state.duration);
  const savedPositionMs = usePlaybackSessionStore((state) => state.savedWorkPositionMs);
  const savedDurationMs = usePlaybackSessionStore((state) => state.savedWorkDurationMs);

  const { data, isLoading, isError, error, refetch } = useCollectionDetailQuery(id, {
    enabled: isValidId,
  });

  useEffect(() => {
    if (data && focusWork && data.works.some((work) => String(work.id) === focusWork)) {
      document.getElementById(`work-${focusWork}`)?.scrollIntoView({ block: 'center' });
    }
  }, [data, focusWork]);

  // 点击外部关闭下拉菜单
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMenuOpen]);

  const totalDurationSeconds = useMemo(() => {
    if (!data?.works?.length) return 0;
    return data.works.reduce((acc, work) => {
      const ms = work.audio?.durationMs ?? work.progress?.durationMs ?? 0;
      return acc + Math.max(0, ms / 1000);
    }, 0);
  }, [data?.works]);

  const isCollectionPlaying = useMemo(() => {
    if (!isPlaying || !currentWorkId || !data?.works) return false;
    return data.works.some((work) => work.id === currentWorkId);
  }, [isPlaying, currentWorkId, data?.works]);

  const handlePlayCollection = async (mode: 'resume' | 'restart') => {
    setActionError(null);
    try {
      await playCollection(id, mode);
    } catch (err) {
      setActionError(userFacingError(err, '暂时无法播放，请重试'));
    }
  };

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
          <h2 className={styles.errorTitle}>故事集加载失败</h2>
          <p className={styles.errorMessage}>
            {userFacingError(error, '网络或服务异常，请稍后重试')}
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
            <Link href={libraryReturnPath()} className={styles.backLink} data-testid="collection-back-btn">
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
    if (isSaving || !draftTitle.trim()) return;
    setIsSaving(true);
    try {
      await mutations.rename(data.id, draftTitle.trim(), data.title);
      setIsRenaming(false);
      GlassToast.show({ icon: 'success', content: '故事集名称已修改' });
    } catch (err) {
      console.error('Collection rename failed:', err);
      GlassToast.show({ icon: 'fail', content: '修改失败，请重试' });
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
      GlassToast.show({ icon: 'success', content: '故事集已移入回收站' });
      if (router) router.push(libraryReturnPath());
    } catch (err) {
      console.error('Collection delete failed:', err);
      GlassToast.show({ icon: 'fail', content: '删除失败，请重试' });
    } finally {
      setIsDeleting(false);
      setIsDeleteConfirmOpen(false);
    }
  };

  const handlePlayWork = async (workId: number) => {
    const requestSeq = playRequestSeqRef.current + 1;
    playRequestSeqRef.current = requestSeq;
    setActionError(null);
    setStartingWorkId(workId);
    try {
      await playStoryWork(workId);
    } catch (err) {
      console.error('Collection member play failed:', err);
      if (playRequestSeqRef.current === requestSeq) {
        setActionError('暂时无法播放这篇作品，请稍后重试。');
      }
    } finally {
      if (playRequestSeqRef.current === requestSeq) {
        setStartingWorkId(null);
        void refetch();
      }
    }
  };

  return (
    <div className={styles.storyDetailPage} data-testid="collection-detail-page">
      <ConversationSwitchConfirmation
        open={resumeFlow.confirmationOpen}
        collectionTitle={resumeFlow.confirmationTitle}
        resolve={resumeFlow.resolveConfirmation}
      />

      {/* 顶部导航与操作栏 */}
      <div className={styles.detailNav}>
        <Link href={libraryReturnPath()} className={styles.backLink} data-testid="collection-back-btn">
          <ChevronLeft size={16} />
          <span>返回故事库</span>
        </Link>
        <div className={styles.navActions}>
          {data.conversationId ? (
            <Link
              className={styles.navHistoryLink}
              href={conversationPath(data.conversationId)}
              data-testid="collection-view-history-btn"
            >
              <History size={14} aria-hidden="true" />
              <span>查看创作记录</span>
            </Link>
          ) : null}

          <button
            type="button"
            className={`${styles.navIconBtn} ${favorited ? styles.favoriteActive : ''}`}
            data-testid="collection-favorite-btn"
            data-favorited={favorited ? 'true' : 'false'}
            disabled={isTogglingFavorite}
            onClick={handleToggleFavorite}
            aria-label={favorited ? '取消收藏' : '收藏'}
            title={favorited ? '取消收藏' : '收藏'}
          >
            <Star size={17} fill={favorited ? '#f59e0b' : 'none'} stroke={favorited ? '#f59e0b' : 'currentColor'} />
          </button>

          <div className={styles.menuWrapper} ref={menuRef}>
            <button
              type="button"
              className={styles.navIconBtn}
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              aria-label="管理故事集"
              data-testid="collection-menu-trigger"
              title="更多操作"
            >
              <MoreVertical size={17} />
            </button>

            {isMenuOpen && (
              <div className={styles.dropdownMenu} role="menu" data-testid="collection-dropdown-menu">
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    setDraftTitle(data.title);
                    setIsRenaming(true);
                    setIsMenuOpen(false);
                  }}
                  data-testid="collection-rename-btn"
                >
                  <Pencil size={15} />
                  <span>重命名故事集</span>
                </button>
                <button
                  type="button"
                  className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
                  onClick={() => {
                    setIsDeleteConfirmOpen(true);
                    setIsMenuOpen(false);
                  }}
                  data-testid="collection-delete-btn"
                >
                  <Trash2 size={15} />
                  <span>移入回收站</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 专辑英雄卡片区（SVG 矢量封面 + 标题统计 + 统一操作栏） */}
      <header className={styles.detailHero}>
        <div className={styles.heroPanel}>
          <div className={styles.heroTopRow}>
            <CollectionCoverArt
              title={data.title}
              collectionId={data.id}
              size="lg"
              isPlaying={isCollectionPlaying}
            />
            <div className={styles.titleArea}>
              <p className={styles.eyebrow}>STORY COLLECTION · 故事集</p>
              <h1 className={styles.detailTitle} data-testid="collection-title">
                {data.title}
              </h1>
              <p className={styles.workCount} data-testid="collection-work-count">
                {formatCollectionWorkCount(data.workCount)}
                {totalDurationSeconds > 0
                  ? ` · 总时长 ${formatPlaybackTime(Math.floor(totalDurationSeconds))}`
                  : ''}
                {' · 按创作顺序排列'}
              </p>
            </div>
          </div>

          {/* 核心播放与续写主操作栏 */}
          <div className={styles.playbackActions}>
            <button
              type="button"
              className={styles.primaryPlayButton}
              disabled={!data.works.length}
              onClick={() => handlePlayCollection('resume')}
              data-testid="collection-play-resume"
              aria-label="继续播放整集"
              title="继续播放"
            >
              <Play size={14} fill="currentColor" aria-hidden="true" />
              <span>继续播放</span>
            </button>

            {data.conversationId ? (
              <button
                type="button"
                className={styles.continueCreateButton}
                disabled={resumeFlow.busy}
                onClick={() => void resumeFlow.resume(data.conversationId!, data.title)}
                data-testid="collection-resume-creation-btn"
              >
                <Sparkles size={14} aria-hidden="true" />
                <span>{resumeFlow.busy ? '正在准备创作…' : '续写新章节'}</span>
              </button>
            ) : null}

            <button
              type="button"
              className={styles.secondaryPlayButton}
              disabled={!data.works.length}
              onClick={() => handlePlayCollection('restart')}
              data-testid="collection-play-restart"
              aria-label="从头播放整集"
              title="从头播放"
            >
              <RotateCcw size={13} aria-hidden="true" />
              <span>从头播放</span>
            </button>
          </div>
        </div>
      </header>

      {/* 重命名弹窗 Modal */}
      {isRenaming && (
        <div className={styles.modalOverlay} onClick={() => setIsRenaming(false)}>
          <div
            className={styles.modalDialog}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="collection-rename-dialog-title"
          >
            <h3 id="collection-rename-dialog-title" className={styles.modalTitle}>
              重命名故事集
            </h3>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveRename();
              }}
            >
              <input
                className={styles.renameInput}
                aria-label="故事集标题"
                data-testid="collection-rename-input"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                maxLength={80}
                autoFocus
              />
              <div className={styles.modalActions}>
                <button
                  type="button"
                  className={styles.modalCancelBtn}
                  data-testid="collection-rename-cancel"
                  onClick={() => setIsRenaming(false)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className={styles.modalConfirmBtn}
                  data-testid="collection-rename-save"
                  disabled={isSaving || draftTitle.trim().length === 0}
                >
                  {isSaving ? '保存中…' : '保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 Modal */}
      {isDeleteConfirmOpen && (
        <div className={styles.modalOverlay} onClick={() => setIsDeleteConfirmOpen(false)}>
          <div
            className={styles.modalDialog}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="collection-delete-dialog-title"
          >
            <h3 id="collection-delete-dialog-title" className={styles.modalTitle}>
              移入回收站？
            </h3>
            <p className={styles.modalMessage}>
              故事集《{data.title}》将被移入回收站，可以在故事库回收站中恢复或彻底删除。
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.modalCancelBtn}
                onClick={() => setIsDeleteConfirmOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.modalDangerBtn}
                data-testid="collection-delete-confirm-btn"
                disabled={isDeleting}
                onClick={handleDelete}
              >
                {isDeleting ? '处理中…' : '移入回收站'}
              </button>
            </div>
          </div>
        </div>
      )}

      <main className={styles.membersSection} data-testid="collection-members">
        <div className={styles.sectionHeading}>
          <div className={styles.sectionHeadingLeft}>
            <h2>章节目录</h2>
            <span className={styles.sectionHint}>点击标题或「正文」阅读全文</span>
          </div>
          <span className={styles.sectionCountBadge}>{data.workCount} 篇</span>
        </div>
        {actionError ? (
          <p className={styles.actionError} role="alert">
            {actionError}
          </p>
        ) : null}
        {resumeFlow.error ? (
          <p className={styles.actionError} role="alert">
            {resumeFlow.error}
          </p>
        ) : null}
        {!membersOrdered ? (
          <p className={styles.actionError} data-testid="collection-order-warning">
            成员顺序异常，请刷新重试
          </p>
        ) : null}
        {data.works.length === 0 ? (
          <div className={styles.emptyMembers}>
            <BookOpen size={24} />
            <p>这个故事集还没有已保存故事</p>
          </div>
        ) : (
          <div className={styles.trackList}>
            {data.works.map((work, visibleIndex) => {
              const isCurrent = currentWorkId === work.id;
              const hasLiveDuration = isCurrent && Number.isFinite(duration) && duration > 0;
              const durationSeconds = hasLiveDuration
                ? duration
                : ((isCurrent ? savedDurationMs : null) ?? work.audio.durationMs ?? work.progress?.durationMs ?? 0) / 1000;
              const positionSeconds = isCurrent
                ? hasLiveDuration ? currentTime : (savedPositionMs ?? work.progress?.positionMs ?? 0) / 1000
                : (work.progress?.positionMs ?? 0) / 1000;
              const heardSeconds = durationSeconds > 0 ? Math.min(positionSeconds, durationSeconds) : positionSeconds;
              const progressPercent =
                durationSeconds > 0 && heardSeconds > 0
                  ? Math.min(100, Math.round((heardSeconds / durationSeconds) * 100))
                  : 0;
              const isPreparing =
                startingWorkId === work.id ||
                (startingWorkId === null &&
                  isCurrent &&
                  (playbackStatus === 'hydrating' || playbackStatus === 'synthesizing'));
              const isCurrentPlaying = isCurrent && isPlaying;
              const isEnded = isCurrent && playbackStatus === 'ended';
              const buttonLabel = isPreparing
                ? '准备语音…'
                : isCurrentPlaying
                  ? '暂停'
                  : isEnded
                    ? '重新播放'
                    : isCurrent
                      ? '继续播放'
                      : work.progress?.positionMs
                        ? work.progress.durationMs && work.progress.positionMs >= work.progress.durationMs - 1000
                          ? '重新播放'
                          : '继续播放'
                        : '播放';
              const ButtonIcon = isPreparing
                ? LoaderCircle
                : isCurrentPlaying
                  ? Pause
                  : isEnded
                    ? RotateCcw
                    : Play;
              return (
                <article
                  key={work.id}
                  id={`work-${work.id}`}
                  className={`${styles.trackItem} ${isCurrent ? styles.trackItemCurrent : ''}`}
                  data-testid={`member-work-${work.id}`}
                  data-position={work.position}
                  data-playback-state={
                    isPreparing ? 'preparing' : isCurrentPlaying ? 'playing' : isCurrent ? playbackStatus : 'idle'
                  }
                  onClick={() => void handlePlayWork(work.id)}
                >
                  <div className={styles.trackLeading}>
                    {isCurrentPlaying ? (
                      <span className={styles.trackEqualizer} aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                    ) : (
                      <span className={styles.trackIndex} aria-hidden="true">
                        {String(visibleIndex + 1).padStart(2, '0')}
                      </span>
                    )}
                  </div>

                  <div className={styles.trackBody}>
                    <div className={styles.trackTitleRow}>
                      <h3 className={styles.trackTitle} data-testid={`member-title-${work.id}`}>
                        <Link
                          href={workPath(work.id, id)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {work.title}
                        </Link>
                      </h3>
                    </div>
                    <div className={styles.trackMetaRow}>
                      <p className={styles.trackMeta}>
                        {heardSeconds > 0
                          ? `听到 ${formatPlaybackTime(Math.floor(heardSeconds))}`
                          : '未听'}
                        {durationSeconds > 0
                          ? ` · 时长 ${formatPlaybackTime(Math.floor(durationSeconds))}`
                          : isPreparing || work.audio.status === 'preparing'
                            ? ' · 正在准备语音'
                            : work.audio.status === 'failed'
                              ? ' · 语音准备失败'
                              : work.audio.status === 'ready'
                                ? ' · 时长未知'
                                : ' · 播放时准备语音'}
                      </p>
                      {progressPercent > 0 ? (
                        <span className={styles.trackMiniProgress} aria-hidden="true">
                          <span
                            className={styles.trackMiniProgressFill}
                            style={{ width: `${progressPercent}%` }}
                          />
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className={styles.trackActions}>
                    <Link
                      href={workPath(work.id, id)}
                      className={styles.trackReadLink}
                      onClick={(e) => e.stopPropagation()}
                      title={`阅读《${work.title}》正文`}
                      aria-label={`阅读《${work.title}》正文`}
                    >
                      <BookOpen size={13} aria-hidden="true" />
                      <span>正文</span>
                    </Link>
                    <button
                      type="button"
                      className={`${styles.trackPlayBtn} ${isCurrentPlaying ? styles.trackPlayBtnActive : ''}`}
                      data-testid={`member-play-${work.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handlePlayWork(work.id);
                      }}
                      disabled={isPreparing}
                      aria-label={`${buttonLabel}《${work.title}》`}
                    >
                      <ButtonIcon
                        size={13}
                        fill={ButtonIcon === Play ? 'currentColor' : 'none'}
                        className={isPreparing ? styles.spinning : undefined}
                      />
                      <span>{buttonLabel}</span>
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};

export default CollectionDetailPage;
