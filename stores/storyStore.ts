import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

import { continueStory, generateStory } from '@/lib/client/storyGenerate';

/**
 * 故事 store 的基础状态，记录当前会话、文本段落及最近错误。
 */
type StoryStoreBaseState = {
  sessionId: string | null;
  inputText: string;
  segments: string[];
  lastError?: string;
};

/**
 * 故事 store 对外暴露的动作。
 */
type StoryStoreActions = {
  startSession: (prompt: string) => Promise<string>;
  continueSession: () => Promise<string>;
  appendSegment: (segment: string) => void;
  reset: () => void;
};

/**
 * 故事 store 的完整状态与动作集合。
 */
export type StoryStore = StoryStoreBaseState & StoryStoreActions;

/**
 * 故事状态的默认初始值。
 */
const INITIAL_STATE: StoryStoreBaseState = {
  sessionId: null,
  inputText: '',
  segments: [],
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
/**
 * 生成新的会话标识，优先使用浏览器原生方法，退化到时间戳随机串。
 */
const createSessionId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `story-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

/**
 * 故事 store 创建器，封装故事生成与状态管理逻辑。
 */
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
      lastError: undefined,
    });

    try {
      const response = await generateStory({ mode: 'generate', prompt });
      const story = response.storyContent;

      if (get().inputText !== prompt) {
        return story;
      }

      set({
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
          });
        } else {
          set({
            lastError: handledError.message,
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
      lastError: undefined,
    });

    try {
      const response = await continueStory(inputText, segments.join(''), {
        withSummary: true,
      });
      const nextSegment = response.storyContent;

      if (get().inputText !== inputText) {
        return nextSegment;
      }

      set({
        lastError: undefined,
      });

      return nextSegment;
    } catch (error) {
      const handledError = normalizeError(error);

      if (get().inputText === inputText) {
        set({
          lastError: handledError.message,
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
   * @returns void
   */
  reset: () => {
    set({ ...INITIAL_STATE });
  },
});

/**
 * 故事 store Hook，提供故事文本状态与操作。
 */
export const useStoryStore = create<StoryStore>()(devtools(storyStoreCreator));
