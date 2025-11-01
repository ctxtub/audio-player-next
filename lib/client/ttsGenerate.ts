import type { TtsGeneratePayload } from '@/types/ttsGenerate';
import { browserHttp } from '@/lib/http/browser';
import { HttpError } from '@/lib/http/common/ErrorHandler';

/**
 * 前端语音 API 客户端错误类型。
 */
export class TtsApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'TtsApiClientError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 通过服务端代理请求语音音频。
 * @param text 待合成的文本。
 * @param voiceName 可选的语音名称。
 * @returns 指向生成音频的临时 URL。
 * @throws TtsApiClientError
 */
export const fetchAudio = async (text: string, voiceName?: string): Promise<string> => {
  const payload: TtsGeneratePayload = {
    text,
    voiceId: voiceName,
  };

  try {
    const response = await browserHttp.post<Blob>('/api/ttsGenerate', payload, {
      headers: {
        'Content-Type': 'application/json',
      },
      responseType: 'blob',
    });

    return URL.createObjectURL(response.data);
  } catch (error) {
    if (error instanceof HttpError) {
      throw new TtsApiClientError(
        error.message,
        error.status,
        error.code || 'TTS_API_ERROR'
      );
    }

    throw new TtsApiClientError(
      error instanceof Error ? error.message : '网络错误',
      0,
      'NETWORK_ERROR'
    );
  }
};
