/**
 * 连续创作编排服务。
 *
 * 取代旧 `stores/preloadStore` + `AUTO_CONTINUE_PROMPT` 续写链：
 * - 调度门：enabled、预算有效、当前 track 正在播放、epoch 匹配、无 next job、进入调度窗；
 * - 严格 work lookahead=1：同一时刻至多一个在途/就绪的 next work；
 * - 生成经正式 `beginChatStream`（origin='preload' 隔离续写气泡，不写 History）；
 * - 所有异步回写携带 epoch + 运行代次，`isStale` / 代次失配一律 no-op；
 * - 预算只在 audio 实际推进时递减，耗尽立即停声并作废在途 next job。
 *
 *  评审闭合（最严解读）：停止矩阵（关闭开关 / 预算耗尽 / 新建创作 /
 * 切换集合 / 登出 / 用户输入抢占）必须真正作废所有在途 next job——
 * 旧结果绝不写回、等待中的结果不得复活自动续播、新会话可立即重新调度。
 *
 * 契约见连续创作技术方案的编排章节。
 */

import {
  useContinuousCreationStore,
  registerContinuousCreationSwitchHandler,
  registerContinuousCreationCancelHandler,
} from '@/stores/continuousCreationStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { isTerminalStatus, isWithinScheduleWindow } from '@/lib/continuous-creation/stateMachine';
import { resolveContinuousCreationBudgetMinutes } from '@/lib/continuous-creation/budget';

import { abortActiveChatStream, beginChatStream } from './chatFlow';

/** 连续创作续写指令（用户可见文案；预载 origin 隔离气泡）。 */
export const CONTINUOUS_CREATION_PROMPT = '请继续故事';

/** 已准备就绪、等待当前 track 结束后自动续播的下一作品。 */
export type PreparedNextWork = {
  audioUrl: string;
  segment: string;
  messageId: string;
};

/** 单槽位（lookahead=1）暂存；携带 epoch 以便 stale 判定。 */
let prepared: { epoch: number; work: PreparedNextWork } | null = null;
/** 是否已有生成在途（防并发重复调度）。 */
let scheduling = false;
/** 上次 audioActive 采样时间（null = 未在推进）。 */
let lastActiveAt: number | null = null;
/**
 * 运行代次：每次强重置/取消自增。异步生成结算时若代次已变，结果一律丢弃
 *（即使 store epoch 因 reset() 回落也绝不误判为“新鲜”），且旧 finally 不得释放新生成的锁。
 */
let runToken = 0;

/** 下一作品生成器签名。 */
type ContinuousCreationGenerator = (
  prompt: string,
) => Promise<{ messageId: string; audioUrl: string; content: string }>;

/** 默认生成器：经正式聊天流（origin='preload' 隔离气泡，不写 History）。 */
const defaultGenerator: ContinuousCreationGenerator = (prompt) =>
  beginChatStream(prompt, { origin: 'preload' });

const generateNextWork: ContinuousCreationGenerator = defaultGenerator;

/** 当前是否有已就绪的下一作品。 */
export function hasPreparedNextWork(): boolean {
  return prepared !== null;
}

/** 释放 prepared 持有的对象 URL（仅 blob:；远程 http(s) 不吊销）。 */
function revokePreparedBlob(): void {
  const url = prepared?.work.audioUrl;
  if (url && url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // 无 URL 环境（Node 测试）忽略。
    }
  }
}

/**
 * 清空编排运行时（新建创作/切换集合/登出）。
 *
 * 注意：本函数只清编排模块状态，不 abort 传输、不改 store status/epoch。
 * 需要「真取消在途生成」的调用方请用 {@link cancelPendingNextWork}。
 */
export function resetContinuousCreationRuntime(): void {
  runToken += 1;
  revokePreparedBlob();
  prepared = null;
  scheduling = false;
  lastActiveAt = null;
}

/**
 * 真正取消在途 next job：abort 传输 + 清编排运行时。
 *
 * store 侧 status/epoch 由调用方按各自语义处理（disable 保持 disabled；
 * 预算耗尽保持 ended_budget；新建创作 advanceEpoch + resetForNewCreation）。
 * 任一情况在途生成恢复后都会因 runToken 失配或 store 不再持有 next job 而被丢弃。
 */
export function cancelPendingNextWork(): void {
  abortActiveChatStream();
  resetContinuousCreationRuntime();
}

/**
 * 终止当前 track 的连续创作编排：真取消在途 next job 并递增 store epoch，
 * 使 next job 槽位清空（enabled_idle）、旧回调一律 stale。
 * 用于 one-shot / 预算外自然收尾等「本轮不再自动续播」的场景。
 */
export function endContinuousCreationRun(): void {
  cancelPendingNextWork();
  useContinuousCreationStore.getState().advanceEpoch();
}

/**
 *   会话/集合切换的真实取消 + 重新初始化。
 *
 * 停止矩阵要求「切换集合 → abort 且以新 collection identity 重新初始化」：
 * 1) 真 abort 在途生成传输，释放单槽 lookahead、清空 prepared（含 blob 释放）与采样点；
 * 2) 以新 collectionId 重新快照预算并递增 epoch——新会话可立即重新调度，
 *    旧会话迟到结果凭 runToken + epoch 双重失配一律丢弃。
 *
 * 注册到 `continuousCreationStore.switchCollection`（store 不得反向 import service）。
 * @param collectionId 新集合 id（可为 null：首作晋升前）。
 * @returns 新 epoch。
 */
function reinitializeForCollectionSwitch(collectionId: string | null): number {
  cancelPendingNextWork();
  const store = useContinuousCreationStore.getState();
  store.resetForNewCreation({
    collectionId,
    budgetMinutes: resolveContinuousCreationBudgetMinutes(),
    epoch: store.epoch + 1,
  });
  return useContinuousCreationStore.getState().epoch;
}

// 模块加载即注册切换钩子：此后任何 switchCollection 都走到真取消 seam。
registerContinuousCreationSwitchHandler(reinitializeForCollectionSwitch);

//   注册 disable 的真取消 seam——关闭开关必须 abort 在途传输并清
// prepared/调度锁，而不是只改 store status（否则 prepared 残留会被迟到轨道结束取出）。
registerContinuousCreationCancelHandler(cancelPendingNextWork);

/**
 * 在调度窗内请求生成下一作品（lookahead=1）。
 * @param input.epoch 调用方捕获的 epoch（stale 直接放弃）。
 * @param input.nowPlaying 当前 track 是否正在播放。
 * @param input.remainingTrackMs 当前 track 剩余毫秒。
 * @returns 是否接受并完成调度。
 */
export async function scheduleNextWork(input: {
  epoch: number;
  nowPlaying: boolean;
  remainingTrackMs: number;
}): Promise<boolean> {
  const store = useContinuousCreationStore.getState();
  if (!store.canSchedule({ nowPlaying: input.nowPlaying, epoch: input.epoch })) {
    return false;
  }
  if (!isWithinScheduleWindow(input.remainingTrackMs, store.windowMs)) {
    return false;
  }
  if (prepared !== null || scheduling) {
    return false;
  }
  if (!store.schedule()) {
    return false;
  }
  const epoch = store.epoch;
  const token = runToken;
  scheduling = true;
  const startedAt = Date.now();
  try {
    const result = await generateNextWork(CONTINUOUS_CREATION_PROMPT);
    // 三重守卫：编排代次未变 + store epoch 未变 + 仍持有 next job 槽位。
    // 任一失配（关闭开关 / 预算耗尽 / 登出 / 新建创作 / 切换集合）结果一律丢弃。
    const current = useContinuousCreationStore.getState();
    if (token !== runToken || current.isStale(epoch) || !current.hasNextJob()) {
      return false;
    }
    prepared = {
      epoch,
      work: {
        audioUrl: result.audioUrl,
        segment: result.content,
        messageId: result.messageId,
      },
    };
    useContinuousCreationStore.getState().audioReady(Date.now() - startedAt);
    return true;
  } catch (error) {
    const current = useContinuousCreationStore.getState();
    if (token === runToken && !current.isStale(epoch) && current.hasNextJob()) {
      current.generationFailed(
        error instanceof Error ? error.message : '连续创作生成下一作品失败',
      );
    }
    return false;
  } finally {
    // 只有仍持有本代次锁时才释放；旧 finally 绝不释放新生成的锁。
    if (token === runToken) {
      scheduling = false;
    }
  }
}

/**
 * 由当前 transport 状态发起一次调度（finite 会话尾段/整轨结束的真实调用入口）。
 * @returns 是否接受并完成调度。
 */
export async function scheduleContinuousNextWork(): Promise<boolean> {
  const playback = usePlaybackStore.getState();
  const { currentTime, duration } = playback;
  const remainingTrackMs = duration > 0 ? Math.max(0, (duration - currentTime) * 1000) : 0;
  return scheduleNextWork({
    epoch: useContinuousCreationStore.getState().epoch,
    nowPlaying: playback.isPlaying,
    remainingTrackMs,
  });
}

/**
 * 当前 track 结束后消费已就绪的下一作品（exactly-once）。
 * @param epoch 调用方捕获的 epoch（stale 一律丢弃，不复活）。
 * @returns 可播放的下一作品；无/过期返回 null。
 */
export function consumePreparedNextWork(epoch: number): PreparedNextWork | null {
  if (prepared === null) {
    return null;
  }
  if (prepared.epoch !== epoch || useContinuousCreationStore.getState().isStale(prepared.epoch)) {
    prepared = null;
    return null;
  }
  const work = prepared.work;
  prepared = null;
  useContinuousCreationStore.getState().nextConsumed();
  return work;
}

/**
 * 上报 audio 实际推进/停顿（预算唯一扣减入口）。
 * @param active 当前是否在推进音频。
 */
export function reportContinuousAudioActive(active: boolean): void {
  const now = Date.now();
  if (!active) {
    lastActiveAt = null;
    return;
  }
  const store = useContinuousCreationStore.getState();
  // 关闭/预算耗尽后到达的迟到 active 采样不得重新开账。
  if (store.status === 'disabled' || store.status === 'ended_budget') {
    lastActiveAt = null;
    return;
  }
  if (lastActiveAt !== null) {
    store.audioActiveTick(now - lastActiveAt);
    if (useContinuousCreationStore.getState().status === 'ended_budget') {
      // 预算耗尽：真取消在途 next job（abort + 清运行时），再停声。
      cancelPendingNextWork();
      void import('./playbackSessionFlow')
        .then((flow) => flow.stopPlayback())
        .catch(() => undefined);
      return;
    }
  }
  lastActiveAt = now;
}

/** 当前 track 结束时的编排决策：有 ready next → 消费；否则进入 waiting_next。 */
export function handleTrackEnded(epoch: number): PreparedNextWork | null {
  const store = useContinuousCreationStore.getState();
  if (store.isStale(epoch)) {
    return null;
  }
  //   终态锁死——disabled / ended_budget 后，迟到的轨道结束
  // 不得取出旧 next，也不得把终态复活成 waiting_next / enabled_idle。
  if (isTerminalStatus(store.status)) {
    return null;
  }
  const work = consumePreparedNextWork(epoch);
  if (work) {
    store.trackEnded(true);
    return work;
  }
  store.trackEnded(false);
  return null;
}

/**
 * 用户主动输入抢占：丢弃在途/就绪的下一作品、abort 在途预载并递增 epoch，使旧回调失效。
 *
 * 由创作页 UI 提交/重试路径调用；连续创作自身的生成不走此路径，避免自我抢占。
 * @returns 是否发生了抢占（有在途/就绪任务）。
 */
export function preemptContinuousCreationForUserInput(): boolean {
  const store = useContinuousCreationStore.getState();
  if (store.hasNextJob() || hasPreparedNextWork()) {
    cancelPendingNextWork();
    store.advanceEpoch();
    return true;
  }
  return false;
}
