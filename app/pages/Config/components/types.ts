import type { APIConfig, VoiceProvider } from '@/types/types';

export type ConfigFormValues = Partial<APIConfig> & {
  playDuration?: number | string;
};

export type VoiceGroup = {
  label: string;
  voices: {
    value: string;
    label: string;
    description: string;
    gender: string;
    locale: string;
  }[];
};

export type VoiceGroups = Record<string, VoiceGroup>;

export type ProviderOption = {
  label: string;
  value: VoiceProvider;
};
