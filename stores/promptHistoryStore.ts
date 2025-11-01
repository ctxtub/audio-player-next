import { create, type StateCreator, type StoreApi } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import { getSafeLocalStorage, isBrowserEnvironment } from '@/utils/storage';

export interface HistoryRecord {
  prompt: string;
  lastUsed: string;
  useCount: number;
}

export type SortMode = 'frequency' | 'recent';

type PromptHistoryBaseState = {
  recordsMap: Record<string, HistoryRecord>;
  sortMode: SortMode;
  initialized: boolean;
};

type PromptHistoryActions = {
  hydrate: () => Promise<void>;
  addOrUpdate: (prompt: string) => void;
  remove: (prompt: string) => void;
  setSortMode: (mode: SortMode) => void;
};

export type PromptHistoryStore = PromptHistoryBaseState & PromptHistoryActions;

const PROMPT_HISTORY_STORAGE_KEY = 'prompt-history-store';
const THIRTY_DAYS_IN_MS = 30 * 24 * 60 * 60 * 1000;

const normalizePrompt = (prompt: string) => prompt.trim();

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

type PersistApi = StoreApi<PromptHistoryStore> & {
  persist: {
    rehydrate: () => Promise<void> | void;
    hasHydrated: () => boolean;
  };
};

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
        void get().hydrate();
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

export const usePromptHistoryStore = create<PromptHistoryStore>()(
  devtools(persistedPromptHistoryStore, { name: 'prompt-history-store' })
);

const sortByFrequency = (records: HistoryRecord[]) =>
  [...records].sort((a, b) => {
    if (b.useCount === a.useCount) {
      return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
    }
    return b.useCount - a.useCount;
  });

const sortByRecent = (records: HistoryRecord[]) =>
  [...records].sort(
    (a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime()
  );

export const sortHistoryRecords = (records: HistoryRecord[], mode: SortMode) =>
  mode === 'frequency' ? sortByFrequency(records) : sortByRecent(records);

export const selectSortMode = (state: PromptHistoryStore) => state.sortMode;
export const selectIsInitialized = (state: PromptHistoryStore) => state.initialized;
