import { ServiceError } from "@/lib/http/server/ErrorHandler";
import type { VoiceOption, VoiceId, VoiceGender } from "@/types/ttsGenerate";

/**
 * OpenAI TTS 服务所需的环境变量配置。
 */
export type TtsEnvConfig = {
  /** OpenAI API 密钥。 */
  apiKey: string;
  /** TTS 模型名称，如 tts-1 或 tts-1-hd。 */
  model: string;
  /** 默认使用的语音 ID。 */
  voiceId: VoiceId;
  /** 允许客户端选择的语音白名单。 */
  voicesList: VoiceOption[];
};

/**
 * 是否处于生产环境，用于决定缓存策略。
 */
const isProductionEnv = process.env.NODE_ENV === "production";

/**
 * 缓存的 TTS 配置，用于生产环境复用解析结果。
 */
let cachedTtsConfig: TtsEnvConfig | null = null;

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
      throw new Error("voice list should be an array");
    }

    const voicesList = parsed
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const { value, label, description, locale, gender } = item as Record<string, unknown>;
        if (typeof value !== "string" || !value.trim()) {
          return null;
        }

        const voice: VoiceOption = {
          value,
          label: typeof label === "string" && label.trim() ? label : value,
        };

        if (typeof description === "string" && description.trim()) {
          voice.description = description;
        }

        if (typeof locale === "string" && locale.trim()) {
          voice.locale = locale;
        }

        if (gender === "Female" || gender === "Male") {
          voice.gender = gender as VoiceGender;
        }

        return voice;
      })
      .filter((voice): voice is VoiceOption => voice !== null);

    if (voicesList.length === 0) {
      throw new Error("voice list is empty");
    }

    return voicesList;
  } catch (error) {
    console.warn("[tts] Failed to parse OPENAI_TTS_VOICE_LIST:", error);
    return [];
  }
};

/**
 * 默认的 TTS 模型名称。
 */
const DEFAULT_TTS_MODEL = "tts-1";

/**
 * 获取 OpenAI API 密钥
 */
const resolveApiKey = (): string | undefined =>
  process.env.OPENAI_API_KEY?.trim();

/**
 * 从环境变量构造 TTS 配置对象。
 * @returns 解析后的配置结果
 */
const buildConfigFromEnv = (): TtsEnvConfig => {
  const apiKey = resolveApiKey();

  if (!apiKey) {
    throw new ServiceError({
      message: "缺少 OPENAI_API_KEY 环境变量",
      status: 500,
      code: "SERVER_CONFIG_ERROR",
    });
  }

  const voiceList = parseVoiceAllowList(process.env.OPENAI_TTS_VOICE_LIST);
  if (voiceList.length === 0) {
    throw new ServiceError({
      message: "缺少 OPENAI_TTS_VOICE_LIST 配置或内容为空",
      status: 500,
      code: "SERVER_CONFIG_ERROR",
    });
  }

  let voiceId = process.env.OPENAI_TTS_DEFAULT_VOICE?.trim();
  if (!voiceId || !voiceList.some((voice) => voice.value === voiceId)) {
    voiceId = voiceList[0].value;
  }

  const model = process.env.OPENAI_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL;

  return {
    apiKey,
    model,
    voiceId,
    voicesList: voiceList,
  };
};

/**
 * 加载并校验 TTS 服务所需的环境配置。
 * @throws ServiceError 当关键配置缺失或非法时抛出。
 */
export const loadTtsConfig = (): TtsEnvConfig => {
  if (!isProductionEnv) {
    return buildConfigFromEnv();
  }

  if (cachedTtsConfig) {
    return cachedTtsConfig;
  }

  const config = buildConfigFromEnv();
  cachedTtsConfig = config;
  return config;
};
