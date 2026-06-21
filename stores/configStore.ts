import { create, StateCreator, type StoreApi } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import type { APIConfig } from '@/types/appConfig';
import type { ThemeMode } from '@/types/theme';
import { getSafeLocalStorage, isBrowserEnvironment } from '@/utils/storage';
import type { VoiceOption } from '@/types/ttsGenerate';
import { fetchAppConfig } from '@/lib/client/appConfig';
import { DEFAULT_USER_CONFIG, type UserConfigPatch } from '@/lib/trpc/schemas/config';
import { fetchMyConfig, saveMyConfig } from '@/lib/client/userConfig';
import GlassToast from '@/components/ui/GlassToast';

/**
 * 配置 store 的基础状态结构：记录当前配置、加载标记及可选语音列表。
 */
type ConfigStoreBaseState = {
  apiConfig: APIConfig;
  isLoaded: boolean;
  voiceOptions: VoiceOption[];
  /** 是否处于登录态（开启服务端回写）。 */
  syncEnabled: boolean;
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
  /**
   * 登录后：拉取服务端配置（本地作 seed），开启回写。
   * @returns Promise<void>
   */
  initForUser: () => Promise<void>;
  /**
   * 登出：重置为默认并清本地缓存，关闭回写。
   * @returns void
   */
  reset: () => void;
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
  speed: 1,
  floatingPlayerEnabled: true,
  themeMode: DEFAULT_USER_CONFIG.themeMode,
});

/**
 * 校验配置对象是否满足使用条件。
 * @param config 待校验的配置
 * @returns 是否有效
 */
const isValidConfig = (config: Partial<APIConfig> | undefined): config is APIConfig => {
  if (!config) {
    return false;
  }

  if (typeof config.playDuration !== 'number' || config.playDuration <= 0) {
    return false;
  }

  if (typeof config.voiceId !== 'string' || !config.voiceId.trim()) {
    return false;
  }

  if (typeof config.speed !== 'number' || config.speed < 0.25 || config.speed > 4.0) {
    return false;
  }

  if (typeof config.floatingPlayerEnabled !== 'boolean') {
    return false;
  }

  if (
    config.themeMode !== 'dark' &&
    config.themeMode !== 'light' &&
    config.themeMode !== 'system'
  ) {
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

  const speed =
    typeof partial.speed === 'number' && partial.speed >= 0.25 && partial.speed <= 4.0
      ? partial.speed
      : base.speed ?? 1.0;

  const floatingPlayerEnabled =
    typeof partial.floatingPlayerEnabled === 'boolean'
      ? partial.floatingPlayerEnabled
      : base.floatingPlayerEnabled;

  const themeMode: ThemeMode =
    partial.themeMode === 'dark' ||
    partial.themeMode === 'light' ||
    partial.themeMode === 'system'
      ? partial.themeMode
      : base.themeMode;

  return {
    playDuration: nextPlayDuration,
    voiceId,
    speed,
    floatingPlayerEnabled,
    themeMode,
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
  /** initForUser 去重：进行中的拉取 Promise（并发合流）。 */
  let userInitPromise: Promise<void> | null = null;

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
          : DEFAULT_USER_CONFIG.playDuration;

      let resolvedVoice: string | undefined;

      if (localConfig && hasVoice(localConfig.voiceId)) {
        resolvedVoice = localConfig.voiceId;
      } else if (hasVoice(remote.voiceId)) {
        resolvedVoice = remote.voiceId;
      }

      if (!resolvedVoice) {
        throw new Error('INVALID_VOICE');
      }

      const mergedConfig: APIConfig = {
        playDuration,
        voiceId: resolvedVoice,
        speed: localConfig?.speed ?? DEFAULT_USER_CONFIG.speed,
        floatingPlayerEnabled:
          localConfig?.floatingPlayerEnabled ?? DEFAULT_USER_CONFIG.floatingPlayerEnabled,
        themeMode: localConfig?.themeMode ?? DEFAULT_USER_CONFIG.themeMode,
      };

      return { config: mergedConfig, voiceOptions };
    } catch (error) {
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

  /** 防抖回写定时器与待写 patch 累积。 */
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPatch: UserConfigPatch = {};

  /**
   * 将完整配置映射为可作为 seed/patch 的形状。
   * @param config 当前完整配置。
   */
  const toPatch = (config: APIConfig): UserConfigPatch => ({
    playDuration: config.playDuration,
    voiceId: config.voiceId,
    speed: config.speed,
    floatingPlayerEnabled: config.floatingPlayerEnabled,
    themeMode: config.themeMode,
  });

  /**
   * 防抖 500ms 将累积 patch 回写服务端，失败保留乐观值并提示。
   * @param patch 本次变更的增量字段。
   */
  const scheduleSave = (patch: UserConfigPatch) => {
    pendingPatch = { ...pendingPatch, ...patch };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const toSend = pendingPatch;
      pendingPatch = {};
      saveTimer = null;
      saveMyConfig(toSend).catch((error) => {
        console.warn('[configStore] saveMyConfig failed', error);
        GlassToast.show({ icon: 'fail', content: '配置同步失败，稍后重试' });
      });
    }, 500);
  };

  return {
    apiConfig: createEmptyConfig(),
    isLoaded: false,
    voiceOptions: [],
    syncEnabled: false,
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
      if (get().syncEnabled) {
        scheduleSave(toPatch(nextConfig));
      }
    },
    isConfigValid: () => isValidConfig(get().apiConfig),
    initForUser: () => {
      // 已按服务端加载则跳过；并发调用复用同一拉取（与其余三块契约一致）
      if (get().syncEnabled) {
        return Promise.resolve();
      }
      if (userInitPromise) {
        return userInitPromise;
      }
      userInitPromise = (async () => {
        // 1) 取本地配置作为 seed（仅服务端无行时被消费）
        const localConfig = await hydrateLocalConfig();
        const seed = localConfig ? toPatch(localConfig) : undefined;
        // 2) 并行拉取系统级音色与个人配置
        const [remote, mine] = await Promise.all([
          fetchAppConfig(),
          fetchMyConfig(seed),
        ]);
        const voiceOptions = Array.isArray(remote.voicesList) ? remote.voicesList : [];
        const hasVoice = (voice?: string) =>
          !!voice && voiceOptions.some(option => option.value === voice);
        // 3) 解析音色：服务端值优先，回落系统默认 / 列表首项
        const resolvedVoice = hasVoice(mine.voiceId)
          ? mine.voiceId
          : hasVoice(remote.voiceId)
            ? remote.voiceId
            : voiceOptions[0]?.value ?? '';

        set({
          apiConfig: {
            playDuration: mine.playDuration,
            voiceId: resolvedVoice,
            speed: mine.speed,
            floatingPlayerEnabled: mine.floatingPlayerEnabled,
            themeMode: mine.themeMode,
          },
          voiceOptions,
          isLoaded: true,
          syncEnabled: true,
        });
      })().finally(() => {
        userInitPromise = null;
      });
      return userInitPromise;
    },
    reset: () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      pendingPatch = {};
      try {
        getSafeLocalStorage().removeItem(CONFIG_STORAGE_KEY);
      } catch {
        // ignore storage 清理失败
      }
      set({
        apiConfig: createEmptyConfig(),
        voiceOptions: [],
        isLoaded: false,
        syncEnabled: false,
      });
    },
  };
};

/**
 * 带持久化与版本迁移能力的配置 store。
 */
const persistedConfigStore = persist(configStoreCreator, {
  name: CONFIG_STORAGE_KEY,
  version: 1,
  storage: createJSONStorage(getSafeLocalStorage),
  partialize: (state) => ({
    apiConfig: state.apiConfig,
  }),
  migrate: (persistedState: unknown) => {
    const raw = (persistedState as { apiConfig?: Partial<APIConfig> } | undefined)?.apiConfig;
    // 回填缺失的 themeMode（旧版本无此字段时用默认；已有则保留）
    const config = raw
      ? { ...raw, themeMode: raw.themeMode ?? DEFAULT_USER_CONFIG.themeMode }
      : undefined;
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
