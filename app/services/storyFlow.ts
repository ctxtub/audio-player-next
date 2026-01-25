import { useConfigStore } from '@/stores/configStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePreloadStore } from '@/stores/preloadStore';
import { useChatStore } from '@/stores/chatStore';
import { useGenerationStore } from '@/stores/generationStore';
import { beginChatStream } from './chatFlow';

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
 */
export const startStoryPlayback = async (messageId: string, audioUrl: string): Promise<void> => {
  const playbackStore = usePlaybackStore.getState();
  const preloadStore = usePreloadStore.getState();
  const apiConfig = useConfigStore.getState().apiConfig;



  // 2. 停止当前正在播放的音频（如有）
  playbackStore.pauseAudioPlayback();

  // 重置状态
  preloadStore.reset();
  clearPreloadRetryTimer();
  playbackStore.reset();

  // 启动播放器会话
  playbackStore.markSessionStart(messageId, apiConfig.playDuration);

  // 3. 自动开始播放生成的音频
  await playbackStore.playAudio(audioUrl, messageId);
};

/**
 * 启动新的故事会话：清空旧状态、生成首段文本与音频，并初始化播放会话及启动播放。
 * @param prompt 用户输入的故事提示词
 */
export const beginStorySession = async (prompt: string) => {
  const { messageId, audioUrl } = await beginChatStream(prompt);
  await startStoryPlayback(messageId, audioUrl);
};

/**
 * 音频即将结束时触发预加载：若仍在有效播放时长内且未在加载，则请求下一段。
 */
export const handleNearEnd = async (): Promise<void> => {
  const playbackState = usePlaybackStore.getState();
  if (!playbackState.sessionId) {
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

  if (remainingMs <= 0) {
    playbackStore.reset();
    usePreloadStore.getState().reset();
    clearPreloadRetryTimer();
    return null;
  }

  // 优先从 ChatStore 获取下一段（支持手动切到旧段落后继续顺序播放）
  const currentMessageId = playbackStore.currentMessageId;

  if (currentMessageId) {
    const nextFromChat = useChatStore.getState().getNextStorySegmentByMessageId(currentMessageId);
    if (nextFromChat) {
      // 若聊天记录中存在下一段，且是“最新”的一段（即系统自动预加载生成的），
      // 则需释放 PreloadStore 的 ready 锁，允许后续继续触发新的预加载。
      if (useChatStore.getState().isLastMessageId(nextFromChat.messageId)) {
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

  // 走到这里说明 ChatStore 里没有下一段了（当前是最后一段，或者没找到）。
  // 这时必须使用 PreloadStore 来生成/获取下一段。

  let result: { segment: string; audioUrl: string; messageId?: string } | null = null;
  const preloadState = usePreloadStore.getState();

  try {
    // 即便状态为 ready，也强制请求以确保获取数据或触发必要操作。
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
  // ChatStore 不重置，保留历史
  clearPreloadRetryTimer();
};
