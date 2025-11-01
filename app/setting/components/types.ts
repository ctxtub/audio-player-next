import type { APIConfig } from '@/types/types';
import type { TtsVoiceOption } from '@/types/tts';

export type ConfigFormValues = Partial<APIConfig> & {
  playDuration?: number | string;
};

export type VoiceGroup = {
  label: string;
  voices: TtsVoiceOption[];
};

export type VoiceGroups = Record<string, VoiceGroup>;
