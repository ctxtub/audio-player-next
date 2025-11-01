import { ServiceError } from '@/lib/http/server/ErrorHandler';
import { TtsVoiceOption } from '@/types/tts';

export type TtsEnvConfig = {
  apiKey: string;
  region: string;
  defaultVoice: string;
  voices: TtsVoiceOption[];
  outputFormat: string;
};

const DEFAULT_OUTPUT_FORMAT = 'audio-16khz-128kbitrate-mono-mp3';

const parseVoiceAllowList = (raw: string | undefined): TtsVoiceOption[] => {
  if (!raw?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('voice list should be an array');
    }

    const voices = parsed
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return null;
        }

        const { value, label, description, locale, gender } = item as Record<string, unknown>;
        if (typeof value !== 'string' || !value.trim()) {
          return null;
        }

        const voice: TtsVoiceOption = {
          value,
          label: typeof label === 'string' && label.trim() ? label : value,
        };

        if (typeof description === 'string' && description.trim()) {
          voice.description = description;
        }

        if (typeof locale === 'string' && locale.trim()) {
          voice.locale = locale;
        }

        if (gender === 'Female' || gender === 'Male') {
          voice.gender = gender;
        }

        return voice;
      })
      .filter((voice): voice is TtsVoiceOption => voice !== null);

    if (voices.length === 0) {
      throw new Error('voice list is empty');
    }

    return voices;
  } catch (error) {
    console.warn('[tts] Failed to parse AZURE_TTS_VOICE_ALLOW_LIST:', error);
    return [];
  }
};

export const loadTtsConfig = (): TtsEnvConfig => {
  const apiKey = process.env.AZURE_TTS_KEY?.trim();
  const region = process.env.AZURE_TTS_REGION?.trim();

  if (!apiKey) {
    throw new ServiceError({
      message: '缺少 AZURE_TTS_KEY 环境变量',
      status: 500,
      code: 'SERVER_CONFIG_ERROR',
    });
  }

  if (!region) {
    throw new ServiceError({
      message: '缺少 AZURE_TTS_REGION 环境变量',
      status: 500,
      code: 'SERVER_CONFIG_ERROR',
    });
  }

  const voiceList = parseVoiceAllowList(process.env.AZURE_TTS_VOICE_ALLOW_LIST);
  if (voiceList.length === 0) {
    throw new ServiceError({
      message: '缺少 AZURE_TTS_VOICE_ALLOW_LIST 配置或内容为空',
      status: 500,
      code: 'SERVER_CONFIG_ERROR',
    });
  }

  let defaultVoice = process.env.AZURE_TTS_DEFAULT_VOICE?.trim();
  if (!defaultVoice || !voiceList.some((voice) => voice.value === defaultVoice)) {
    defaultVoice = voiceList[0].value;
  }

  return {
    apiKey,
    region,
    defaultVoice,
    voices: voiceList,
    outputFormat: DEFAULT_OUTPUT_FORMAT,
  };
};
