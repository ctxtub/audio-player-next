/**
 * M5-09 PlaybackSessionFlow（spec §27）。
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
 * storyFlow.ts 回到故事生成流程；其中播放 session / preload / ended 逻辑
 * 已逐步迁出，此处为过渡期唯一兼容 fallback：无 session 的 legacy 音频
 *（未经理 Session SSOT 的旧 oneShot 链）仍委托 storyFlow 处理，M9 删除。
 */

import { usePlaybackStore } from '@/stores/playbackStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import type { PlaybackSourceRef } from '@/lib/playback/source';

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

/** 显式暂停（transport + checkpoint debounce）。 */
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
}

/** 从头重播（§30 restart 语义由 server + store 持有）。 */
export async function restartPlayback(): Promise<void> {
  await usePlaybackSessionStore.getState().restart();
}

/** Draft→Work 提升（§24，sessionId 不变，hash 不一致 reset 0）。 */
export async function promoteDraftToWork(workId: number): Promise<void> {
  await usePlaybackSessionStore.getState().promoteDraftToWork(workId);
}

/** 停止（本地停驻，不清 server Anchor；显式清理请用 clear）。 */
export function stopPlayback(): void {
  usePlaybackSessionStore.getState().stop();
}

/** 播放器开始播放时更新 transport 倒计时。 */
export function reportPlaybackStart(): void {
  usePlaybackStore.getState().start();
}

/** 播放器暂停时同步 transport。 */
export function reportPlaybackPause(): void {
  usePlaybackStore.getState().pause();
}

/** 播放进度推进（供 timeupdate/loadedmetadata 复用）。 */
export function reportProgress(payload: { currentTime: number; duration: number }): void {
  usePlaybackStore.getState().updateProgress(payload);
}

/**
 * near-end 预载决策（§27）：
 * - 有 session source：段落级预载（lookahead=1，finite 绝不走聊天续写）；
 * - 无 session（legacy 音频）：委托 storyFlow.handleNearEnd 兼容（M9 删除）。
 */
export async function handleNearEnd(): Promise<void> {
  const session = usePlaybackSessionStore.getState();
  if (session.source && session.totalParagraphs > 0) {
    // finite 会话：仅段落预载；最终段前不触发任何 AI 续写。
    return;
  }
  // Transitional fallback：无 session 的 legacy 音频仍走旧聊天续写链。
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
    payload.hasTriggeredPreload.current = true;
    void session.prefetchNextParagraph(session.nextParagraphIndex + 1).catch((error) => {
      console.error('段落预加载失败:', error);
    });
    return;
  }
  if (session.source && session.totalParagraphs > 0) {
    // 有 session 但无需段落预载（单段/末段/finite）：严禁聊天续写，直接返回。
    return;
  }
  // 无 session legacy：走旧 near-end（内部自带 isOneShot/budget/Preload 锁）。
  payload.hasTriggeredPreload.current = true;
  handleNearEnd().catch((error) => {
    console.error('预加载下一段音频失败:', error);
  });
}

/**
 * ended 决策（§27）：
 * - 有 session source：统一走段落收尾（最终段 completeSession 后即止，严禁聊天续写）；
 * - 无 session（legacy 音频）：委托 storyFlow.handleSegmentEnded 兼容，返回可播段则由调用方播放。
 * @param play 播放函数（Host 传入的 transport play，用于 legacy fallback 段播放）
 * @returns continued=true 表示已自动推进下一段（调用方直接返回）
 */
export async function handleEnded(play: (audioUrl: string, messageId?: string) => Promise<void>): Promise<boolean> {
  const session = usePlaybackSessionStore.getState();
  if (session.source && session.totalParagraphs > 0) {
    const continued = await session.handleParagraphEnded();
    return continued;
  }
  const { handleSegmentEnded } = await import('@/app/services/storyFlow');
  const nextSegment: SessionPlayableSegment | null = await handleSegmentEnded();
  if (!nextSegment) return false;
  await play(nextSegment.audioUrl, nextSegment.messageId);
  return true;
}
