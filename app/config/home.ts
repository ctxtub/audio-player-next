import { AVAILABLE_MODELS, APIConfig } from '@/types/types';

export const CURRENT_CONFIG_VERSION = Number(process.env.REACT_APP_BUILD_TIMESTAMP);

export const DEFAULT_API_CONFIG: APIConfig = {
  version: CURRENT_CONFIG_VERSION,
  apiKey: 'sk-rtfelnkvmlO8CajDnyLe2wfejuyt5tSw4p8rLx2eX6emDMZV',
  apiBaseUrl: 'https://one.prev.bid',
  storyModel: AVAILABLE_MODELS.STORY_MODELS[0].value,
  summaryModel: AVAILABLE_MODELS.SUMMARY_MODELS[0].value,
  playDuration: 30,
  voiceProvider: 'free-tts',
  azureTtsConfig: {
    speechKey: '',
    speechRegion: 'eastasia',
    voiceName: 'zh-CN-XiaoxiaoNeural',
  },
  freeTtsConfig: {
    voiceName: 'zh-CN-XiaoxiaoNeural',
    speechKey: 'sk-rtfelnkvmlO8CajDnyLe2wfejuyt5tSw4p8rLx2eX6emDMZV',
  },
};

export const isValidConfig = (config: APIConfig): boolean => {
  return !!(config && config.apiKey && config.apiBaseUrl && config.playDuration > 0);
};
  