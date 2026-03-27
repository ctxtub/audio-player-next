/**
 * 用户设置 Router
 *
 * 提供用户个性化设置的读写接口。登录用户通过 DB 持久化，未登录用户返回 null。
 */

import { router, publicProcedure, authedProcedure } from '../init';
import { saveSettingsSchema } from '../schemas/settings';
import { prisma } from '@/lib/db';

export const settingsRouter = router({
  /**
   * 获取当前用户的个性化设置，未登录时返回 null。
   */
  get: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.session) {
      return null;
    }

    const settings = await prisma.userSettings.findUnique({
      where: { userId: ctx.session.userId },
    });

    if (!settings) {
      return null;
    }

    return {
      playDuration: settings.playDuration,
      voiceId: settings.voiceId,
      speed: settings.speed,
      floatingPlayerEnabled: settings.floatingPlayerEnabled,
      themeMode: settings.themeMode as 'light' | 'dark' | 'system',
    };
  }),

  /**
   * 保存用户个性化设置（增量更新），需登录态。
   */
  save: authedProcedure
    .input(saveSettingsSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.userId;

      const settings = await prisma.userSettings.upsert({
        where: { userId },
        create: {
          userId,
          ...input,
        },
        update: input,
      });

      return {
        playDuration: settings.playDuration,
        voiceId: settings.voiceId,
        speed: settings.speed,
        floatingPlayerEnabled: settings.floatingPlayerEnabled,
        themeMode: settings.themeMode as 'light' | 'dark' | 'system',
      };
    }),
});
