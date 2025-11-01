import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

import { continueStory, generateStory } from '@/lib/client/storyGenerate';

/**
 * 故事 store 的基础状态，记录当前会话、文本段落及加载标记。
 */
type StoryStoreBaseState = {
  sessionId: string | null;
  inputText: string;
  segments: string[];
  isFirstStoryLoading: boolean;
  isContinuing: boolean;
  lastError?: string;
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
  sessionId: null,
  inputText: '',
  segments: [],
  isFirstStoryLoading: false,
  isContinuing: false,
  lastError: undefined,
};

/**
 * 将未知异常转换为 Error 实例，确保调用方处理一致。
 * @param error unknown 捕获到的异常
 * @returns Error 标准化后的错误对象
 */
const normalizeError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  return new Error('UNKNOWN_ERROR');
};

/**
 * 生成新的会话标识，优先使用浏览器原生方法，退化到时间戳随机串。
 */
const createSessionId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `story-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const storyStoreCreator: StateCreator<StoryStore> = (set, get) => ({
  ...INITIAL_STATE,
  /**
   * 开启新的故事会话：重置旧数据并请求首段故事文本。
   * @param prompt 用户输入的提示词
   * @returns Promise，resolve 为首段故事文本
   */
  startSession: async (prompt) => {
    const sessionId = createSessionId();
    set({
      sessionId,
      inputText: prompt,
      segments: [],
      isFirstStoryLoading: true,
      isContinuing: false,
      lastError: undefined,
    });

    try {
      const response = await generateStory(prompt);
      const story = response.story;

      if (get().inputText !== prompt) {
        return story;
      }

      set({
        isFirstStoryLoading: false,
        lastError: undefined,
      });

      return story;
    } catch (error) {
      const handledError = normalizeError(error);
      const currentState = get();

      if (currentState.inputText === prompt) {
        if (currentState.sessionId === sessionId) {
          set({
            sessionId: null,
            lastError: handledError.message,
            isFirstStoryLoading: false,
          });
        } else {
          set({
            lastError: handledError.message,
            isFirstStoryLoading: false,
          });
        }
      }

      throw handledError;
    }
  },
  /**
   * 续写当前故事：在已有文本基础上请求下一段内容。
   * @returns Promise，resolve 为续写段落
   */
  continueSession: async () => {
    const { inputText, segments } = get();

    if (!inputText || segments.length === 0) {
      const error = new Error('当前没有正在进行的故事会话');
      set({ lastError: error.message });
      throw error;
    }

    set({
      isContinuing: true,
      lastError: undefined,
    });

    try {
      const response = await continueStory(inputText, segments.join(''), {
        withSummary: true,
      });
      const nextSegment = response.story;

      if (get().inputText !== inputText) {
        return nextSegment;
      }

      set({
        isContinuing: false,
        lastError: undefined,
      });

      return nextSegment;
    } catch (error) {
      const handledError = normalizeError(error);

      if (get().inputText === inputText) {
        set({
          lastError: handledError.message,
          isContinuing: false,
        });
      }

      throw handledError;
    }
  },
  /**
   * 将新段落加入故事列表，供 UI 展示或后续续写使用。
   * @param segment string 新增的故事段落
   * @returns void
   */
  appendSegment: (segment) => {
    set((state) => ({
      segments: [...state.segments, segment],
    }));
  },
  /**
   * 外部可手动覆盖 loading 标记（例如 orchestrator 保证状态一致）。
   * @param flags Partial<{@link StoryStoreBaseState.isFirstStoryLoading} | {@link StoryStoreBaseState.isContinuing}>
   *              需要覆盖的 loading 字段
   * @returns void
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
   * @returns void
   */
  reset: () => {
    set({ ...INITIAL_STATE });
  },
});

export const useStoryStore = create<StoryStore>()(devtools(storyStoreCreator));
