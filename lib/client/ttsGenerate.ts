/**
 * TTS 语音合成客户端
 *
 * 使用 tRPC 请求语音合成并返回音频 URL。
 */

import { trpc } from '@/lib/trpc/client';
import type { VoiceId } from '@/types/ttsGenerate';

/**
 * 通过 tRPC 请求语音音频。
 * @param text 待合成的文本。
 * @param voiceId 可选的语音标识。
 * @param speed 可选的语速 (0.25 - 4.0)。
 * @returns 指向生成音频的临时 URL。
 */
export const fetchAudio = async (text: string, voiceId?: VoiceId, speed?: number): Promise<string> => {
  const result = await trpc.tts.synthesize.mutate({ text, voiceId, speed });

  // 将 base64 转换为 Blob URL
  let binaryString: string;
  try {
    binaryString = atob(result.audioBase64);
  } catch {
    throw new Error('TTS 返回的音频数据格式异常');
  }
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: result.contentType });

  return URL.createObjectURL(blob);
};
