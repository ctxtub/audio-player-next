import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { debounce } from 'lodash-es';
import type { APIConfig } from '@/types/appConfig';
import type { VoiceOption } from '@/types/ttsGenerate';
import { fetchAppConfig } from '@/lib/client/appConfig';
import { trpc } from '@/lib/trpc/client';

/**
 * 配置 store 的基础状态结构：记录当前配置、加载标记及可选语音列表。
 */
type ConfigStoreBaseState = {
  apiConfig: APIConfig;
  isLoaded: boolean;
  /** 当前用户是否已登录，决定是否将配置写入数据库。 */
  isLoggedIn: boolean;
  voiceOptions: VoiceOption[];
};

/**
 * 配置 store 提供的操作集合，负责初始化、校验与更新。
 */
type ConfigStoreActions = {
  /**
   * 初始化配置（远端默认值 + 用户 DB 设置），确保仅执行一次。
   * @returns Promise<void>
   */
  initialize: () => Promise<void>;
  /**
   * 合并更新配置，并通过防抖写入数据库。
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
 * 构造初始配置对象。
 * @returns 默认配置
 */
const createEmptyConfig = (): APIConfig => ({
  playDuration: 0,
  voiceId: '',
  speed: 1,
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

  if (typeof config.speed !== 'number' || config.speed < 0.25 || config.speed > 4.0) {
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
    typeof partial.playDuration === 'number' && partial.playDuration >= 10 && partial.playDuration <= 60
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

  return {
    playDuration: nextPlayDuration,
    voiceId,
    speed,
    floatingPlayerEnabled,
  };
};

/**
 * 防抖保存用户设置到数据库，静默失败避免阻塞交互。
 */
const saveSettingsToDb = debounce((config: Partial<APIConfig>) => {
  trpc.settings.save.mutate(config).catch((err: unknown) => {
    console.warn('[configStore] saveSettingsToDb failed', err);
  });
}, 500);

/**
 * 配置 store Hook，提供配置读取与操作能力。
 */
export const useConfigStore = create<ConfigStore>()(
  devtools((set, get) => {
    let initializationPromise: Promise<void> | null = null;

    /**
     * 加载远端应用配置与用户个性化设置，合并后写入 store。
     */
    const runInitialization = async () => {
      /** 并行请求应用默认配置与用户 DB 设置 */
      const [remote, userSettings] = await Promise.all([
        fetchAppConfig(),
        trpc.settings.get.query().catch(() => null),
      ]);

      const voiceOptions = Array.isArray(remote.voicesList) ? remote.voicesList : [];
      const hasVoice = (voice?: string) =>
        !!voice && voiceOptions.some(option => option.value === voice);

      /** 播放时长：用户设置 > 远端默认值 */
      const playDuration =
        userSettings && userSettings.playDuration > 0
          ? userSettings.playDuration
          : remote.playDuration;

      if (!playDuration || playDuration <= 0) {
        throw new Error('INVALID_PLAY_DURATION');
      }

      /** 语音：用户设置 > 远端默认 > 第一个可用 */
      let resolvedVoice: string | undefined;
      if (userSettings && hasVoice(userSettings.voiceId)) {
        resolvedVoice = userSettings.voiceId;
      } else if (hasVoice(remote.voiceId)) {
        resolvedVoice = remote.voiceId;
      }

      if (!resolvedVoice) {
        throw new Error('INVALID_VOICE');
      }

      const floatingPlayerEnabled =
        userSettings != null
          ? userSettings.floatingPlayerEnabled
          : remote.floatingPlayerEnabled ?? true;

      const mergedConfig: APIConfig = {
        playDuration,
        voiceId: resolvedVoice,
        speed: userSettings?.speed ?? 1.0,
        floatingPlayerEnabled,
      };

      set({
        apiConfig: mergedConfig,
        voiceOptions,
        isLoaded: true,
        isLoggedIn: userSettings != null,
      });
    };

    return {
      apiConfig: createEmptyConfig(),
      isLoaded: false,
      isLoggedIn: false,
      voiceOptions: [],
      initialize: () => {
        if (!initializationPromise) {
          initializationPromise = runInitialization().catch(error => {
            console.warn('[configStore] initialize failed', error);
            set({
              apiConfig: createEmptyConfig(),
              isLoaded: false,
              isLoggedIn: false,
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
        set({ apiConfig: nextConfig });
        /** 仅登录用户防抖写入数据库 */
        if (get().isLoggedIn) {
          saveSettingsToDb(partial);
        }
      },
      isConfigValid: () => isValidConfig(get().apiConfig),
    };
  })
);
