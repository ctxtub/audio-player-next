/**
 * 连续创作编排服务（第三段：正式下一作品闭环）。
 *
 * 取代旧 `{ audioUrl, segment, messageId }` 临时曲目链：
 * - 调度门：enabled、预算有效、当前 track 正在播放、epoch 匹配、无 next job、进入调度窗；
 * - 严格 work lookahead=1：同一时刻至多一个在途/就绪的正式 next work；
 * - 生成经正式 `beginChatStream`（origin='preload' 隔离续写气泡，不写 History）；
 * - 正文完成后经既有 Artifact 晋升入口（chatStore 自动编排）创建正式 Work，
 *   晋升成功后调用正式单轨音频 ensure；只有拿到 workId 且音频 ready 才进入 next_ready；
 * - 所有异步回写携带 epoch + 运行代次 + 会话/集合身份三元组，
 *   `isStale` / 代次失配 / 身份失配一律完全丢弃；
 * - 预算只在 audio 实际推进时递减，耗尽立即停声并作废在途 next job。
 *
 * 评审闭合（最严解读）：停止矩阵（关闭开关 / 预算耗尽 / 新建创作 /
 * 切换集合 / 登出 / 用户输入抢占）必须真正 abort 在途传输并清空编排运行时——
 * 旧结果绝不写回、等待中的结果不得复活自动续播、新会话可立即重新调度。
 * 代次/epoch 守卫只作第二道防线。
 *
 * 契约见连续创作技术方案的编排章节。
 */

import {
  useContinuousCreationStore,
  registerContinuousCreationSwitchHandler,
  registerContinuousCreationCancelHandler,
  type ContinuousNextWorkIdentity,
} from '@/stores/continuousCreationStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useChatStore } from '@/stores/chatStore';
import { isStoryArtifactPart } from '@/types/chat';
import { isTerminalStatus, isWithinScheduleWindow } from '@/lib/continuous-creation/stateMachine';
import { resolveContinuousCreationBudgetMinutes } from '@/lib/continuous-creation/budget';
import { createPlaybackSessionId } from '@/lib/playback/session';
import { ensureAsset } from '@/lib/client/storyAudio';

import { abortActiveChatStream, beginChatStream } from './chatFlow';

/** 连续创作续写指令（用户可见文案；预载 origin 隔离气泡）。 */
export const CONTINUOUS_CREATION_PROMPT = '请继续故事';

/**
 * 已准备就绪、等待当前 track 结束后自动续播的下一作品。
 *
 * 正式 Work 身份：一条 Work、一条连续音频时间轴，无临时 URL 曲目。
 */
export type PreparedNextWork = {
  epoch: number;
  conversationId: string | null;
  collectionId: string | null;
  workId: number;
  sourceMessageId: string;
  title: string;
  audioStatus: 'ready';
};

/** 单槽位（lookahead=1）暂存；身份三元组内嵌以便迟到丢弃。 */
let prepared: PreparedNextWork | null = null;
/** 是否已有生成在途（防并发重复调度）。 */
let scheduling = false;
/** 上次 audioActive 采样时间（null = 未在推进）。 */
let lastActiveAt: number | null = null;
/** 在途 pipeline 的中断器（晋升等待/ensure 轮询可 abort；取消时由运行时清理）。 */
let pipelineAbort: AbortController | null = null;
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

/**
 * 清空编排运行时（新建创作/切换集合/登出/真取消）。
 *
 * 真取消语义：同步 abort 在途 pipeline 等待（晋升轮询/ensure 睡眠），
 * 递增运行代次，清空 lookahead 暂存槽、调度锁与采样点。
 * 不改 store status/epoch（由调用方按各自语义处理）。
 */
export function resetContinuousCreationRuntime(): void {
  runToken += 1;
  prepared = null;
  scheduling = false;
  lastActiveAt = null;
  if (pipelineAbort) {
    try {
      pipelineAbort.abort();
    } catch {
      // 中断器已失效时忽略，不阻断运行时清理。
    }
    pipelineAbort = null;
  }
}

/**
 * 真正取消在途 next job：abort 传输 + 清编排运行时 + 清下一篇展示身份。
 *
 * 关闭开关 / 预算耗尽 / 切换会话集合 / 登出 / 新建创作 / 用户抢占
 * 六条入口全部经过本 seam（abort 与清空都在此处真实发生，
 * 代次/epoch 守卫只作第二道防线）。
 *
 * store 侧 status/epoch 由调用方按各自语义处理（disable 保持 disabled；
 * 预算耗尽保持 ended_budget；新建创作 advanceEpoch + resetForNewCreation）。
 * 任一情况在途任务恢复后都会因 runToken 失配、身份失配或 store 不再持有
 * next job 槽位而被丢弃。
 */
export function cancelPendingNextWork(): void {
  abortActiveChatStream();
  resetContinuousCreationRuntime();
  useContinuousCreationStore.getState().clearNextWork();
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
 * 会话/集合切换的真实取消 + 重新初始化。
 *
 * 停止矩阵要求「切换集合 → abort 且以新 collection identity 重新初始化」：
 * 1) 真 abort 在途生成传输与 ensure 等待，释放单槽 lookahead、清空 prepared 与采样点；
 * 2) 以新 collectionId 重新快照预算并递增 epoch——新会话可立即重新调度，
 *    旧会话迟到结果凭 runToken + epoch + 身份三重失配一律丢弃。
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

// 注册 disable 的真取消 seam——关闭开关必须 abort 在途传输并清
// prepared/调度锁，而不是只改 store status（否则 prepared 残留会被迟到轨道结束取出）。
registerContinuousCreationCancelHandler(cancelPendingNextWork);

/** 可中断睡眠（取消时立即退出等待，不吞中断）。 */
function sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 中断错误判定（chatFlow 同风格：真取消一律静默丢弃，不落 error）。 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * 在途身份新鲜度：编排代次未变 + store epoch 未变 + 仍持有 next job 槽位 +
 * 会话/集合身份未变。任一失配（关闭开关 / 预算耗尽 / 登出 / 新建创作 /
 * 切换集合 / 用户抢占）结果一律完全丢弃。
 */
function isFreshIdentity(
  token: number,
  epoch: number,
  conversationId: string | null,
  collectionId: string | null,
): boolean {
  if (token !== runToken) {
    return false;
  }
  const current = useContinuousCreationStore.getState();
  if (current.isStale(epoch) || !current.hasNextJob()) {
    return false;
  }
  if (useChatStore.getState().conversationId !== conversationId) {
    return false;
  }
  if (current.collectionId !== collectionId) {
    return false;
  }
  return true;
}

/** 晋升观测结果：ready 携带正式 Work 身份；失败抛错由调用方落 error。 */
type PromotionObservation = { workId: number; title: string } | null;

/**
 * 从 chatStore 读取指定消息的 Artifact 晋升状态（纯读，不触晋升编排）。
 * @returns ready 身份；promotion_failed/interrupted 记 'failed'；其余（在途）记 null。
 */
function readPromotionObservation(messageId: string): PromotionObservation | 'failed' {
  const message = useChatStore
    .getState()
    .messages.find((m) => m.id === messageId && m.role === 'assistant');
  const part = message?.parts?.find(isStoryArtifactPart);
  const artifact = part?.artifact;
  if (!artifact) {
    return null;
  }
  if (artifact.status === 'ready') {
    return { workId: artifact.storyWorkId, title: artifact.title ?? '' };
  }
  if (artifact.status === 'promotion_failed' || artifact.status === 'interrupted') {
    return 'failed';
  }
  return null;
}

/** 晋升等待上限（毫秒）：超过则按失败处理，可重试。 */
const PROMOTION_WAIT_TIMEOUT_MS = 120_000;
/** 晋升轮询间隔（毫秒）。 */
const PROMOTION_POLL_INTERVAL_MS = 250;

/**
 * 等待既有 Artifact 晋升入口产出正式 Work（chatStore 自动编排 promoting→ready）。
 * 正文生成完成后必须走此路径拿 workId，不伪造身份。
 * @throws 中断时抛 AbortError（调用方静默丢弃）；失败/超时抛 Error（调用方落 error）。
 */
async function waitForPromotionReady(
  messageId: string,
  signal: AbortSignal,
): Promise<{ workId: number; title: string }> {
  const deadline = Date.now() + PROMOTION_WAIT_TIMEOUT_MS;
  for (;;) {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const observed = readPromotionObservation(messageId);
    if (observed === 'failed') {
      throw new Error('下一篇保存失败');
    }
    if (observed) {
      return observed;
    }
    if (Date.now() >= deadline) {
      throw new Error('下一篇保存超时');
    }
    await sleepInterruptible(PROMOTION_POLL_INTERVAL_MS, signal);
  }
}

/** ensure 轮询上限（与正式起播路径同口径）。 */
const ENSURE_MAX_ATTEMPTS = 20;

/**
 * 正式单轨音频 ensure（含 preparing 轮询）。
 * 与正式起播共用同一服务端资产（按 Work 身份去重），预热后起播复用 ready 资产。
 * @throws 中断时抛 AbortError；超时/失败抛 Error。
 */
async function ensureNextWorkAudio(input: {
  workId: number;
  sessionId: string;
  signal: AbortSignal;
}): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    if (input.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const output = await ensureAsset({ workId: input.workId, sessionId: input.sessionId });
    if (output.status === 'ready') {
      return;
    }
    if (attempt >= ENSURE_MAX_ATTEMPTS) {
      throw new Error('下一篇语音准备超时');
    }
    const retryAfter =
      output.status === 'preparing' && typeof output.retryAfterMs === 'number'
        ? output.retryAfterMs
        : 500;
    await sleepInterruptible(Math.max(0, Math.min(retryAfter, 2000)), input.signal);
  }
}

/**
 * 在调度窗内请求生成下一作品（lookahead=1，正式 Work 管线）。
 *
 * 管线：正文生成 → saving_next_work（晋升等待）→ workSaved → preparing_audio
 * → 单轨 ensure → next_ready（仅 workId + 音频 ready）。任一步骤的迟到结果
 * （epoch/会话/集合失配或代次变化）一律完全丢弃。
 *
 * @param input.epoch 调用方捕获的 epoch（stale 直接放弃）。
 * @param input.nowPlaying 当前 track 是否正在播放。
 * @param input.remainingTrackMs 当前 track 剩余毫秒。
 * @returns 是否接受并完成调度。
 */
export async function scheduleNextWork(input: {
  epoch: number;
  nowPlaying: boolean;
  remainingTrackMs: number;
  playWhenReady?: boolean;
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
  const conversationId = useChatStore.getState().conversationId;
  const collectionId = useContinuousCreationStore.getState().collectionId;
  scheduling = true;
  const controller = new AbortController();
  pipelineAbort = controller;
  const signal = controller.signal;
  const startedAt = Date.now();
  // 管线生命周期内是否观察到 waiting_next：若当前音频先结束，
  // 准备完成后必须立即自动续播，不要求用户再点一次播放。
  let sawWaiting = input.playWhenReady === true;
  const noteWaiting = () => {
    if (useContinuousCreationStore.getState().status === 'waiting_next') {
      sawWaiting = true;
    }
  };
  try {
    // 1) 正文生成（正式聊天流；预载 origin 隔离气泡）。
    const result = await generateNextWork(CONTINUOUS_CREATION_PROMPT);
    noteWaiting();
    if (!isFreshIdentity(token, epoch, conversationId, collectionId)) {
      return false;
    }
    // 2) 正文完成 → 进入正式 Work 晋升阶段（晋升由 chatStore 既有编排完成）。
    useContinuousCreationStore.getState().generationComplete();
    const savingStartedAt = Date.now();
    // 3) 等待正式 Work 落地，拿到 workId（无 workId 绝不进入 next_ready）。
    const promoted = await waitForPromotionReady(result.messageId, signal);
    // 本地晋升可能在首轮查询前已经完成。保留一个可感知但很短的保存态窗口，
    // 避免 UI 从“正在创作”直接闪到“准备语音”；等待仍响应 abort，不拖住取消。
    await sleepInterruptible(Math.max(0, 400 - (Date.now() - savingStartedAt)), signal);
    noteWaiting();
    if (!isFreshIdentity(token, epoch, conversationId, collectionId)) {
      return false;
    }
    // 4) 晋升成功 → preparing；写入下一篇正式身份；实际派发 audioPreparing。
    const identity: ContinuousNextWorkIdentity = {
      workId: promoted.workId,
      sourceMessageId: result.messageId,
      title: promoted.title,
      audioStatus: 'preparing',
    };
    const live = useContinuousCreationStore.getState();
    live.workSaved();
    live.setNextWork(identity);
    live.audioPreparing();
    // 5) 正式单轨音频 ensure（lookahead 独立会话身份，不抢当前播放会话）。
    await ensureNextWorkAudio({
      workId: promoted.workId,
      sessionId: createPlaybackSessionId(),
      signal,
    });
    noteWaiting();
    if (!isFreshIdentity(token, epoch, conversationId, collectionId)) {
      return false;
    }
    // 6) 只有 workId + 音频 ready 才进入 next_ready。
    prepared = {
      epoch,
      conversationId,
      collectionId,
      workId: promoted.workId,
      sourceMessageId: result.messageId,
      title: promoted.title,
      audioStatus: 'ready',
    };
    const settled = useContinuousCreationStore.getState();
    settled.setNextWork({ ...identity, audioStatus: 'ready' });
    settled.audioReady(Date.now() - startedAt);
    // waiting 期间变 ready → 立即自动续播。
    if (sawWaiting || useContinuousCreationStore.getState().status === 'waiting_next') {
      await playReadyNextWork();
    }
    return true;
  } catch (error) {
    // 真取消（abort）一律静默丢弃，不落 error、不复活。
    if (isAbortError(error) || signal.aborted) {
      return false;
    }
    const current = useContinuousCreationStore.getState();
    if (
      token === runToken &&
      !current.isStale(epoch) &&
      current.hasNextJob() &&
      useChatStore.getState().conversationId === conversationId &&
      current.collectionId === collectionId
    ) {
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
    if (pipelineAbort === controller) {
      pipelineAbort = null;
    }
  }
}

/**
 * 由当前 transport 状态发起一次调度（finite 会话尾段/整轨结束的真实调用入口）。
 * @returns 是否接受并完成调度。
 */
export async function scheduleContinuousNextWork(options?: {
  allowAfterTrackEnded?: boolean;
}): Promise<boolean> {
  const playback = usePlaybackStore.getState();
  const { currentTime, duration } = playback;
  const allowAfterTrackEnded = options?.allowAfterTrackEnded === true;
  const playWhenReady = allowAfterTrackEnded && !playback.isPlaying;
  const remainingTrackMs =
    allowAfterTrackEnded || duration <= 0 ? 0 : Math.max(0, (duration - currentTime) * 1000);
  return scheduleNextWork({
    epoch: useContinuousCreationStore.getState().epoch,
    nowPlaying: playback.isPlaying || allowAfterTrackEnded,
    remainingTrackMs,
    playWhenReady,
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
  const work = prepared;
  prepared = null;
  useContinuousCreationStore.getState().nextConsumed();
  return work;
}

/**
 * 原子取出已就绪的下一篇并经正式播放入口续播。
 *
 * 续播沿用 `playbackSessionFlow.playStoryWork` 的串行临界区 + 请求代收口
 *（最后一次操作胜出，不并发创建多个服务端 begin 请求），本段不新建
 * store 状态去模拟并发控制。
 *
 * @returns 是否实际续播（无/过期返回 false）。
 */
export async function playReadyNextWork(): Promise<boolean> {
  const epoch = prepared?.epoch;
  if (epoch === undefined) {
    return false;
  }
  const work = consumePreparedNextWork(epoch);
  if (!work) {
    return false;
  }
  const { playStoryWork } = await import('./playbackSessionFlow');
  await playStoryWork(work.workId, { origin: 'autoplay' });
  return true;
}

/**
 * 上报 audio 实际推进/停顿（预算唯一扣减入口）。
 * 生成、保存、TTS、网络等待、缓冲和暂停均不经过此处，不扣预算。
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
      // 耗尽后不再生成或播放新作品：终态锁死后续调度与迟到续播。
      cancelPendingNextWork();
      void import('./playbackSessionFlow')
        .then((flow) => flow.stopPlayback())
        .catch(() => undefined);
      return;
    }
  }
  lastActiveAt = now;
}

/**
 * 当前 track 结束时的编排决策。
 *
 * - `next_ready`：原子取出并经正式播放入口续播；
 * - 其他在途状态：进入 `waiting_next`（不扣预算），准备完成后自动续播；
 * - `error`：保持当前页面（重试/关闭由下一篇卡片提供），不转移状态；
 * - 终态/过期：一律丢弃，不复活。
 *
 * @param epoch 调用方捕获的 epoch。
 * @returns 是否已自动续播。
 */
export async function handleTrackEnded(epoch: number): Promise<boolean> {
  const store = useContinuousCreationStore.getState();
  if (store.isStale(epoch)) {
    return false;
  }
  // 终态锁死——disabled / ended_budget 后，迟到的轨道结束
  // 不得取出旧 next，也不得把终态复活成 waiting_next / enabled_idle。
  if (isTerminalStatus(store.status)) {
    return false;
  }
  // error 保持当前页面：不消费、不转移，重试/关闭由卡片提供。
  if (store.status === 'error') {
    return false;
  }
  if (store.status === 'next_ready' && prepared !== null && prepared.epoch === epoch) {
    return playReadyNextWork();
  }
  store.trackEnded(false);
  return false;
}

/**
 * 用户主动输入抢占：丢弃在途/就绪的下一作品、abort 在途任务并递增 epoch，使旧回调失效。
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

/**
 * 下一篇失败后重试：回到空闲并按当前播放状态重新调度。
 * 仅 error 态可重试；调度仍受调度门（在播/进窗/预算）约束。
 */
export function retryContinuousCreation(): void {
  const store = useContinuousCreationStore.getState();
  if (store.status !== 'error') {
    return;
  }
  if (prepared !== null || scheduling) {
    return;
  }
  store.enable();
  // 当前作品可能已经结束；这是用户从错误卡片发起的显式恢复，允许在静音等待态
  // 重新启动生成，准备完成后仍按正式 Work 交接。
  void scheduleContinuousNextWork({ allowAfterTrackEnded: true });
}
