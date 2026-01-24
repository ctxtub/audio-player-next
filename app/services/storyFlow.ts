import { fetchAudio } from '@/lib/client/ttsGenerate';
import { useConfigStore } from '@/stores/configStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { usePreloadStore } from '@/stores/preloadStore';
import { useChatStore } from '@/stores/chatStore';
import { useGenerationStore } from '@/stores/generationStore';
import { generateStoryStream } from '@/lib/client/storyGenerateStream';

/**
 * 可播放段落对象，包含音频地址与文本内容，并标注来源（首段/预加载/即时生成）。
 */
type PlayableSegment = {
  audioUrl: string;
  segment: string;
  source: 'initial' | 'preloaded' | 'generated';
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
 * 确保配置已经加载并合法，否则抛出错误。
 * @returns 当前有效的配置对象
 */
const ensureConfigReady = () => {
  const configState = useConfigStore.getState();
  if (!configState.isConfigValid()) {
    throw new Error('请先完成配置，再开始生成故事');
  }
  return configState.apiConfig;
};

/**
 * 启动新的故事会话：清空旧状态、生成首段文本与音频，并初始化播放会话。
 * @param prompt 用户输入的故事提示词
 * @returns 包含首段故事文本、音频地址及来源标记的对象
 */
export const beginStorySession = async (prompt: string): Promise<PlayableSegment> => {
  const apiConfig = ensureConfigReady();
  const playbackStore = usePlaybackStore.getState();
  const preloadStore = usePreloadStore.getState();
  const chatStore = useChatStore.getState();
  const generationStore = useGenerationStore.getState();

  // 重置状态
  preloadStore.reset();
  clearPreloadRetryTimer();
  playbackStore.reset();
  generationStore.reset();
  // 注意：不再调用 storyStore.reset，也不重置 chatStore (保留聊天记录)
  // 如果需要清空之前的会话，可以在这里调用 chatStore.resetActiveSession() 
  // 但根据需求“映射到聊天”，理应保留。

  // 1. 设置生成中文本阶段
  generationStore.setPhase('generating_text');

  // 2. 准备故事会话：在 ChatStore 中创建 用户消息 + 助手占位
  const { assistantMessage } = chatStore.prepareStorySubmission(prompt);

  // 3. 流式请求故事文本
  const firstSegment = await new Promise<string>((resolve, reject) => {
    generateStoryStream(prompt, {
      onChunk: (chunk) => {
        // 同步更新 UI 状态与 Chat 消息
        useGenerationStore.getState().appendText(chunk);
        useChatStore.getState().appendAssistantDelta(chunk);
      },
      onComplete: (content) => {
        resolve(content);
      },
      onError: (error) => {
        // 失败时标记 chatStore
        useChatStore.getState().markFailure();
        reject(error);
      },
    });
  });

  // 4. 文本生成完成，进入音频生成阶段
  generationStore.setPhase('generating_audio');

  try {
    const audioUrl = await fetchAudio(firstSegment, apiConfig.voiceId);

    // 5. 更新 ChatStore，将 StoryCard 标记为完成（附带音频）
    useChatStore.getState().finalizeStoryMessage({
      storyText: firstSegment,
      audioUrl,
    });

    // 启动播放器会话
    // 使用助手消息 ID 作为会话标识，或者沿用之前的随机 ID 逻辑
    // 这里使用 assistantMessage.id 确保唯一性
    playbackStore.markSessionStart(assistantMessage.id, apiConfig.playDuration);

    // 6. 生成完成
    generationStore.setPhase('ready');

    return {
      audioUrl,
      segment: firstSegment,
      source: 'initial',
    };
  } catch (error) {
    generationStore.setError(error instanceof Error ? error.message : '音频生成失败');
    useChatStore.getState().markFailure();
    throw error;
  }
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
    // schedulePreloadRetry(); // 暂时屏蔽重试，避免复杂化 debugging
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

  let source: PlayableSegment['source'] = 'preloaded';
  let result = usePreloadStore.getState().consume();

  if (!result) {
    source = 'generated';
    try {
      // 如果没有缓存，尝试即时请求
      await usePreloadStore.getState().requestPreload();
      result = usePreloadStore.getState().consume();
    } catch (error) {
      if (error instanceof Error && error.message === 'PRELOAD_IN_PROGRESS') {
        return null;
      }
      return null;
    }
  }

  if (!result) {
    return null;
  }

  // 注意：不再需要在此处追加 ChatStore 消息，
  // 因为 preloadStore.requestPreload 已经在生成过程中完成了消息的创建与更新。
  // 我们只需要处理播放器的状态推进。

  usePlaybackStore.getState().advanceSegment();
  clearPreloadRetryTimer();

  return {
    ...result,
    source,
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
