/**
 * TTS 语音合成 Router
 *
 * 提供文本转语音接口，返回 base64 编码的音频数据。
 */

import { router, publicProcedure } from '../init';
import { ttsInputSchema } from '../schemas/tts';
import { synthesizeSpeech, getTtsConfig } from '@/lib/server/openai';

export const ttsRouter = router({
    /**
     * 语音合成接口。
     */
    synthesize: publicProcedure
        .input(ttsInputSchema)
        .mutation(async ({ input }) => {
            const config = getTtsConfig();

            // 验证 voiceId 是否在白名单中
            const voiceId = input.voiceId && config.voicesList.some((v) => v.value === input.voiceId)
                ? input.voiceId
                : config.voiceId;

            const result = await synthesizeSpeech(input.text, voiceId, input.speed);

            return {
                audioBase64: Buffer.from(result.audioData).toString('base64'),
                contentType: 'audio/mpeg',
            };
        }),
});
