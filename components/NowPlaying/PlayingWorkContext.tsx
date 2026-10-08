'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { useCollectionPlaybackStore } from '@/stores/collectionPlaybackStore';
import { useLibraryDetailQuery } from '@/lib/client/libraryQueries';
import { collectionPath, conversationPath } from '@/lib/navigation/storyRoutes';
import { refreshPlayingWorkMetadata } from '@/app/services/playbackSessionFlow';
import { selectCollectionWork } from '@/app/services/collectionPlaybackFlow';
import GlassToast from '@/components/ui/GlassToast';
import styles from '@/components/Library/storyControls.module.scss';
/** 播放内容导航和回听队列只消费正式归属及编排入口。 */
export function PlayingWorkContext({ close }: { close: () => void }) {
  const router = useRouter();
  const workId = usePlaybackSessionStore((state) => state.source?.kind === 'work' ? state.source.workId : null);
  const queue = useCollectionPlaybackStore();
  const { data } = useLibraryDetailQuery(workId ?? 0, { enabled: workId !== null });
  useEffect(() => { if (data) refreshPlayingWorkMetadata(data); }, [data]);
  if (!workId) return null;
  const navigate = (path: string) => { close(); router.push(path); };
  const select = async (index: number) => { try { await selectCollectionWork(index); } catch { GlassToast.show({ icon: 'fail', content: '准备语音失败，请重试或跳过' }); } };
  return <div className={styles.menuBody}>
    {data?.collectionId && <button onClick={() => navigate(`${collectionPath(data.collectionId!)}?focusWork=${workId}`)}>查看故事集</button>}
    {data?.conversationId && <button onClick={() => navigate(`${conversationPath(data.conversationId!)}${data.sourceMessageId ? `?focusMessage=${encodeURIComponent(data.sourceMessageId)}` : ''}`)}>查看创作记录</button>}
    {queue.collectionId && <section aria-label="集内播放列表">
      <p>整集回听 · 第 {queue.index + 1} / {queue.works.length} 篇</p>
      <button disabled={queue.index <= 0} onClick={() => select(queue.index - 1)}>上一篇</button>
      <button disabled={queue.index >= queue.works.length - 1} onClick={() => select(queue.index + 1)}>下一篇</button>
      <details><summary>播放列表</summary>{queue.works.map((work, index) => <button key={work.id} aria-current={index === queue.index ? 'true' : undefined} onClick={() => select(index)}>{index === queue.index ? '当前：' : ''}{work.title}</button>)}</details>
      {queue.error && <div role="alert"><p>下一篇准备失败</p><button onClick={() => select(queue.index)}>重试当前篇</button><button disabled={queue.index >= queue.works.length - 1} onClick={() => select(queue.index + 1)}>跳过</button></div>}
      <button onClick={queue.clear}>关闭整集连播</button>
    </section>}
  </div>;
}
