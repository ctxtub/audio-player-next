import OpenAI from "openai";

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
    /** OpenAI 返回的 MP3 音频数据。 */
    audioData: ArrayBuffer;
    /** 请求标识（OpenAI 不返回，保留字段兼容）。 */
    requestId: string;
};

/**
 * OpenAI TTS 支持的语音类型。
 */
type OpenAIVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

/**
 * 使用 OpenAI TTS-1 执行文本转语音，并返回音频二进制数据。
 * @param params.text 已经过业务裁剪的文本内容。
 * @param params.voiceId 白名单中的语音标识。
 * @returns OpenAI 的音频结果。
 * @throws ServiceError 当请求失败或结果缺失时抛出。
 */
export const synthesizeSpeech = async (
    params: SynthesizeSpeechParams,
): Promise<SynthesizeSpeechResult> => {
    const { text, voiceId } = params;
    const config = loadTtsConfig();

    const openai = new OpenAI({
        apiKey: config.apiKey,
    });

    try {
        const response = await openai.audio.speech.create({
            model: config.model,
            voice: voiceId as OpenAIVoice,
            input: text,
            response_format: "mp3",
        });

        const audioBuffer = await response.arrayBuffer();

        if (!audioBuffer || audioBuffer.byteLength === 0) {
            throw new ServiceError({
                message: "OpenAI TTS 返回空音频",
                status: 502,
                code: "UPSTREAM_INVALID_RESPONSE",
            });
        }

        return {
            audioData: audioBuffer,
            requestId: "",
        };
    } catch (error) {
        if (error instanceof ServiceError) {
            throw error;
        }

        if (error instanceof OpenAI.APIError) {
            throw new ServiceError({
                message: `OpenAI TTS 请求失败: ${error.message}`,
                status: error.status ?? 502,
                code: "UPSTREAM_API_ERROR",
                details: {
                    type: error.type,
                    code: error.code,
                },
                cause: error,
            });
        }

        throw new ServiceError({
            message: error instanceof Error ? error.message : "OpenAI TTS 调用失败",
            status: 502,
            code: "UPSTREAM_NETWORK_ERROR",
            details: error,
            cause: error,
        });
    }
};
