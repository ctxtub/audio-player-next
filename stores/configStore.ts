import { create, StateCreator, type StoreApi } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import type { APIConfig } from '@/types/appConfig';
import { getSafeLocalStorage, isBrowserEnvironment } from '@/utils/storage';
import type { VoiceOption } from '@/types/ttsGenerate';
import { fetchAppConfig, AppConfigClientError } from '@/lib/client/appConfig';

/**
 * 配置 store 的基础状态结构：记录当前配置、加载标记及可选语音列表。
 */
type ConfigStoreBaseState = {
  apiConfig: APIConfig;
  isLoaded: boolean;
  voiceOptions: VoiceOption[];
};

/**
 * 配置 store 提供的操作集合，负责初始化、校验与更新。
 */
type ConfigStoreActions = {
  /**
   * 初始化配置（本地 + 远端），确保仅执行一次。
   * @returns Promise<void>
   */
  initialize: () => Promise<void>;
  /**
   * 合并更新配置，并写入持久化层。
   * @param partial Partial<APIConfig> 待更新的字段片段
   * @returns void
   */
  update: (partial: Partial<APIConfig>) => void;
  /**
   * 判断当前配置是否满足业务要求。
   * @returns boolean true 表示配置合法
   */
  isConfigValid: () => boolean;
};

/**
 * 配置 store 的完整状态与动作集合。
 */
export type ConfigStore = ConfigStoreBaseState & ConfigStoreActions;

/**
 * 持久化存储键名。
 */
const CONFIG_STORAGE_KEY = 'config-store';

/**
 * 构造初始配置对象。
 * @returns 默认配置
 */
const createEmptyConfig = (): APIConfig => ({
  playDuration: 0,
  voiceId: '',
  floatingPlayerEnabled: true,
});

/**
 * 校验配置对象是否满足使用条件。
 * @param config 待校验的配置
 * @returns 是否有效
 */
const isValidConfig = (config: APIConfig | undefined): config is APIConfig => {
  if (!config) {
    return false;
  }

  if (typeof config.playDuration !== 'number' || config.playDuration <= 0) {
    return false;
  }

  if (typeof config.voiceId !== 'string' || !config.voiceId.trim()) {
    return false;
  }

  if (typeof config.floatingPlayerEnabled !== 'boolean') {
    return false;
  }

  return true;
};

/**
 * 合并新旧配置，确保字段合法。
 * @param base 当前配置。
 * @param partial 待合并的增量配置。
 */
const mergeConfig = (base: APIConfig, partial: Partial<APIConfig>): APIConfig => {
  const voiceId =
    typeof partial.voiceId === 'string' && partial.voiceId.trim()
      ? partial.voiceId.trim()
      : base.voiceId;

  const nextPlayDuration =
    typeof partial.playDuration === 'number' && partial.playDuration > 0
      ? partial.playDuration
      : base.playDuration;

  const floatingPlayerEnabled =
    typeof partial.floatingPlayerEnabled === 'boolean'
      ? partial.floatingPlayerEnabled
      : base.floatingPlayerEnabled;

  return {
    playDuration: nextPlayDuration,
    voiceId,
    floatingPlayerEnabled,
  };
};

/**
 * Zustand persist 中间件暴露的扩展 API。
 */
type PersistApi = StoreApi<ConfigStore> & {
  persist: {
    rehydrate: () => Promise<void> | void;
    hasHydrated: () => boolean;
  };
};

/**
 * 配置 store 的状态创建器，包含初始化与更新逻辑。
 */
const configStoreCreator: StateCreator<ConfigStore> = (set, get, api) => {
  const persistApi = api as PersistApi;
  let initializationPromise: Promise<void> | null = null;

  const hydrateLocalConfig = async (): Promise<APIConfig | undefined> => {
    if (!isBrowserEnvironment()) {
      return undefined;
    }

    if (persistApi.persist.hasHydrated()) {
      const stored = get().apiConfig;
      return isValidConfig(stored) ? stored : undefined;
    }

    try {
      await persistApi.persist.rehydrate();
      const stored = get().apiConfig;
      return isValidConfig(stored) ? stored : undefined;
    } catch (error) {
      console.warn('[configStore] hydrateLocalConfig failed', error);
      return undefined;
    }
  };

  const loadRemoteConfig = async (
    localConfig: APIConfig | undefined
  ): Promise<{ config: APIConfig; voiceOptions: VoiceOption[] }> => {
    try {
      const remote = await fetchAppConfig();
      const voiceOptions = Array.isArray(remote.voicesList) ? remote.voicesList : [];
      const hasVoice = (voice?: string) =>
        !!voice && voiceOptions.some(option => option.value === voice);

      const playDuration =
        localConfig && localConfig.playDuration > 0
          ? localConfig.playDuration
          : remote.playDuration;

      if (!playDuration || playDuration <= 0) {
        throw new Error('INVALID_PLAY_DURATION');
      }

      let resolvedVoice: string | undefined;

      if (localConfig && hasVoice(localConfig.voiceId)) {
        resolvedVoice = localConfig.voiceId;
      } else if (hasVoice(remote.voiceId)) {
        resolvedVoice = remote.voiceId;
      }

      if (!resolvedVoice) {
        throw new Error('INVALID_VOICE');
      }

      const floatingPlayerEnabled =
        typeof remote.floatingPlayerEnabled === 'boolean'
          ? remote.floatingPlayerEnabled
          : localConfig?.floatingPlayerEnabled ?? true;

      const mergedConfig: APIConfig = {
        playDuration,
        voiceId: resolvedVoice,
        floatingPlayerEnabled,
      };

      return { config: mergedConfig, voiceOptions };
    } catch (error) {
      if (error instanceof AppConfigClientError) {
        throw error;
      }
      throw new Error(
        error instanceof Error ? error.message : 'FAILED_TO_FETCH_REMOTE_CONFIG'
      );
    }
  };

  const runInitialization = async () => {
    const localConfig = await hydrateLocalConfig();
    const { config, voiceOptions } = await loadRemoteConfig(localConfig);
    set({
      apiConfig: config,
      voiceOptions,
      isLoaded: true,
    });
  };

  return {
    apiConfig: createEmptyConfig(),
    isLoaded: false,
    voiceOptions: [],
    initialize: () => {
      if (!initializationPromise) {
        initializationPromise = runInitialization().catch(error => {
          console.warn('[configStore] initialize failed', error);
          set({
            apiConfig: createEmptyConfig(),
            isLoaded: false,
            voiceOptions: [],
          });
          initializationPromise = null;
          throw error;
        });
      }
      return initializationPromise;
    },
    update: (partial) => {
      const current = get().apiConfig;
      const nextConfig = mergeConfig(current, partial);
      set({
        apiConfig: nextConfig,
      });
    },
    isConfigValid: () => isValidConfig(get().apiConfig),
  };
};

/**
 * 带持久化与版本迁移能力的配置 store。
 */
const persistedConfigStore = persist(configStoreCreator, {
  name: CONFIG_STORAGE_KEY,
  storage: createJSONStorage(getSafeLocalStorage),
  partialize: (state) => ({
    apiConfig: state.apiConfig,
  }),
  migrate: (persistedState: unknown) => {
    const config = (persistedState as Partial<ConfigStore> | undefined)?.apiConfig;
    if (isValidConfig(config)) {
      return { apiConfig: config };
    }

    return {
      apiConfig: createEmptyConfig(),
    };
  },
  skipHydration: true,
});

/**
 * 配置 store Hook，提供配置读取与操作能力。
 */
export const useConfigStore = create<ConfigStore>()(devtools(persistedConfigStore));
