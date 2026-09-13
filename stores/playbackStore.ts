/**
 * M5-09 Legacy Cutover：本文件正缩回 Audio Transport Store（spec §9.1）。
 * 新 SSOT = server 四表 + Anchor DTO + stores/playbackSessionStore.ts。
 * 下列语义 identity 副本已 @deprecated（M6 presentation 收敛时移除，
 * M9 物理删除）：sessionId / currentMessageId / sourceType / sourceId /
 * title / isOneShot / isRehydratedReady / currentParagraphIndex /
 * totalParagraphs。M6-04 已删除 spec §2.2 Mini 显隐三件套：Mini 显隐只由
 * PlaybackSession 派生（spec §2.3/§30），Transport 不再持有第二套显隐标记。
 * Transport 动作（playAudio/resumeAudio/pauseAudio/seek/setPlaybackRate/
 * ensureUnlocked/registerAudioController + isPlaying/currentTime/duration/
 * playbackRate/remainingMs/totalAllowedMs）保持不变，仍为全局 <audio> 唯一 ownership。
 * 旧字段仅作兼容镜像由 PlaybackSessionStore 同步写入，新代码禁止直接写入它们。
 */
import { useCallback } from 'react';
import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { AudioControllerHandle } from '@/types/audioPlayer';
import type { SleepTimerMode } from '@/lib/playback/sleepTimer';
import { resolveSleepTimerModeFromLegacy as resolveHydratedSleepTimerMode } from '@/lib/playback/sleepTimer';

/**
 * 一分钟对应的毫秒数，用于换算倒计时。
 */
const MINUTE_IN_MS = 60000;

/**
 * M7-02 P3A seek clamp 纯函数（spec §17.3）。
 * 所有 seek 必须 clamp(target, 0, duration)；duration=0/unknown fail-safe 返回 null（调用方 no-op）。
 * @param target 目标秒数
 * @param duration 当前段总时长（秒）
 * @returns 钳制后秒数；不可 seek 时返回 null
 */
export const clampSegmentSeekTarget = (target: number, duration: number): number | null => {
  if (!Number.isFinite(target) || !Number.isFinite(duration)) {
    return null;
  }
  if (!(duration > 0)) {
    return null;
  }
  if (target <= 0) {
    return 0;
  }
  if (target >= duration) {
    return duration;
  }
  return target;
};

/**
 * M7-02 playbackRate 合法性（spec §20：保留七档语义，Transport 接受 0.25–4.0 有限值）。
 */
export const isValidTransportPlaybackRate = (rate: number): boolean =>
  typeof rate === 'number' && Number.isFinite(rate) && rate >= 0.25 && rate <= 4.0;

/**
 * 播放器状态数据结构：Transport 字段为 SSOT；以下 identity 字段已 deprecated。
 */
type PlaybackStoreBaseState = {
  /** @deprecated M5-09：session identity 已迁移至 PlaybackSessionStore.sessionId，本字段仅兼容镜像。 */
  sessionId: string | null;
  isPlaying: boolean;
  /**
   * M7-03 fixup（复审 Blocking 1 / §25.1）：音频“实际推进”的纯运行时信号（Host 上报 buffering 生命周期）。
   * waiting/stalled/pause/ended → false；playing → true。仅用于 countdown 门使 buffering 不计入
   * “再听 N 分钟”，不参与 Session 语义状态（waiting ≠ 用户暂停，status 不改、不 checkpoint）。
   */
  audioActive: boolean;
  currentSegmentIndex: number;
  playbackRate: number;
  remainingMs: number | null;
  totalAllowedMs: number | null;
  /**
   * M7-03 Sleep Timer 三态（spec §22/§25：只有 minutes 才启动 countdown）。
   * 与 remainingMs/totalAllowedMs 同步（hydrate/setSleepTimer/expiry/complete/reset 统一维护）。
   */
  sleepTimerMode: SleepTimerMode;
  currentTime: number;
  duration: number;
  _tickIntervalId: ReturnType<typeof setInterval> | null;
  _lastTickAt: number | null;
  /**
   * M7-03 到期编排回调（spec §26：pause → checkpoint → off 由 Flow/Session 承接）。
   * Transport 只负责 pause audio + 状态归一，领域后事（checkpoint/Toast）经此回调
   * 交给 playbackSessionFlow.handleSleepTimerExpired（AudioControllerHost 挂载时注册）。
   */
  _onSleepTimerExpired: (() => void) | null;
  audioController: AudioControllerHandle | null;
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
  /** M7-03 fixup（§25.1）：Host 上报音频实际推进信号（waiting/stalled=false；playing=true）。 */
  reportAudioActive: (active: boolean) => void;
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
    /** M7-03 Sleep Timer 三态（缺省按 Legacy 派生）。 */
    sleepTimerMode?: SleepTimerMode;
    isOneShot: boolean;
    currentParagraphIndex: number;
    totalParagraphs: number;
  }) => void;
  clearRehydratedReady: () => void;
  /**
   * M7-03 同步 Sleep Timer 三态 + 预算（spec §25：只有 minutes 启动 countdown）。
   * 由 Session 侧（hydrate/begin/setSleepTimer/expiry/complete）统一调用；
   * 非法 mode 直接忽略；off/story_end 到期归一（0 残留→null）。
   * @param mode 三态
   * @param remainingMs 剩余毫秒（off/story_end 必须为 null）
   * @param totalMs 总额毫秒（off/story_end 必须为 null）
   */
  setSleepTimerState: (mode: SleepTimerMode, remainingMs: number | null, totalMs: number | null) => void;
  /**
   * M7-03 注册到期编排回调（AudioControllerHost 挂载时经 flow 注册；reset 不清除）。
   * @param handler 到期回调（无则传 null 解除）
   */
  registerSleepTimerExpiryHandler: (handler: (() => void) | null) => void;
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
  audioActive: false,
  currentSegmentIndex: 0,
  playbackRate: 1,
  remainingMs: null,
  totalAllowedMs: null,
  sleepTimerMode: 'off',
  currentTime: 0,
  duration: 0,
  _tickIntervalId: null,
  _lastTickAt: null,
  _onSleepTimerExpired: null,
  audioController: null,
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
   * M7-03 P3C：起停必须同 realm（同 globalThis.setInterval/clearInterval 配对）；
   * 混用 window.* 与裸调用会在 jsdom 等多 realm 下清不掉计时器（ orphan interval
   * 导致测试进程 hanging；浏览器 globalThis===window，语义不变）。
   */
  const clearCountdown = () => {
    const intervalId = get()._tickIntervalId;
    if (intervalId !== null) {
      globalThis.clearInterval(intervalId);
    }
    set({
      _tickIntervalId: null,
      _lastTickAt: null,
    });
  };

  /**
   * 启动倒计时：每秒扣减剩余播放时间；当到达 0 时自动暂停播放。
   * M7-03（spec §25/§25.1）：只有 sleepTimerMode == minutes 才启动 countdown；
   * 只在音频真实播放时减少（tick 内以 isPlaying 为门，paused/synthesizing/
   * network wait/ready 均不扣——“再听 N 分钟”语义，M7-P03）。
   */
  const startCountdown = () => {
    if (typeof window === 'undefined') {
      return;
    }

    const existingIntervalId = get()._tickIntervalId;
    if (existingIntervalId !== null) {
      return;
    }

    // M7-03：非 minutes 模式不启动倒计时（off/story_end 无墙钟 semantics）。
    if (get().sleepTimerMode !== 'minutes' || get().remainingMs === null) {
      return;
    }

    const tick = () => {
      const state = get();
      if (state.sleepTimerMode !== 'minutes' || state.remainingMs === null) {
        clearCountdown();
        return;
      }
      if (!state.isPlaying) {
        // 用户暂停：停表（恢复播放由 start() 重新挂表，现状语义）。
        clearCountdown();
        return;
      }
      if (!state.audioActive) {
        // M7-03 fixup（复审 Blocking 1 / §25.1）：network wait / buffering 不是用户暂停——
        // 不扣减、不拆表、不触 expiry、不 checkpoint；刷新锚点防等待时长在恢复后被补扣。
        set({ _lastTickAt: Date.now() });
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
        handleSleepTimerExpiry();
      }
    };

    const intervalId = globalThis.setInterval(tick, 1000);
    set({
      _tickIntervalId: intervalId,
      _lastTickAt: Date.now(),
    });
  };

  /**
   * M7-03 Sleep Timer 到期（spec §26 M7 新规则）：
   * pause audio → 状态归一（mode=off, remaining=null, total=null, isPlaying=false）
   * → 经 _onSleepTimerExpired 交 Flow/Session 做 checkpoint + Toast。
   * Session 保留 paused；之后 Play 正常继续（null 预算不受旧 <=0 守卫影响）。
   */
  const handleSleepTimerExpiry = () => {
    clearCountdown();
    set({
      isPlaying: false,
      sleepTimerMode: 'off',
      remainingMs: null,
      totalAllowedMs: null,
    });
    // 中文注释：到期声画一致——倒计时归零须联动暂停音频元素，否则 UI 暂停而音频续响（H-08 同源）。
    get().audioController?.pause();
    const handler = get()._onSleepTimerExpired;
    if (handler) {
      try {
        handler();
      } catch (error) {
        console.warn('[playbackStore] sleep timer expiry handler failed', error);
      }
    }
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
        // M7-03：legacy 入口保持“有时长即 minutes”旧语义（新 Session 默认走
        // flow.setSleepTimerState 显式同步，此处仅兼容 storyFlow 旧链，M9 删除）。
        sleepTimerMode: 'minutes',
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        _lastTickAt: null,
        currentAudioUrl: null,
        currentMessageId: null,
        isOneShot: options?.oneShot ?? false,
      });
    },
    /**
     * 开始播放：设置播放状态并启动倒计时。
     * M7-03（spec §26/H-08）：已知耗尽（非 null 且 <=0）在任何模式下早退
     * （fail-closed：legacy 面无 mode 概念，0 即耗尽；新面该状态经归一不可达，
     * 到期归一 null 后 Play 正常继续，不锁死）；
     * minutes 模式 null（未知预算）亦早退；off/story_end 的 null 为合法无限态，放行。
     * @returns void
     */
    start: () => {
      // 中文注释：预算耗尽早退——已知耗尽（<=0）在任何模式下不得放行；
      // minutes+null（未知预算）早退；off/story_end+null（合法无限）放行。
      const startRemainingMs = get().remainingMs;
      if (startRemainingMs !== null && startRemainingMs <= 0) {
        return;
      }
      if (get().sleepTimerMode === 'minutes' && startRemainingMs === null) {
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
     * M7-03 fixup（复审 Blocking 1 / §25.1）：Host 上报音频实际推进信号（buffering 生命周期）。
     * 幂等；不改 Session 语义状态（waiting ≠ 用户暂停：status 保持、无 checkpoint、无 Toast）。
     */
    reportAudioActive: (active) => {
      if (get().audioActive === active) {
        return;
      }
      set({ audioActive: active });
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
     * M7-02：非法值直接忽略（不写 Transport、不触 controller）；合法值同步 controller。
     * @param rate number 目标倍速值
     * @returns void
     */
    setPlaybackRate: (rate, options) => {
      if (!isValidTransportPlaybackRate(rate)) {
        return;
      }
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
     * M7-03：到期回调 handler 与 audioController 同为 Host 级注册，随挂载生命周期，
     * reset 不清除（clearSession/reset 后到期编排仍可用）。
     * @returns void
     */
    reset: () => {
      clearCountdown();
      const controller = get().audioController;
      const expiryHandler = get()._onSleepTimerExpired;
      controller?.pause();
      set({
        ...INITIAL_STATE,
        currentAudioUrl: null,
        currentMessageId: null,
        audioController: controller,
        _onSleepTimerExpired: expiryHandler,
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
      // 中文注释：预算耗尽守卫——已知耗尽（非 null 且 <=0）时任何模式下任何 playAudio
      // 不得出声/切轨（H-08，legacy 面无 mode 概念时 0 即耗尽）；
      // minutes+null（未知预算）同样拦截；off/story_end+null（合法无限）放行（M7-03 §26 到期后继续）。
      const playBudgetMs = get().remainingMs;
      if (playBudgetMs !== null && playBudgetMs <= 0) {
        return;
      }
      if (get().sleepTimerMode === 'minutes' && playBudgetMs === null) {
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
      // 中文注释：预算耗尽守卫——已知耗尽（非 null 且 <=0）任何模式下 resume 不得续响；
      // minutes+null 拦截；off/story_end+null 合法，保持既有语义（M7-03 §26）。
      const resumeBudgetMs = get().remainingMs;
      if (resumeBudgetMs !== null && resumeBudgetMs <= 0) {
        return;
      }
      if (get().sleepTimerMode === 'minutes' && resumeBudgetMs === null) {
        return;
      }
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
     * M7-02 P3A（spec §17.3）：全 clamp + fail-safe。duration 未知/<=0 或 target 非法
     * 时 no-op（不触 controller、不抛错）；合法时钳制到 [0, duration] 后 seek。
     * 只动 Transport 段内 currentTime，不写 Session 段落 identity、不落 checkpoint。
     * @param time number 目标时间（秒）
     * @returns void
     */
    seekAudio: (time: number) => {
      const duration = get().duration;
      const clamped = clampSegmentSeekTarget(time, duration);
      if (clamped === null) {
        return;
      }
      get().audioController?.seek(clamped);
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
        // M7-03：Anchor.sleepTimerMode 缺省（旧快照）按 Legacy 派生，不得只依赖 transport 默认。
        sleepTimerMode: payload.sleepTimerMode ?? resolveHydratedSleepTimerMode(payload.remainingMs),
        isOneShot: payload.isOneShot,
        currentSegmentIndex: payload.currentParagraphIndex,
        currentParagraphIndex: payload.currentParagraphIndex,
        totalParagraphs: payload.totalParagraphs,
        isPlaying: false,
        isRehydratedReady: true,
        currentAudioUrl: null,
        currentTime: 0,
        duration: 0,
      });
    },
    clearRehydratedReady: () => {
      set({ isRehydratedReady: false });
    },
    setSleepTimerState: (mode, remainingMs, totalMs) => {
      if (mode !== 'off' && mode !== 'minutes' && mode !== 'story_end') {
        return;
      }
      // 到期归一：off/story_end 不得携带预算残留（0 亦归一 null，§26）。
      const normalizedRemaining = mode === 'minutes' ? remainingMs : null;
      const normalizedTotal = mode === 'minutes' ? totalMs : null;
      const shouldCountdown =
        mode === 'minutes' && typeof normalizedRemaining === 'number' && normalizedRemaining > 0;
      // 切换出 minutes 时停掉在途 countdown（setSleepTimer off/story_end 立即停表）。
      if (!shouldCountdown && get()._tickIntervalId !== null) {
        clearCountdown();
      }
      set({
        sleepTimerMode: mode,
        remainingMs: normalizedRemaining,
        totalAllowedMs: normalizedTotal,
        _lastTickAt: Date.now(),
      });
      // 切入可倒计时且正在播放时即时起表（setSleepTimer minutes 在播放中设置需立即生效）。
      if (shouldCountdown && get().isPlaying) {
        startCountdown();
      }
    },
    registerSleepTimerExpiryHandler: (handler) => {
      set({ _onSleepTimerExpired: handler });
    },
    /**
     * 补齐倒计时预算：仅在缺失时回填，不覆盖睡眠倒计时继承的已有数值。
     * M7-03（spec §26）：仅 minutes 模式回填；off/story_end 模式 null 为合法态，
     * 回填会错误复活已到期/已关闭的 Timer，必须拒绝。
     * @param budgetMs 回落预算（毫秒），须为有限正数，否则直接忽略
     */
    ensureCountdownBudget: (budgetMs) => {
      if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
        return;
      }
      const current = get();
      if (current.sleepTimerMode !== 'minutes') {
        return;
      }
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
 * 播放控制 Hook（M6-04 收官：已删除 spec §2.2 显隐命令；
 * Mini 显隐只由 PlaybackSession 派生，本 hook 仅保留 Transport 播放面
 * play/resume/pause，供 ChatLayout/AudioPlayer 显式点播入口使用）。
 * @returns 播放控制方法集合
 */
export const useFloatingPlayer = () => {
  const ensureUnlocked = usePlaybackStore((state) => state.ensureUnlocked);
  const playAudio = usePlaybackStore((state) => state.playAudio);
  const resumeAudio = usePlaybackStore((state) => state.resumeAudio);
  const pauseAudioPlayback = usePlaybackStore((state) => state.pauseAudioPlayback);

  const play = useCallback(
    async (audioUrl: string, messageId?: string, options?: { explicit?: boolean }) => {
      // 中文注释：play 即用户显式点播入口，缺省按显式放行（auto 须显式传 { explicit: false }）。
      await playAudio(audioUrl, messageId, { explicit: options?.explicit ?? true });
    },
    [playAudio]
  );

  const resume = useCallback(async () => {
    await resumeAudio();
  }, [resumeAudio]);

  const pause = useCallback(() => {
    pauseAudioPlayback();
  }, [pauseAudioPlayback]);

  return {
    ensureUnlocked,
    play,
    resume,
    pause,
  };
};
