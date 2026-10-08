import { cancelPendingNextWork } from './continuousCreationFlow';
import { usePlaybackIntentStore } from '@/stores/playbackIntentStore';
import { useCollectionPlaybackStore } from '@/stores/collectionPlaybackStore';
import { useContinuousCreationStore } from '@/stores/continuousCreationStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { ensureAsset } from '@/lib/client/storyAudio';
import { createPlaybackSessionId } from '@/lib/playback/session';
import { getCollection } from '@/lib/client/collection';
import { playStoryWork } from './playbackSessionFlow';

/** 建立按创作顺序的回听快照，显式替换自动创作编排。 */
export async function playCollection(collectionId: string, mode: 'resume' | 'restart' = 'resume'): Promise<void> {
  usePlaybackIntentStore.getState().clearAutoplay();
  const store = useCollectionPlaybackStore;
  store.getState().clear();
  const epoch = store.getState().epoch;
  const detail = await getCollection(collectionId);
  if (store.getState().epoch !== epoch) return;
  if (!detail.works.length) throw new Error('这个故事集还没有可播放的故事');
  cancelPendingNextWork();
  useContinuousCreationStore.getState().setCreationWork(null);
  const unfinished = [...detail.works].filter((work) => work.progress && work.progress.positionMs > 0 && (!work.progress.durationMs || work.progress.positionMs < work.progress.durationMs - 1000)).sort((a, b) => b.progress!.lastPlayedAt.localeCompare(a.progress!.lastPlayedAt))[0];
  const target = mode === 'restart' ? detail.works[0] : unfinished ?? detail.works.find((work) => !work.progress || !work.progress.durationMs || work.progress.positionMs < work.progress.durationMs - 1000) ?? detail.works[0];
  store.setState({ collectionId, works: detail.works.map(({ id, title }) => ({ id, title })), index: detail.works.findIndex((work) => work.id === target.id) });
  await playStoryWork(target.id, { origin: 'queue', mode: mode === 'restart' || (!unfinished && detail.works.every((work) => work.progress?.completedAt)) ? 'restart' : 'resume' });
  void prepareCollectionNextWork();
}

/** 手动队列选择以当前最新目标为准，失败保留可重试目标。 */
export async function selectCollectionWork(index: number, mode: 'resume' | 'restart' = 'resume', timer?: { remaining: number; total: number | null }): Promise<void> {
  const queue = useCollectionPlaybackStore.getState();
  const work = queue.works[index];
  if (!work || !queue.collectionId) return;
  useCollectionPlaybackStore.setState({ index, error: null, preparingWorkId: null, readyWorkId: null, epoch: queue.epoch + 1 });
  const epoch = queue.epoch + 1;
  const playback = usePlaybackStore.getState();
  const inheritedTimer = timer ?? (playback.sleepTimerMode === 'minutes' && playback.remainingMs !== null && playback.remainingMs > 0 ? { remaining: playback.remainingMs, total: playback.totalAllowedMs } : undefined);
  try {
    await playStoryWork(work.id, { origin: 'queue', mode, timer: inheritedTimer });
    if (useCollectionPlaybackStore.getState().epoch === epoch) void prepareCollectionNextWork();
  }
  catch (error) {
    if (useCollectionPlaybackStore.getState().epoch === epoch) useCollectionPlaybackStore.setState({ error: error instanceof Error ? error.message : '准备下一篇失败' });
    throw error;
  }
}

/** 完播后推进已有作品；返回 true 表示队列接管，包括失败等待。 */
export async function advanceCollectionPlayback(sessionId: string | null): Promise<boolean> {
  const queue = useCollectionPlaybackStore.getState();
  if (!queue.collectionId || !sessionId) return false;
  const session = usePlaybackSessionStore.getState();
  if (session.sessionId !== sessionId || session.source?.kind !== 'work' || queue.works[queue.index]?.id !== session.source.workId) return false;
  const timer = usePlaybackStore.getState();
  const mode = session.sleepTimerMode;
  const remaining = timer.remainingMs;
  const total = timer.totalAllowedMs;
  await session.handleParagraphEnded();
  if (useCollectionPlaybackStore.getState().epoch !== queue.epoch || usePlaybackSessionStore.getState().sessionId !== sessionId) return true;
  if (mode === 'story_end' || (mode === 'minutes' && remaining !== null && remaining <= 0)) { queue.clear(); return true; }
  const detail = await getCollection(queue.collectionId).catch(() => null);
  if (useCollectionPlaybackStore.getState().epoch !== queue.epoch || usePlaybackSessionStore.getState().sessionId !== sessionId) return true;
  if (!detail) { useCollectionPlaybackStore.setState({ error: '故事集暂时不可用，请重试' }); return true; }
  const valid = new Set(detail.works.map((work) => work.id));
  let next = queue.index + 1;
  while (next < queue.works.length && !valid.has(queue.works[next].id)) next += 1;
  if (next >= queue.works.length) { queue.clear(); return true; }
  try {
    await selectCollectionWork(next, 'restart', mode === 'minutes' && remaining !== null ? { remaining, total } : undefined);
  } catch { /* 队列保存错误目标，播放器提供重试和跳过。 */ }
  return true;
}

/** 单槽位语音预备中断器，任何队列身份切换都作废旧回包。 */
let preparationAbort: AbortController | null = null;
useCollectionPlaybackStore.subscribe((state, previous) => {
  if (state.epoch !== previous.epoch) { preparationAbort?.abort(); preparationAbort = null; }
});

/** 只预备下一篇已保存故事，不创建内容、不切换播放 Anchor。 */
export async function prepareCollectionNextWork(): Promise<void> {
  const queue = useCollectionPlaybackStore.getState();
  const next = queue.works[queue.index + 1];
  const source = usePlaybackSessionStore.getState().source;
  if (!usePlaybackStore.getState().isPlaying || !next || !queue.collectionId || source?.kind !== 'work' || source.workId !== queue.works[queue.index]?.id) return;
  preparationAbort?.abort();
  const controller = new AbortController();
  preparationAbort = controller;
  useCollectionPlaybackStore.setState({ preparingWorkId: next.id, readyWorkId: null });
  try {
    const sessionId = createPlaybackSessionId();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (controller.signal.aborted || useCollectionPlaybackStore.getState().epoch !== queue.epoch) return;
      const result = await ensureAsset({ workId: next.id, sessionId }, controller.signal);
      if (controller.signal.aborted || useCollectionPlaybackStore.getState().epoch !== queue.epoch) return;
      if (result.status === 'ready') { useCollectionPlaybackStore.setState({ preparingWorkId: null, readyWorkId: next.id }); return; }
      await new Promise<void>((resolve) => {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, Math.min(2000, result.retryAfterMs ?? 500));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  } catch { /* 预备失败不打断当前音频，交接时走正式重试与错误界面。 */ }
  finally {
    if (preparationAbort === controller) preparationAbort = null;
    if (useCollectionPlaybackStore.getState().epoch === queue.epoch) useCollectionPlaybackStore.setState({ preparingWorkId: null });
  }
}
