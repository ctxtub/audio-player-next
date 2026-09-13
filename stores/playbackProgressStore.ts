/**
 * 客户端断点续播状态机 Store
 *
 * @deprecated M5-09 Legacy Cutover：新 SSOT 为 stores/playbackSessionStore.ts
 *（server 四表 + Anchor DTO，经 library.get(workId) 精确 resolve，§25.1）。
 * 本文件保留为 compatibility adapter 一个迁移周期（M9 删除），行为不动：
 * - initForUser/initForGuest 仍可用，但 AccountSync 已切换到 PlaybackSessionStore.init；
 * - hydrateFromDTO 仍支持旧 PlaybackProgressDTO（getProgress/saveProgress/clearProgress），
 *   新代码禁止新增调用，一律走 playback.getAnchor / PlaybackSessionStore；
 * - 本文件绝不作为 Work rehydrate 的 source 解析入口（分页后 find(id) 必然丢失远页 Anchor）。
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
  playParagraph: (paragraphIndex: number, options?: { explicit?: boolean }) => Promise<void>;
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
    // M5-03 reader 四值兼容：chat|draft 同走 Chat 消息分支，generation|work 同走作品分支
    //（DB canonical 为 draft|work，旧值 chat|generation 仍可读，至少一个兼容周期）。
    let storyText = '';

    if (dto.sourceType === 'chat' || dto.sourceType === 'draft') {
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
    } else if (dto.sourceType === 'generation' || dto.sourceType === 'work') {
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
      currentMessageId:
        dto.sourceType === 'chat' || dto.sourceType === 'draft' ? dto.sourceId : null,
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
    // 中文注释：恢复态预算补齐——DTO 数值优先（水合已写入 playbackStore），缺失时回落到用户配置播放时长
    // （与 startStoryPlayback 同源：playDuration 分钟→毫秒），避免 remainingMs=null 导致 start() 早返。
    // 仅补齐 null 项，不覆盖睡眠倒计时继承的已有数值；新故事/一次性回放路径不经过此处，语义不受影响。
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
        const latest = get();
        if (latest.remainingAllowedMs === null || latest.totalAllowedMs === null) {
          set({
            remainingAllowedMs: latest.remainingAllowedMs ?? fallbackBudgetMs,
            totalAllowedMs: latest.totalAllowedMs ?? fallbackBudgetMs,
          });
        }
      }
    }
    const targetIndex = get().nextParagraphIndex;
    // 中文注释：H-08 显式恢复链预算守卫（E2E-W2C-03-02）——回落补齐后仍已知耗尽时直接返回，
    // 不再进入 playParagraph 合成/出声；null 未知预算与正常预算保持既有语义。
    const resumeBudgetMs = usePlaybackStore.getState().remainingMs;
    if (resumeBudgetMs !== null && resumeBudgetMs <= 0) {
      return;
    }
    await get().playParagraph(targetIndex, { explicit: true });
  },

  playParagraph: async (paragraphIndex: number, options?: { explicit?: boolean }) => {
    const state = get();
    if (paragraphIndex >= state.paragraphs.length) {
      // 全部播放完毕，清理进度
      await get().clearProgress();
      return;
    }
    // 中文注释：H-08 预算耗尽守卫（E2E-W2C-03-02）——已知耗尽（非 null 且 <=0）时直接返回，
    // 不合成、不出声、不推进 next；null 未知预算与正常预算保持既有语义（含 H-07 显式放行）。
    const paragraphBudgetMs = usePlaybackStore.getState().remainingMs;
    if (paragraphBudgetMs !== null && paragraphBudgetMs <= 0) {
      return;
    }
    // 中文注释：H-07 切换窗口守卫（入口快拦，仅限自动续播链）——暂停且已有在播轨道时自动续播不再覆盖暂停意图，
    // 省去无效合成；初始起播（无轨道）与播放态放行；用户显式点播（explicit:true）一律放行。
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

    // 中文注释：H-07 切换窗口守卫（合成后复检，仅限自动续播链）——慢 TTS 放大的切换窗口内暂停须被尊重，
    // 合成完成时自动续播若已暂停且有轨道则不再续播（防覆盖暂停意图）；显式点播放行。
    if (
      !usePlaybackStore.getState().isPlaying &&
      usePlaybackStore.getState().currentAudioUrl !== null &&
      !options?.explicit
    ) {
      return;
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

    const msgId =
      state.sourceType === 'chat' || state.sourceType === 'draft'
        ? (state.sourceId ?? undefined)
        : undefined;
    await usePlaybackStore.getState().playAudio(audioUrl, msgId, { explicit: options?.explicit });
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
      // 中文注释：H-07 自动续播链——段落自然结束的推进不带 explicit，暂停窗口守卫继续拦截。
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
    await get().playParagraph(0, { explicit: true });
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

    // 门禁：chat/draft 场景必须是 delivered 态（M5-03：draft 为 chat 的 canonical 形态，同门禁）
    if (state.sourceType === 'chat' || state.sourceType === 'draft') {
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
