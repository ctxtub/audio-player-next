import { create, StateCreator, type StoreApi } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import { APIConfig } from '@/types/types';
import { CURRENT_CONFIG_VERSION, DEFAULT_API_CONFIG, isValidConfig } from '@/app/config/home';

type ConfigStoreBaseState = {
  apiConfig: APIConfig;
  isLoaded: boolean;
  loadError?: string;
};

type ConfigStoreActions = {
  hydrateFromStorage: () => Promise<void>;
  update: (partial: Partial<APIConfig>) => void;
  resetToDefault: () => void;
  isConfigValid: () => boolean;
  missingFields: () => string[];
  // TODO 此处需考虑跟播放器状态的分工划分
  applyUserPreferences: (preferences: Partial<APIConfig>) => void;
};

export type ConfigStore = ConfigStoreBaseState & ConfigStoreActions;

const CONFIG_STORAGE_KEY = 'config-store';

const fallbackStorage: Storage = {
  get length() {
    return 0;
  },
  clear() {
    return undefined;
  },
  getItem() {
    return null;
  },
  key() {
    return null;
  },
  removeItem() {
    return undefined;
  },
  setItem() {
    return undefined;
  },
};

const cloneDefaultConfig = (): APIConfig => ({
  ...DEFAULT_API_CONFIG,
  azureTtsConfig: { ...DEFAULT_API_CONFIG.azureTtsConfig },
  freeTtsConfig: { ...DEFAULT_API_CONFIG.freeTtsConfig },
});

const mergeConfig = (base: APIConfig, partial: Partial<APIConfig>): APIConfig => ({
  ...base,
  ...partial,
  azureTtsConfig: {
    ...base.azureTtsConfig,
    ...(partial.azureTtsConfig ?? {}),
  },
  freeTtsConfig: {
    ...base.freeTtsConfig,
    ...(partial.freeTtsConfig ?? {}),
  },
  version: CURRENT_CONFIG_VERSION,
});

const collectMissingFields = (config: APIConfig): string[] => {
  const missing: string[] = [];

  if (!config.apiBaseUrl?.trim()) {
    missing.push('apiBaseUrl');
  }

  if ((!config.apiKey || !config.apiKey.trim()) && config.voiceProvider !== 'free-tts') {
    missing.push('apiKey');
  }

  if (!config.playDuration || config.playDuration <= 0) {
    missing.push('playDuration');
  }

  if (config.voiceProvider === 'azure-tts') {
    if (!config.azureTtsConfig.speechKey?.trim()) {
      missing.push('azureTtsConfig.speechKey');
    }
    if (!config.azureTtsConfig.speechRegion?.trim()) {
      missing.push('azureTtsConfig.speechRegion');
    }
    if (!config.azureTtsConfig.voiceName?.trim()) {
      missing.push('azureTtsConfig.voiceName');
    }
  }

  if (config.voiceProvider === 'free-tts') {
    if (!config.freeTtsConfig.voiceName?.trim()) {
      missing.push('freeTtsConfig.voiceName');
    }
  }

  return missing;
};

type PersistApi = StoreApi<ConfigStore> & {
  persist: {
    rehydrate: () => Promise<void> | void;
    hasHydrated: () => boolean;
  };
};

const configStoreCreator: StateCreator<ConfigStore> = (set, get, api) => {
  const persistApi = api as PersistApi;

  return {
    apiConfig: cloneDefaultConfig(),
    isLoaded: false,
    loadError: undefined,
    hydrateFromStorage: async () => {
      if (typeof window === 'undefined') {
        set({ isLoaded: true });
        return;
      }

      if (persistApi.persist.hasHydrated()) {
        set({ isLoaded: true });
        return;
      }

      try {
        await persistApi.persist.rehydrate();
        const hydratedConfig = get().apiConfig;
        if (!isValidConfig(hydratedConfig)) {
          set({
            apiConfig: cloneDefaultConfig(),
            loadError: 'INVALID_CONFIG',
          });
        } else {
          set({ loadError: undefined });
        }
      } catch (error) {
        set({
          apiConfig: cloneDefaultConfig(),
          loadError: error instanceof Error ? error.message : 'FAILED_TO_HYDRATE',
        });
      } finally {
        set({ isLoaded: true });
      }
    },
    update: (partial) => {
      const current = get().apiConfig;
      const nextConfig = mergeConfig(current, partial);
      set({
        apiConfig: nextConfig,
        loadError: undefined,
      });
    },
    resetToDefault: () => {
      set({
        apiConfig: cloneDefaultConfig(),
        loadError: undefined,
      });
    },
    isConfigValid: () => isValidConfig(get().apiConfig),
    missingFields: () => collectMissingFields(get().apiConfig),
    applyUserPreferences: (preferences) => {
      const current = get().apiConfig;
      const nextConfig = mergeConfig(current, preferences);
      set({
        apiConfig: nextConfig,
        loadError: undefined,
      });
    },
  };
};

const persistedConfigStore = persist(configStoreCreator, {
  name: CONFIG_STORAGE_KEY,
  version: CURRENT_CONFIG_VERSION,
  storage: createJSONStorage(() =>
    typeof window === 'undefined' ? fallbackStorage : window.localStorage
  ),
  partialize: (state) => ({
    apiConfig: state.apiConfig,
  }),
  migrate: (persistedState: unknown) => {
    const config = (persistedState as Partial<ConfigStore> | undefined)?.apiConfig;
    if (!config) {
      return { apiConfig: cloneDefaultConfig() };
    }

    if (config.version !== CURRENT_CONFIG_VERSION || !isValidConfig(config)) {
      return { apiConfig: cloneDefaultConfig() };
    }

    return {
      apiConfig: mergeConfig(cloneDefaultConfig(), config),
    };
  },
  skipHydration: true,
});

export const useConfigStore = create<ConfigStore>()(devtools(persistedConfigStore));
