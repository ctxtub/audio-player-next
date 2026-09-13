/**
 * M5-09 Legacy Cutover：本文件正缩回 Audio Transport Store（spec §9.1）。
 * 新 SSOT = server 四表 + Anchor DTO + stores/playbackSessionStore.ts。
 * 下列语义 identity 副本已 @deprecated（M6 presentation 收敛时移除，
 * M9 物理删除）：sessionId / currentMessageId / sourceType / sourceId /
 * title / isOneShot / isRehydratedReady / currentParagraphIndex /
 * totalParagraphs / isFloatingVisible。Transport 动作
 *（playAudio/resumeAudio/pauseAudio/seek/setPlaybackRate/ensureUnlocked/
 * registerAudioController + isPlaying/currentTime/duration/playbackRate/
 * remainingMs/totalAllowedMs）保持不变，仍为全局 <audio> 唯一 ownership。
 * 旧字段仅作兼容镜像由 PlaybackSessionStore 同步写入，新代码禁止直接写入它们。
 */
import { useCallback } from 'react';
import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { AudioControllerHandle } from '@/types/audioPlayer';

/**
 * 一分钟对应的毫秒数，用于换算倒计时。
 */
const MINUTE_IN_MS = 60000;

/**
 * 播放器状态数据结构：Transport 字段为 SSOT；以下 identity 字段已 deprecated。
 */
type PlaybackStoreBaseState = {
  /** @deprecated M5-09：session identity 已迁移至 PlaybackSessionStore.sessionId，本字段仅兼容镜像。 */
  sessionId: string | null;
  isPlaying: boolean;
  currentSegmentIndex: number;
  playbackRate: number;
  remainingMs: number | null;
  totalAllowedMs: number | null;
  currentTime: number;
  duration: number;
  _tickIntervalId: number | null;
  _lastTickAt: number | null;
  audioController: AudioControllerHandle | null;
  /**
   * 浮动播放器是否展示。
   * @deprecated M5-09：属 M6 presentation state，不再作为 playback engine 状态。新代码勿读。
   */
  isFloatingVisible: boolean;
  /**
   * 当前播放的音频地址。
   */
  currentAudioUrl: string | null;
  /**
   * 当前播放的故事消息 ID（用于追踪“下一段”）。
   * @deprecated M5-09：已迁移至 PlaybackSessionStore.source，本字段仅兼容镜像。
   */
  currentMessageId: string | null;
  /**
   * 一次性播放（如历史回放）：播完即止，不触发预加载续写。
   * @deprecated M5-09：已收敛为 PlaybackSessionStore.continuationMode finite|extendable（§11），本字段仅兼容镜像。
   */
  isOneShot: boolean;
  /**
   * 是否处于断点水合完成的就绪待播态（停驻 PAUSED/READY，解封播放按钮）。
   * @deprecated M5-09：已迁移至 PlaybackSessionStore.status=ready，本字段仅兼容镜像。
   */
  isRehydratedReady: boolean;
  /**
   * 创作源类型：M5-03 起为四值兼容 'chat' | 'generation' | 'draft' | 'work'
   *（DB canonical 为 draft|work，旧值仍可读；新写统一由 server 收敛为 canonical）。
   * @deprecated M5-09：已迁移至 PlaybackSessionStore.source，本字段仅兼容镜像。
   */
  sourceType: 'chat' | 'generation' | 'draft' | 'work' | null;
  /**
   * 溯源业务标识。
   * @deprecated M5-09：已迁移至 PlaybackSessionStore.source，本字段仅兼容镜像。
   */
  sourceId: string | null;
  /**
   * 故事展示标题。
   * @deprecated M5-09：已迁移至 PlaybackSessionStore.title，本字段仅兼容镜像。
   */
  title: string | null;
  /**
   * 当前自然段序号（从 0 开始）。
   * @deprecated M5-09：已迁移至 PlaybackSessionStore.nextParagraphIndex，本字段仅兼容镜像。
   */
  currentParagraphIndex: number;
  /**
   * 该故事总自然段数。
   * @deprecated M5-09：已迁移至 PlaybackSessionStore.totalParagraphs，本字段仅兼容镜像。
   */
  totalParagraphs: number;
};

/**
 * 播放器可执行的动作：启动/暂停播放、更新进度、推进段落、恢复初始状态等。
 */
type PlaybackStoreActions = {
  markSessionStart: (
    sessionId: string,
    playDurationMinutes: number,
    options?: { oneShot?: boolean }
  ) => void;
  start: () => void;
  pause: () => void;
  updateProgress: (payload: { currentTime: number; duration: number }) => void;
  setPlaybackRate: (rate: number, options?: { applyToController?: boolean }) => void;
  advanceSegment: () => void;
  reset: () => void;
  registerAudioController: (controller: AudioControllerHandle | null) => void;
  ensureUnlocked: () => Promise<void>;
  playAudio: (audioUrl: string, messageId?: string, options?: { explicit?: boolean }) => Promise<void>;
  resumeAudio: () => Promise<void>;
  pauseAudioPlayback: () => void;
  seekAudio: (time: number) => void;
  /**
   * 显示浮动播放器面板。
   * @returns void
   */
  showFloatingPlayer: () => void;
  /**
   * 隐藏浮动播放器面板。
   * @returns void
   */
  hideFloatingPlayer: () => void;
  setCurrentAudioUrl: (url: string | null) => void;
  syncPlaybackState: (url: string, messageId?: string) => void;
  /**
   * 断点水合装载：置为就绪暂停态，解封播放按钮。
   */
  hydrateFromProgress: (payload: {
    sessionId: string | null;
    currentMessageId: string | null;
    sourceType: 'chat' | 'generation' | 'draft' | 'work' | null;
    sourceId: string | null;
    title: string;
    remainingMs: number | null;
    totalAllowedMs: number | null;
    isOneShot: boolean;
    currentParagraphIndex: number;
    totalParagraphs: number;
  }) => void;
  clearRehydratedReady: () => void;
  /**
   * 补齐倒计时预算：仅填充仍为 null 的剩余/总额，不覆盖已有数值。
   * @param budgetMs 回落预算（毫秒），必须为有限正数
   */
  ensureCountdownBudget: (budgetMs: number) => void;
  setParagraphInfo: (info: {
    currentParagraphIndex: number;
    totalParagraphs: number;
    title?: string;
  }) => void;
};

/**
 * 播放器 store 的完整状态与动作集合。
 */
export type PlaybackStore = PlaybackStoreBaseState & PlaybackStoreActions;

/**
 * 播放器状态的默认初始值。
 */
const INITIAL_STATE: PlaybackStoreBaseState = {
  sessionId: null,
  isPlaying: false,
  currentSegmentIndex: 0,
  playbackRate: 1,
  remainingMs: null,
  totalAllowedMs: null,
  currentTime: 0,
  duration: 0,
  _tickIntervalId: null,
  _lastTickAt: null,
  audioController: null,
  isFloatingVisible: false,
  currentAudioUrl: null,
  currentMessageId: null,
  isOneShot: false,
  isRehydratedReady: false,
  sourceType: null,
  sourceId: null,
  title: null,
  currentParagraphIndex: 0,
  totalParagraphs: 1,
};

/**
 * 播放器 store 创建器，封装倒计时与状态更新逻辑。
 */
const playbackStoreCreator: StateCreator<PlaybackStore> = (set, get) => {
  /**
   * 停止倒计时定时器，防止内存泄漏或重复累加。
   */
  const clearCountdown = () => {
    const intervalId = get()._tickIntervalId;
    if (intervalId !== null) {
      clearInterval(intervalId);
    }
    set({
      _tickIntervalId: null,
      _lastTickAt: null,
    });
  };

  /**
   * 启动倒计时：每秒扣减剩余播放时间；当到达 0 时自动暂停播放。
   */
  const startCountdown = () => {
    if (typeof window === 'undefined') {
      return;
    }

    const existingIntervalId = get()._tickIntervalId;
    if (existingIntervalId !== null) {
      return;
    }

    const tick = () => {
      const state = get();
      if (!state.isPlaying || state.remainingMs === null) {
        clearCountdown();
        return;
      }

      const now = Date.now();
      const lastTickAt = state._lastTickAt ?? now;
      const elapsed = now - lastTickAt;
      const nextRemaining = Math.max(0, state.remainingMs - elapsed);

      set({
        remainingMs: nextRemaining,
        _lastTickAt: now,
      });

      if (nextRemaining === 0) {
        clearCountdown();
        set({
          isPlaying: false,
        });
        // 中文注释：H-08 预算耗尽声画一致——倒计时归零须联动暂停音频元素，否则 UI 暂停而音频续响。
        get().audioController?.pause();
      }
    };

    const intervalId = window.setInterval(tick, 1000);
    set({
      _tickIntervalId: intervalId,
      _lastTickAt: Date.now(),
    });
  };

  return {
    ...INITIAL_STATE,
    /**
     * 标记新的播放会话：记录 sessionId、重置段落索引并初始化倒计时。
     * @param sessionId 当前故事会话标识
     * @param playDurationMinutes 允许播放时长（分钟）
     * @param options.oneShot 是否为一次性播放（历史回放），播完即止、不续写
     * @returns void
     */
    markSessionStart: (sessionId, playDurationMinutes, options) => {
      clearCountdown();
      set({
        sessionId,
        currentSegmentIndex: 0,
        remainingMs: playDurationMinutes * MINUTE_IN_MS,
        totalAllowedMs: playDurationMinutes * MINUTE_IN_MS,
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        _lastTickAt: null,
        isFloatingVisible: false,
        currentAudioUrl: null,
        currentMessageId: null,
        isOneShot: options?.oneShot ?? false,
      });
    },
    /**
     * 开始播放：设置播放状态并启动倒计时。
     * @returns void
     */
    start: () => {
      // 中文注释：H-08 预算耗尽早退——0 值与 null 同等视为无预算，不得放行（E2E-03-02）。
      const remainingMs = get().remainingMs;
      if (remainingMs === null || remainingMs <= 0) {
        return;
      }
      set({
        isPlaying: true,
        _lastTickAt: Date.now(),
      });
      startCountdown();
    },
    /**
     * 暂停播放并保持剩余时长，组件可继续显示倒计时。
     * @returns void
     */
    pause: () => {
      set({ isPlaying: false });
    },
    /**
     * 更新播放器的当前进度，用于展示或后续逻辑计算。
     * @param payload.currentTime 当前时间（秒）
     * @param payload.duration 当前音频总时长（秒）
     * @returns void
     */
    updateProgress: ({ currentTime, duration }) => {
      set({
        currentTime,
        duration,
      });
    },
    /**
     * 调整播放速率，供播放器组件响应倍速切换。
     * @param rate number 目标倍速值
     * @returns void
     */
    setPlaybackRate: (rate, options) => {
      set({
        playbackRate: rate,
      });
      if (options?.applyToController === false) {
        return;
      }
      const controller = get().audioController;
      controller?.setPlaybackRate(rate);
    },
    /**
     * 在切换到下一段音频时自增段落索引，便于统计或调试。
     */
    advanceSegment: () => {
      set((state) => ({
        currentSegmentIndex: state.currentSegmentIndex + 1,
      }));
    },
    /**
     * 恢复初始状态并清除定时器。
     * @returns void
     */
    reset: () => {
      clearCountdown();
      const controller = get().audioController;
      controller?.pause();
      set({
        ...INITIAL_STATE,
        currentAudioUrl: null,
        currentMessageId: null,
        audioController: controller,
      });
    },
    /**
     * 注册播放器控制器，供 Store 内部执行播放控制。
     * @param controller AudioControllerHandle 或 null
     * @returns void
     */
    registerAudioController: (controller) => {
      set({
        audioController: controller,
      });
      if (controller) {
        controller.setPlaybackRate(get().playbackRate);
      }
    },
    /**
     * 解锁音频播放能力，确保后续播放不会因手势限制失败。
     * @returns Promise<void>
     */
    ensureUnlocked: async () => {
      const controller = get().audioController;
      if (!controller) {
        throw new Error('音频播放器尚未注册');
      }
      await controller.unlock();
    },
    /**
     * 播放指定音频地址，若控制器尚未注册则抛出异常。
     * @param audioUrl string 音频文件地址
     * @param messageId string (可选) 关联的故事消息 ID
     * @param options.explicit boolean (可选) 是否为用户显式点播；不传视为自动续播链
     * @returns Promise<void>
     */
    playAudio: async (audioUrl: string, messageId?: string, options?: { explicit?: boolean }) => {
      const controller = get().audioController;
      if (!controller) {
        throw new Error('音频播放器尚未注册');
      }
      // 中文注释：H-08 预算耗尽守卫（E2E-W2C-03-02）——已知耗尽（非 null 且 <=0）时任何 playAudio 不得出声/切轨，
      // 堵住绕过 start() 早退的显式恢复链；null 为未知预算（新故事/一次性回放），保持既有放行语义，正常预算放行。
      const playBudgetMs = get().remainingMs;
      if (playBudgetMs !== null && playBudgetMs <= 0) {
        return;
      }
      // 中文注释：H-07 切换窗口守卫（仅限自动续播链）——暂停且已有在播轨道时自动续播不再覆盖暂停意图；
      // 初始起播（无轨道）与播放态放行；用户显式点播（explicit:true）一律放行，不改变正常切换语义。
      // 显式放行不预置 isPlaying：依赖控制器 play 成功后的 handlePlaybackStart 置位，
      // 合成失败/播放中断时暂停态得以保留，语义最干净。
      if (!get().isPlaying && get().currentAudioUrl !== null && !options?.explicit) {
        return;
      }
      set({
        isFloatingVisible: true,
        currentAudioUrl: audioUrl,
        currentMessageId: messageId ?? null,
        isRehydratedReady: false,
      });
      await controller.play(audioUrl, messageId);
    },
    /**
     * 恢复暂停的音频播放。
     * @returns Promise<void>
     */
    resumeAudio: async () => {
      const controller = get().audioController;
      if (!controller) {
        throw new Error('音频播放器尚未注册');
      }
      // 中文注释：H-08 预算耗尽守卫（E2E-W2C-03-02 点击 2 路径）——已知耗尽时 resume 不得续响音频元素，
      // 否则暂停态 UI 下音频播至段尾；null 未知预算与正常预算保持既有语义。
      const resumeBudgetMs = get().remainingMs;
      if (resumeBudgetMs !== null && resumeBudgetMs <= 0) {
        return;
      }
      set({ isFloatingVisible: true });
      await controller.resume();
    },
    /**
     * 暂停当前音频播放。
     * @returns void
     */
    pauseAudioPlayback: () => {
      get().audioController?.pause();
    },
    /**
     * 跳转到指定播放时间点。
     * @param time number 目标时间（秒）
     * @returns void
     */
    seekAudio: (time: number) => {
      get().audioController?.seek(time);
    },
    showFloatingPlayer: () => {
      set({ isFloatingVisible: true });
    },
    hideFloatingPlayer: () => {
      set({ isFloatingVisible: false });
    },
    /**
     * 直接设置当前的音频 URL，用于同步播放状态（例如自动切歌时）。
     * @param url 音频地址或 null
     */
    setCurrentAudioUrl: (url: string | null) => {
      set({ currentAudioUrl: url });
    },
    syncPlaybackState: (url: string, messageId?: string) => {
      set({
        isFloatingVisible: true,
        currentAudioUrl: url,
        currentMessageId: messageId ?? null,
      });
    },
    hydrateFromProgress: (payload) => {
      clearCountdown();
      set({
        sessionId: payload.sessionId,
        currentMessageId: payload.currentMessageId,
        sourceType: payload.sourceType,
        sourceId: payload.sourceId,
        title: payload.title,
        remainingMs: payload.remainingMs,
        totalAllowedMs: payload.totalAllowedMs,
        isOneShot: payload.isOneShot,
        currentSegmentIndex: payload.currentParagraphIndex,
        currentParagraphIndex: payload.currentParagraphIndex,
        totalParagraphs: payload.totalParagraphs,
        isPlaying: false,
        isRehydratedReady: true,
        currentAudioUrl: null,
        currentTime: 0,
        duration: 0,
        isFloatingVisible: true,
      });
    },
    clearRehydratedReady: () => {
      set({ isRehydratedReady: false });
    },
    /**
     * 补齐倒计时预算：仅在缺失时回填，不覆盖睡眠倒计时继承的已有数值。
     * @param budgetMs 回落预算（毫秒），须为有限正数，否则直接忽略
     */
    ensureCountdownBudget: (budgetMs) => {
      if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
        return;
      }
      const current = get();
      if (current.remainingMs === null || current.totalAllowedMs === null) {
        set({
          remainingMs: current.remainingMs ?? budgetMs,
          totalAllowedMs: current.totalAllowedMs ?? budgetMs,
        });
      }
    },
    setParagraphInfo: (info) => {
      set((state) => ({
        currentParagraphIndex: info.currentParagraphIndex,
        totalParagraphs: info.totalParagraphs,
        title: info.title !== undefined ? info.title : state.title,
      }));
    },
  };
};

/**
 * 播放器 store Hook，提供播放状态与操作。
 */
export const usePlaybackStore = create<PlaybackStore>()(devtools(playbackStoreCreator));

/**
 * 浮动播放器控制 Hook，封装播放显隐等操作。
 * @returns 浮动播放器控制方法集合
 */
export const useFloatingPlayer = () => {
  const ensureUnlocked = usePlaybackStore((state) => state.ensureUnlocked);
  const playAudio = usePlaybackStore((state) => state.playAudio);
  const resumeAudio = usePlaybackStore((state) => state.resumeAudio);
  const pauseAudioPlayback = usePlaybackStore((state) => state.pauseAudioPlayback);
  const showFloatingPlayer = usePlaybackStore((state) => state.showFloatingPlayer);
  const hideFloatingPlayer = usePlaybackStore((state) => state.hideFloatingPlayer);

  const play = useCallback(
    async (audioUrl: string, messageId?: string, options?: { explicit?: boolean }) => {
      showFloatingPlayer();
      // 中文注释：浮窗 play 即用户显式点播入口，缺省按显式放行（auto 须显式传 { explicit: false }）。
      await playAudio(audioUrl, messageId, { explicit: options?.explicit ?? true });
    },
    [playAudio, showFloatingPlayer]
  );

  const resume = useCallback(async () => {
    showFloatingPlayer();
    await resumeAudio();
  }, [resumeAudio, showFloatingPlayer]);

  const pause = useCallback(() => {
    pauseAudioPlayback();
  }, [pauseAudioPlayback]);

  return {
    ensureUnlocked,
    play,
    resume,
    pause,
    show: showFloatingPlayer,
    hide: hideFloatingPlayer,
  };
};
