/**
 * TTS 语音合成相关 Zod Schemas
 */

import { z } from 'zod';

/**
 * 最大文本长度限制。
 */
const MAX_TEXT_LENGTH = 2000;

/**
 * TTS 请求 Schema。
 */
export const ttsInputSchema = z.object({
    text: z
        .string()
        .min(1, 'text 不能为空')
        .max(MAX_TEXT_LENGTH, `文本长度不能超过 ${MAX_TEXT_LENGTH} 字符`),
    voiceId: z.string().min(1).optional(),
    speed: z.number().min(0.25).max(4.0).optional(),
});

/**
 * TTS 请求类型。
 */
export type TtsInput = z.infer<typeof ttsInputSchema>;

/**
 * TTS 响应 Schema。
 */
export const ttsOutputSchema = z.object({
    audioBase64: z.string(),
    contentType: z.string(),
});

export type TtsOutput = z.infer<typeof ttsOutputSchema>;
