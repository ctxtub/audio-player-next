/**
 * 语音服务使用的声音标识。
 */
export type VoiceId = string;

/**
 * 支持的语音性别枚举。
 */
export type VoiceGender = 'Female' | 'Male';

/**
 * 前端展示的语音选项。
 */
export type VoiceOption = {
  value: VoiceId;
  label: string;
  description?: string;
  locale?: string;
  gender?: VoiceGender;
};

/**
 * 语音合成请求载荷。
 */
export type TtsGeneratePayload = {
  text: string;
  voiceId?: VoiceId;
};

/**
 * Alias 类型，便于兼容旧命名。
 */
export type TtsVoiceOption = VoiceOption;
/**
 * API 请求载荷别名。
 */
export type TtsApiRequest = TtsGeneratePayload;
