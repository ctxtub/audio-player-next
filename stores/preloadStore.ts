import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

import { beginChatStream } from '@/app/services/chatFlow';

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

    const taskToken = Symbol('active-preload');
    const preloadTask = (async () => {
      const { messageId: generatedId, audioUrl, content: generatedContent } = await beginChatStream('请继续故事');
      let nextSegment = generatedContent;

      const currentState = get();

      // 并发检查
      if (currentState._activePreloadTask?.token !== taskToken) {
        return {
          segment: nextSegment,
          audioUrl,
          messageId: generatedId,
        };
      }

      set({
        status: 'ready',
        retryCount: 0,
      });

      return {
        segment: nextSegment,
        audioUrl,
        messageId: generatedId,
      };
    })()
      .catch((error) => {
        const handledError = normalizeError(error);
        const currentState = get();

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
