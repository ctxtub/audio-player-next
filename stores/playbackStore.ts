import { useCallback } from 'react';
import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { AudioControllerHandle } from '@/types/audioPlayer';

/**
 * 一分钟对应的毫秒数，用于换算倒计时。
 */
const MINUTE_IN_MS = 60000;

/**
 * 播放器状态数据结构：负责记录播放会话标识、倒计时、当前段落与进度。
 */
type PlaybackStoreBaseState = {
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
   */
  isFloatingVisible: boolean;
};

/**
 * 播放器可执行的动作：启动/暂停播放、更新进度、推进段落、恢复初始状态等。
 */
type PlaybackStoreActions = {
  markSessionStart: (sessionId: string, playDurationMinutes: number) => void;
  start: () => void;
  pause: () => void;
  updateProgress: (payload: { currentTime: number; duration: number }) => void;
  setPlaybackRate: (rate: number, options?: { applyToController?: boolean }) => void;
  advanceSegment: () => void;
  reset: () => void;
  registerAudioController: (controller: AudioControllerHandle | null) => void;
  playAudio: (audioUrl: string) => Promise<void>;
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
     * @returns void
     */
    markSessionStart: (sessionId, playDurationMinutes) => {
      clearCountdown();
      set({
        sessionId,
        currentSegmentIndex: 0,
        remainingMs: playDurationMinutes * MINUTE_IN_MS,
        totalAllowedMs: playDurationMinutes * MINUTE_IN_MS,
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        _tickIntervalId: null,
        _lastTickAt: null,
        isFloatingVisible: false,
      });
    },
    /**
     * 开始播放：设置播放状态并启动倒计时。
     * @returns void
     */
    start: () => {
      if (get().remainingMs === null) {
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
      set({
        ...INITIAL_STATE,
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
     * 播放指定音频地址，若控制器尚未注册则抛出异常。
     * @param audioUrl string 音频文件地址
     * @returns Promise<void>
     */
    playAudio: async (audioUrl: string) => {
      const controller = get().audioController;
      if (!controller) {
        throw new Error('音频播放器尚未注册');
      }
      set({ isFloatingVisible: true });
      await controller.play(audioUrl);
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
  const playAudio = usePlaybackStore((state) => state.playAudio);
  const resumeAudio = usePlaybackStore((state) => state.resumeAudio);
  const pauseAudioPlayback = usePlaybackStore((state) => state.pauseAudioPlayback);
  const showFloatingPlayer = usePlaybackStore((state) => state.showFloatingPlayer);
  const hideFloatingPlayer = usePlaybackStore((state) => state.hideFloatingPlayer);

  const play = useCallback(
    async (audioUrl: string) => {
      showFloatingPlayer();
      await playAudio(audioUrl);
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
    play,
    resume,
    pause,
    show: showFloatingPlayer,
    hide: hideFloatingPlayer,
  };
};
