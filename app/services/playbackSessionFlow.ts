/**
 * M5-10 PlaybackSessionFlow（spec §27，M5 收官运行时编排唯一入口）。
 *
 * Audio 事件 → 播放决策的唯一编排层：
 * beginPlayback / resumePlayback / playParagraph / handleNearEnd /
 * handleEnded / pause / restart / promoteDraftToWork / stop。
 *
 * AudioControllerHost 只报告 audio events（unlock/play/pause/resume/seek/
 * rate/timeupdate/ended 的 transport ownership 仍在 Host），本 flow 决定
 * segment / continuation / checkpoint。Host 不再直接 import ChatStore /
 * PreloadStore / PlaybackProgressStore / storyFlow 领域逻辑（§26.1）。
 *
 * Continuation 统一（§28）：本文件是续写判定的唯一位置，
 * `continuationMode === 'extendable'` 才允许 AI continuation，
 * 否则播完现有 paragraphs → ended。旧 isOneShot / sourceId guard /
 * currentMessageId guard 组合已退役，本文件一律不读取它们。
 *
 * Stale async TTS 保护（§50）：synth/fetchAudio 返回在
 * stores/playbackSessionStore 以 originatingSessionId 校验后才 play()，
 * 失配直接 revoke blob / discard；legacy 合成路径见 storyFlow 同名守卫。
 *
 * storyFlow.ts 回到故事生成流程兼容层；其中播放 session / preload / ended
 * 逻辑已迁出，此处为过渡期唯一兼容 fallback：无 session 的 legacy 音频
 *（未经理 Session SSOT 的旧 oneShot 链）仍委托 storyFlow 处理，M9 删除。
 * extendable 会话尾段是唯一允许回退 legacy AI 续写链的例外（§28）。
 */

import { usePlaybackStore, clampSegmentSeekTarget } from '@/stores/playbackStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import type { PlaybackSourceRef } from '@/lib/playback/source';
import type { SessionContinuationMode } from '@/stores/playbackSessionStore';
import type { SleepTimerMode } from '@/lib/playback/sleepTimer';

/** 可播放段落（legacy fallback 透传形态，与 storyFlow.PlayableSegment 同形）。 */
export type SessionPlayableSegment = {
  audioUrl: string;
  segment: string;
  messageId?: string;
};

/** 开始播放（新会话 / 切换 source / restart 统一经 Session API）。 */
export async function beginPlayback(params: {
  source: PlaybackSourceRef;
  mode: 'resume' | 'restart';
  speed?: number;
  draftSnapshot?: { title: string; contentHash: string; totalParagraphs: number; voiceId: string };
}): Promise<void> {
  await usePlaybackSessionStore.getState().beginPlayback(params);
}

/** 恢复已水合的断点（§25.5 Ready → 合成当前 paragraph → play）。 */
export async function resumePlayback(): Promise<void> {
  await usePlaybackSessionStore.getState().resumeRehydratedPlayback();
}

/** 播放指定段落（带 session guard，TTS 晚到丢弃见 store）。 */
export async function playParagraph(
  paragraphIndex: number,
  options?: { explicit?: boolean },
): Promise<void> {
  await usePlaybackSessionStore.getState().playParagraph(paragraphIndex, options);
}

/**
 * Continuation 统一判定（§28 纯判定，不触 store/网络）：
 * 仅 `extendable` 允许触发 AI continuation，其余一律播完现有段落 → ended。
 * @param mode 当前会话续写模式
 * @returns 是否允许 AI 续写
 */
export function shouldAllowAiContinuation(mode: SessionContinuationMode): boolean {
  return mode === 'extendable';
}

/**
 * 物理停重入 guard：AudioControllerHost.pause 会经 pauseViaSessionFlow 回调本函数，
 * 置位期间跳过二次物理停，避免互调死循环（幂等 1 次物理停 + 幂等逻辑停）。
 */
let physicalPauseReentry = false;

/** 显式暂停（transport 逻辑停 + 音频物理停 + checkpoint debounce）。 */
export function pausePlayback(): void {
  try {
    usePlaybackStore.getState().pause();
  } catch {
    // transport 暂停失败不阻断 session 侧 checkpoint。
  }
  try {
    usePlaybackSessionStore.getState().handleExplicitPause();
  } catch {
    // ignore
  }
  if (!physicalPauseReentry) {
    physicalPauseReentry = true;
    try {
      // 声画一致：显式暂停必须停住物理播放（否则 paused=false 的 audio 会继续播到段尾、
      // 触发 ended → 段落推进）；无 controller 时 no-op（幂等）。
      usePlaybackStore.getState().audioController?.pause();
    } finally {
      physicalPauseReentry = false;
    }
  }
}

/** 从头重播（§30 restart 语义由 server + store 持有）。 */
export async function restartPlayback(): Promise<void> {
  await usePlaybackSessionStore.getState().restart();
}

/**
 * M7-02 P3A 当前 Segment seek（spec §17/§17.1/§17.3 additive，无新 SSOT）。
 * 只动 Transport 段内 currentTime（经 AudioControllerHost 唯一 audio owner），
 * 不改变 Session sessionId/source/paragraph identity，不落 checkpoint。
 * 全 clamp + duration=0/unknown fail-safe（no-op 返回 false）。
 * @param targetSeconds 目标秒数
 * @returns 是否实际发起 seek
 */
export function seekCurrentSegment(targetSeconds: number): boolean {
  const transport = usePlaybackStore.getState();
  const clamped = clampSegmentSeekTarget(targetSeconds, transport.duration);
  if (clamped === null) {
    return false;
  }
  transport.seekAudio(clamped);
  return true;
}

/**
 * M7-02 P3A 相对 seek（keyboard ±5s，spec §17.2）。
 * currentTime + delta 后走同一 clamp/fail-safe；不改变 Session identity。
 * @param deltaSeconds 相对秒数（+5/-5）
 * @returns 是否实际发起 seek
 */
export function seekRelative(deltaSeconds: number): boolean {
  if (typeof deltaSeconds !== 'number' || !Number.isFinite(deltaSeconds)) {
    return false;
  }
  const transport = usePlaybackStore.getState();
  return seekCurrentSegment(transport.currentTime + deltaSeconds);
}

/**
 * M7-02 P3A 当前 Session 倍速（spec §20/§20.1 additive，无新 SSOT）。
 * Session.speed + Transport.playbackRate + Anchor 持久化三同步；
 * 不写回 UserConfig 默认 speed；不触发新 TTS（只调 <audio>.playbackRate）。
 * @param rate 目标倍速（旧七档之一；越界/非法直接 no-op）
 */
export async function setPlaybackRate(rate: number): Promise<void> {
  await usePlaybackSessionStore.getState().setSpeed(rate);
}

/**
 * M7-03 P3C 当前 Session Sleep Timer 设置（spec §24 additive，无新 SSOT）。
 * 只改当前 Session Timer（经 playback.setSleepTimer 独立持久化），不自动改
 * Settings 默认（§31.1）；stale（Session 已切换）返回 false（§24.1）。
 * UI 只经此入口，不得直接操作 <audio> / Session 字段（评审约束 10）。
 * @param mode 三态（story_end 仅 Work；Draft 由 Session 侧拒绝返回 false）
 * @param minutes mode==minutes 时必填（10–120）
 * @returns 是否设置成功（stale/非法返回 false）
 */
export async function setSleepTimer(mode: SleepTimerMode, minutes?: number): Promise<boolean> {
  return usePlaybackSessionStore.getState().setSleepTimer(mode, minutes);
}

/**
 * M7-03 Sleep Timer 到期承接（spec §26）。
 * Transport 到期已 pause audio + 归一 off/null；此处承接 Session paused +
 * checkpoint 持久化 + Toast。Session 保留 paused，之后 Play 正常继续。
 */
export async function handleSleepTimerExpired(): Promise<void> {
  await usePlaybackSessionStore.getState().handleSleepTimerExpired();
}

/**
 * M7-03 到期回调注册（AudioControllerHost 挂载时调用，卸载时传 null 解除）。
 * Transport 到期（非 minutes 不触发）经此回调进入 Flow 编排，
 * Transport 本身不 import Session（防循环依赖）。
 */
export function registerSleepTimerExpiryHandler(): void {
  try {
    usePlaybackStore.getState().registerSleepTimerExpiryHandler(() => {
      void handleSleepTimerExpired();
    });
  } catch {
    // 注册失败不阻断 Host 挂载（到期仅缺 Toast/checkpoint，audio 照停）。
  }
}

/** Draft→Work 提升（§24，sessionId 不变，hash 不一致 reset 0）。 */
export async function promoteDraftToWork(workId: number): Promise<void> {
  await usePlaybackSessionStore.getState().promoteDraftToWork(workId);
}

/** 停止（本地停驻，不清 server Anchor；显式清理请用 clear）。 */
export function stopPlayback(): void {
  usePlaybackSessionStore.getState().stop();
}

/**
 * §27 规范名别名（与 spec 动词一致；pausePlayback / restartPlayback /
 * stopPlayback 保留供 Host 等既有调用方，M9 再收敛命名）。
 * M7-02 增补 restartCurrentSession（spec §47/M7 对 M5 additive contract 命名统一，
 * 同一 restart 实现，不新增重复状态）。
 */
export { pausePlayback as pause, restartPlayback as restart, stopPlayback as stop };
export { restartPlayback as restartCurrentSession };

/** 播放器开始播放时更新 transport 倒计时。 */
export function reportPlaybackStart(): void {
  usePlaybackStore.getState().start();
}

/** 播放器暂停时同步 transport。 */
export function reportPlaybackPause(): void {
  usePlaybackStore.getState().pause();
}

/**
 * M7-03 fixup（复审 Blocking 1 / §25.1）：Host 上报音频“实际推进”运行时信号
 * （playing → true；waiting / stalled / pause / ended → false）。
 * 仅用于 sleep timer countdown 门使 buffering 不计入“再听 N 分钟”，不改变 Session 语义状态。
 */
export function reportAudioActive(active: boolean): void {
  usePlaybackStore.getState().reportAudioActive(active);
}

/** 播放进度推进（供 timeupdate/loadedmetadata 复用）。 */
export function reportProgress(payload: { currentTime: number; duration: number }): void {
  usePlaybackStore.getState().updateProgress(payload);
}

/**
 * near-end 预载决策（§27/§28）：
 * - 有 session source：finite 一律仅段落级推进，绝不走聊天续写（§28 唯一门）；
 *   仅 extendable 允许回退 legacy AI 续写链（过渡期，M9 删除）；
 * - 无 session（legacy 音频）：委托 storyFlow.handleNearEnd 兼容（M9 删除）。
 */
export async function handleNearEnd(): Promise<void> {
  const session = usePlaybackSessionStore.getState();
  // §28 唯一门：有 session 且 finite → 播完现有 paragraphs，严禁 AI 续写，直接返回。
  if (
    session.source &&
    session.totalParagraphs > 0 &&
    !shouldAllowAiContinuation(session.continuationMode)
  ) {
    return;
  }
  // 到达此处仅两种情形：无 session 的 legacy 音频，或 extendable 会话尾段
  //（唯一允许 AI continuation 的例外）；二者皆走 legacy 聊天续写链（M9 删除）。
  const { handleNearEnd: legacyNearEnd } = await import('@/app/services/storyFlow');
  await legacyNearEnd();
}

/**
 * timeupdate 上报 + 自适应 near-end 调度（Host 唯一调用点）。
 * @returns void（预载失败仅日志，不抛错中断播放）
 */
export function reportTimeUpdate(payload: {
  currentTime: number;
  duration: number;
  hasTriggeredPreload: { current: boolean };
}): void {
  reportProgress({ currentTime: payload.currentTime, duration: payload.duration });
  const { currentTime, duration } = payload;
  if (!(duration > 0)) return;
  const remaining = duration - currentTime;
  const adaptiveThreshold = Math.min(10, Math.max(5, duration * 0.25));
  if (remaining > adaptiveThreshold) return;
  if (payload.hasTriggeredPreload.current) return;
  if (!usePlaybackStore.getState().isPlaying) return;

  const session = usePlaybackSessionStore.getState();
  if (session.source && session.totalParagraphs > 1 && session.nextParagraphIndex + 1 < session.totalParagraphs) {
    // 非尾段：段落级预载（lookahead=1，续写模式无关——预载已定段落不是 AI 续写）。
    payload.hasTriggeredPreload.current = true;
    void session.prefetchNextParagraph(session.nextParagraphIndex + 1).catch((error) => {
      console.error('段落预加载失败:', error);
    });
    return;
  }
  if (session.source && session.totalParagraphs > 0) {
    // 有 session 的尾段/单段：§28 唯一门——finite 严禁聊天续写，直接返回；
    // 仅 extendable 允许回退 legacy AI 续写链。
    if (!shouldAllowAiContinuation(session.continuationMode)) {
      return;
    }
  }
  // 无 session legacy，或 extendable 会话尾段：走旧 near-end
  //（legacy 内部自带 budget/Preload 锁；session 归属由其首部守卫复核）。
  payload.hasTriggeredPreload.current = true;
  handleNearEnd().catch((error) => {
    console.error('预加载下一段音频失败:', error);
  });
}

/**
 * ended 决策（§27/§28）：
 * - 有 session source：非尾段一律走段落推进；尾段 finite 直接收尾
 *  （播完现有 paragraphs → ended，严禁聊天续写），仅 extendable 尾段允许
 *   先试 legacy AI 续写链，取不到新段才收尾；
 * - 无 session（legacy 音频）：委托 storyFlow.handleSegmentEnded 兼容，返回可播段则由调用方播放。
 * @param play 播放函数（Host 传入的 transport play，用于 legacy fallback 段播放）
 * @returns continued=true 表示已自动推进下一段（调用方直接返回）
 */
export async function handleEnded(play: (audioUrl: string, messageId?: string) => Promise<void>): Promise<boolean> {
  const session = usePlaybackSessionStore.getState();
  if (session.source && session.totalParagraphs > 0) {
    const atTail = session.nextParagraphIndex + 1 >= session.totalParagraphs;
    // §28 唯一门：非尾段，或尾段 finite → 会话段落机收尾，不碰 AI 续写。
    if (!atTail || !shouldAllowAiContinuation(session.continuationMode)) {
      const continued = await session.handleParagraphEnded();
      return continued;
    }
    // extendable 尾段（唯一例外）：先试 legacy AI 续写链，取不到才收尾。
    const { handleSegmentEnded } = await import('@/app/services/storyFlow');
    const nextSegment: SessionPlayableSegment | null = await handleSegmentEnded();
    if (!nextSegment) {
      const continued = await session.handleParagraphEnded();
      return continued;
    }
    await play(nextSegment.audioUrl, nextSegment.messageId);
    return true;
  }
  const { handleSegmentEnded } = await import('@/app/services/storyFlow');
  const nextSegment: SessionPlayableSegment | null = await handleSegmentEnded();
  if (!nextSegment) return false;
  await play(nextSegment.audioUrl, nextSegment.messageId);
  return true;
}
