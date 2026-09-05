import { create, StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { APIConfig } from '@/types/appConfig';
import type { ThemeMode } from '@/types/theme';
import { getSafeLocalStorage, isBrowserEnvironment } from '@/utils/storage';
import type { VoiceOption } from '@/types/ttsGenerate';
import { fetchAppConfig } from '@/lib/client/appConfig';
import { DEFAULT_USER_CONFIG, type UserConfigPatch } from '@/lib/trpc/schemas/config';
import { fetchMyConfig, saveMyConfig } from '@/lib/client/userConfig';
import GlassToast from '@/components/ui/GlassToast';

const CONFIG_STORAGE_KEY = 'config-store';

/**
 * 启动时防御式清理：彻底消除历史版本留在客户端的 config-store 键。
 */
if (isBrowserEnvironment()) {
  try {
    getSafeLocalStorage().removeItem(CONFIG_STORAGE_KEY);
  } catch {
    // ignore storage write failures
  }
}

/**
 * 配置 store 的基础状态结构：记录当前配置、加载标记及可选语音列表。
 */
type ConfigStoreBaseState = {
  apiConfig: APIConfig;
  isLoaded: boolean;
  initError: string | null;
  voiceOptions: VoiceOption[];
  /** 是否处于同步状态（全量上云架构下始终为 true）。 */
  syncEnabled: boolean;
};

/**
 * 配置 store 提供的操作集合，负责初始化、校验与更新。
 */
type ConfigStoreActions = {
  /**
   * 初始化配置（统一从服务端拉取），确保仅执行一次。
   * @returns Promise<void>
   */
  initialize: () => Promise<void>;
  /**
   * 合并更新配置，并防抖同步至服务端。
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
   * 登录态初始化：统一收敛为 initialize()。
   * @returns Promise<void>
   */
  initForUser: () => Promise<void>;
  /**
   * 登出：重置内存状态，作废在途网络请求，保留 theme-mode 防闪烁缓存。
   * @returns void
   */
  reset: () => void;
};

/**
 * 配置 store 的完整状态与动作集合。
 */
export type ConfigStore = ConfigStoreBaseState & ConfigStoreActions;

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
 * 构造系统级默认配置对象（用于网络故障时的内存兜底）。
 */
const createDefaultConfig = (): APIConfig => ({
  playDuration: DEFAULT_USER_CONFIG.playDuration,
  voiceId: DEFAULT_USER_CONFIG.voiceId,
  speed: DEFAULT_USER_CONFIG.speed,
  floatingPlayerEnabled: DEFAULT_USER_CONFIG.floatingPlayerEnabled,
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
 * 配置 store 的状态创建器。
 */
const configStoreCreator: StateCreator<ConfigStore> = (set, get) => {
  let initializationPromise: Promise<void> | null = null;
  let accountEpoch = 0;

  /** 防抖回写定时器与待写 patch 累积。 */
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPatch: UserConfigPatch = {};

  /**
   * 将完整配置映射为可作为 patch 的形状。
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

  const runInitialization = async () => {
    const currentEpoch = accountEpoch;
    try {
      if (isBrowserEnvironment()) {
        try {
          getSafeLocalStorage().removeItem(CONFIG_STORAGE_KEY);
        } catch {}
      }

      // 并行拉取系统级音色配置与主体云端配置
      const [remote, mine] = await Promise.all([
        fetchAppConfig(),
        fetchMyConfig(),
      ]);

      if (currentEpoch !== accountEpoch) {
        return; // 期间登出过，放弃回写
      }

      const voiceOptions = Array.isArray(remote.voicesList) ? remote.voicesList : [];
      const hasVoice = (voice?: string) =>
        !!voice && voiceOptions.some(option => option.value === voice);

      let resolvedVoice: string | undefined;
      if (hasVoice(mine.voiceId)) {
        resolvedVoice = mine.voiceId;
      } else if (hasVoice(remote.voiceId)) {
        resolvedVoice = remote.voiceId;
      } else {
        resolvedVoice = voiceOptions[0]?.value;
      }

      if (!resolvedVoice) {
        throw new Error('INVALID_VOICE');
      }

      const nextConfig: APIConfig = {
        playDuration: mine.playDuration,
        voiceId: resolvedVoice,
        speed: mine.speed,
        floatingPlayerEnabled: mine.floatingPlayerEnabled,
        themeMode: mine.themeMode,
      };

      set({
        apiConfig: nextConfig,
        voiceOptions,
        isLoaded: true,
        initError: null,
        syncEnabled: true,
      });
    } catch (error) {
      if (currentEpoch !== accountEpoch) {
        return;
      }
      set({
        apiConfig: createDefaultConfig(),
        voiceOptions: [],
        isLoaded: false,
        initError: error instanceof Error ? error.message : 'FAILED_TO_FETCH_REMOTE_CONFIG',
        syncEnabled: true,
      });
      throw error;
    }
  };

  return {
    apiConfig: createEmptyConfig(),
    isLoaded: false,
    initError: null,
    voiceOptions: [],
    syncEnabled: true,
    initialize: () => {
      if (!initializationPromise) {
        initializationPromise = runInitialization().catch((error) => {
          console.warn('[configStore] initialize failed', error);
          set({
            apiConfig: createDefaultConfig(),
            isLoaded: false,
            initError: error instanceof Error ? error.message : 'FAILED_TO_FETCH_REMOTE_CONFIG',
            voiceOptions: [],
            syncEnabled: true,
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
      scheduleSave(toPatch(nextConfig));
    },
    isConfigValid: () => isValidConfig(get().apiConfig),
    initForUser: () => get().initialize(),
    reset: () => {
      accountEpoch++;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      pendingPatch = {};
      initializationPromise = null;
      if (isBrowserEnvironment()) {
        try {
          getSafeLocalStorage().removeItem(CONFIG_STORAGE_KEY);
        } catch {}
      }
      set({
        apiConfig: createEmptyConfig(),
        voiceOptions: [],
        isLoaded: false,
        initError: null,
        syncEnabled: true,
      });
    },
  };
};

/**
 * 配置 store Hook，提供配置读取与操作能力。
 */
export const useConfigStore = create<ConfigStore>()(devtools(configStoreCreator));
