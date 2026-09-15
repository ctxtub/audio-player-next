/**
 * M9-03：本文件为故事生成流程兼容层；播放 session / preload / ended
 * 编排已迁出至 app/services/playbackSessionFlow.ts + stores/playbackSessionStore.ts。
 * 旧 playbackProgressStore 第二 SSOT 已删除。
 *
 * M9-F01（Active Playback Session Visibility Closure）：全部用户故事播放入口
 * （StoryCard / Generation History / 生成完成后 autoplay）已迁移至
 * PlaybackSessionFlow（playStoryCard / playWorkFromHistory / autoplayDraftStory）；
 * 下列 dead 故事入口已删除：startStoryPlayback / synthesizeAndPlayOnce /
 * replayGeneration / playStoryText（删除后无产品调用方；TTS 合成只经 Session
 * playParagraph 发起，§50 stale 守卫由 Session/Flow 持有）。
 * handleNearEnd / handleSegmentEnded 仅为无 session legacy 音频的传输锁保留
 * （无 UI 可达：产品代码 playAudio 调用点 ⊆ PlaybackSessionStore，见 L1 锁定），
 * 首部 session ownership 早退保证 finite 会话永不进入旧判定。
 * 新播放代码禁止新增调用，一律走 PlaybackSessionFlow。
 *
 * M5-10 收敛（§27/§28/§50）：
 * - continuation 唯一门在 PlaybackSessionFlow（continuationMode==='extendable'）；
 *   本文件首部的 session ownership 早退保证：只要 Session SSOT 持有 source 且
 *   finite，会话外的任何直接调用也不得触发 AI 续写；
 * - 旧 isOneShot / sourceId / currentMessageId guard 组合已退役为 legacy
 *   无 session 角落的传输锁（@deprecated），不再是续写决策依据。
 */
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePreloadStore } from '@/stores/preloadStore';
import { useChatStore } from '@/stores/chatStore';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlaybackSessionStore } from '@/stores/playbackSessionStore';

/**
 * 可播放段落对象，包含音频地址与文本内容，并标注来源（首段/预加载/即时生成）。
 */
type PlayableSegment = {
  audioUrl: string;
  segment: string;
  messageId?: string;
};

/**
 * 预加载失败后的重试间隔（毫秒）。
 */
const PRELOAD_RETRY_DELAY = 5000;
/**
 * 预加载允许的最大重试次数。
 */
const PRELOAD_RETRY_LIMIT = 3;

/**
 * 预加载重试的挂起定时器实例。
 */
let preloadRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 清理预加载重试定时器，防止重复调度。
 */
const clearPreloadRetryTimer = () => {
  if (preloadRetryTimer) {
    clearTimeout(preloadRetryTimer);
    preloadRetryTimer = null;
  }
};

/**
 * 按固定间隔调度下一次预加载重试，超过上限后自动停止。
 */
const schedulePreloadRetry = () => {
  const { retryCount } = usePreloadStore.getState();
  if (retryCount >= PRELOAD_RETRY_LIMIT) {
    return;
  }
  if (preloadRetryTimer) {
    return;
  }

  preloadRetryTimer = setTimeout(async () => {
    preloadRetryTimer = null;
    try {
      await usePreloadStore.getState().requestPreload();
      clearPreloadRetryTimer();
    } catch {
      schedulePreloadRetry();
    }
  }, PRELOAD_RETRY_DELAY);
};

/**
 * Session ownership 早退（M5-10 §27/§28）：
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

/**
 * 音频即将结束时触发预加载：若仍在有效播放时长内且未在加载，则请求下一段。
 *
 * @deprecated M5-10：续写决策已收敛至 PlaybackSessionFlow（§28 唯一门
 * continuationMode==='extendable'）。本函数仅为无 session legacy 音频的
 * 传输锁保留；首部 session ownership 早退保证 finite 会话永不进入旧判定。
 */
export const handleNearEnd = async (): Promise<void> => {
  // M5-10 §27/§28：Session SSOT 持有 finite 会话时直接让路（不触任何旧 guard）。
  if (shouldYieldToPlaybackSession()) {
    return;
  }
  const playbackState = usePlaybackStore.getState();
  if (!playbackState.sessionId) {
    return;
  }

  // 一次性播放（历史回放）不预加载续写
  // @deprecated M5-10：legacy 无 session 角落的传输锁；续写决策以 flow 的
  // continuationMode 唯一门为准。
  if (playbackState.isOneShot) {
    return;
  }

  // M9-03：旧段落机（progressState sourceId/isOneShot）已删；段落级故事由
  // PlaybackSessionFlow 会话段落机推进，此处 legacy 音频无段落上下文，直接走传输锁判定。

  if (playbackState.remainingMs !== null && playbackState.remainingMs <= 0) {
    return;
  }

  const preloadState = usePreloadStore.getState();
  if (preloadState.status === 'loading' || preloadState.status === 'ready') {
    return;
  }

  try {
    await usePreloadStore.getState().requestPreload();
    clearPreloadRetryTimer();
  } catch (error) {
    if (error instanceof Error && error.message === 'PRELOAD_IN_PROGRESS') {
      return;
    }
    schedulePreloadRetry();
  }
};

/**
 * 音频播放结束回调：优先消费已缓存的预加载内容，否则即时生成下一段。
 *
 * @deprecated M5-10：续写决策已收敛至 PlaybackSessionFlow（§28 唯一门）。
 * 本函数仅为无 session legacy 音频的兼容实现；首部 session ownership 早退
 * 保证 finite 会话永不进入旧 isOneShot/sourceId/currentMessageId 判定，
 * 且绝不 reset 会话 transport（bare return null，不碰任何 store）。
 * @returns 成功获取到的播放段落；若无需继续播放则返回 null
 */
export const handleSegmentEnded = async (): Promise<PlayableSegment | null> => {
  // M5-10 §27/§28：Session SSOT 持有 finite 会话时直接让路（bare null，不 reset）。
  if (shouldYieldToPlaybackSession()) {
    return null;
  }
  const playbackStore = usePlaybackStore.getState();
  const remainingMs = playbackStore.remainingMs ?? 0;

  // 一次性播放（历史回放）：播完即止，不续写下一段
  // 中文注释：M9-03 旧进度侧一次性标记已删；仅以播放侧传输锁判定。
  // @deprecated M5-10：legacy 无 session 角落的传输锁；续写决策以 flow 的
  // continuationMode 唯一门为准。
  if (playbackStore.isOneShot) {
    playbackStore.reset();
    usePreloadStore.getState().reset();
    clearPreloadRetryTimer();
    return null;
  }

  if (remainingMs <= 0) {
    playbackStore.reset();
    usePreloadStore.getState().reset();
    clearPreloadRetryTimer();
    return null;
  }

  // 优先从 ChatStore 获取下一段（支持手动切到旧段落后继续顺序播放）
  const currentMessageId = playbackStore.currentMessageId;

  if (currentMessageId) {
    const nextFromChat = useChatStore.getState().selectors.nextStorySegment(currentMessageId);
    if (nextFromChat) {
      // 释放 PreloadStore 的锁，允许后续预加载。
      // 仅当下一段是最新生成的消息时才操作，避免回放旧内容干扰生成流程。
      if (useChatStore.getState().selectors.isLatestMessage(nextFromChat.messageId)) {
        usePreloadStore.getState().consume();
      }

      usePlaybackStore.getState().advanceSegment();
      clearPreloadRetryTimer();

      return {
        audioUrl: nextFromChat.audioUrl,
        segment: nextFromChat.storyText,
        messageId: nextFromChat.messageId,
      };
    }
  }

  // ChatStore 中无后续段落，尝试从预加载 Store 获取。
  // 场景：当前播放的是最后一段，或者预加载的内容尚未同步到 ChatStore。
  // 中文注释：段落级故事由 PlaybackSessionFlow 会话段落机推进；
  // 此处 legacy 音频无段落上下文，直接走预载传输锁，不再经旧段落机 early-return。
  let result: { segment: string; audioUrl: string; messageId?: string } | null = null;
  const preloadState = usePreloadStore.getState();

  try {
    // 强制触发消费预加载内容，即使状态已就绪。
    if (preloadState.status === 'ready') {
      usePreloadStore.getState().consume();
    }

    result = await usePreloadStore.getState().requestPreload();
  } catch (error) {
    if (error instanceof Error && error.message === 'PRELOAD_IN_PROGRESS') {
      return null;
    }
    return null;
  }

  if (!result) {
    return null;
  }

  // 消费本次生成产生的 ready 锁，避免阻塞下次预加载
  usePreloadStore.getState().consume();

  usePlaybackStore.getState().advanceSegment();
  clearPreloadRetryTimer();

  return {
    audioUrl: result.audioUrl,
    segment: result.segment,
    messageId: result.messageId,
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
 * 完整重置故事播放链路，清空播放、预加载与故事状态并取消定时器。
 * M9-03：旧断点 reset 已删；会话侧本地停驻（stop，不清 server Anchor，
 * 与旧语义对齐：仅清本地运行时），transport/preload/generation/chat 照旧。
 */
export const resetStoryFlow = () => {
  try {
    usePlaybackSessionStore.getState().stop();
  } catch {
    // session 不可用时仅清传输，不阻断重置链。
  }
  usePlaybackStore.getState().reset();
  usePreloadStore.getState().reset();
  useGenerationStore.getState().reset();
  useChatStore.getState().resetChat();
  clearPreloadRetryTimer();
};
