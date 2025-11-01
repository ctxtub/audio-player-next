export type VoiceId = string;

export type VoiceGender = 'Female' | 'Male';

export type VoiceOption = {
  value: VoiceId;
  label: string;
  description?: string;
  locale?: string;
  gender?: VoiceGender;
};

export type TtsGeneratePayload = {
  text: string;
  voiceId?: VoiceId;
};

export type TtsVoiceOption = VoiceOption;
export type TtsApiRequest = TtsGeneratePayload;
