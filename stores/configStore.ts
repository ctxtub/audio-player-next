import { create, StateCreator, type StoreApi } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import { APIConfig } from '@/types/types';
import { CURRENT_CONFIG_VERSION, DEFAULT_API_CONFIG, isValidConfig } from '@/app/config/home';

/**
 * 配置 store 的基础状态结构：记录当前配置、加载标记及错误信息。
 */
type ConfigStoreBaseState = {
  apiConfig: APIConfig;
  isLoaded: boolean;
  loadError?: string;
};

/**
 * 配置 store 提供的操作集合，负责初始化、校验与更新。
 */
type ConfigStoreActions = {
  /**
   * 从持久化介质恢复配置数据。
   * @returns Promise<void> 恢复流程结束时 resolve，便于外部等待
   */
  hydrateFromStorage: () => Promise<void>;
  /**
   * 合并更新配置，并写入持久化层。
   * @param partial Partial<APIConfig> 待更新的字段片段
   * @returns void
   */
  update: (partial: Partial<APIConfig>) => void;
  /**
   * 恢复为默认配置，常用于用户手动重置。
   * @returns void
   */
  resetToDefault: () => void;
  /**
   * 判断当前配置是否满足业务要求。
   * @returns boolean true 表示配置合法
   */
  isConfigValid: () => boolean;
  /**
   * 返回缺失的关键配置项，用于 UI 提示。
   * @returns string[] 缺失字段名称数组
   */
  missingFields: () => string[];
};

export type ConfigStore = ConfigStoreBaseState & ConfigStoreActions;

const CONFIG_STORAGE_KEY = 'config-store';

/**
 * 服务端或隐私模式下 localStorage 不可用时的兜底实现。
 */
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

/**
 * 克隆默认配置，保证引用安全。
 * @returns APIConfig 默认配置的深拷贝
 */
const cloneDefaultConfig = (): APIConfig => ({
  ...DEFAULT_API_CONFIG,
});

/**
 * 合并新旧配置，确保字段合法。
 * @param base 当前配置。
 * @param partial 待合并的增量配置。
 */
const mergeConfig = (base: APIConfig, partial: Partial<APIConfig>): APIConfig => {
  const voiceName =
    typeof partial.voiceName === 'string' && partial.voiceName.trim()
      ? partial.voiceName.trim()
      : base.voiceName;

  const nextPlayDuration =
    typeof partial.playDuration === 'number' && partial.playDuration > 0
      ? partial.playDuration
      : base.playDuration;

  return {
    version: CURRENT_CONFIG_VERSION,
    playDuration: nextPlayDuration,
    voiceName,
  };
};

/**
 * 收集配置缺失字段，帮助前端展示校验信息。
 * @param config APIConfig 当前配置
 * @returns string[] 缺失字段列表
 */
/**
 * 收集缺失的关键配置字段。
 * @param config 当前配置。
 * @returns 缺失字段列表。
 */
const collectMissingFields = (config: APIConfig): string[] => {
  const missing: string[] = [];

  if (!config.playDuration || config.playDuration <= 0) {
    missing.push('playDuration');
  }

  if (!config.voiceName?.trim()) {
    missing.push('voiceName');
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
    /**
     * 初始配置默认取内置值，保证 UI 可立即渲染。
     */
    apiConfig: cloneDefaultConfig(),
    isLoaded: false,
    loadError: undefined,
    /**
     * 尝试从 localStorage 恢复配置，失败则回退默认值。
     */
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
    /**
     * 合并更新配置，同时清除旧的错误提示。
     */
    update: (partial) => {
      const current = get().apiConfig;
      const nextConfig = mergeConfig(current, partial);
      set({
        apiConfig: nextConfig,
        loadError: undefined,
      });
    },
    /**
     * 恢复默认配置。
     */
    resetToDefault: () => {
      set({
        apiConfig: cloneDefaultConfig(),
        loadError: undefined,
      });
    },
    /**
     * 校验当前配置是否满足业务约束。
     */
    isConfigValid: () => isValidConfig(get().apiConfig),
    /**
     * 提供缺失字段列表以便前端提示。
     */
    missingFields: () => collectMissingFields(get().apiConfig),
  };
};

/**
 * 带持久化与版本迁移能力的配置 store。
 */
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
