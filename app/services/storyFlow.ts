/**
 *：故事生成流程兼容层。
 *
 * 播放 session / preload / ended 编排已迁出至
 * `app/services/playbackSessionFlow.ts` + `stores/playbackSessionStore.ts`。
 * 旧 `stores/preloadStore` + `AUTO_CONTINUE_PROMPT` 续写链已在  删除，
 * near-end / ended 的下一作品编排改由 `app/services/continuousCreationFlow.ts`
 *（连续创作状态机：调度窗、lookahead=1、预算、epoch 守卫）承担。
 *
 *  收敛（§27/§28/§50）：
 * - continuation 唯一门在 PlaybackSessionFlow（continuationMode==='extendable'）；
 *   本文件首部的 session ownership 早退保证：只要 Session SSOT 持有 source 且
 *   finite，会话外的任何直接调用也不得触发 AI 续写。
 */
import { usePlaybackStore } from '@/stores/playbackStore';
import { useChatStore } from '@/stores/chatStore';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';
import { useContinuousCreationStore } from '@/stores/continuousCreationStore';

import {
  endContinuousCreationRun,
  handleTrackEnded,
  scheduleNextWork,
} from './continuousCreationFlow';

/**
 * 可播放段落对象，包含音频地址与文本内容，并标注来源（首段/预加载/即时生成）。
 */
type PlayableSegment = {
  audioUrl: string;
  segment: string;
  messageId?: string;
};

/**
 * Session ownership 早退（ §27/§28）：
 * Session SSOT 持有 source 且 finite 时，播放编排归 PlaybackSessionFlow 独占，
 * legacy 续写链不得以任何理由触发 AI continuation（也不得 reset 会话 transport）。
 * 仅无 session，或 extendable 尾段经 flow 显式委托，才允许继续 legacy 判定。
 * @returns true=调用方应直接返回（不得续写）
 */
const shouldYieldToPlaybackSession = (): boolean => {
  try {
    const session = usePlaybackSessionStore.getState();
    if (session.source && session.continuationMode !== 'extendable') {
      return true;
    }
  } catch {
    // session store 不可用时保持 legacy 行为（fail-open 仅限无 SSOT 角落）。
  }
  return false;
};

/** 当前 track 剩余毫秒（读 transport 进度；duration 未知时返回 0）。 */
const currentRemainingTrackMs = (): number => {
  const { currentTime, duration } = usePlaybackStore.getState();
  if (!(duration > 0)) {
    return 0;
  }
  return Math.max(0, (duration - currentTime) * 1000);
};

/**
 * 音频即将结束时触发连续创作调度：进入调度窗且状态机允许时请求下一作品。
 *
 * @deprecated：续写决策唯一门仍在 PlaybackSessionFlow（§28）；
 * 本函数仅为无 session legacy 音频的传输锁保留，首部 session ownership
 * 早退保证 finite 会话永不进入旧判定。
 */
export const handleNearEnd = async (): Promise<void> => {
  //  §27/§28：Session SSOT 持有 finite 会话时直接让路。
  if (shouldYieldToPlaybackSession()) {
    return;
  }
  const playbackState = usePlaybackStore.getState();
  if (!playbackState.sessionId) {
    return;
  }
  if (playbackState.isOneShot) {
    return;
  }
  if (playbackState.remainingMs !== null && playbackState.remainingMs <= 0) {
    return;
  }

  await scheduleNextWork({
    epoch: useContinuousCreationStore.getState().epoch,
    nowPlaying: playbackState.isPlaying,
    remainingTrackMs: currentRemainingTrackMs(),
  });
};

/**
 * 音频播放结束回调：优先消费连续创作已就绪的下一作品，否则按 legacy 段落推进。
 *
 * @deprecated：续写决策唯一门仍在 PlaybackSessionFlow（§28）。
 * 本函数仅为无 session legacy 音频的兼容实现；首部 session ownership 早退
 * 保证 finite 会话永不进入旧判定，且绝不 reset 会话 transport。
 * @returns 成功获取到的播放段落；若无需继续播放则返回 null
 */
export const handleSegmentEnded = async (): Promise<PlayableSegment | null> => {
  //  §27/§28：Session SSOT 持有 finite 会话时直接让路（bare null，不 reset）。
  if (shouldYieldToPlaybackSession()) {
    return null;
  }
  const playbackStore = usePlaybackStore.getState();
  const remainingMs = playbackStore.remainingMs ?? 0;

  if (playbackStore.isOneShot) {
    playbackStore.reset();
    endContinuousCreationRun();
    return null;
  }

  if (remainingMs <= 0) {
    playbackStore.reset();
    endContinuousCreationRun();
    return null;
  }

  // 优先从 ChatStore 获取下一段（支持手动切到旧段落后继续顺序播放）
  const currentMessageId = playbackStore.currentMessageId;
  if (currentMessageId) {
    const nextFromChat = useChatStore.getState().selectors.nextStorySegment(currentMessageId);
    if (nextFromChat) {
      usePlaybackStore.getState().advanceSegment();
      return {
        audioUrl: nextFromChat.audioUrl,
        segment: nextFromChat.storyText,
        messageId: nextFromChat.messageId,
      };
    }
  }

  // 连续创作：消费已就绪的下一作品（lookahead=1，exactly-once）。
  const nextWork = handleTrackEnded(useContinuousCreationStore.getState().epoch);
  if (!nextWork) {
    return null;
  }
  usePlaybackStore.getState().advanceSegment();
  return {
    audioUrl: nextWork.audioUrl,
    segment: nextWork.segment,
    messageId: nextWork.messageId,
  };
};

/**
 * 播放器开始播放时更新播放状态并启动倒计时。
 */
export const handlePlaybackStart = () => {
  usePlaybackStore.getState().start();
};

/**
 * 播放器暂停时同步状态，用于暂停倒计时与 UI。
 */
export const handlePlaybackPause = () => {
  usePlaybackStore.getState().pause();
};

/**
 * 播放进度推进时记录当前时间与总时长，供 UI 显示及其他逻辑使用。
 * @param payload.currentTime 当前播放位置（秒）
 * @param payload.duration 当前音频总时长（秒）
 */
export const updatePlaybackProgress = (payload: { currentTime: number; duration: number }) => {
  usePlaybackStore.getState().updateProgress(payload);
};

/**
 * 完整重置故事播放链路，清空播放与连续创作运行时。
 *
 *：「新建创作」的强重置入口是 `app/services/startNewCreation.ts`；
 * 本函数仅在旧调用点保留，负责停声 + 清运行时，不递增 epoch/不改预算快照。
 */
export const resetStoryFlow = () => {
  try {
    usePlaybackSessionStore.getState().stop();
  } catch {
    // session 不可用时仅清传输，不阻断重置链。
  }
  usePlaybackStore.getState().reset();
  useGenerationStore.getState().reset();
  useChatStore.getState().resetChat();
  endContinuousCreationRun();
};
