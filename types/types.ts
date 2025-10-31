declare global {
  interface Window {
    gtag: (
      command: 'event',
      action: string,
      params: {
        event_category?: string;
        event_label?: string;
        value?: number;
        [key: string]: any;
      }
    ) => void;
  }
}

export interface APIConfig {
  version: number;
  apiKey: string;
  apiBaseUrl: string;
  storyModel: string;
  summaryModel: string;
  playDuration: number;
  voiceProvider: VoiceProvider;
  azureTtsConfig: {
    speechKey: string;
    speechRegion: string;
    voiceName: string;
  };
  freeTtsConfig: {
    voiceName: string;
    speechKey: string;
  };
}

export type VoiceProvider = 'azure-tts' | 'free-tts';

export interface AzureVoiceOption {
  value: string;
  label: string;
  description: string;
  gender: 'Female' | 'Male';
  locale: string;
}

export interface StoryConfig {
  prompt: string;
}

export type AzureRegion = 
  | 'eastasia'
  | 'southeastasia'
  | 'eastus'
  | 'eastus2'
  | 'westus'
  | 'westus2'
  | 'westus3'
  | 'northeurope'
  | 'westeurope'
  | 'japaneast'
  | 'japanwest'
  | 'australiaeast'
  | 'southcentralus'
  | 'centralus'
  | 'northcentralus'
  | 'centralindia'
  | 'eastasia'
  | 'koreacentral';

export interface RegionOption {
  value: AzureRegion;
  label: string;
  description: string;
}

export interface MsVoiceOption {
  value: string;
  label: string;
  description: string;
  gender: 'Male' | 'Female';
  locale: string;
}

export const AVAILABLE_MODELS = {
  STORY_MODELS: [
    { value: 'hoki-story', label: '故事生成大模型' }
  ],
  SUMMARY_MODELS: [
    { value: '', label: '关闭故事摘要' },
  ]
} as const;

// 为 AVAILABLE_MODELS 添加类型定义
export interface ModelOption {
  value: string;
  label: string;
}

export interface AvailableModels {
  STORY_MODELS: ModelOption[];
  SUMMARY_MODELS: ModelOption[];
}

export type ThemeMode = 'dark' | 'light' | 'system';
