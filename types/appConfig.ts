import type { VoiceOption, VoiceId } from '@/types/ttsGenerate';

/**
 * 应用配置默认值定义。
 */
export type AppConfigDefaults =  {
  playDuration: number;
  voiceName: VoiceId;
};

/**
 * 应用配置接口响应结构。
 */
export type AppConfigResponse = {
  voicesList: VoiceOption[];
  voiceId: VoiceId;
  playDuration: number;
};

/**
 * 客户端使用的应用配置结构。
 */
export type APIConfig = AppConfigDefaults;
