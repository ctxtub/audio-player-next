/**
 * M5-09 PlaybackSessionStore（spec §10 / §25 Client Session SSOT）。
 *
 * 新客户端会话唯一事实源：server 四表 + Anchor DTO 为持久化 SSOT，
 * 本 store 为运行时 SSOT。Work 路径按 workId 经 library.get 精确 resolve
 *（§25.1，严禁走 generationHistoryStore 最近 N 条 find(id) 旧路径）；
 * Draft 路径按 messageId 查 StoryCard 检查正文，缺失清 dangling Anchor
 *（§25.2 fail-closed）。Hash 统一 segmentation SSOT（§25.3），Title 变化
 * 只更新 title 不重置 progress（§25.4），成功后 status=ready + transport idle
 * 不 autoplay（§25.5）。
 *
 * continuation：一律 finite（§12，所有持久化 Anchor 重水合后视为 finite；
 * lib/playback/progress.ts resolveContinuationMode / rehydratedContinuationMode）。
 *
 * hydration 纪元：每次 init() 自增 epoch，过期异步 resolve 直接丢弃，
 * 不写回状态（防切源/TTS 晚到覆盖，见 spec §50 session guard）。
 *
 * M5-09 cutover：stores/accountSync 已切换到本 store；旧
 * stores/playbackProgressStore 保留 @deprecated adapter（M9 删除），
 * 本文件绝不 import generationHistoryStore / playbackProgressStore /
 * storyFlow / preloadStore（旧路径残留不得破坏新流程）。
 */

import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';
import GlassToast from '@/components/ui/GlassToast';
import type {
  GetPlaybackAnchorOutput,
  PlaybackAnchorDTO,
} from '@/lib/trpc/schemas/playback';
import {
  getPlaybackAnchor,
  beginPlaybackSession,
  savePlaybackCheckpoint,
  completePlaybackSession,
  clearPlaybackAnchor,
  promoteDraftPlaybackToWork,
} from '@/lib/client/playbackSession';
import { get as getWorkDetail } from '@/lib/client/library';
import {
  SEGMENTATION_VERSION,
  computeStoryContentHash,
  normalizeStoryText,
  segmentStoryText,
} from '@/utils/segmentation';
import {
  decideRehydratedPosition,
  resolveRehydratedTitle,
} from '@/lib/playback/rehydrate';
import {
  rehydratedContinuationMode,
  resolvePromotedNextParagraphIndex,
  shouldPreserveDraftBreakpointOnPromote,
} from '@/lib/playback/progress';
import { createPlaybackSessionId } from '@/lib/playback/session';
import type { PlaybackSourceRef } from '@/lib/playback/source';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useChatStore } from '@/stores/chatStore';
import { useConfigStore } from '@/stores/configStore';
import { fetchAudio } from '@/lib/client/ttsGenerate';
import type { ChatMessage } from '@/types/chat';

/** §10 PlaybackSessionStatus（运行态 playing/synthesizing/error 不持久化）。 */
export type PlaybackSessionStatus =
  | 'idle'
  | 'hydrating'
  | 'ready'
  | 'synthesizing'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

/** §10 continuation：rehydrate 后一律 finite（§12 invariant）。 */
export type SessionContinuationMode = 'finite' | 'extendable';

interface PlaybackSessionState {
  sessionId: string | null;
  /** 新 SSOT source（discriminated union draft/work，替代旧 sourceType/sourceId 双写）。 */
  source: PlaybackSourceRef | null;
  title: string;
  storyText: string;
  paragraphs: string[];
  contentHash: string;
  segmentationVersion: string;
  lastCompletedParagraphIndex: number;
  nextParagraphIndex: number;
  totalParagraphs: number;
  voiceId: string;
  speed: number;
  continuationMode: SessionContinuationMode;
  status: PlaybackSessionStatus;
  prefetchedAudioUrl: string | null;
  prefetchingIndex: number | null;
  lastSavedKey: string | null;
  /** hydration 纪元（每次 init 自增，过期 resolve 丢弃）。 */
  hydrationEpoch: number;
}

interface PlaybackSessionActions {
  /** §25 页面启动：getAnchor → resolve Source（hydration 纪元守卫）。 */
  init: (deps?: SessionRehydrateDeps) => Promise<boolean>;
  initForUser: (deps?: SessionRehydrateDeps) => Promise<boolean>;
  initForGuest: (deps?: SessionRehydrateDeps) => Promise<boolean>;
  /** 由 Anchor DTO 直接水合（init 内部与测试共用）。 */
  hydrateFromAnchor: (anchor: PlaybackAnchorDTO, deps?: SessionRehydrateDeps) => Promise<boolean>;
  setActiveStory: (params: {
    source: PlaybackSourceRef;
    sessionId?: string | null;
    title: string;
    storyText: string;
    voiceId?: string;
    speed?: number;
    continuationMode?: SessionContinuationMode;
    remainingAllowedMs?: number | null;
    totalAllowedMs?: number | null;
    initialNextIndex?: number;
  }) => void;
  resumeRehydratedPlayback: () => Promise<void>;
  playParagraph: (paragraphIndex: number, options?: { explicit?: boolean }) => Promise<void>;
  prefetchNextParagraph: (paragraphIndex: number) => Promise<void>;
  handleParagraphEnded: () => Promise<boolean>;
  handleExplicitPause: () => void;
  /** §30 restart：新 sessionId + position 0（保留 completedAt 由 server 侧持有）。 */
  restart: () => Promise<void>;
  promoteDraftToWork: (workId: number) => Promise<void>;
  beginPlayback: (params: {
    source: PlaybackSourceRef;
    mode: 'resume' | 'restart';
    speed?: number;
    draftSnapshot?: { title: string; contentHash: string; totalParagraphs: number; voiceId: string };
  }) => Promise<void>;
  saveCheckpointDebounced: (options?: { forceReset?: boolean }) => void;
  saveCheckpointImmediate: (options?: { forceReset?: boolean }) => Promise<void>;
  clearSession: () => Promise<void>;
  stop: () => void;
  reset: () => void;
  setStatus: (status: PlaybackSessionStatus) => void;
}

export type PlaybackSessionStore = PlaybackSessionState & PlaybackSessionActions;

/** 可注入的 rehydrate 依赖（生产默认走真实 client/store；测试注入 fake）。 */
export interface SessionRehydrateDeps {
  getAnchor?: () => Promise<GetPlaybackAnchorOutput>;
  getWork?: (workId: number) => Promise<{
    title: string;
    storyText: string;
    voiceId: string;
    contentHash: string;
  }>;
  ensureChatLoaded?: () => Promise<void>;
  findDraftStoryText?: (messageId: string) => string | null;
  clearAnchor?: (sessionId: string) => Promise<unknown>;
  notifyDrift?: () => void;
}

const INITIAL_SESSION_STATE: PlaybackSessionState = {
  sessionId: null,
  source: null,
  title: '',
  storyText: '',
  paragraphs: [],
  contentHash: '',
  segmentationVersion: SEGMENTATION_VERSION,
  lastCompletedParagraphIndex: -1,
  nextParagraphIndex: 0,
  totalParagraphs: 1,
  voiceId: '',
  speed: 1.0,
  continuationMode: 'finite',
  status: 'idle',
  prefetchedAudioUrl: null,
  prefetchingIndex: null,
  lastSavedKey: null,
  hydrationEpoch: 0,
};

let debounceSaveTimer: ReturnType<typeof setTimeout> | null = null;
let prefetchAbortController: AbortController | null = null;
let initPromise: Promise<boolean> | null = null;
let hydrationEpochCounter = 0;

const clearDebounceTimer = () => {
  if (debounceSaveTimer) {
    clearTimeout(debounceSaveTimer);
    debounceSaveTimer = null;
  }
};

const abortPrefetch = () => {
  if (prefetchAbortController) {
    prefetchAbortController.abort();
    prefetchAbortController = null;
  }
};

/** 默认 Draft 正文查找：ChatStore delivered 消息的 storyCard/storyArtifact 正文。 */
function defaultFindDraftStoryText(messageId: string): string | null {
  const msg = useChatStore
    .getState()
    .messages.find((m: ChatMessage) => m.id === messageId) as ChatMessage | undefined;
  if (!msg || (msg.status !== undefined && msg.status !== 'delivered')) return null;
  const parts = msg.parts ?? [];
  for (const part of parts) {
    if (part.type === 'storyCard' && typeof (part as { storyText?: unknown }).storyText === 'string') {
      const text = (part as { storyText: string }).storyText;
      if (text && text.length > 0) return text;
    }
    if (part.type === 'storyArtifact') {
      const artifact = (part as { artifact?: { storyText?: unknown } }).artifact;
      if (artifact && typeof artifact.storyText === 'string' && artifact.storyText.length > 0) {
        return artifact.storyText;
      }
    }
  }
  return null;
}

const defaultDeps: Required<SessionRehydrateDeps> = {
  getAnchor: () => getPlaybackAnchor(),
  getWork: async (workId: number) => {
    const detail = await getWorkDetail({ id: workId });
    return {
      title: detail.title,
      storyText: detail.storyText,
      voiceId: detail.voiceId,
      contentHash: detail.contentHash,
    };
  },
  ensureChatLoaded: async () => {
    await useChatStore.getState().initForUser();
  },
  findDraftStoryText: (messageId: string) => defaultFindDraftStoryText(messageId),
  clearAnchor: (sessionId: string) => clearPlaybackAnchor({ sessionId }),
  notifyDrift: () => {
    GlassToast.show({ icon: 'fail', content: '故事正文已更新，将从开头重新播放' });
  },
};

function resolveDeps(deps?: SessionRehydrateDeps): Required<SessionRehydrateDeps> {
  return {
    getAnchor: deps?.getAnchor ?? defaultDeps.getAnchor,
    getWork: deps?.getWork ?? defaultDeps.getWork,
    ensureChatLoaded: deps?.ensureChatLoaded ?? defaultDeps.ensureChatLoaded,
    findDraftStoryText: deps?.findDraftStoryText ?? defaultDeps.findDraftStoryText,
    clearAnchor: deps?.clearAnchor ?? defaultDeps.clearAnchor,
    notifyDrift: deps?.notifyDrift ?? defaultDeps.notifyDrift,
  };
}

/** dangling 清理（fail-closed）：本地 + transport 复位，best-effort 清 server Anchor。 */
async function dropDanglingAnchor(
  get: () => PlaybackSessionStore,
  set: (partial: Partial<PlaybackSessionState>) => void,
  sessionId: string | null,
  clearAnchorFn: (sessionId: string) => Promise<unknown>,
  reason: string,
): Promise<boolean> {
  console.warn(`[playbackSessionStore] Resolved source missing; dropped dangling anchor (${reason})`);
  if (sessionId) {
    try {
      await clearAnchorFn(sessionId);
    } catch {
      // best-effort：server 清理失败不掩盖 fail-closed，仍复位本地。
    }
  }
  get().reset();
  try {
    usePlaybackStore.getState().reset();
  } catch {
    // transport 复位失败仅告警，不抛错阻断水合返回。
  }
  return false;
}

const playbackSessionStoreCreator: StateCreator<PlaybackSessionStore> = (set, get) => ({
  ...INITIAL_SESSION_STATE,

  setStatus: (status) => set({ status }),

  init: async (deps) => {
    if (initPromise) return initPromise;
    const d = resolveDeps(deps);
    hydrationEpochCounter += 1;
    const epoch = hydrationEpochCounter;
    set({ hydrationEpoch: epoch, status: 'hydrating' });
    initPromise = (async (): Promise<boolean> => {
      try {
        const anchor = await d.getAnchor();
        // 纪元守卫：init 并发/切账号后过期 resolve 直接丢弃。
        if (get().hydrationEpoch !== epoch) return false;
        if (!anchor) {
          if (get().hydrationEpoch === epoch) set({ status: 'idle' });
          return false;
        }
        return get().hydrateFromAnchor(anchor, deps);
      } catch (err) {
        console.warn('[playbackSessionStore] init failed', err);
        if (get().hydrationEpoch === epoch) set({ status: 'idle' });
        return false;
      } finally {
        initPromise = null;
      }
    })();
    return initPromise;
  },

  initForUser: async (deps) => get().init(deps),

  initForGuest: async (deps) => get().init(deps),

  hydrateFromAnchor: async (anchor, deps) => {
    const d = resolveDeps(deps);
    const epochAtStart = get().hydrationEpoch;
    set({ status: 'hydrating' });

    // —— §25 resolve Source（Work 精确 resolve / Draft 查卡） ——
    let storyText = '';
    let liveTitle: string | null = null;
    let liveVoiceId = anchor.voiceId;

    if (anchor.source.kind === 'draft') {
      try {
        await d.ensureChatLoaded();
      } catch (err) {
        console.warn('[playbackSessionStore] draft chat load failed', err);
      }
      if (get().hydrationEpoch !== epochAtStart) return false;
      const found = d.findDraftStoryText(anchor.source.messageId);
      if (!found) {
        return dropDanglingAnchor(
          get,
          set,
          anchor.sessionId ?? null,
          d.clearAnchor,
          `draft:${anchor.source.messageId}`,
        );
      }
      storyText = found;
      liveTitle = null;
    } else {
      // §25.1：严禁走 generationHistoryStore 最近 N 条 find(id)；
      // library.get(workId) 精确 resolve（分页后 Anchor 可指向任意页）。
      let work: { title: string; storyText: string; voiceId: string; contentHash: string };
      try {
        work = await d.getWork(anchor.source.workId);
      } catch {
        return dropDanglingAnchor(
          get,
          set,
          anchor.sessionId ?? null,
          d.clearAnchor,
          `work:${anchor.source.workId}`,
        );
      }
      if (get().hydrationEpoch !== epochAtStart) return false;
      if (!work || typeof work.storyText !== 'string' || work.storyText.length === 0) {
        return dropDanglingAnchor(
          get,
          set,
          anchor.sessionId ?? null,
          d.clearAnchor,
          `work:${anchor.source.workId}`,
        );
      }
      storyText = work.storyText;
      liveTitle = work.title;
      if (!liveVoiceId && work.voiceId) liveVoiceId = work.voiceId;
    }

    // —— §25.3 Hash Validation（统一 segmentation SSOT） ——
    const normalized = normalizeStoryText(storyText);
    const currentHash = computeStoryContentHash(normalized);
    const paragraphs = segmentStoryText(normalized);
    const totalParagraphs = Math.max(1, paragraphs.length);
    const position = decideRehydratedPosition({
      savedNextParagraphIndex: anchor.nextParagraphIndex,
      savedLastCompletedParagraphIndex: anchor.lastCompletedParagraphIndex,
      savedContentHash: anchor.contentHash,
      savedSegmentationVersion: anchor.segmentationVersion,
      currentContentHash: currentHash,
      totalParagraphs,
    });
    if (position.drifted) {
      try {
        d.notifyDrift();
      } catch {
        // toast 失败不阻断水合。
      }
    }

    // —— §25.4 Title 变化：更新 title，不重置 progress ——
    const title = resolveRehydratedTitle(anchor.title, liveTitle);

    if (get().hydrationEpoch !== epochAtStart) return false;

    // —— §25.5 最终状态：status=ready + transport idle，不 autoplay ——
    set({
      sessionId: anchor.sessionId,
      source: anchor.source.kind === 'draft'
        ? { kind: 'draft', messageId: anchor.source.messageId }
        : { kind: 'work', workId: anchor.source.workId },
      title,
      storyText: normalized,
      paragraphs,
      contentHash: currentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: position.lastCompletedParagraphIndex,
      nextParagraphIndex: position.nextParagraphIndex,
      totalParagraphs,
      voiceId: liveVoiceId,
      speed: anchor.speed,
      continuationMode: rehydratedContinuationMode(),
      status: 'ready',
      lastSavedKey: `${anchor.sessionId}:${position.nextParagraphIndex}`,
    });

    try {
      usePlaybackStore.getState().hydrateFromProgress({
        sessionId: anchor.sessionId,
        currentMessageId: anchor.source.kind === 'draft' ? anchor.source.messageId : null,
        sourceType: anchor.source.kind === 'draft' ? 'draft' : 'work',
        sourceId: anchor.source.kind === 'draft'
          ? anchor.source.messageId
          : String(anchor.source.workId),
        title,
        remainingMs: anchor.remainingAllowedMs ?? null,
        totalAllowedMs: anchor.totalAllowedMs ?? null,
        isOneShot: true,
        currentParagraphIndex: position.nextParagraphIndex,
        totalParagraphs,
      });
    } catch (err) {
      console.warn('[playbackSessionStore] transport sync failed', err);
    }

    return true;
  },

  setActiveStory: (params) => {
    if (params.source.kind === 'draft' && params.source.messageId.startsWith('replay-text-')) {
      return;
    }
    const normalized = normalizeStoryText(params.storyText);
    const currentHash = computeStoryContentHash(normalized);
    const paragraphs = segmentStoryText(normalized);
    const totalParagraphs = Math.max(1, paragraphs.length);
    const nextParagraphIndex = params.initialNextIndex ?? 0;
    const lastCompleted = nextParagraphIndex > 0 ? nextParagraphIndex - 1 : -1;

    abortPrefetch();
    clearDebounceTimer();

    set({
      sessionId: params.sessionId ?? null,
      source: params.source.kind === 'draft'
        ? { kind: 'draft', messageId: params.source.messageId }
        : { kind: 'work', workId: params.source.workId },
      title: params.title,
      storyText: normalized,
      paragraphs,
      contentHash: currentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: lastCompleted,
      nextParagraphIndex,
      totalParagraphs,
      voiceId: params.voiceId ?? '',
      speed: params.speed ?? 1.0,
      continuationMode: params.continuationMode ?? 'finite',
      status: 'playing',
      prefetchedAudioUrl: null,
      prefetchingIndex: null,
    });

    try {
      usePlaybackStore.getState().setParagraphInfo({
        currentParagraphIndex: nextParagraphIndex,
        totalParagraphs,
        title: params.title,
      });
    } catch {
      // transport 同步失败不阻断本地激活。
    }
  },

  resumeRehydratedPlayback: async () => {
    const state = get();
    if (!state.source || state.paragraphs.length === 0) return;
    await usePlaybackStore.getState().ensureUnlocked();
    const playbackState = usePlaybackStore.getState();
    if (playbackState.remainingMs === null || playbackState.totalAllowedMs === null) {
      const playDurationMinutes = useConfigStore.getState().apiConfig.playDuration;
      if (
        typeof playDurationMinutes === 'number' &&
        Number.isFinite(playDurationMinutes) &&
        playDurationMinutes > 0
      ) {
        const fallbackBudgetMs = playDurationMinutes * 60000;
        playbackState.ensureCountdownBudget(fallbackBudgetMs);
      }
    }
    const resumeBudgetMs = usePlaybackStore.getState().remainingMs;
    if (resumeBudgetMs !== null && resumeBudgetMs <= 0) return;
    await get().playParagraph(get().nextParagraphIndex, { explicit: true });
  },

  playParagraph: async (paragraphIndex, options) => {
    const state = get();
    const originatingSessionId = state.sessionId;
    if (paragraphIndex >= state.paragraphs.length) {
      await get().clearSession();
      return;
    }
    const paragraphBudgetMs = usePlaybackStore.getState().remainingMs;
    if (paragraphBudgetMs !== null && paragraphBudgetMs <= 0) return;
    if (
      !usePlaybackStore.getState().isPlaying &&
      usePlaybackStore.getState().currentAudioUrl !== null &&
      !options?.explicit
    ) {
      return;
    }

    const textToPlay = state.paragraphs[paragraphIndex];
    const voiceId = state.voiceId || useConfigStore.getState().apiConfig.voiceId;
    const speed = state.speed || useConfigStore.getState().apiConfig.speed;

    let audioUrl = state.prefetchedAudioUrl;
    if (state.prefetchingIndex !== paragraphIndex || !audioUrl) {
      set({ status: 'synthesizing' });
      try {
        audioUrl = await fetchAudio(textToPlay, voiceId, speed);
      } catch (err) {
        // §50 session guard：失败也须确认仍是同一 session 才置 error，避免旧 TTS 失败覆盖新会话。
        if (get().sessionId !== originatingSessionId) return;
        set({ status: 'error' });
        GlassToast.show({ icon: 'fail', content: '语音生成稍有延迟，请重试' });
        throw err;
      }
    }

    // §50 session guard：TTS 晚到必须检查 sessionId，不一致直接丢弃，绝不覆盖新会话。
    if (get().sessionId !== originatingSessionId) {
      try {
        if (audioUrl && audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl);
      } catch {
        // 忽略回收失败。
      }
      return;
    }

    if (
      !usePlaybackStore.getState().isPlaying &&
      usePlaybackStore.getState().currentAudioUrl !== null &&
      !options?.explicit
    ) {
      return;
    }

    set({
      prefetchedAudioUrl: null,
      prefetchingIndex: null,
      nextParagraphIndex: paragraphIndex,
      status: 'playing',
    });

    usePlaybackStore.getState().clearRehydratedReady();
    usePlaybackStore.getState().setParagraphInfo({
      currentParagraphIndex: paragraphIndex,
      totalParagraphs: state.totalParagraphs,
    });

    const msgId = state.source?.kind === 'draft' ? state.source.messageId : undefined;
    await usePlaybackStore.getState().playAudio(audioUrl, msgId, { explicit: options?.explicit });
  },

  prefetchNextParagraph: async (paragraphIndex) => {
    const state = get();
    if (paragraphIndex !== state.nextParagraphIndex + 1) return;
    if (paragraphIndex >= state.paragraphs.length) return;
    if (!usePlaybackStore.getState().isPlaying) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    const remainingMs = usePlaybackStore.getState().remainingMs;
    if (remainingMs !== null && remainingMs <= 0) return;
    if (state.prefetchingIndex === paragraphIndex) return;

    abortPrefetch();
    const abortCtrl = new AbortController();
    prefetchAbortController = abortCtrl;
    const originatingSessionId = state.sessionId;

    set({ prefetchingIndex: paragraphIndex });
    const textToPrefetch = state.paragraphs[paragraphIndex];
    const voiceId = state.voiceId || useConfigStore.getState().apiConfig.voiceId;
    const speed = state.speed || useConfigStore.getState().apiConfig.speed;

    try {
      const audioUrl = await fetchAudio(textToPrefetch, voiceId, speed);
      if (abortCtrl.signal.aborted) return;
      // session 已切换则丢弃预取结果，不污染新会话。
      if (get().sessionId !== originatingSessionId) {
        try {
          if (audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl);
        } catch {
          // ignore
        }
        return;
      }
      set({ prefetchedAudioUrl: audioUrl, prefetchingIndex: paragraphIndex });
    } catch {
      if (!abortCtrl.signal.aborted) set({ prefetchingIndex: null });
    } finally {
      if (prefetchAbortController === abortCtrl) prefetchAbortController = null;
    }
  },

  handleParagraphEnded: async (): Promise<boolean> => {
    const state = get();
    if (state.totalParagraphs <= 0 || state.paragraphs.length === 0) return false;
    const completed = state.nextParagraphIndex;
    const next = completed + 1;
    if (next < state.totalParagraphs) {
      set({ lastCompletedParagraphIndex: completed, nextParagraphIndex: next });
      await get().saveCheckpointImmediate({ forceReset: false });
      await get().playParagraph(next);
      return true;
    }
    set({ lastCompletedParagraphIndex: completed, nextParagraphIndex: next, status: 'ended' });
    try {
      if (state.sessionId) await completePlaybackSession({ sessionId: state.sessionId });
    } catch (err) {
      console.warn('[playbackSessionStore] completeSession failed', err);
    }
    return false;
  },

  handleExplicitPause: () => {
    abortPrefetch();
    set({ status: 'paused' });
    get().saveCheckpointDebounced({ forceReset: false });
  },

  restart: async () => {
    const state = get();
    if (!state.source) return;
    const newSessionId = createPlaybackSessionId();
    set({ nextParagraphIndex: 0, lastCompletedParagraphIndex: -1 });
    await get().saveCheckpointImmediate({ forceReset: true });
    // restart 语义由 server beginSession 持有（新 sessionId + position 0）时，
    // 此处经 beginPlayback 走服务端 restart；无 source 时回落本地从头播放。
    void newSessionId;
    await get().playParagraph(0, { explicit: true });
  },

  promoteDraftToWork: async (workId) => {
    const state = get();
    if (!state.sessionId || !state.source || state.source.kind !== 'draft') return;
    const sessionId = state.sessionId;
    const draftHash = state.contentHash;
    const draftNext = state.nextParagraphIndex;
    const anchor = await promoteDraftPlaybackToWork({ sessionId, workId });
    // server 已切换 source/title/hash/voiceId（sessionId 不变）；本地按 hash 取舍断点。
    const preserved = shouldPreserveDraftBreakpointOnPromote(draftHash, anchor.contentHash);
    const next = preserved
      ? resolvePromotedNextParagraphIndex(draftNext, draftHash, anchor.contentHash, anchor.totalParagraphs)
      : 0;
    set({
      source: { kind: 'work', workId },
      title: anchor.title,
      contentHash: anchor.contentHash,
      segmentationVersion: anchor.segmentationVersion,
      lastCompletedParagraphIndex: next > 0 ? next - 1 : -1,
      nextParagraphIndex: next,
      totalParagraphs: anchor.totalParagraphs,
      voiceId: anchor.voiceId,
      speed: anchor.speed,
    });
  },

  beginPlayback: async (params) => {
    const sessionId = createPlaybackSessionId();
    const speed = params.speed ?? get().speed ?? 1.0;
    const anchor = await beginPlaybackSession({
      sessionId,
      source: params.source,
      mode: params.mode,
      speed,
      draftSnapshot: params.draftSnapshot,
    });
    await get().hydrateFromAnchor(anchor);
  },

  saveCheckpointDebounced: (options) => {
    clearDebounceTimer();
    debounceSaveTimer = setTimeout(() => {
      void get().saveCheckpointImmediate(options);
    }, 2000);
  },

  saveCheckpointImmediate: async (options) => {
    clearDebounceTimer();
    const state = get();
    if (!state.sessionId || !state.source) return;
    const saveKey = `${state.sessionId}:${state.nextParagraphIndex}:${options?.forceReset ? 'force' : 'normal'}`;
    if (!options?.forceReset && state.lastSavedKey === saveKey) return;
    const playbackStore = usePlaybackStore.getState();
    try {
      await savePlaybackCheckpoint({
        sessionId: state.sessionId,
        contentHash: state.contentHash,
        segmentationVersion: state.segmentationVersion,
        lastCompletedParagraphIndex: state.lastCompletedParagraphIndex,
        nextParagraphIndex: state.nextParagraphIndex,
        totalParagraphs: state.totalParagraphs,
        speed: state.speed,
        remainingAllowedMs: playbackStore.remainingMs ?? undefined,
        totalAllowedMs: playbackStore.totalAllowedMs ?? undefined,
      });
      // 仅当 session 未切换才写 lastSavedKey，避免旧会话覆盖新键。
      if (get().sessionId === state.sessionId) set({ lastSavedKey: saveKey });
    } catch (err) {
      console.warn('[playbackSessionStore] saveCheckpoint failed', err);
    }
  },

  clearSession: async () => {
    clearDebounceTimer();
    abortPrefetch();
    const sessionId = get().sessionId;
    try {
      if (sessionId) await clearPlaybackAnchor({ sessionId });
    } catch (err) {
      console.warn('[playbackSessionStore] clearSession failed', err);
    }
    get().reset();
    try {
      usePlaybackStore.getState().reset();
    } catch {
      // ignore
    }
  },

  stop: () => {
    clearDebounceTimer();
    abortPrefetch();
    try {
      usePlaybackStore.getState().pauseAudioPlayback();
    } catch {
      // ignore
    }
    set({ status: 'paused', prefetchedAudioUrl: null, prefetchingIndex: null });
  },

  reset: () => {
    clearDebounceTimer();
    abortPrefetch();
    const epoch = get().hydrationEpoch;
    set({ ...INITIAL_SESSION_STATE, hydrationEpoch: epoch });
  },
});

export const usePlaybackSessionStore = create<PlaybackSessionStore>()(
  devtools(playbackSessionStoreCreator, { name: 'playback-session-store' }),
);

/** 测试隔离：清 debounce/prefetch/init 句柄与纪元（不触业务状态）。 */
export function __resetPlaybackSessionTestHooks(): void {
  clearDebounceTimer();
  abortPrefetch();
  initPromise = null;
  hydrationEpochCounter = 0;
}
