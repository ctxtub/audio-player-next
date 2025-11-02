import { ServiceError } from '@/lib/http/server/ErrorHandler';
import type { VoiceOption, VoiceId, VoiceGender } from '@/types/ttsGenerate';

/**
 * Azure TTS 服务所需的环境变量配置。
 */
export type TtsEnvConfig = {
  apiKey: string;
  region: string;
  voiceId: VoiceId;
  voicesList: VoiceOption[];
  outputFormat: string;
};

/**
 * 默认的音频输出格式。
 */
const DEFAULT_OUTPUT_FORMAT = 'audio-16khz-128kbitrate-mono-mp3';

/**
 * 解析环境变量中的语音白名单，过滤掉异常项。
 * @param raw 环境变量原始字符串。
 */
const parseVoiceAllowList = (raw: string | undefined): VoiceOption[] => {
  if (!raw?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('voice list should be an array');
    }

    const voicesList = parsed
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return null;
        }

        const { value, label, description, locale, gender } = item as Record<string, unknown>;
        if (typeof value !== 'string' || !value.trim()) {
          return null;
        }

        const voice: VoiceOption = {
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
          voice.gender = gender as VoiceGender;
        }

        return voice;
      })
      .filter((voice): voice is VoiceOption => voice !== null);

    if (voicesList.length === 0) {
      throw new Error('voice list is empty');
    }

    return voicesList;
  } catch (error) {
    console.warn('[tts] Failed to parse AZURE_TTS_VOICE_ALLOW_LIST:', error);
    return [];
  }
};

/**
 * 加载并校验 TTS 服务所需的环境配置。
 * @throws ServiceError 当关键配置缺失或非法时抛出。
 */
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

  let voiceId = process.env.AZURE_TTS_DEFAULT_VOICE?.trim();
  if (!voiceId || !voiceList.some((voice) => voice.value === voiceId)) {
    voiceId = voiceList[0].value;
  }

  return {
    apiKey,
    region,
    voiceId,
    voicesList: voiceList,
    outputFormat: DEFAULT_OUTPUT_FORMAT,
  };
};
