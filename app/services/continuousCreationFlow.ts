/**
 * M9-C1 T2：连续创作编排服务。
 *
 * 取代旧 `stores/preloadStore` + `AUTO_CONTINUE_PROMPT` 续写链：
 * - 调度门：enabled、预算有效、当前 track 正在播放、epoch 匹配、无 next job、进入调度窗；
 * - 严格 work lookahead=1：同一时刻至多一个在途/就绪的 next work；
 * - 生成经正式 `beginChatStream`（origin='preload' 隔离续写气泡，不写 History）；
 * - 所有异步回写携带 epoch，`isStale` 为真一律 no-op；
 * - 预算只在 audio 实际推进时递减，耗尽立即停声。
 *
 * 契约：tech-design §5；docs/e2e/10-会话与作品集连续创作/05..08。
 */

import { useContinuousCreationStore } from '@/stores/continuousCreationStore';
import { isWithinScheduleWindow } from '@/lib/continuous-creation/stateMachine';

import { beginChatStream } from './chatFlow';

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

/** 下一作品生成器签名。 */
type ContinuousCreationGenerator = (
  prompt: string,
) => Promise<{ messageId: string; audioUrl: string; content: string }>;

/** 默认生成器：经正式聊天流（origin='preload' 隔离气泡，不写 History）。 */
const defaultGenerator: ContinuousCreationGenerator = (prompt) =>
  beginChatStream(prompt, { origin: 'preload' });

/** 当前生成器（测试可注入）。 */
let generateNextWork: ContinuousCreationGenerator = defaultGenerator;

/**
 * 测试专用：注入/还原下一作品生成器（避免 L2 触网）。
 * @param generator 注入的生成器；传 null 还原默认。
 */
export function __setContinuousCreationGeneratorForTests(
  generator: ContinuousCreationGenerator | null,
): void {
  generateNextWork = generator ?? defaultGenerator;
}

/** 当前是否有已就绪的下一作品。 */
export function hasPreparedNextWork(): boolean {
  return prepared !== null;
}

/** 清空编排运行时（新建创作/切换集合/登出）。 */
export function resetContinuousCreationRuntime(): void {
  prepared = null;
  scheduling = false;
  lastActiveAt = null;
}

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
  scheduling = true;
  const startedAt = Date.now();
  try {
    const result = await generateNextWork(CONTINUOUS_CREATION_PROMPT);
    if (useContinuousCreationStore.getState().isStale(epoch)) {
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
    if (!useContinuousCreationStore.getState().isStale(epoch)) {
      useContinuousCreationStore
        .getState()
        .generationFailed(error instanceof Error ? error.message : '连续创作生成下一作品失败');
    }
    return false;
  } finally {
    scheduling = false;
  }
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
  if (lastActiveAt !== null) {
    useContinuousCreationStore.getState().audioActiveTick(now - lastActiveAt);
    if (useContinuousCreationStore.getState().status === 'ended_budget') {
      lastActiveAt = null;
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
  const work = consumePreparedNextWork(epoch);
  if (work) {
    store.trackEnded(true);
    return work;
  }
  store.trackEnded(false);
  return null;
}

/**
 * 用户主动输入抢占：丢弃在途/就绪的下一作品并递增 epoch，使旧回调失效。
 *
 * 由创作页 UI 提交路径调用；连续创作自身的生成不走此路径，避免自我抢占。
 */
export function preemptContinuousCreationForUserInput(): void {
  const store = useContinuousCreationStore.getState();
  if (store.hasNextJob() || hasPreparedNextWork()) {
    resetContinuousCreationRuntime();
    store.advanceEpoch();
  }
}
