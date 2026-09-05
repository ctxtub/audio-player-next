/**
 * 断点续播 Router
 *
 * 管理用户和具名访客的段落播放进度读取、保存与清除。
 */

import { router, guardedProcedure } from '../init';
import { savePlaybackProgressInputSchema } from '../schemas/playback';
import {
  getPlaybackProgressForSubject,
  savePlaybackProgressForSubject,
  clearPlaybackProgressForSubject,
} from '@/lib/server/playbackProgress';
import { resolveSubject } from '@/lib/server/subject';
import { enforceProcedureRateLimit } from '@/lib/server/rateLimit';

export const playbackRouter = router({
  /**
   * 读取当前主体（登录用户或具名访客）的段落播放进度。
   */
  getProgress: guardedProcedure.query(async ({ ctx }) => {
    const subject = resolveSubject(ctx);
    return getPlaybackProgressForSubject(subject);
  }),

  /**
   * 保存当前主体（登录用户或具名访客）的段落播放进度。
   */
  saveProgress: guardedProcedure
    .input(savePlaybackProgressInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceProcedureRateLimit('playback:saveProgress', ctx, {
        guestLimit: 60,
        authedLimit: 120,
      });
      const subject = resolveSubject(ctx);
      return savePlaybackProgressForSubject(subject, input);
    }),

  /**
   * 清除当前主体（登录用户或具名访客）的段落播放进度。
   */
  clearProgress: guardedProcedure.mutation(async ({ ctx }) => {
    const subject = resolveSubject(ctx);
    await clearPlaybackProgressForSubject(subject);
    return { success: true as const };
  }),
});
