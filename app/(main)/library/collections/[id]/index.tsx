'use client';

/**
 * Collection 详情页客户端 Shell（）。
 *
 * - 头部：返回、标题、重命名、收藏、删除（集合级生命周期）；
 * - 成员：按服务端 position 升序直出（areMemberPositionsOrdered 复核），逐 Work 播放；
 * - 软删除集合 fail closed：服务端 get 拒绝 → 统一不可用视图；
 * - 删除成功后自动导航回 /library（Undo 跨路由留存于 layout provider）。
 */

import React, { useContext, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { libraryReturnPath } from '@/components/Library/LibraryNavigationMemory';
import { WorkManagement } from '@/components/Library/WorkManagement';
import { conversationPath, workPath } from '@/lib/navigation/storyRoutes';
import { playCollection } from '@/app/services/collectionPlaybackFlow';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  AlertCircle,
  BookOpen,
  ChevronLeft,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
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
import styles from './index.module.scss';

export interface CollectionDetailPageProps {
  id: string;
}

const CollectionDetailPage: React.FC<CollectionDetailPageProps> = ({ id }) => {
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
  const [startingWorkId, setStartingWorkId] = useState<number | null>(null);
  const playRequestSeqRef = useRef(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const currentWorkId = usePlaybackSessionStore((state) =>
    state.source?.kind === 'work' ? state.source.workId : null,
  );
  const playbackStatus = usePlaybackSessionStore((state) => state.status);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);

  const { data, isLoading, isError, error, refetch } = useCollectionDetailQuery(id, {
    enabled: isValidId,
  });

  useEffect(() => {
    if (data && focusWork && data.works.some((work) => String(work.id) === focusWork)) document.getElementById(`work-${focusWork}`)?.scrollIntoView({ block: 'center' });
  }, [data, focusWork]);
  const handlePlayCollection = async (mode: 'resume' | 'restart') => {
    setActionError(null);
    try { await playCollection(id, mode); } catch (err) { setActionError(err instanceof Error ? err.message : '暂时无法播放，请重试'); }
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
      if (router) router.push(libraryReturnPath());
    } catch (err) {
      console.error('Collection delete failed:', err);
    } finally {
      setIsDeleting(false);
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
      // 旧请求晚到不得清掉更新目标的 preparing 状态。
      if (playRequestSeqRef.current === requestSeq) {
        setStartingWorkId(null);
      }
    }
  };

  return (
    <div className={styles.storyDetailPage} data-testid="collection-detail-page">
      <header className={styles.detailHero}>
        <Link href={libraryReturnPath()} className={styles.backLink} data-testid="collection-back-btn">
          <ChevronLeft size={16} />
          <span>返回故事库</span>
        </Link>
        <div className={styles.heroPanel}>
          <div className={styles.titleArea}>
            <p className={styles.eyebrow}>故事集</p>
            {isRenaming ? (
              <form
                className={styles.renameForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSaveRename();
                }}
              >
                <input
                  className={styles.renameInput}
                  aria-label="作品集标题"
                  data-testid="collection-rename-input"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  maxLength={80}
                  autoFocus
                />
                <div className={styles.renameActions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    data-testid="collection-rename-cancel"
                    onClick={() => setIsRenaming(false)}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className={styles.primaryButton}
                    data-testid="collection-rename-save"
                    disabled={isSaving || draftTitle.trim().length === 0}
                  >
                    {isSaving ? '保存中…' : '保存'}
                  </button>
                </div>
              </form>
            ) : (
              <h1 className={styles.detailTitle} data-testid="collection-title">
                {data.title}
              </h1>
            )}
            <p className={styles.workCount} data-testid="collection-work-count">
              {formatCollectionWorkCount(data.workCount)} · 按创作顺序排列
            </p>
          </div>
          <div className={styles.collectionActions}>
            <button className={styles.primaryButton} disabled={!data.works.length} onClick={() => handlePlayCollection('resume')}>继续听整集</button>
            <button className={styles.secondaryButton} disabled={!data.works.length} onClick={() => handlePlayCollection('restart')}>从头听整集</button>
            {data.conversationId && <Link className={styles.secondaryButton} href={conversationPath(data.conversationId)}>查看创作记录</Link>}
            {!isRenaming ? (
              <button
                type="button"
                className={styles.secondaryButton}
                data-testid="collection-rename-btn"
                onClick={() => {
                  setDraftTitle(data.title);
                  setIsRenaming(true);
                }}
              >
                <Pencil size={14} />
                <span>重命名</span>
              </button>
            ) : null}
            <button
              type="button"
              className={`${styles.secondaryButton} ${favorited ? styles.favoriteActive : ''}`}
              data-testid="collection-favorite-btn"
              data-favorited={favorited ? 'true' : 'false'}
              disabled={isTogglingFavorite}
              onClick={handleToggleFavorite}
              aria-label={favorited ? '取消收藏' : '收藏'}
            >
              <Star size={15} fill={favorited ? 'currentColor' : 'none'} />
              <span>{favorited ? '已收藏' : '收藏'}</span>
            </button>
            <button
              type="button"
              className={styles.dangerButton}
              data-testid="collection-delete-btn"
              disabled={isDeleting}
              onClick={handleDelete}
            >
              <Trash2 size={14} />
              <span>{isDeleting ? '删除中…' : '删除作品集'}</span>
            </button>
          </div>
        </div>
      </header>

      <main className={styles.membersSection} data-testid="collection-members">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>播放列表</p>
            <h2>集内作品</h2>
          </div>
          <span>{data.workCount} 篇</span>
        </div>
        {actionError ? (
          <p className={styles.actionError} role="alert">
            {actionError}
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
            <p>这个作品集还没有完整作品</p>
          </div>
        ) : (
          <div className={styles.memberList}>
            {data.works.map((work) => {
              const isCurrent = currentWorkId === work.id;
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
                  className={`${styles.memberCard} ${isCurrent ? styles.memberCardCurrent : ''}`}
                  data-testid={`member-work-${work.id}`}
                  data-position={work.position}
                  data-playback-state={
                    isPreparing ? 'preparing' : isCurrentPlaying ? 'playing' : isCurrent ? playbackStatus : 'idle'
                  }
                >
                  <div className={styles.memberPosition} aria-hidden="true">
                    {String(work.position + 1).padStart(2, '0')}
                  </div>
                  <div className={styles.memberBody}>
                    <div className={styles.memberTitleRow}>
                      <h3 data-testid={`member-title-${work.id}`}><Link href={workPath(work.id, id)}>{work.title}</Link></h3>
                      {isCurrent ? <span className={styles.currentBadge}>当前作品</span> : null}
                    </div>
                    {work.excerpt ? <p className={styles.memberExcerpt}>{work.excerpt}</p> : null}
                    <p className={styles.memberExcerpt}>{work.progress?.positionMs ? `听到 ${Math.floor(work.progress.positionMs / 60000)}分${Math.floor(work.progress.positionMs / 1000) % 60}秒` : '未听'}{work.audio.durationMs ? ` · 时长 ${Math.ceil(work.audio.durationMs / 60000)}分钟` : ' · 播放时准备语音'}</p>
                  </div>
                  <button
                    type="button"
                    className={`${styles.playButton} ${isCurrentPlaying ? styles.playButtonActive : ''}`}
                    data-testid={`member-play-${work.id}`}
                    onClick={() => handlePlayWork(work.id)}
                    disabled={isPreparing}
                    aria-label={`${buttonLabel}《${work.title}》`}
                  >
                    <ButtonIcon
                      size={15}
                      fill={ButtonIcon === Play ? 'currentColor' : 'none'}
                      className={isPreparing ? styles.spinning : undefined}
                    />
                    <span>{buttonLabel}</span>
                  </button>
                  <WorkManagement work={{ ...work, collectionId: id }} />
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
