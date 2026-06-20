import type { VoiceOption, VoiceId } from '@/types/ttsGenerate';
import type { ThemeMode } from '@/types/theme';

/**
 * 应用配置默认值定义（客户端持有的完整偏好）。
 */
export type AppConfigDefaults = {
  playDuration: number;
  voiceId: VoiceId;
  speed: number;
  floatingPlayerEnabled: boolean;
  themeMode: ThemeMode;
};

/**
 * 系统级配置接口（config.get）响应结构：仅音色白名单与系统默认音色。
 */
export type AppConfigResponse = {
  voicesList: VoiceOption[];
  voiceId: VoiceId;
};

/**
 * 客户端使用的应用配置结构。
 */
export type APIConfig = AppConfigDefaults;
