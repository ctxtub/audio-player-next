'use client';
import { userFacingError } from '@/lib/client/userFacingError';
import { useState } from 'react';
import Link from 'next/link';
import { useLibraryMutationsSafe } from '@/lib/client/libraryMutations';
import { workPath } from '@/lib/navigation/storyRoutes';
import { playStoryWork } from '@/app/services/playbackSessionFlow';
import GlassToast from '@/components/ui/GlassToast';
import type { StoryWorkSummaryDTO } from '@/lib/trpc/schemas/library';
import styles from './storyControls.module.scss';

/** 单篇更多操作，无单篇收藏与回收站，删除直接物理删除。 */
export function WorkManagement({ work }: { work: StoryWorkSummaryDTO }) {
  const mutations = useLibraryMutationsSafe();
  const [title, setTitle] = useState(work.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      const message = userFacingError(err, '操作失败，请重试');
      setError(message);
      GlassToast.show({ icon: 'fail', content: message });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = () => {
    void run(async () => {
      await mutations?.moveToTrash({ id: work.id, title: work.title });
      GlassToast.show({ icon: 'success', content: '故事已删除' });
      setConfirmDelete(false);
    });
  };

  return (
    <details className={styles.menu}>
      <summary aria-label={`管理《${work.title}》`}>更多</summary>
      <div className={styles.menuBody}>
        <Link href={workPath(work.id, work.collectionId)}>查看正文</Link>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => playStoryWork(work.id, { mode: 'restart' }))}
        >
          从头播放
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => mutations?.rename({ id: work.id, title }) ?? Promise.resolve());
          }}
        >
          <label>
            故事标题
            <input
              aria-label={`修改《${work.title}》标题`}
              value={title}
              maxLength={100}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <button type="submit" className={styles.primaryAction} disabled={busy || !title.trim()}>
            保存标题
          </button>
        </form>
        {confirmDelete ? (
          <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
            <button
              type="button"
              className={styles.dangerAction}
              disabled={busy}
              onClick={handleDelete}
            >
              确认彻底删除
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={styles.dangerAction}
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            删除故事
          </button>
        )}
        {error && (
          <p className={styles.recordError} role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
