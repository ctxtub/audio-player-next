import type { VoiceId } from '@/types/ttsGenerate';

/**
 * 应用配置默认值定义。
 */
export type AppConfigDefaults = {
  playDuration: number;
  voiceId: VoiceId;
  speed: number;
  floatingPlayerEnabled: boolean;
};

/**
 * 客户端使用的应用配置结构。
 */
export type APIConfig = AppConfigDefaults;
