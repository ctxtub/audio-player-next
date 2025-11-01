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
