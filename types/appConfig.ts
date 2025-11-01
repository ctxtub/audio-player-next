import type { VoiceOption, VoiceId } from '@/types/ttsGenerate';

export type AppConfigDefaults =  {
  playDuration: number;
  voiceName: VoiceId;
};

export type AppConfigResponse = {
  voicesList: VoiceOption[];
  voiceId: VoiceId;
  playDuration: number;
};

export type APIConfig = AppConfigDefaults;
