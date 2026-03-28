import { create, type StateCreator, type StoreApi } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import { getSafeLocalStorage, isBrowserEnvironment } from '@/utils/storage';

/**
 * 历史记录条目结构，记录提示词使用信息。
 */
export interface HistoryRecord {
  prompt: string;
  lastUsed: string;
  useCount: number;
}

/**
 * 排序模式，支持按频率或最近时间排序。
 */
export type SortMode = 'frequency' | 'recent';

/**
 * 历史记录 store 的基础状态。
 */
type PromptHistoryBaseState = {
  recordsMap: Record<string, HistoryRecord>;
  sortMode: SortMode;
  initialized: boolean;
};

/**
 * 历史记录 store 的操作集合。
 */
type PromptHistoryActions = {
  hydrate: () => Promise<void>;
  addOrUpdate: (prompt: string) => void;
  remove: (prompt: string) => void;
  setSortMode: (mode: SortMode) => void;
};

/**
 * 历史记录 store 的完整状态与动作集合。
 */
export type PromptHistoryStore = PromptHistoryBaseState & PromptHistoryActions;

/**
 * 历史记录持久化键名。
 */
const PROMPT_HISTORY_STORAGE_KEY = 'prompt-history-store';
/**
 * 历史记录有效期（毫秒）。
 */
const THIRTY_DAYS_IN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 归一化提示词，便于去重。
 */
const normalizePrompt = (prompt: string) => prompt.trim();

/**
 * 清理过期或非法的历史记录，返回更新后的映射。
 * @param recordsMap 当前历史记录映射
 * @returns 包含新映射与是否发生变化的对象
 */
const pruneRecords = (
  recordsMap: Record<string, HistoryRecord>
): { map: Record<string, HistoryRecord>; dirty: boolean } => {
  const threshold = Date.now() - THIRTY_DAYS_IN_MS;
  const next: Record<string, HistoryRecord> = {};
  let dirty = false;

  Object.values(recordsMap).forEach((record) => {
    const normalizedPrompt = normalizePrompt(record.prompt);
    const lastUsedTime = new Date(record.lastUsed).getTime();
    const isValidDate = !Number.isNaN(lastUsedTime);
    const isWithinRange = isValidDate && lastUsedTime >= threshold;

    if (isWithinRange) {
      next[normalizedPrompt] = {
        prompt: normalizedPrompt,
        lastUsed: record.lastUsed,
        useCount: record.useCount,
      };

      if (normalizedPrompt !== record.prompt) {
        dirty = true;
      }
    } else {
      dirty = true;
    }
  });

  return {
    map: next,
    dirty,
  };
};

/**
 * persist 中间件附加的 API 类型。
 */
type PersistApi = StoreApi<PromptHistoryStore> & {
  persist: {
    rehydrate: () => Promise<void> | void;
    hasHydrated: () => boolean;
  };
};

/**
 * 历史记录 store 构建函数，负责持久化与增删改逻辑。
 */
const promptHistoryStoreCreator: StateCreator<PromptHistoryStore> = (set, get, api) => {
  const persistApi = api as PersistApi;

  return {
    recordsMap: {},
    sortMode: 'frequency',
    initialized: false,
    hydrate: async () => {
      if (get().initialized) {
        return;
      }

      if (!isBrowserEnvironment()) {
        set({ initialized: true });
        return;
      }

      if (!persistApi.persist.hasHydrated()) {
        await Promise.resolve(persistApi.persist.rehydrate());
      }

      set((state) => {
        const { map, dirty } = pruneRecords(state.recordsMap);
        if (dirty) {
          return {
            recordsMap: map,
            initialized: true,
          };
        }
        return {
          initialized: true,
        };
      });
    },
    addOrUpdate: (rawPrompt) => {
      const prompt = normalizePrompt(rawPrompt);
      if (!prompt) {
        return;
      }

      if (!get().initialized) {
        // 先触发 hydrate，待完成后再执行写入，避免 hydrate 覆盖本次更新
        void get().hydrate().then(() => get().addOrUpdate(rawPrompt));
        return;
      }

      const now = new Date().toISOString();

      set((state) => {
        const nextMap = { ...state.recordsMap };
        const existing = nextMap[prompt];
        nextMap[prompt] = existing
          ? {
              prompt,
              lastUsed: now,
              useCount: existing.useCount + 1,
            }
          : {
              prompt,
              lastUsed: now,
              useCount: 1,
            };

        const { map: prunedMap } = pruneRecords(nextMap);

        return {
          recordsMap: prunedMap,
          initialized: true,
        };
      });
    },
    remove: (rawPrompt) => {
      const prompt = normalizePrompt(rawPrompt);
      if (!prompt) {
        return;
      }

      if (!get().initialized) {
        void get().hydrate();
      }

      set((state) => {
        if (!state.recordsMap[prompt]) {
          return {};
        }

        const nextMap = { ...state.recordsMap };
        delete nextMap[prompt];

        const { map: prunedMap } = pruneRecords(nextMap);

        return {
          recordsMap: prunedMap,
          initialized: true,
        };
      });
    },
    setSortMode: (mode) => {
      if (get().sortMode === mode) {
        return;
      }
      set({
        sortMode: mode,
      });
    },
  };
};

const persistedPromptHistoryStore = persist(promptHistoryStoreCreator, {
  name: PROMPT_HISTORY_STORAGE_KEY,
  version: 1,
  storage: createJSONStorage(getSafeLocalStorage),
  partialize: (state) => ({
    recordsMap: state.recordsMap,
    sortMode: state.sortMode,
  }),
  skipHydration: true,
});

/**
 * 历史记录 store Hook，支持增删查提示词。
 */
export const usePromptHistoryStore = create<PromptHistoryStore>()(
  devtools(persistedPromptHistoryStore, { name: 'prompt-history-store' })
);

/**
 * 按使用频率排序历史记录，频率相同则按最近时间排序。
 */
const sortByFrequency = (records: HistoryRecord[]) =>
  [...records].sort((a, b) => {
    if (b.useCount === a.useCount) {
      return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
    }
    return b.useCount - a.useCount;
  });

/**
 * 按最近使用时间排序历史记录。
 */
const sortByRecent = (records: HistoryRecord[]) =>
  [...records].sort(
    (a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime()
  );

/**
 * 根据排序模式返回排序后的历史记录列表。
 * @param records 历史记录数组
 * @param mode 排序模式
 * @returns 排序后的数组
 */
export const sortHistoryRecords = (records: HistoryRecord[], mode: SortMode) =>
  mode === 'frequency' ? sortByFrequency(records) : sortByRecent(records);

/**
 * 选择排序模式的 selector。
 */
export const selectSortMode = (state: PromptHistoryStore) => state.sortMode;
/**
 * 选择初始化标记的 selector。
 */
export const selectIsInitialized = (state: PromptHistoryStore) => state.initialized;
