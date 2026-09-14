/**
 * 断点续播 Router
 *
 * M5-04：Playback router 从 CRUD Progress 升级成 Session API（spec §13/§14）。
 * 7 个正式 procedures（getAnchor / beginSession / saveCheckpoint /
 * completeSession / clearAnchor / promoteDraftToWork / getWorkProgressBatch），
 * 经 lib/server/playbackSession.ts facade 对外提供。
 * M9-03：旧 getProgress / saveProgress / clearProgress compatibility procedures
 * 已删除（无合法 consumer，经全仓 audit 确认），行为由 Session API 承载。
 */

import { router, guardedProcedure } from '../init';
import {
  beginPlaybackSessionInputSchema,
  clearPlaybackAnchorInputSchema,
  completePlaybackSessionInputSchema,
  getWorkPlaybackProgressBatchInputSchema,
  promoteDraftPlaybackToWorkInputSchema,
  savePlaybackCheckpointInputSchema,
  setSleepTimerInputSchema,
} from '../schemas/playback';
import {
  beginPlaybackSessionForSubject,
  clearPlaybackAnchorForSubject,
  completePlaybackSessionForSubject,
  getPlaybackAnchorForSubject,
  getWorkPlaybackProgressBatchForSubject,
  promoteDraftPlaybackToWorkForSubject,
  savePlaybackCheckpointForSubject,
  setSleepTimerForSubject,
} from '@/lib/server/playbackSession';
import { resolveSubject } from '@/lib/server/subject';
import { enforceProcedureRateLimit } from '@/lib/server/rateLimit';

export const playbackRouter = router({
  /**
   * §15 playback.getAnchor：读取当前 Subject 唯一 Anchor（无则 null）。
   */
  getAnchor: guardedProcedure.query(async ({ ctx }) => {
    const subject = resolveSubject(ctx);
    return getPlaybackAnchorForSubject(subject);
  }),

  /**
   * §16 playback.beginSession：开始新 Work / 从头播放 / 切换 Source 时创建新会话。
   */
  beginSession: guardedProcedure
    .input(beginPlaybackSessionInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceProcedureRateLimit('playback:beginSession', ctx, {
        guestLimit: 60,
        authedLimit: 120,
      });
      const subject = resolveSubject(ctx);
      return beginPlaybackSessionForSubject(subject, input);
    }),

  /**
   * §17 playback.saveCheckpoint：同一 Session 内的段落进度上报
   *（含 STALE_SESSION 与单调守卫）。
   */
  saveCheckpoint: guardedProcedure
    .input(savePlaybackCheckpointInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceProcedureRateLimit('playback:saveCheckpoint', ctx, {
        guestLimit: 60,
        authedLimit: 120,
      });
      const subject = resolveSubject(ctx);
      return savePlaybackCheckpointForSubject(subject, input);
    }),

  /**
   * §19 playback.completeSession：完播收尾（保留 ended Anchor）。
   */
  completeSession: guardedProcedure
    .input(completePlaybackSessionInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceProcedureRateLimit('playback:completeSession', ctx, {
        guestLimit: 60,
        authedLimit: 120,
      });
      const subject = resolveSubject(ctx);
      return completePlaybackSessionForSubject(subject, input);
    }),

  /**
   * §21 playback.clearAnchor：只能清理当前 session（不匹配则 no-op）。
   */
  clearAnchor: guardedProcedure
    .input(clearPlaybackAnchorInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceProcedureRateLimit('playback:clearAnchor', ctx, {
        guestLimit: 60,
        authedLimit: 120,
      });
      const subject = resolveSubject(ctx);
      return clearPlaybackAnchorForSubject(subject, input);
    }),

  /**
   * §24 playback.promoteDraftToWork：Draft→Work 提升。
   */
  promoteDraftToWork: guardedProcedure
    .input(promoteDraftPlaybackToWorkInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceProcedureRateLimit('playback:promoteDraftToWork', ctx, {
        guestLimit: 60,
        authedLimit: 120,
      });
      const subject = resolveSubject(ctx);
      return promoteDraftPlaybackToWorkForSubject(subject, input);
    }),

  /**
   * M7-03 playback.setSleepTimer：当前 Session Timer 设置（spec §24 / §24.1）。
   * stale（sessionId 不匹配当前 Anchor）→ {accepted:false, reason:'STALE_SESSION'}；
   * Draft story_end → BAD_REQUEST。
   */
  setSleepTimer: guardedProcedure
    .input(setSleepTimerInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceProcedureRateLimit('playback:setSleepTimer', ctx, {
        guestLimit: 60,
        authedLimit: 120,
      });
      const subject = resolveSubject(ctx);
      return setSleepTimerForSubject(subject, input);
    }),

  /**
   * §22 playback.getWorkProgressBatch：M3 消费的 Work 进度批量视图。
   */
  getWorkProgressBatch: guardedProcedure
    .input(getWorkPlaybackProgressBatchInputSchema)
    .query(async ({ ctx, input }) => {
      const subject = resolveSubject(ctx);
      return getWorkPlaybackProgressBatchForSubject(subject, input);
    }),
});
