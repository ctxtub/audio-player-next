import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

const MINUTE_IN_MS = 60_000;

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
};

/**
 * 播放器可执行的动作：启动/暂停播放、更新进度、推进段落、恢复初始状态等。
 */
type PlaybackStoreActions = {
  markSessionStart: (sessionId: string, playDurationMinutes: number) => void;
  start: () => void;
  pause: () => void;
  updateProgress: (payload: { currentTime: number; duration: number }) => void;
  setPlaybackRate: (rate: number) => void;
  advanceSegment: () => void;
  reset: () => void;
};

export type PlaybackStore = PlaybackStoreBaseState & PlaybackStoreActions;

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
};

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

    const intervalId = window.setInterval(tick, 1_000);
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
      });
    },
    /**
     * 开始播放：设置播放状态并启动倒计时。
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
     */
    pause: () => {
      set({ isPlaying: false });
    },
    /**
     * 更新播放器的当前进度，用于展示或后续逻辑计算。
     * @param payload.currentTime 当前时间（秒）
     * @param payload.duration 当前音频总时长（秒）
     */
    updateProgress: ({ currentTime, duration }) => {
      set({
        currentTime,
        duration,
      });
    },
    setPlaybackRate: (rate) => {
      set({
        playbackRate: rate,
      });
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
     */
    reset: () => {
      clearCountdown();
      set({ ...INITIAL_STATE });
    },
  };
};

export const usePlaybackStore = create<PlaybackStore>()(devtools(playbackStoreCreator));
