import type { TtsVoiceOption } from '@/types/tts';

export type AppConfigResponse = {
  tts: {
    voices: TtsVoiceOption[];
    defaultVoice: string;
  };
  defaults: {
    playDuration: number;
    voiceName: string;
  };
};
