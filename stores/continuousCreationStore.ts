/**
 * 连续创作 store（薄封装 `lib/continuous-creation/stateMachine`）。
 *
 * 唯一职责：把纯状态机接到 Zustand，并持有 collection identity；不做 IO、不生成、不播放。
 * 真正的编排（生成下一 Work / 准备音频 / 自动续播）在
 * `app/services/continuousCreationFlow.ts`，且必须携带 epoch 并经 `isStale` 守卫。
 */

import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

import {
  canScheduleNext,
  createInitialState,
  hasNextJob,
  isStaleCallback,
  reduce,
  type ContinuousCreationEvent,
  type ContinuousCreationState,
  type ContinuousCreationStatus,
} from '@/lib/continuous-creation/stateMachine';

/** store 状态 = 状态机快照 + 当前集合身份。 */
export type ContinuousCreationStoreState = ContinuousCreationState & {
  /** 当前集合 id；null = 尚未有集合（首作晋升前）。 */
  collectionId: string | null;
};

/** store 动作。 */
export type ContinuousCreationStoreActions = {
  /** 打开开关。 */
  enable: () => void;
  /** 关闭开关并清除 next job。 */
  disable: () => void;
  /** 新建创作：递增 epoch、重新快照预算、清空窗口样本。 */
  resetForNewCreation: (params: {
    collectionId: string | null;
    budgetMinutes: number | null | undefined;
    epoch: number;
  }) => void;
  /** 直接设置预算快照（毫秒）。 */
  setBudget: (budgetMs: number | null) => void;
  /** 仅音频实际推进时调用；生成/TTS/缓冲/暂停不得调用。 */
  audioActiveTick: (deltaMs: number) => void;
  /** 请求调度下一作品；返回是否被接受（lookahead=1 时重复调度返回 false）。 */
  schedule: () => boolean;
  /** 下一作品生成失败。 */
  generationFailed: (error: string) => void;
  /** 下一作品进入音频准备。 */
  audioPreparing: () => void;
  /** 下一作品音频就绪（记录准备耗时样本）。 */
  audioReady: (prepMs: number) => void;
  /** 当前整轨结束。 */
  trackEnded: (hasReadyNext: boolean) => void;
  /** 消费已就绪的 next（自动续播后）。 */
  nextConsumed: () => void;
  /** 递增 epoch 并使旧回调失效。 */
  advanceEpoch: () => number;
  /** 调度门（enabled/预算/播放/epoch/无 next job）。 */
  canSchedule: (context: { nowPlaying: boolean; epoch: number }) => boolean;
  /** 该 epoch 是否已过期（stale 回调必须 no-op）。 */
  isStale: (epoch: number) => boolean;
  /** 当前是否占用唯一 next job 槽位。 */
  hasNextJob: () => boolean;
  /** 切换集合：以新 collectionId 重新初始化并递增 epoch。 */
  switchCollection: (collectionId: string | null) => number;
  /** 全局重置（登出等）。 */
  reset: () => void;
};

export type ContinuousCreationStore = ContinuousCreationStoreState &
  ContinuousCreationStoreActions;

const INITIAL_STATE: ContinuousCreationStoreState = {
  ...createInitialState(),
  collectionId: null,
};

/** 从 store 状态取出纯状态机快照。 */
function machineStateOf(state: ContinuousCreationStoreState): ContinuousCreationState {
  const { collectionId: _collectionId, ...machine } = state;
  void _collectionId;
  return machine;
}

/** 把纯状态机事件应用到 store（保留 collectionId）。 */
function applyEvent(
  state: ContinuousCreationStoreState,
  event: ContinuousCreationEvent,
): ContinuousCreationStoreState {
  return { ...reduce(machineStateOf(state), event), collectionId: state.collectionId };
}

/**
 * 会话/集合切换的「真取消 + 重新初始化」钩子（由 `continuousCreationFlow` 注册）。
 *
 * 分层原因：store 不得直接 import app service——service → chatFlow → chatStore 会成环。
 * 仅当编排服务已被加载（即可能已经产生在途/就绪 next）时钩子非空；否则无任务可取消，
 * `switchCollection` 退化为纯 epoch 推进 + 绑定新集合。
 *
 * 钩子语义（：abort 在途传输、清空 prepared/调度锁/采样点，
 * 再以新 collection identity 重新初始化并重新快照预算，返回新 epoch。
 */
export type ContinuousCreationSwitchHandler = (collectionId: string | null) => number;

let switchHandler: ContinuousCreationSwitchHandler | null = null;

/**
 * 注册/注销会话切换钩子（`continuousCreationFlow` 模块加载时注册）。
 * @param handler 钩子；null 表示注销（测试清理用）。
 */
export function registerContinuousCreationSwitchHandler(
  handler: ContinuousCreationSwitchHandler | null,
): void {
  switchHandler = handler;
}

/**
 * 关闭开关（disable）的「真取消」钩子（由 `continuousCreationFlow` 注册）。
 *
 * `disable` 不能只改 store status——必须 abort 在途生成传输并清空
 * 模块级 prepared/调度锁，否则关闭前就绪的 next 会被迟到 `handleTrackEnded` 取出续播。
 * 与 switch 钩子同理，store 不得反向 import service。
 */
export type ContinuousCreationCancelHandler = () => void;

let cancelHandler: ContinuousCreationCancelHandler | null = null;

/**
 * 注册/注销 disable 真取消钩子（`continuousCreationFlow` 模块加载时注册）。
 * @param handler 钩子；null 表示注销（测试清理用）。
 */
export function registerContinuousCreationCancelHandler(
  handler: ContinuousCreationCancelHandler | null,
): void {
  cancelHandler = handler;
}

const continuousCreationStoreCreator: StateCreator<ContinuousCreationStore> = (set, get) => ({
  ...INITIAL_STATE,

  enable: () => set((state) => applyEvent(state, { type: 'enable' })),
  disable: () => {
    // 关闭开关必须先走真取消 seam（abort 在途传输 + 清 prepared/
    // 调度锁），再落 disabled 终态；否则关闭前的就绪 next 会被迟到轨道结束续播。
    cancelHandler?.();
    set((state) => applyEvent(state, { type: 'disable' }));
  },

  resetForNewCreation: ({ collectionId, budgetMinutes, epoch }) =>
    set((state) => ({
      ...applyEvent(state, { type: 'reset', epoch, budgetMinutes }),
      collectionId,
    })),

  setBudget: (budgetMs) => set((state) => applyEvent(state, { type: 'setBudget', budgetMs })),

  audioActiveTick: (deltaMs) =>
    set((state) => applyEvent(state, { type: 'audioActiveTick', deltaMs })),

  schedule: () => {
    const before = get().status;
    set((state) => applyEvent(state, { type: 'schedule' }));
    return get().status !== before && get().status === 'generating_next';
  },

  generationFailed: (error) =>
    set((state) => applyEvent(state, { type: 'generationFailed', error })),
  audioPreparing: () => set((state) => applyEvent(state, { type: 'audioPreparing' })),
  audioReady: (prepMs) => set((state) => applyEvent(state, { type: 'audioReady', prepMs })),
  trackEnded: (hasReadyNext) =>
    set((state) => applyEvent(state, { type: 'trackEnded', hasReadyNext })),
  nextConsumed: () => set((state) => applyEvent(state, { type: 'nextConsumed' })),

  advanceEpoch: () => {
    set((state) => applyEvent(state, { type: 'advanceEpoch' }));
    return get().epoch;
  },

  switchCollection: (collectionId) => {
    // 切换会话/集合必须「真取消」在途 next 并清 prepared，
    // 不能只靠 epoch 失配做逻辑 no-op（否则 prepared/调度锁会占住 lookahead=1 槽位，
    // 导致新会话无法立即重新调度）。真实取消 + 重新初始化由编排服务钩子完成。
    if (switchHandler !== null) {
      return switchHandler(collectionId);
    }
    // 编排服务未加载（不存在在途/就绪任务可取消）：退化为纯 epoch 推进 + 绑定新集合。
    set((state) => ({
      ...applyEvent(state, { type: 'advanceEpoch' }),
      collectionId,
    }));
    return get().epoch;
  },

  canSchedule: (context) => canScheduleNext(machineStateOf(get()), context),
  isStale: (epoch) => isStaleCallback(machineStateOf(get()), epoch),
  hasNextJob: () => hasNextJob(machineStateOf(get())),
  reset: () => {
    // 评审闭合：登出/全局重置必须推进 epoch（绝不回落到 0），
    // 否则旧会话在途回调可能因 epoch 恰好相等而误判“新鲜”。
    const nextEpoch = get().epoch + 1;
    set({ ...INITIAL_STATE, epoch: nextEpoch });
  },
});

/** 连续创作 store Hook。 */
export const useContinuousCreationStore = create<ContinuousCreationStore>()(
  devtools(continuousCreationStoreCreator, { name: 'continuous-creation-store' }),
);

/** 状态卡文案映射（UI 与状态机同源）。 */
export const CONTINUOUS_CREATION_STATUS_LABEL: Record<ContinuousCreationStatus, string> = {
  disabled: '连续创作已关闭',
  enabled_idle: '连续创作已开启',
  generating_next: '正在生成下一集',
  preparing_audio: '正在准备下一集音频',
  next_ready: '下一集已就绪',
  waiting_next: '等待下一集',
  ended_budget: '播放预算已用完',
  error: '连续创作出错',
};

/** 人类可读剩余预算（mm:ss）；null = 不限。 */
export function formatRemainingMs(remainingMs: number | null): string {
  if (remainingMs === null) {
    return '不限';
  }
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
