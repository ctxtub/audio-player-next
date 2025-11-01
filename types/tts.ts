export type TtsVoiceOption = {
  value: string;
  label: string;
  description?: string;
  locale?: string;
  gender?: 'Female' | 'Male';
};

export type TtsApiRequest = {
  text: string;
  voiceName?: string;
};

export type TtsApiError = {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
};

export type TtsVoicesResponse = {
  voices: TtsVoiceOption[];
  defaultVoice: string;
};
