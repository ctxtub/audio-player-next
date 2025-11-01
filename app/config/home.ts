import { APIConfig } from '@/types/types';

export const CURRENT_CONFIG_VERSION = Number(process.env.REACT_APP_BUILD_TIMESTAMP);

export const DEFAULT_API_CONFIG: APIConfig = {
  version: CURRENT_CONFIG_VERSION,
  playDuration: 30,
  voiceName: 'zh-CN-XiaoxiaoNeural',
};

export const isValidConfig = (config: APIConfig): boolean => {
  if (!config) {
    return false;
  }

  if (!config.playDuration || config.playDuration <= 0) {
    return false;
  }

  return typeof config.voiceName === 'string' && config.voiceName.trim().length > 0;
};
  
