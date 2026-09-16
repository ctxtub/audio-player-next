/**
 *：连续创作领域状态机（纯函数，无 React/Zustand/DB 依赖）。
 *
 * 契约来源：`docs/specs/2026-09-15-story-collection-continuous-creation-technical-design.md` §5
 * 对应连续创作、预算停止和下一作品准备状态。
 *
 * 设计约束：
 * - 单一状态源：状态机只描述编排状态与预算，不做 IO、不持有 token；
 * - 预算只在 audio 实际推进（audioActive）时递减，生成/TTS/缓冲/暂停不扣；
 * - 严格 work lookahead=1：`hasNextJob` 为真时不得再次调度；
 * - 调度窗 = 下一作品准备耗时的移动平均，clamp 30–120 秒，冷启动 60 秒；
 * - 所有异步回写携带 epoch，`isStaleCallback` 为真一律 no-op（stale guard）。
 */

/** 调度窗下界（毫秒）。 */
export const CONTINUOUS_WINDOW_MIN_MS = 30_000;
/** 调度窗上界（毫秒）。 */
export const CONTINUOUS_WINDOW_MAX_MS = 120_000;
/** 冷启动调度窗（毫秒）。 */
export const CONTINUOUS_WINDOW_COLD_START_MS = 60_000;
/** 每分钟毫秒数。 */
export const MS_PER_MINUTE = 60_000;

/** 连续创作状态机状态（与 UI 状态卡一一对应）。 */
export type ContinuousCreationStatus =
  | 'disabled'
  | 'enabled_idle'
  | 'generating_next'
  | 'preparing_audio'
  | 'next_ready'
  | 'waiting_next'
  | 'ended_budget'
  | 'error';

/** 会占用 lookahead=1 唯一槽位的状态。 */
const NEXT_JOB_STATUSES: ReadonlySet<ContinuousCreationStatus> = new Set([
  'generating_next',
  'preparing_audio',
  'next_ready',
]);

/** 状态机快照。 */
export type ContinuousCreationState = {
  /** 当前编排状态。 */
  status: ContinuousCreationStatus;
  /** 会话/集合代次；epoch 变化使一切旧回调失效。 */
  epoch: number;
  /** 本次会话预算快照（毫秒）；null = 不限（设置页播放时长为 0/缺失）。 */
  budgetMs: number | null;
  /** 剩余预算（毫秒）；null = 不限。 */
  remainingMs: number | null;
  /** 最近若干次「下一作品准备耗时」样本（用于移动平均）。 */
  prepSamplesMs: number[];
  /** 当前调度窗（毫秒）。 */
  windowMs: number;
  /** 最近一次错误文案（error 态）。 */
  lastError: string | null;
  /** 开关是否处于开启意图（与 status 解耦，便于 error/ended_budget 后恢复）。 */
  enabled: boolean;
};

/** 状态机事件。 */
export type ContinuousCreationEvent =
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'reset'; epoch: number; budgetMinutes: number | null | undefined }
  | { type: 'setBudget'; budgetMs: number | null }
  | { type: 'audioActiveTick'; deltaMs: number }
  | { type: 'schedule' }
  | { type: 'generationFailed'; error: string }
  | { type: 'audioPreparing' }
  | { type: 'audioReady'; prepMs: number }
  | { type: 'trackEnded'; hasReadyNext: boolean }
  | { type: 'nextConsumed' }
  | { type: 'advanceEpoch' };

/** 把设置页播放时长（分钟）换算为预算快照；<=0/缺失/非有限数视为不限（null）。 */
export function resolveBudgetMs(minutes: number | null | undefined): number | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  return Math.round(minutes * MS_PER_MINUTE);
}

/** 把任意耗时收敛到 30–120 秒窗口；非有限值回退冷启动 60 秒。 */
export function clampWindowMs(value: number): number {
  if (!Number.isFinite(value)) {
    return CONTINUOUS_WINDOW_COLD_START_MS;
  }
  return Math.min(CONTINUOUS_WINDOW_MAX_MS, Math.max(CONTINUOUS_WINDOW_MIN_MS, Math.round(value)));
}

/** 由历史准备耗时样本计算下一调度窗：EWMA（alpha=0.5），冷启动 60s，clamp 30–120s。 */
export function computeWindowMs(samples: readonly number[]): number {
  if (samples.length === 0) {
    return CONTINUOUS_WINDOW_COLD_START_MS;
  }
  let ewma = samples[0];
  for (let index = 1; index < samples.length; index += 1) {
    ewma = ewma * 0.5 + samples[index] * 0.5;
  }
  return clampWindowMs(ewma);
}

/** 构造初始状态（enabled 默认 true，符合「连续创作默认开启」）。 */
export function createInitialState(input?: {
  enabled?: boolean;
  epoch?: number;
  budgetMinutes?: number | null | undefined;
}): ContinuousCreationState {
  const enabled = input?.enabled ?? true;
  const budgetMs = resolveBudgetMs(input?.budgetMinutes);
  return {
    status: enabled ? 'enabled_idle' : 'disabled',
    epoch: input?.epoch ?? 0,
    budgetMs,
    remainingMs: budgetMs,
    prepSamplesMs: [],
    windowMs: CONTINUOUS_WINDOW_COLD_START_MS,
    lastError: null,
    enabled,
  };
}

/** 是否存在占位中的 next job（严格 lookahead=1）。 */
export function hasNextJob(state: ContinuousCreationState): boolean {
  return NEXT_JOB_STATUSES.has(state.status);
}

/** 回调 epoch 是否过期（stale guard：为真则 no-op）。 */
export function isStaleCallback(state: ContinuousCreationState, epoch: number): boolean {
  return epoch !== state.epoch;
}

/**
 * 是否为「锁死的终态」：开关关闭 / 预算耗尽。
 *
 * 终态一旦进入，任何迟到事件（trackEnded / nextConsumed / generationFailed /
 * schedule / audioPreparing / audioReady）都不得复活它；仅显式恢复路径
 *（enable / reset / setBudget）可离开终态。
 */
export function isTerminalStatus(status: ContinuousCreationStatus): boolean {
  return status === 'disabled' || status === 'ended_budget';
}

/** 预算是否仍可继续（不限或未耗尽）。 */
export function hasBudgetRemaining(state: ContinuousCreationState): boolean {
  return state.remainingMs === null || state.remainingMs > 0;
}

/**
 * 调度门：enabled、预算有效、当前 track 正在播放、epoch 匹配、无 next job。
 * 窗口判断由调用方用 `state.windowMs` 与剩余播放时长比较后决定。
 */
export function canScheduleNext(
  state: ContinuousCreationState,
  context: { nowPlaying: boolean; epoch: number },
): boolean {
  if (!state.enabled || state.status !== 'enabled_idle') {
    return false;
  }
  if (isStaleCallback(state, context.epoch)) {
    return false;
  }
  if (!context.nowPlaying) {
    return false;
  }
  return hasBudgetRemaining(state);
}

/** 当前 track 剩余时长是否已进入调度窗。 */
export function isWithinScheduleWindow(remainingTrackMs: number, windowMs: number): boolean {
  if (!Number.isFinite(remainingTrackMs)) {
    return false;
  }
  return remainingTrackMs <= windowMs;
}

/** 仅 audio 实际推进时递减；waiting_next/disabled/ended_budget/error 不扣。 */
export function applyAudioActiveTick(
  state: ContinuousCreationState,
  deltaMs: number,
): ContinuousCreationState {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return state;
  }
  if (state.remainingMs === null) {
    return state;
  }
  if (
    state.status === 'disabled' ||
    state.status === 'waiting_next' ||
    state.status === 'ended_budget' ||
    state.status === 'error'
  ) {
    return state;
  }
  const next = Math.max(0, state.remainingMs - deltaMs);
  if (next <= 0) {
    return { ...state, remainingMs: 0, status: 'ended_budget' };
  }
  return { ...state, remainingMs: next };
}

/** 追加准备耗时样本并重算窗口（保留最近 8 次）。 */
export function recordPrepSample(
  state: ContinuousCreationState,
  prepMs: number,
  maxSamples = 8,
): ContinuousCreationState {
  if (!Number.isFinite(prepMs) || prepMs < 0) {
    return state;
  }
  const prepSamplesMs = [...state.prepSamplesMs, prepMs].slice(-maxSamples);
  return { ...state, prepSamplesMs, windowMs: computeWindowMs(prepSamplesMs) };
}

/** 状态机归约（纯函数）。 */
export function reduce(
  state: ContinuousCreationState,
  event: ContinuousCreationEvent,
): ContinuousCreationState {
  //   修复轮 3：终态锁死守卫——disabled / ended_budget 一旦进入，迟到事件
  //（trackEnded / nextConsumed / generationFailed / schedule / audioPreparing / audioReady）
  // 一律 no-op，不得把终态复活成 waiting_next / enabled_idle / error。
  // 仅显式恢复路径（enable / reset / setBudget / advanceEpoch）可离开终态。
  if (isTerminalStatus(state.status)) {
    switch (event.type) {
      case 'enable':
      case 'reset':
      case 'setBudget':
      case 'advanceEpoch':
      case 'audioActiveTick':
        break;
      default:
        return state;
    }
  }
  switch (event.type) {
    case 'enable': {
      const enabled = true;
      if (state.status === 'ended_budget') {
        return { ...state, enabled, status: 'enabled_idle', remainingMs: state.budgetMs };
      }
      return { ...state, enabled, status: 'enabled_idle', lastError: null };
    }
    case 'disable':
      return { ...state, enabled: false, status: 'disabled', lastError: null };
    case 'reset': {
      const budgetMs = resolveBudgetMs(event.budgetMinutes);
      return {
        status: (state.enabled ?? true) ? 'enabled_idle' : 'disabled',
        epoch: event.epoch,
        budgetMs,
        remainingMs: budgetMs,
        prepSamplesMs: [],
        windowMs: CONTINUOUS_WINDOW_COLD_START_MS,
        lastError: null,
        enabled: state.enabled ?? true,
      };
    }
    case 'setBudget': {
      const budgetMs = event.budgetMs;
      const remainingMs = budgetMs;
      return {
        ...state,
        budgetMs,
        remainingMs,
        status:
          budgetMs !== null && budgetMs <= 0
            ? 'ended_budget'
            : state.enabled
              ? 'enabled_idle'
              : 'disabled',
      };
    }
    case 'audioActiveTick':
      return applyAudioActiveTick(state, event.deltaMs);
    case 'schedule':
      if (!state.enabled || state.status !== 'enabled_idle' || !hasBudgetRemaining(state)) {
        return state;
      }
      return { ...state, status: 'generating_next', lastError: null };
    case 'generationFailed':
      return { ...state, status: 'error', lastError: event.error };
    case 'audioPreparing':
      if (state.status !== 'generating_next') {
        return state;
      }
      return { ...state, status: 'preparing_audio' };
    case 'audioReady':
      if (state.status !== 'generating_next' && state.status !== 'preparing_audio') {
        return state;
      }
      return recordPrepSample({ ...state, status: 'next_ready', lastError: null }, event.prepMs);
    case 'trackEnded':
      if (event.hasReadyNext) {
        return { ...state, status: state.enabled ? 'enabled_idle' : 'disabled' };
      }
      return { ...state, status: state.enabled ? 'waiting_next' : 'disabled' };
    case 'nextConsumed':
      return { ...state, status: state.enabled ? 'enabled_idle' : 'disabled' };
    case 'advanceEpoch':
      return {
        ...state,
        epoch: state.epoch + 1,
        status: state.enabled ? 'enabled_idle' : 'disabled',
        lastError: null,
      };
    default:
      return state;
  }
}
