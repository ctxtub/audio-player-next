import { serverHttp } from '@/lib/http/server';
import { HttpError } from '@/lib/http/common/ErrorHandler';
import { ServiceError } from '@/lib/http/server/ErrorHandler';
import { loadTtsConfig } from '@/lib/server/ttsUpstream/config';
import type { TtsEnvConfig } from '@/lib/server/ttsUpstream/config';
import type { TtsGeneratePayload, VoiceId } from '@/types/ttsGenerate';

/**
 * 转义 SSML 允许的特殊字符。
 * @param input 原始文本。
 */
const escapeSsml = (input: string): string =>
  input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * 去除多余空白并转义文本，避免注入恶意 SSML。
 * @param text 待合成的文本。
 */
const sanitizeText = (text: string): string => {
  return escapeSsml(text.replace(/\s+/g, ' ').trim());
};

/**
 * 调用底层语音合成时需要的参数。
 */
type SynthesizeParams = {
  text: string;
  voiceName?: VoiceId;
};

/**
 * 语音合成的结果载体。
 */
type SynthesizeResult = {
  audio: ArrayBuffer;
  voiceName: VoiceId;
};

/**
 * 根据白名单解析实际使用的语音。
 * @param voiceName 客户端请求的语音名称。
 * @param config 已解析好的 TTS 配置，可复用避免重复解析。
 * @returns 白名单中允许的语音名称。
 */
export const resolveVoiceName = (voiceName?: VoiceId, config?: TtsEnvConfig): VoiceId => {
  const activeConfig = config ?? loadTtsConfig();
  if (voiceName && activeConfig.voicesList.some((voice) => voice.value === voiceName)) {
    return voiceName;
  }
  return activeConfig.voiceId;
};

/**
 * 调用 Azure TTS 合成语音。
 * @param text 待转换的文本内容。
 * @param voiceName 可选的语音参数。
 * @returns 音频数组缓冲及实际使用的语音。
 * @throws ServiceError 当请求非法或上游失败时抛出。
 */
export const synthesizeSpeech = async ({
  text,
  voiceName,
}: SynthesizeParams): Promise<SynthesizeResult> => {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    throw new ServiceError({
      message: 'text 不能为空',
      status: 400,
      code: 'INVALID_REQUEST',
    });
  }

  if (trimmed.length > 2000) {
    throw new ServiceError({
      message: '文本长度超过限制',
      status: 400,
      code: 'TEXT_TOO_LONG',
    });
  }

  const config = loadTtsConfig();
  const resolvedVoice = resolveVoiceName(voiceName, config);
  const targetVoice = config.voicesList.find((voice) => voice.value === resolvedVoice);

  const ssml = `
    <speak version='1.0' xml:lang='zh-CN'>
      <voice xml:lang='zh-CN' xml:gender='${targetVoice?.gender ?? 'Female'}' name='${resolvedVoice}'>
        ${sanitizeText(trimmed)}
      </voice>
    </speak>
  `;

  try {
    const response = await serverHttp.post<ArrayBuffer>(
      `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      ssml,
      {
        headers: {
          'Ocp-Apim-Subscription-Key': config.apiKey,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': config.outputFormat,
          'User-Agent': 'audio-player-next/tts-proxy',
        },
        responseType: 'arraybuffer',
      }
    );

    const audio = response.data;
    if (!audio || audio.byteLength === 0) {
      throw new ServiceError({
        message: 'Azure TTS 返回空音频',
        status: 502,
        code: 'UPSTREAM_INVALID_RESPONSE',
      });
    }

    return {
      audio,
      voiceName: resolvedVoice,
    };
  } catch (error) {
    if (error instanceof ServiceError) {
      throw error;
    }

    if (error instanceof HttpError) {
      const status = typeof error.status === 'number' && error.status > 0 ? error.status : 502;
      throw new ServiceError({
        message: error.message,
        status,
        code: error.code ?? 'UPSTREAM_ERROR',
        details: error.details,
        cause: error,
      });
    }

    throw new ServiceError({
      message: error instanceof Error ? error.message : '未知错误',
      status: 502,
      code: 'UPSTREAM_NETWORK_ERROR',
      details: error,
      cause: error,
    });
  }
};

/**
 * 处理语音合成请求的入参校验并调用底层合成逻辑。
 * @param payload 原始请求体。
 */
export const handleTtsRequest = async (payload: unknown): Promise<SynthesizeResult> => {
  if (!payload || typeof payload !== 'object') {
    throw new ServiceError({
      message: '请求体必须是对象',
      status: 400,
      code: 'INVALID_REQUEST',
    });
  }

  const rawPayload = payload as Partial<TtsGeneratePayload>;

  const text =
    typeof rawPayload.text === 'string'
      ? rawPayload.text
      : rawPayload.text == null
        ? ''
        : String(rawPayload.text);

  const voiceName =
    typeof rawPayload.voiceId === 'string' ? rawPayload.voiceId : undefined;

  return synthesizeSpeech({
    text,
    voiceName,
  });
};
