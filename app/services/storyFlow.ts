import { useConfigStore } from '@/stores/configStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePreloadStore } from '@/stores/preloadStore';
import { useChatStore } from '@/stores/chatStore';
import { useGenerationStore } from '@/stores/generationStore';
import type { GenerationRecord } from '@/stores/generationHistoryStore';
import { fetchAudio } from '@/lib/client/ttsGenerate';

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
 * 启动故事播放会话：停止当前播放、重置状态并开始播放指定的故事音频。
 * @param messageId 故事对应的消息 ID
 * @param audioUrl 音频地址
 * @param options.oneShot 一次性播放（历史回放）：播完即止，不触发预加载续写
 */
export const startStoryPlayback = async (
  messageId: string,
  audioUrl: string,
  options?: { oneShot?: boolean },
): Promise<void> => {
  const playbackStore = usePlaybackStore.getState();
  const preloadStore = usePreloadStore.getState();
  const apiConfig = useConfigStore.getState().apiConfig;

  // 停止当前正在播放的音频（如有）
  playbackStore.pauseAudioPlayback();

  // 重置状态
  preloadStore.reset();
  clearPreloadRetryTimer();
  playbackStore.reset();

  // 启动播放器会话
  playbackStore.markSessionStart(messageId, apiConfig.playDuration, options);

  // 3. 自动开始播放生成的音频
  await playbackStore.playAudio(audioUrl, messageId);
};

/**
 * 合成给定正文并一次性播放：播完即止（oneShot 防续写），不清空聊天会话。
 * 由于音频为临时 blob URL 无法持久化，历史/恢复回放均依赖正文重新走 TTS 合成。
 * @param storyText 故事正文。
 * @param voiceId 音色。
 * @param messageId 播放会话标识。
 */
const synthesizeAndPlayOnce = async (
  storyText: string,
  voiceId: string,
  messageId: string,
): Promise<void> => {
  // 清理可能残留的生成阶段，避免恢复态故事卡片误显示生成动效
  useGenerationStore.getState().reset();
  const { speed } = useConfigStore.getState().apiConfig;
  const audioUrl = await fetchAudio(storyText, voiceId, speed);
  await startStoryPlayback(messageId, audioUrl, { oneShot: true });
};

/**
 * 回放一条历史生成（生成历史弹窗）。
 * @param record 生成历史记录。
 */
export const replayGeneration = async (record: GenerationRecord): Promise<void> => {
  const { voiceId } = useConfigStore.getState().apiConfig;
  await synthesizeAndPlayOnce(record.storyText, record.voiceId || voiceId, `replay-${record.id}`);
};

/**
 * 回放给定故事正文（恢复态故事卡片的"播放故事"）。
 * @param storyText 故事正文。
 */
export const playStoryText = async (storyText: string): Promise<void> => {
  const { voiceId } = useConfigStore.getState().apiConfig;
  await synthesizeAndPlayOnce(storyText, voiceId, `replay-text-${Date.now()}`);
};

/**
 * 音频即将结束时触发预加载：若仍在有效播放时长内且未在加载，则请求下一段。
 */
export const handleNearEnd = async (): Promise<void> => {
  const playbackState = usePlaybackStore.getState();
  if (!playbackState.sessionId) {
    return;
  }

  // 一次性播放（历史回放）不预加载续写
  if (playbackState.isOneShot) {
    return;
  }

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
 * @returns 成功获取到的播放段落；若无需继续播放则返回 null
 */
export const handleSegmentEnded = async (): Promise<PlayableSegment | null> => {
  const playbackStore = usePlaybackStore.getState();
  const remainingMs = playbackStore.remainingMs ?? 0;

  // 一次性播放（历史回放）：播完即止，不续写下一段
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
 */
export const resetStoryFlow = () => {
  usePlaybackStore.getState().reset();
  usePreloadStore.getState().reset();
  useGenerationStore.getState().reset();
  useChatStore.getState().resetChat();
  clearPreloadRetryTimer();
};
