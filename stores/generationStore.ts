/**
 * 生成状态 Store
 *
 * 管理故事生成过程的阶段状态，供打字机效果组件消费。
 */

import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';

/**
 * 生成阶段枚举：
 * - idle: 空闲状态
 * - generating_text: 正在生成文本（流式）
 * - generating_audio: 正在生成音频
 * - ready: 生成完成，准备播放
 * - error: 生成出错
 */
export type GenerationPhase = 'idle' | 'generating_text' | 'generating_audio' | 'ready' | 'error';

/**
 * 生成状态 Store 的基础状态。
 */
type GenerationStoreBaseState = {
    phase: GenerationPhase;
    streamingText: string;
    errorMessage?: string;
};

/**
 * 生成状态 Store 的动作。
 */
type GenerationStoreActions = {
    setPhase: (phase: GenerationPhase) => void;
    appendText: (chunk: string) => void;
    setError: (message: string) => void;
    reset: () => void;
};

/**
 * 生成状态 Store 的完整类型。
 */
export type GenerationStore = GenerationStoreBaseState & GenerationStoreActions;

/**
 * 初始状态。
 */
const INITIAL_STATE: GenerationStoreBaseState = {
    phase: 'idle',
    streamingText: '',
    errorMessage: undefined,
};

/**
 * Store 创建器。
 */
const generationStoreCreator: StateCreator<GenerationStore> = (set) => ({
    ...INITIAL_STATE,

    /**
     * 设置当前生成阶段。
     */
    setPhase: (phase) => {
        set({ phase, errorMessage: undefined });
    },

    /**
     * 追加流式文本块。
     */
    appendText: (chunk) => {
        set((state) => ({
            streamingText: state.streamingText + chunk,
        }));
    },

    /**
     * 设置错误状态。
     */
    setError: (message) => {
        set({ phase: 'error', errorMessage: message });
    },

    /**
     * 重置到初始状态。
     */
    reset: () => {
        set({ ...INITIAL_STATE });
    },
});

/**
 * 生成状态 Store Hook。
 */
export const useGenerationStore = create<GenerationStore>()(devtools(generationStoreCreator));
