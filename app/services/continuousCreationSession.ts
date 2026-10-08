/** 仅持久化本次创作时长与播放身份；异步任务永不跨刷新恢复。 */
import { useChatStore } from '@/stores/chatStore';
import { useConfigStore } from '@/stores/configStore';
import { useContinuousCreationStore } from '@/stores/continuousCreationStore';
import { resolveContinuousCreationBudgetMinutes } from '@/lib/continuous-creation/budget';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { cancelPendingNextWork } from './continuousCreationFlow';

const prefix = 'creation-duration:';
type Saved = { version: 1; budgetMs: number; remainingMs: number; creationWorkId: number | null; exhausted: boolean };
let subscribed = false;
let restoring = false;
function read(id: string): Saved | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(prefix + id) ?? 'null');
    if (value?.version !== 1 || !Number.isFinite(value.budgetMs) || value.budgetMs < 600000 || value.budgetMs > 7200000 || !Number.isFinite(value.remainingMs) || value.remainingMs < 0 || value.remainingMs > value.budgetMs || typeof value.exhausted !== 'boolean') return null;
    return { ...value, creationWorkId: Number.isInteger(value.creationWorkId) && value.creationWorkId > 0 ? value.creationWorkId : null };
  } catch { return null; }
}
function save(): void {
  const state = useContinuousCreationStore.getState();
  if (restoring || !state.ready || !state.conversationId || state.budgetMs === null || state.remainingMs === null) return;
  try { sessionStorage.setItem(prefix + state.conversationId, JSON.stringify({ version: 1, budgetMs: state.budgetMs, remainingMs: state.remainingMs, creationWorkId: state.creationWorkId, exhausted: state.status === 'ended_budget' || state.remainingMs <= 0 } satisfies Saved)); } catch { /* 禁用存储不阻断当前播放。 */ }
}
function bind(): void {
  const chat = useChatStore.getState();
  const config = useConfigStore.getState();
  if (!config.isLoaded || !chat.syncEnabled || !chat.conversationId) return;
  const current = useContinuousCreationStore.getState();
  const budgetMs = resolveContinuousCreationBudgetMinutes() * 60000;
  const enabled = config.apiConfig.defaultSleepTimerEnabled;
  if (current.ready && current.conversationId === chat.conversationId && current.budgetMs === budgetMs && current.enabled === enabled) return;
  const saved = current.ready && current.conversationId === chat.conversationId ? { budgetMs: current.budgetMs ?? budgetMs, remainingMs: current.remainingMs ?? budgetMs, creationWorkId: current.creationWorkId, exhausted: current.status === 'ended_budget' || current.remainingMs === 0 } : read(chat.conversationId);
  const spent = saved ? saved.budgetMs - saved.remainingMs : 0;
  restoring = true;
  try { current.restoreSession({ conversationId: chat.conversationId, collectionId: chat.collectionId, enabled, budgetMs, remainingMs: saved?.exhausted ? 0 : Math.max(0, budgetMs - spent), creationWorkId: saved?.creationWorkId ?? null, exhausted: saved?.exhausted ?? false }); } finally { restoring = false; }
  save();
  if (!enabled) cancelPendingNextWork();
  const source = usePlaybackSessionStore.getState().source;
  if (source?.kind === 'work' && source.workId === saved?.creationWorkId) {
    if (enabled) void import('./playbackSessionFlow').then((flow) => {
      if (flow.isCreationPlayback() && useContinuousCreationStore.getState().enabled && useContinuousCreationStore.getState().remainingMs === 0) flow.stopPlayback();
      else void flow.synchronizeCreationTimer();
    });
    else void usePlaybackSessionStore.getState().setSleepTimer('off');
  }
}
export function ensureContinuousCreationSession(): void {
  if (subscribed || typeof window === 'undefined') return;
  subscribed = true;
  useChatStore.subscribe((state, previous) => { if (state.conversationId !== previous.conversationId || state.syncEnabled !== previous.syncEnabled) bind(); });
  useConfigStore.subscribe((state, previous) => { if (state.isLoaded !== previous.isLoaded || state.apiConfig.defaultSleepTimerEnabled !== previous.apiConfig.defaultSleepTimerEnabled || state.apiConfig.defaultSleepTimerMinutes !== previous.apiConfig.defaultSleepTimerMinutes) bind(); });
  useContinuousCreationStore.subscribe((state, previous) => {
    save();
    const session = usePlaybackSessionStore.getState();
    if (state.ready && state.enabled && state.remainingMs !== previous.remainingMs && session.source?.kind === 'work' && session.source.workId === state.creationWorkId && session.conversationId === state.conversationId) usePlaybackStore.getState().setSleepTimerState('minutes', state.remainingMs, state.budgetMs);
  });
  window.addEventListener('pagehide', save);
  bind();
}
export function clearContinuousCreationSessions(): void {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key); } catch { /* 无浏览器存储。 */ }
}
export function resetContinuousCreationDuration(): void {
  const state = useContinuousCreationStore.getState();
  const chat = useChatStore.getState();
  if (!state.ready || !chat.conversationId || !useConfigStore.getState().apiConfig.defaultSleepTimerEnabled) return;
  cancelPendingNextWork();
  const budgetMs = resolveContinuousCreationBudgetMinutes() * 60000;
  state.restoreSession({ conversationId: chat.conversationId, collectionId: chat.collectionId, enabled: true, budgetMs, remainingMs: budgetMs, creationWorkId: state.creationWorkId, exhausted: false });
  void import('./playbackSessionFlow').then((flow) => {
    if (!flow.isCreationPlayback()) return;
    flow.pausePlayback();
    void flow.synchronizeCreationTimer();
    void usePlaybackSessionStore.getState().persistSingleTrackProgress({ force: true });
  });
}
