import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

import { fetchAudio } from '@/lib/client/ttsGenerate';
import { continueStory } from '@/lib/client/storyGenerate';
import { useConfigStore } from './configStore';
import { useChatStore } from './chatStore';
import { useGenerationStore } from './generationStore';

/**
 * 预加载阶段的状态枚举：
 * - idle: 无任务
 * - loading: 正在请求故事或音频
 * - ready: 已有可用缓存
 * - error: 最近一次请求失败
 */
type PreloadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * 正在进行中的预加载任务，用于防止重复请求。
 */
type ActivePreloadTask = {
  token: symbol;
  promise: Promise<{ segment: string; audioUrl: string; messageId?: string }>;
};

/**
 * 预加载 store 的基础状态。
 */
type PreloadStoreBaseState = {
  status: PreloadStatus;
  error?: string;
  retryCount: number;
  /**
   * 保存当前在运行的预加载任务，用于去重和防止过期任务写回结果。
   */
  _activePreloadTask: ActivePreloadTask | null;
};

/**
 * 预加载 store 对外暴露的动作。
 */
type PreloadStoreActions = {
  requestPreload: () => Promise<{ segment: string; audioUrl: string; messageId?: string }>;
  consume: () => void;
  reset: () => void;
};

/**
 * 预加载 store 的完整状态与动作集合。
 */
export type PreloadStore = PreloadStoreBaseState & PreloadStoreActions;

/**
 * 预加载状态的初始值。
 */
const INITIAL_STATE: PreloadStoreBaseState = {
  status: 'idle',
  error: undefined,
  retryCount: 0,
  _activePreloadTask: null,
};

/**
 * 统一规范未知错误为 Error 实例，便于上层处理。
 * @param error unknown 捕获到的异常
 * @returns Error 归一化后的错误对象
 */
const normalizeError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  return new Error('UNKNOWN_PRELOAD_ERROR');
};

/**
 * 预加载 store 创建器，封装预加载流程与错误处理。
 */
const preloadStoreCreator: StateCreator<PreloadStore> = (set, get) => ({
  ...INITIAL_STATE,
  /**
   * 请求下一段故事与音频，带去重能力；若已有缓存则直接返回。
   * @returns Promise，resolve 为故事文本与音频地址
   */
  requestPreload: async () => {
    const state = get();
    if (state.status === 'loading' && state._activePreloadTask) {
      return state._activePreloadTask.promise;
    }

    // 如果处于 ready 状态，说明前一次预加载已完成但未被外部消费（consume）。
    // 此时继续请求虽然不符合常规流转，但为了保证 Promise 签名返回值，
    // 我们允许直接向下执行重新生成逻辑（调用者应在请求前自行判断或消费）。

    const configState = useConfigStore.getState();
    if (!configState.isConfigValid()) {
      const error = new Error('配置未就绪，无法预加载故事');
      set((prev) => ({
        status: 'error',
        error: error.message,
        retryCount: prev.retryCount + 1,
        _activePreloadTask: null,
      }));
      return Promise.reject(error);
    }

    const taskToken = Symbol('active-preload');
    const preloadTask = (async () => {
      // 切换为从 chatStore 获取上下文
      const { prompt, storyContent } = useChatStore.getState().getStoryContext();

      if (!prompt || !storyContent) {
        // 如果没有上下文，可能是会话还没开始，或者数据异常
        throw new Error('无法获取故事上下文，预加载跳过');
      }

      // 1. 在 ChatStore 中准备续写占位
      useChatStore.getState().prepareFollowUpStorySubmission();
      const generatedMessageId = useChatStore.getState().activeAssistantMessage?.id;

      // 1. 重置生成状态，准备展示动效
      useGenerationStore.getState().reset();
      useGenerationStore.getState().setPhase('generating_text');

      // 请求续写 (注意：若 continueStory 不支持流式，这里无法实现真正的逐字飞入，只能在完成后一次性展示)
      // 但为了配合 StoryCardPartRenderer，我们需要设置 streamingText
      const response = await continueStory(prompt, storyContent, { withSummary: true });
      const nextSegment = response.storyContent;

      // 模拟流式效果（如果 API 不支持）或者直接设置
      useGenerationStore.getState().appendText(nextSegment);

      // 进入音频生成阶段
      useGenerationStore.getState().setPhase('generating_audio');

      // 2. 将文本同步到 ChatStore
      useChatStore.getState().appendAssistantDelta(nextSegment);

      // 生成音频
      const audioUrl = await fetchAudio(nextSegment, configState.apiConfig.voiceId, configState.apiConfig.speed);

      const currentState = get();

      // 这里是生成过程内部的并发检查。
      // 如果 token 不匹配，说明任务被取消或覆盖，只需返回当前结果即可（虽然可能没人接收）。
      if (currentState._activePreloadTask?.token !== taskToken) {
        return {
          segment: nextSegment,
          audioUrl,
          messageId: generatedMessageId, // 即使被放弃，最好也返回正确结构
        };
      }

      // 生成完成
      useGenerationStore.getState().setPhase('ready');

      // 3. 标记 ChatStore 消息完成
      useChatStore.getState().finalizeStoryMessage({
        storyText: nextSegment,
        audioUrl,
      });

      set({
        status: 'ready',
        retryCount: 0,
      });

      return {
        segment: nextSegment,
        audioUrl,
        messageId: generatedMessageId,
      };
    })()
      .catch((error) => {
        const handledError = normalizeError(error);
        const currentState = get();

        // 失败时同步 ChatStore 状态
        useChatStore.getState().markFailure();

        if (currentState._activePreloadTask?.token === taskToken) {
          set((prev) => ({
            status: 'error',
            error: handledError.message,
            retryCount: prev.retryCount + 1,
            _activePreloadTask: null,
          }));
        }

        throw handledError;
      })
      .finally(() => {
        set((prev) => ({
          _activePreloadTask:
            prev._activePreloadTask?.token === taskToken ? null : prev._activePreloadTask,
        }));
      });

    set({
      status: 'loading',
      error: undefined,
      _activePreloadTask: {
        token: taskToken,
        promise: preloadTask,
      },
    });

    return preloadTask;
  },
  /**
   * 消费已缓存的预加载结果，并重置状态。
   * (不再返回数据，只负责重置状态锁)
   */
  consume: () => {
    const { status } = get();
    if (status !== 'ready') {
      return;
    }

    set({
      status: 'idle',
      retryCount: 0,
      error: undefined,
    });
  },
  /**
   * 重置预加载状态，通常在启动新会话或取消播放时调用。
   * @returns void
   */
  reset: () => {
    set({ ...INITIAL_STATE });
  },
});

/**
 * 预加载 store Hook，提供预加载状态与动作。
 */
export const usePreloadStore = create<PreloadStore>()(devtools(preloadStoreCreator));
