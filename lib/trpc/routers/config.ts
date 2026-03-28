/**
 * 配置 Router
 *
 * 返回应用运行时配置。
 */

import { router, publicProcedure } from '../init';
import { getTtsConfig } from '@/lib/server/openai';

/**
 * 默认播放时长（分钟）。
 */
const DEFAULT_PLAY_DURATION = 30;

export const configRouter = router({
    /**
     * 获取应用配置。
     */
    get: publicProcedure.query(() => {
        const { voicesList, voiceId } = getTtsConfig();

        return {
            voicesList,
            voiceId,
            playDuration: DEFAULT_PLAY_DURATION,
            floatingPlayerEnabled: true,
        };
    }),
});
