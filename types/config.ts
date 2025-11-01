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

export type AppConfigError = {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
};
