import * as sdk from "microsoft-cognitiveservices-speech-sdk";

import { ServiceError } from "@/lib/http/server/ErrorHandler";

import { loadTtsConfig } from "./config";

/**
 * 语音合成所需的入参结构。
 */
export type SynthesizeSpeechParams = {
  /** 已在 BFF 校验过的文本内容。 */
  text: string;
  /** 语音白名单中的语音 ID。 */
  voiceId: string;
};

/**
 * 语音合成后的返回结构。
 */
export type SynthesizeSpeechResult = {
  /** Azure SDK 返回的 MP3 音频数据。 */
  audioData: ArrayBuffer;
  /** Azure 请求对应的跟踪 ID。 */
  requestId: string;
};

/**
 * 将配置中的字符串格式映射到 SDK 的输出格式枚举。
 * @param formatText 配置中的格式标识。
 */
const mapOutputFormat = (formatText: string): sdk.SpeechSynthesisOutputFormat => {
  switch (formatText) {
    case "audio-16khz-128kbitrate-mono-mp3":
      return sdk.SpeechSynthesisOutputFormat.Audio16Khz128KBitRateMonoMp3;
    case "audio-24khz-160kbitrate-mono-mp3":
      return sdk.SpeechSynthesisOutputFormat.Audio24Khz160KBitRateMonoMp3;
    case "audio-48khz-192kbitrate-mono-mp3":
      return sdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3;
    default:
      return sdk.SpeechSynthesisOutputFormat.Audio24Khz160KBitRateMonoMp3;
  }
};

/**
 * 使用 Azure Speech SDK 执行文本转语音，并返回音频二进制数据。
 * @param params.text 已经过业务裁剪的文本内容。
 * @param params.voiceId 白名单中的语音标识。
 * @returns Azure SDK 的音频结果与请求 ID。
 * @throws ServiceError 当请求失败或结果缺失时抛出。
 */
export const synthesizeSpeech = async (
  params: SynthesizeSpeechParams,
): Promise<SynthesizeSpeechResult> => {
  const { text, voiceId } = params;
  const config = loadTtsConfig();

  const speechConfig = sdk.SpeechConfig.fromSubscription(config.apiKey, config.region);
  speechConfig.speechSynthesisVoiceName = voiceId;
  speechConfig.speechSynthesisOutputFormat = mapOutputFormat(config.outputFormat);

  const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

  try {
    const result = await new Promise<sdk.SpeechSynthesisResult>((resolve, reject) => {
      synthesizer.speakTextAsync(
        text,
        (success) => resolve(success),
        (error) => reject(error),
      );
    });

    if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
      const audioBuffer = result.audioData as ArrayBuffer;
      const requestId = result.resultId ?? "";

      if (!audioBuffer || audioBuffer.byteLength === 0) {
        throw new ServiceError({
          message: "Azure TTS 返回空音频",
          status: 502,
          code: "UPSTREAM_INVALID_RESPONSE",
        });
      }

      return {
        audioData: audioBuffer,
        requestId,
      };
    }

    if (result.reason === sdk.ResultReason.Canceled) {
      const details = sdk.CancellationDetails.fromResult(result);
      throw new ServiceError({
        message: `Azure TTS 请求被取消: ${details.errorDetails ?? "未知原因"}`,
        status: 502,
        code: "UPSTREAM_CANCELED",
        details: {
          reason: details.reason,
          errorDetails: details.errorDetails,
        },
      });
    }

    throw new ServiceError({
      message: `Azure TTS 未能完成合成，状态: ${result.reason}`,
      status: 502,
      code: "UPSTREAM_INVALID_RESPONSE",
      details: undefined,
    });
  } catch (error) {
    if (error instanceof ServiceError) {
      throw error;
    }

    throw new ServiceError({
      message: error instanceof Error ? error.message : "Azure TTS 调用失败",
      status: 502,
      code: "UPSTREAM_NETWORK_ERROR",
      details: error,
      cause: error,
    });
  } finally {
    synthesizer.close();
  }
};
