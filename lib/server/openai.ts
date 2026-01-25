/**
 * OpenAI 服务统一模块
 *
 * 整合 Chat Completion、TTS 语音合成等 OpenAI API 调用，
 * 提供环境变量配置加载、客户端单例管理及上游请求封装。
 */

import OpenAI, { APIError } from "openai";
import { TRPCError } from "@trpc/server";

import type { VoiceOption, VoiceGender } from "@/types/ttsGenerate";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * OpenAI Chat API 环境变量配置结构。
 */
export type OpenAIConfig = {
    /** OpenAI API Key。 */
    apiKey: string;
    /** 可选的自定义 Base URL（代理场景）。 */
    baseUrl?: string;
    /** 故事生成专用模型。 */
    storyModel: string;
    /** Agent 流程专用模型。 */
    agentModel: string;
    /** 默认采样温度。 */
    temperature?: number;
    /** 默认最大输出 token 数。 */
    maxTokens?: number;
};

/**
 * TTS 语音合成配置结构。
 */
export type TtsConfig = {
    /** TTS 模型名称。 */
    model: string;
    /** 默认语音 ID。 */
    voiceId: string;
    /** 允许客户端选择的语音白名单。 */
    voicesList: VoiceOption[];
};

/**
 * 语音合成返回结构。
 */
export type SynthesizeSpeechResult = {
    /** 音频二进制数据。 */
    audioData: ArrayBuffer;
    /** 请求标识（保留字段）。 */
    requestId: string;
};

// ============================================================================
// 配置加载与客户端管理
// ============================================================================

/** 缓存的 OpenAI 配置。 */
let cachedOpenAIConfig: OpenAIConfig | null = null;

/** 缓存的 TTS 配置。 */
let cachedTtsConfig: TtsConfig | null = null;

/** 缓存的 OpenAI 客户端实例。 */
let cachedClient: OpenAI | null = null;

/**
 * 将环境变量字符串解析为数字，无效时返回 undefined。
 * @param raw 环境变量原始值。
 */
const parseEnvNumber = (raw: string | undefined): number | undefined => {
    if (!raw?.trim()) return undefined;
    const num = Number(raw);
    return Number.isNaN(num) ? undefined : num;
};

/**
 * 加载并缓存 OpenAI Chat API 配置。
 * @throws TRPCError 当必须的环境变量缺失时。
 */
export const getOpenAIConfig = (): OpenAIConfig => {
    if (cachedOpenAIConfig) return cachedOpenAIConfig;

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    const storyModel = process.env.OPENAI_MODEL_STORY?.trim();
    const agentModel = process.env.OPENAI_MODEL_AGENT?.trim();

    if (!apiKey) {
        throw new TRPCError({
            message: "缺少必要的环境变量: OPENAI_API_KEY",
            code: "INTERNAL_SERVER_ERROR",
        });
    }

    if (!storyModel) {
        throw new TRPCError({
            message: "缺少必要的环境变量: OPENAI_MODEL_STORY",
            code: "INTERNAL_SERVER_ERROR",
        });
    }

    if (!agentModel) {
        throw new TRPCError({
            message: "缺少必要的环境变量: OPENAI_MODEL_AGENT",
            code: "INTERNAL_SERVER_ERROR",
        });
    }

    const rawBaseUrl = process.env.OPENAI_BASE_URL?.trim();
    const baseUrl = rawBaseUrl ? rawBaseUrl.replace(/\/+$/, "") : undefined;

    const temperature = parseEnvNumber(process.env.OPENAI_TEMPERATURE);
    if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
        throw new TRPCError({
            message: "OPENAI_TEMPERATURE 必须在 0 到 2 之间",
            code: "INTERNAL_SERVER_ERROR",
        });
    }

    const maxTokens = parseEnvNumber(process.env.OPENAI_MAX_TOKENS);
    if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
        throw new TRPCError({
            message: "OPENAI_MAX_TOKENS 必须是正整数",
            code: "INTERNAL_SERVER_ERROR",
        });
    }

    cachedOpenAIConfig = { apiKey, baseUrl, storyModel, agentModel, temperature, maxTokens };
    return cachedOpenAIConfig;
};

/**
 * 解析环境变量中的语音白名单 JSON。
 * @param raw 环境变量原始字符串。
 */
const parseVoiceList = (raw: string | undefined): VoiceOption[] => {
    if (!raw?.trim()) return [];

    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];

        return parsed
            .map((item) => {
                if (!item || typeof item !== "object") return null;
                const { value, label, description, locale, gender } = item as Record<string, unknown>;
                if (typeof value !== "string" || !value.trim()) return null;

                const voice: VoiceOption = {
                    value,
                    label: typeof label === "string" && label.trim() ? label : value,
                };
                if (typeof description === "string" && description.trim()) voice.description = description;
                if (typeof locale === "string" && locale.trim()) voice.locale = locale;
                if (gender === "Female" || gender === "Male") voice.gender = gender as VoiceGender;

                return voice;
            })
            .filter((v): v is VoiceOption => v !== null);
    } catch {
        return [];
    }
};

/**
 * 加载并缓存 TTS 配置。
 * @throws TRPCError 当必须的环境变量缺失时。
 */
export const getTtsConfig = (): TtsConfig => {
    // 非生产环境不缓存，便于开发调试
    if (process.env.NODE_ENV !== "production" || !cachedTtsConfig) {
        const voicesList = parseVoiceList(process.env.OPENAI_TTS_VOICE_LIST);
        if (voicesList.length === 0) {
            throw new TRPCError({
                message: "缺少 OPENAI_TTS_VOICE_LIST 配置或内容为空",
                code: "INTERNAL_SERVER_ERROR",
            });
        }

        let voiceId = process.env.OPENAI_TTS_DEFAULT_VOICE?.trim();
        if (!voiceId || !voicesList.some((v) => v.value === voiceId)) {
            voiceId = voicesList[0].value;
        }

        const model = process.env.OPENAI_TTS_MODEL?.trim() || "tts-1";

        cachedTtsConfig = { model, voiceId, voicesList };
    }

    return cachedTtsConfig;
};

/**
 * 获取或创建 OpenAI 客户端单例。
 */
export const getOpenAIClient = (): OpenAI => {
    if (cachedClient) return cachedClient;

    const config = getOpenAIConfig();
    cachedClient = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
    });

    return cachedClient;
};

/**
 * 重置所有缓存（测试用）。
 */
export const resetCache = (): void => {
    cachedOpenAIConfig = null;
    cachedTtsConfig = null;
    cachedClient = null;
};

// ============================================================================
// TTS API
// ============================================================================

/** OpenAI TTS 支持的语音类型。 */
type OpenAIVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

/**
 * 使用 OpenAI TTS 执行文本转语音。
 * @param text 已经过业务裁剪的文本内容。
 * @param voiceId 白名单中的语音标识。
 * @returns 音频二进制数据。
 * @throws TRPCError 当请求失败时。
 */
export const synthesizeSpeech = async (
    text: string,
    voiceId: string,
    speed?: number,
): Promise<SynthesizeSpeechResult> => {
    const openAIConfig = getOpenAIConfig();
    const ttsConfig = getTtsConfig();

    const openai = new OpenAI({ apiKey: openAIConfig.apiKey });

    try {
        const response = await openai.audio.speech.create({
            model: ttsConfig.model,
            voice: voiceId as OpenAIVoice,
            input: text,
            speed,
            response_format: "mp3",
        });

        const audioBuffer = await response.arrayBuffer();

        if (!audioBuffer || audioBuffer.byteLength === 0) {
            throw new TRPCError({
                message: "OpenAI TTS 返回空音频",
                code: "BAD_GATEWAY",
            });
        }

        return { audioData: audioBuffer, requestId: "" };
    } catch (error) {
        if (error instanceof TRPCError) throw error;

        if (error instanceof OpenAI.APIError) {
            throw new TRPCError({
                message: `OpenAI TTS 请求失败: ${error.message}`,
                code: "BAD_GATEWAY",
                cause: error,
            });
        }

        throw new TRPCError({
            message: error instanceof Error ? error.message : "OpenAI TTS 调用失败",
            code: "BAD_GATEWAY",
            cause: error,
        });
    }
};
