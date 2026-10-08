'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useLibraryMutationsSafe } from '@/lib/client/libraryMutations';
import { workPath } from '@/lib/navigation/storyRoutes';
import { playStoryWork } from '@/app/services/playbackSessionFlow';
import GlassToast from '@/components/ui/GlassToast';
import type { StoryWorkSummaryDTO } from '@/lib/trpc/schemas/library';
import styles from './storyControls.module.scss';
/** 单篇更多操作，复用已有变更与撤销流程。 */
export function WorkManagement({ work }: { work: StoryWorkSummaryDTO }) {
  const mutations = useLibraryMutationsSafe();
  const [title, setTitle] = useState(work.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); } catch (err) { const message = err instanceof Error ? err.message : '操作失败，请重试'; setError(message); GlassToast.show({ icon: 'fail', content: message }); } finally { setBusy(false); }
  };
  return <details className={styles.menu}>
    <summary aria-label={`管理《${work.title}》`}>更多</summary>
    <div className={styles.menuBody}>
      <Link href={workPath(work.id, work.collectionId)}>查看正文</Link>
      <button disabled={busy} onClick={() => run(() => playStoryWork(work.id, { mode: 'restart' }))}>从头播放</button>
      <button disabled={busy} onClick={() => run(() => mutations?.toggleFavorite({ id: work.id, favorite: !work.favoritedAt }) ?? Promise.resolve())}>{work.favoritedAt ? '取消收藏单篇' : '收藏单篇'}</button>
      <form onSubmit={(event) => { event.preventDefault(); void run(() => mutations?.rename({ id: work.id, title }) ?? Promise.resolve()); }}>
        <label>故事标题<input aria-label={`修改《${work.title}》标题`} value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} /></label>
        <button disabled={busy || !title.trim()}>保存标题</button>
      </form>
      <button disabled={busy} onClick={() => run(() => mutations?.moveToTrash({ id: work.id, title: work.title }) ?? Promise.resolve())}>移入回收站</button>
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
