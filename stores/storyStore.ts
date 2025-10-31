import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

import { generateStory, continueStory } from '@/app/api/chat';
import { useConfigStore } from './configStore';

/**
 * 故事 store 的基础状态，记录当前会话、文本段落及加载标记。
 */
type StoryStoreBaseState = {
  inputText: string;
  segments: string[];
  isFirstStoryLoading: boolean;
  isContinuing: boolean;
  lastError?: string;
  sessionId: string | null;
  _activeRequestId: string | null;
};

/**
 * 故事 store 对外暴露的动作。
 */
type StoryStoreActions = {
  startSession: (prompt: string) => Promise<string>;
  continueSession: () => Promise<string>;
  appendSegment: (segment: string) => void;
  setLoadingState: (
    flags: Partial<Pick<StoryStoreBaseState, 'isFirstStoryLoading' | 'isContinuing'>>
  ) => void;
  reset: () => void;
};

export type StoryStore = StoryStoreBaseState & StoryStoreActions;

const INITIAL_STATE: StoryStoreBaseState = {
  inputText: '',
  segments: [],
  isFirstStoryLoading: false,
  isContinuing: false,
  lastError: undefined,
  sessionId: null,
  _activeRequestId: null,
};

const createRequestId = (prefix: 'session' | 'continue'): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${randomPart}`;
};

const normalizeError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  return new Error('UNKNOWN_ERROR');
};

const storyStoreCreator: StateCreator<StoryStore> = (set, get) => ({
  ...INITIAL_STATE,
  /**
   * 开启新的故事会话：重置旧数据并请求首段故事文本。
   * @param prompt 用户输入的提示词
   * @returns Promise，resolve 为首段故事文本
   */
  startSession: async (prompt) => {
    const requestId = createRequestId('session');
    const configState = useConfigStore.getState();

    if (!configState.isConfigValid()) {
      const error = new Error('配置未就绪，无法生成故事');
      set({
        lastError: error.message,
        isFirstStoryLoading: false,
        _activeRequestId: null,
      });
      throw error;
    }

    set({
      inputText: prompt,
      segments: [],
      isFirstStoryLoading: true,
      isContinuing: false,
      lastError: undefined,
      sessionId: requestId,
      _activeRequestId: requestId,
    });

    try {
      const story = await generateStory(prompt, configState.apiConfig);

      if (get()._activeRequestId !== requestId) {
        return story;
      }

      set({
        isFirstStoryLoading: false,
        lastError: undefined,
        _activeRequestId: null,
      });

      return story;
    } catch (error) {
      const handledError = normalizeError(error);

      if (get()._activeRequestId === requestId) {
        set({
          lastError: handledError.message,
          isFirstStoryLoading: false,
          _activeRequestId: null,
        });
      }

      throw handledError;
    }
  },
  /**
   * 续写当前故事：在已有文本基础上请求下一段内容。
   * @returns Promise，resolve 为续写段落
   */
  continueSession: async () => {
    const { inputText, segments, sessionId } = get();

    if (!sessionId || !inputText) {
      const error = new Error('当前没有正在进行的故事会话');
      set({ lastError: error.message });
      throw error;
    }

    const requestId = createRequestId('continue');
    const configState = useConfigStore.getState();

    set({
      isContinuing: true,
      lastError: undefined,
      _activeRequestId: requestId,
    });

    try {
      const nextSegment = await continueStory(inputText, segments.join(''), configState.apiConfig);

      if (get()._activeRequestId !== requestId) {
        return nextSegment;
      }

      set({
        isContinuing: false,
        lastError: undefined,
        _activeRequestId: null,
      });

      return nextSegment;
    } catch (error) {
      const handledError = normalizeError(error);

      if (get()._activeRequestId === requestId) {
        set({
          lastError: handledError.message,
          isContinuing: false,
          _activeRequestId: null,
        });
      }

      throw handledError;
    }
  },
  /**
   * 将新段落加入故事列表，供 UI 展示或后续续写使用。
   */
  appendSegment: (segment) => {
    set((state) => ({
      segments: [...state.segments, segment],
    }));
  },
  /**
   * 外部可手动覆盖 loading 标记（例如 orchestrator 保证状态一致）。
   */
  setLoadingState: (flags) => {
    const updates: Partial<StoryStoreBaseState> = {};

    if (typeof flags.isFirstStoryLoading === 'boolean') {
      updates.isFirstStoryLoading = flags.isFirstStoryLoading;
    }

    if (typeof flags.isContinuing === 'boolean') {
      updates.isContinuing = flags.isContinuing;
    }

    if (Object.keys(updates).length > 0) {
      set(updates);
    }
  },
  /**
   * 重置故事状态，通常在结束播放或启动新会话时调用。
   */
  reset: () => {
    set({ ...INITIAL_STATE });
  },
});

export const useStoryStore = create<StoryStore>()(devtools(storyStoreCreator));
