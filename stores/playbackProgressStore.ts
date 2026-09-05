/**
 * 客户端断点续播状态机 Store
 *
 * 负责端侧断点水合、创作源解析与校验、文本漂移侦测、至多一次保存防抖与自适应预加载调度。
 */

import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';
import GlassToast from '@/components/ui/GlassToast';
import type { PlaybackProgressDTO, PlaybackSourceType } from '@/lib/trpc/schemas/playback';
import {
  fetchPlaybackProgress,
  savePlaybackProgress,
  clearPlaybackProgress,
} from '@/lib/client/playbackProgress';
import {
  normalizeStoryText,
  segmentStoryText,
  computeStoryContentHash,
  SEGMENTATION_VERSION,
} from '@/utils/segmentation';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useChatStore } from '@/stores/chatStore';
import { useGenerationHistoryStore } from '@/stores/generationHistoryStore';
import { useConfigStore } from '@/stores/configStore';
import { fetchAudio } from '@/lib/client/ttsGenerate';
import type { StoryCardPart } from '@/types/chat';

export type PlaybackProgressStatus = 'idle' | 'hydrating' | 'ready' | 'synthesizing' | 'playing' | 'error';

interface PlaybackProgressState {
  sourceType: PlaybackSourceType | null;
  sourceId: string | null;
  sessionId: string | null;
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
  remainingAllowedMs: number | null;
  totalAllowedMs: number | null;
  isOneShot: boolean;
  status: PlaybackProgressStatus;
  prefetchedAudioUrl: string | null;
  prefetchingIndex: number | null;
  lastSavedKey: string | null;
}

interface PlaybackProgressActions {
  initForUser: () => Promise<void>;
  initForGuest: () => Promise<void>;
  hydrateFromDTO: (dto: PlaybackProgressDTO) => Promise<boolean>;
  setActiveStory: (params: {
    sourceType: PlaybackSourceType;
    sourceId: string;
    sessionId?: string | null;
    title: string;
    storyText: string;
    voiceId?: string;
    speed?: number;
    isOneShot?: boolean;
    remainingAllowedMs?: number | null;
    totalAllowedMs?: number | null;
    initialNextIndex?: number;
  }) => void;
  resumeRehydratedPlayback: () => Promise<void>;
  playParagraph: (paragraphIndex: number) => Promise<void>;
  prefetchNextParagraph: (paragraphIndex: number) => Promise<void>;
  handleParagraphEnded: () => Promise<boolean>;
  handleExplicitPause: () => void;
  replayFromStart: () => Promise<void>;
  saveProgressDebounced: (options?: { forceReset?: boolean }) => void;
  saveProgressImmediate: (options?: { forceReset?: boolean }) => Promise<void>;
  clearProgress: () => Promise<void>;
  reset: () => void;
  setStatus: (status: PlaybackProgressStatus) => void;
}

export type PlaybackProgressStore = PlaybackProgressState & PlaybackProgressActions;

const INITIAL_PROGRESS_STATE: PlaybackProgressState = {
  sourceType: null,
  sourceId: null,
  sessionId: null,
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
  remainingAllowedMs: null,
  totalAllowedMs: null,
  isOneShot: false,
  status: 'idle',
  prefetchedAudioUrl: null,
  prefetchingIndex: null,
  lastSavedKey: null,
};

let debounceSaveTimer: ReturnType<typeof setTimeout> | null = null;
let prefetchAbortController: AbortController | null = null;
let initPromise: Promise<void> | null = null;

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

const playbackProgressStoreCreator: StateCreator<PlaybackProgressStore> = (set, get) => ({
  ...INITIAL_PROGRESS_STATE,

  setStatus: (status) => set({ status }),

  initForUser: async () => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        set({ status: 'hydrating' });
        const progress = await fetchPlaybackProgress();
        if (!progress) {
          set({ status: 'idle' });
          return;
        }
        await get().hydrateFromDTO(progress);
      } catch (err) {
        console.warn('[playbackProgressStore] initForUser failed', err);
        set({ status: 'idle' });
      } finally {
        initPromise = null;
      }
    })();
    return initPromise;
  },

  initForGuest: async () => {
    return get().initForUser();
  },

  hydrateFromDTO: async (dto: PlaybackProgressDTO): Promise<boolean> => {
    // 1. 创作源检索与门禁校验 (Stable Creative Source Resolution)
    let storyText = '';

    if (dto.sourceType === 'chat') {
      let msg = useChatStore.getState().messages.find((m) => m.id === dto.sourceId);
      if (!msg) {
        await useChatStore.getState().initForUser();
        msg = useChatStore.getState().messages.find((m) => m.id === dto.sourceId);
      }

      if (!msg || msg.status !== 'delivered') {
        console.warn(
          `[playbackResume] Resolved source missing; dropped dangling progress for ${dto.sourceType}:${dto.sourceId}`
        );
        get().reset();
        usePlaybackStore.getState().reset();
        void clearPlaybackProgress().catch(() => {});
        return false;
      }

      const storyCard = msg.parts?.find((p): p is StoryCardPart => p.type === 'storyCard');
      if (!storyCard || !storyCard.storyText) {
        console.warn(
          `[playbackResume] Resolved source missing; dropped dangling progress for ${dto.sourceType}:${dto.sourceId}`
        );
        get().reset();
        usePlaybackStore.getState().reset();
        void clearPlaybackProgress().catch(() => {});
        return false;
      }

      storyText = storyCard.storyText;
    } else if (dto.sourceType === 'generation') {
      let record = useGenerationHistoryStore.getState().records.find((r) => String(r.id) === dto.sourceId);
      if (!record) {
        await useGenerationHistoryStore.getState().initForUser();
        record = useGenerationHistoryStore.getState().records.find((r) => String(r.id) === dto.sourceId);
      }

      if (!record || !record.storyText) {
        console.warn(
          `[playbackResume] Resolved source missing; dropped dangling progress for ${dto.sourceType}:${dto.sourceId}`
        );
        get().reset();
        usePlaybackStore.getState().reset();
        void clearPlaybackProgress().catch(() => {});
        return false;
      }

      storyText = record.storyText;
    } else {
      return false;
    }

    // 2. 规范化文本与漂移侦测 (Text Drift Detection)
    const normalized = normalizeStoryText(storyText);
    const currentHash = computeStoryContentHash(normalized);
    const paragraphs = segmentStoryText(normalized);
    const totalParagraphs = Math.max(1, paragraphs.length);

    let nextParagraphIndex = dto.nextParagraphIndex;
    let lastCompletedParagraphIndex = dto.lastCompletedParagraphIndex;

    const isDrifted =
      currentHash !== dto.contentHash || dto.segmentationVersion !== SEGMENTATION_VERSION;

    if (isDrifted) {
      nextParagraphIndex = 0;
      lastCompletedParagraphIndex = -1;
      GlassToast.show({ icon: 'fail', content: '故事正文已更新，将从开头重新播放' });
    } else {
      if (nextParagraphIndex >= totalParagraphs) {
        nextParagraphIndex = Math.max(0, totalParagraphs - 1);
      }
    }

    // 3. 停驻 PAUSED/READY 态 (无自动起播)
    set({
      sourceType: dto.sourceType,
      sourceId: dto.sourceId,
      sessionId: dto.sessionId ?? null,
      title: dto.title,
      storyText: normalized,
      paragraphs,
      contentHash: currentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex,
      nextParagraphIndex,
      totalParagraphs,
      voiceId: dto.voiceId,
      speed: dto.speed,
      remainingAllowedMs: dto.remainingAllowedMs ?? null,
      totalAllowedMs: dto.totalAllowedMs ?? null,
      isOneShot: dto.isOneShot,
      status: 'ready',
      lastSavedKey: `${dto.sourceId}:${dto.nextParagraphIndex}`,
    });

    usePlaybackStore.getState().hydrateFromProgress({
      sessionId: dto.sessionId ?? null,
      currentMessageId: dto.sourceType === 'chat' ? dto.sourceId : null,
      sourceType: dto.sourceType,
      sourceId: dto.sourceId,
      title: dto.title,
      remainingMs: dto.remainingAllowedMs ?? null,
      totalAllowedMs: dto.totalAllowedMs ?? null,
      isOneShot: dto.isOneShot,
      currentParagraphIndex: nextParagraphIndex,
      totalParagraphs,
    });

    return true;
  },

  setActiveStory: (params) => {
    // 门禁：严禁使用瞬态 replay-text-* 作为已持久化 sourceId
    if (params.sourceId.startsWith('replay-text-')) {
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
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      sessionId: params.sessionId ?? null,
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
      remainingAllowedMs: params.remainingAllowedMs ?? null,
      totalAllowedMs: params.totalAllowedMs ?? null,
      isOneShot: params.isOneShot ?? false,
      status: 'playing',
      prefetchedAudioUrl: null,
      prefetchingIndex: null,
    });

    usePlaybackStore.getState().setParagraphInfo({
      currentParagraphIndex: nextParagraphIndex,
      totalParagraphs,
      title: params.title,
    });
  },

  resumeRehydratedPlayback: async () => {
    const state = get();
    if (!state.sourceId || state.paragraphs.length === 0) {
      return;
    }

    await usePlaybackStore.getState().ensureUnlocked();
    const targetIndex = state.nextParagraphIndex;
    await get().playParagraph(targetIndex);
  },

  playParagraph: async (paragraphIndex: number) => {
    const state = get();
    if (paragraphIndex >= state.paragraphs.length) {
      // 全部播放完毕，清理进度
      await get().clearProgress();
      return;
    }

    const textToPlay = state.paragraphs[paragraphIndex];
    const voiceId = state.voiceId || useConfigStore.getState().apiConfig.voiceId;
    const speed = state.speed || useConfigStore.getState().apiConfig.speed;

    // 检查预加载缓存
    let audioUrl = state.prefetchedAudioUrl;
    if (state.prefetchingIndex !== paragraphIndex || !audioUrl) {
      set({ status: 'synthesizing' });
      try {
        audioUrl = await fetchAudio(textToPlay, voiceId, speed);
      } catch (err) {
        set({ status: 'error' });
        GlassToast.show({ icon: 'fail', content: '语音生成稍有延迟，请重试' });
        throw err;
      }
    }

    // 消费预加载
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

    const msgId = state.sourceType === 'chat' ? state.sourceId ?? undefined : undefined;
    await usePlaybackStore.getState().playAudio(audioUrl, msgId);
  },

  prefetchNextParagraph: async (paragraphIndex: number) => {
    const state = get();
    // 严禁 lookahead > 1
    if (paragraphIndex !== state.nextParagraphIndex + 1) {
      return;
    }
    if (paragraphIndex >= state.paragraphs.length) {
      return;
    }
    // 暂停中、倒计时用尽、离线时严禁预加载
    if (!usePlaybackStore.getState().isPlaying) {
      return;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return;
    }
    const remainingMs = usePlaybackStore.getState().remainingMs;
    if (remainingMs !== null && remainingMs <= 0) {
      return;
    }
    if (state.prefetchingIndex === paragraphIndex) {
      return; // 正在预加载中
    }

    abortPrefetch();
    const abortCtrl = new AbortController();
    prefetchAbortController = abortCtrl;

    set({ prefetchingIndex: paragraphIndex });
    const textToPrefetch = state.paragraphs[paragraphIndex];
    const voiceId = state.voiceId || useConfigStore.getState().apiConfig.voiceId;
    const speed = state.speed || useConfigStore.getState().apiConfig.speed;

    try {
      const audioUrl = await fetchAudio(textToPrefetch, voiceId, speed);
      if (abortCtrl.signal.aborted) {
        return;
      }
      set({ prefetchedAudioUrl: audioUrl, prefetchingIndex: paragraphIndex });
    } catch {
      if (!abortCtrl.signal.aborted) {
        set({ prefetchingIndex: null });
      }
    } finally {
      if (prefetchAbortController === abortCtrl) {
        prefetchAbortController = null;
      }
    }
  },

  handleParagraphEnded: async (): Promise<boolean> => {
    const state = get();
    if (state.totalParagraphs <= 0 || state.paragraphs.length === 0) {
      return false;
    }

    const completed = state.nextParagraphIndex;
    const next = completed + 1;

    if (next < state.totalParagraphs) {
      // 推进段落并立即落盘
      set({
        lastCompletedParagraphIndex: completed,
        nextParagraphIndex: next,
      });
      await get().saveProgressImmediate({ forceReset: false });
      await get().playParagraph(next);
      return true;
    } else {
      // 故事完播，清除断点
      set({
        lastCompletedParagraphIndex: completed,
        nextParagraphIndex: next,
      });
      await get().clearProgress();
      return false;
    }
  },

  handleExplicitPause: () => {
    abortPrefetch();
    get().saveProgressDebounced({ forceReset: false });
  },

  replayFromStart: async () => {
    set({
      nextParagraphIndex: 0,
      lastCompletedParagraphIndex: -1,
    });
    await get().saveProgressImmediate({ forceReset: true });
    await get().playParagraph(0);
  },

  saveProgressDebounced: (options) => {
    clearDebounceTimer();
    debounceSaveTimer = setTimeout(() => {
      void get().saveProgressImmediate(options);
    }, 2000);
  },

  saveProgressImmediate: async (options) => {
    clearDebounceTimer();
    const state = get();
    if (!state.sourceType || !state.sourceId) {
      return;
    }
    // 门禁：瞬态 ID 绝对不持久化
    if (state.sourceId.startsWith('replay-text-')) {
      return;
    }

    // 门禁：chat 场景必须是 delivered 态
    if (state.sourceType === 'chat') {
      const msg = useChatStore.getState().messages.find((m) => m.id === state.sourceId);
      if (msg && msg.status !== 'delivered') {
        return;
      }
    }

    const saveKey = `${state.sourceId}:${state.nextParagraphIndex}:${options?.forceReset ? 'force' : 'normal'}`;
    if (!options?.forceReset && state.lastSavedKey === saveKey) {
      return; // 去重跳过
    }

    const playbackStore = usePlaybackStore.getState();

    try {
      await savePlaybackProgress({
        sourceType: state.sourceType,
        sourceId: state.sourceId,
        sessionId: state.sessionId ?? undefined,
        title: state.title || '音频故事',
        contentHash: state.contentHash,
        segmentationVersion: state.segmentationVersion,
        lastCompletedParagraphIndex: state.lastCompletedParagraphIndex,
        nextParagraphIndex: state.nextParagraphIndex,
        totalParagraphs: state.totalParagraphs,
        voiceId: state.voiceId,
        speed: state.speed,
        remainingAllowedMs: playbackStore.remainingMs ?? undefined,
        totalAllowedMs: playbackStore.totalAllowedMs ?? undefined,
        isOneShot: state.isOneShot,
        forceReset: options?.forceReset,
      });
      set({ lastSavedKey: saveKey });
    } catch (err) {
      console.warn('[playbackProgressStore] saveProgress failed', err);
    }
  },

  clearProgress: async () => {
    clearDebounceTimer();
    abortPrefetch();
    try {
      await clearPlaybackProgress();
    } catch (err) {
      console.warn('[playbackProgressStore] clearProgress failed', err);
    }
    get().reset();
  },

  reset: () => {
    clearDebounceTimer();
    abortPrefetch();
    set({
      ...INITIAL_PROGRESS_STATE,
    });
  },
});

export const usePlaybackProgressStore = create<PlaybackProgressStore>()(
  devtools(playbackProgressStoreCreator)
);
