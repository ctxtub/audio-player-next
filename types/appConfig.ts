import type { VoiceOption, VoiceId } from '@/types/ttsGenerate';
import type { ThemeMode } from '@/types/theme';

/**
 * 应用配置默认值定义（客户端持有的完整偏好）。
 * desktopFloatingPlayerEnabled 为唯一产品语义（true=宽屏可悬浮，false=宽屏 docked；
 * 移动端始终 docked，不受该字段影响）。
 * 默认睡眠定时正式字段 defaultSleepTimerEnabled + defaultSleepTimerMinutes；
 * 旧 playDuration 作为 compatibility alias 同值保留一个发布周期（spec §30）。
 */
export type AppConfigDefaults = {
  defaultSleepTimerMinutes: number;
  defaultSleepTimerEnabled: boolean;
  /** @deprecated compatibility alias：与 defaultSleepTimerMinutes 同值，保留一个发布周期。 */
  playDuration: number;
  voiceId: VoiceId;
  speed: number;
  desktopFloatingPlayerEnabled: boolean;
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
