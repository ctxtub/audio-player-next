'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, ListMusic, Loader2, MessageCircle } from 'lucide-react';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { useCollectionPlaybackStore } from '@/stores/collectionPlaybackStore';
import { useLibraryDetailQuery } from '@/lib/client/libraryQueries';
import { useCollectionDetailQuery } from '@/lib/client/collectionQueries';
import { collectionPath, conversationPath } from '@/lib/navigation/storyRoutes';
import { playStoryWork, refreshPlayingWorkMetadata } from '@/app/services/playbackSessionFlow';
import { prepareCollectionNextWork, selectCollectionWork } from '@/app/services/collectionPlaybackFlow';
import GlassToast from '@/components/ui/GlassToast';
import playerStyles from './ExpandedNowPlaying.module.scss';

/**
 * 播放内容导航与选集列表（像音乐播放列表一样展示全集曲目并支持即点即播）。
 */
export function PlayingWorkContext({ close, onSelect }: { close: () => void; onSelect?: () => void }) {
  const router = useRouter();
  const workId = usePlaybackSessionStore((state) => state.source?.kind === 'work' ? state.source.workId : null);
  const playbackStatus = usePlaybackSessionStore((state) => state.status);
  const queue = useCollectionPlaybackStore();
  const { data } = useLibraryDetailQuery(workId ?? 0, { enabled: workId !== null });
  const targetCollectionId = queue.collectionId ?? data?.collectionId ?? null;
  const { data: collectionDetail } = useCollectionDetailQuery(targetCollectionId ?? '', {
    enabled: Boolean(targetCollectionId),
  });

  useEffect(() => {
    if (data) refreshPlayingWorkMetadata(data);
  }, [data]);

  if (!workId) return null;

  const navigate = (path: string) => {
    close();
    router.push(path);
  };

  // 计算有效的全集曲目列表
  const effectiveWorks: Array<{ id: number; title: string }> = queue.collectionId && queue.works.length > 0
    ? queue.works
    : (collectionDetail?.works?.map((w) => ({ id: w.id, title: w.title })) ?? (data ? [{ id: data.id, title: data.title }] : []));

  const effectiveIndex = queue.collectionId && queue.index >= 0
    ? queue.index
    : Math.max(0, effectiveWorks.findIndex((w) => w.id === workId));

  const select = async (index: number) => {
    if (index < 0 || index >= effectiveWorks.length) return;
    try {
      if (queue.collectionId) {
        await selectCollectionWork(index);
      } else if (targetCollectionId) {
        useCollectionPlaybackStore.setState({
          collectionId: targetCollectionId,
          works: effectiveWorks,
          index,
          epoch: queue.epoch + 1,
          error: null,
          preparingWorkId: null,
          readyWorkId: null,
        });
        await playStoryWork(effectiveWorks[index].id, { origin: 'queue' });
        void prepareCollectionNextWork();
      } else {
        await playStoryWork(effectiveWorks[index].id, { origin: 'user' });
      }
      onSelect?.();
    } catch {
      GlassToast.show({ icon: 'fail', content: '准备语音失败，请重试或跳过' });
    }
  };

  const hasPlaylist = effectiveWorks.length > 0;

  return (
    <div className={playerStyles.playingWorkWrapper}>
      {hasPlaylist && (
        <section className={playerStyles.playlistCard} aria-label="集内播放列表">
          <div className={playerStyles.playlistHeader}>
            <div className={playerStyles.playlistTitleGroup}>
              <ListMusic size={16} className={playerStyles.playlistIcon} aria-hidden="true" />
              <span className={playerStyles.playlistTitle}>选集</span>
              <span className={playerStyles.playlistCounter}>
                {effectiveWorks.length} 篇
              </span>
            </div>
          </div>

          <div className={playerStyles.playlistTrackList} role="list" aria-label="选集列表">
            {effectiveWorks.map((work, idx) => {
              const isCurrent = work.id === workId;
              const isPlaying = isCurrent && playbackStatus === 'playing';
              return (
                <button
                  key={work.id}
                  type="button"
                  className={playerStyles.playlistTrackItem}
                  data-current={isCurrent ? 'true' : 'false'}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => select(idx)}
                >
                  <span className={playerStyles.trackNumberZone}>
                    {isPlaying ? (
                      <span className={playerStyles.soundWaveIndicator} aria-label="正在播放">
                        <span />
                        <span />
                        <span />
                      </span>
                    ) : (
                      <span className={playerStyles.trackNumber}>
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                    )}
                  </span>
                  <span className={playerStyles.trackTitle}>
                    {work.title}
                  </span>
                </button>
              );
            })}
          </div>

          {queue.preparingWorkId && (
            <p className={playerStyles.playlistStatusLine} role="status">
              <Loader2 className={playerStyles.spinner} size={13} aria-hidden="true" />
              <span>正在准备下一篇语音…</span>
            </p>
          )}

          {queue.readyWorkId && (
            <p className={playerStyles.playlistStatusLine} role="status">
              <span>下一篇已准备好</span>
            </p>
          )}

          {queue.error && (
            <div className={playerStyles.playlistErrorAlert} role="alert">
              <p>下一篇准备失败</p>
              <div className={playerStyles.playlistErrorActions}>
                <button type="button" onClick={() => select(effectiveIndex)}>重试当前篇</button>
                <button
                  type="button"
                  disabled={effectiveIndex >= effectiveWorks.length - 1}
                  onClick={() => select(effectiveIndex + 1)}
                >
                  跳过
                </button>
              </div>
            </div>
          )}

          {queue.collectionId && (
            <button
              type="button"
              className={playerStyles.playlistCloseBtn}
              onClick={queue.clear}
            >
              关闭整集连播
            </button>
          )}
        </section>
      )}
      {(data?.collectionId || data?.conversationId) && (
        <div className={playerStyles.playingWorkContextNav} data-testid="playing-work-context-nav">
          {data?.collectionId && (
            <button type="button" onClick={() => navigate(`${collectionPath(data.collectionId!)}?focusWork=${workId}`)}>
              <BookOpen size={16} aria-hidden="true" />
              <span>查看故事集</span>
            </button>
          )}
          {data?.conversationId && (
            <button type="button" onClick={() => navigate(`${conversationPath(data.conversationId!)}${data.sourceMessageId ? `?focusMessage=${encodeURIComponent(data.sourceMessageId)}` : ''}`)}>
              <MessageCircle size={16} aria-hidden="true" />
              <span>查看创作记录</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
