/**
 * 断点续播 Router
 *
 * 管理用户和具名访客的段落播放进度读取、保存与清除。
 *
 * M5-04：Playback router 从 CRUD Progress 升级成 Session API（spec §13/§14）。
 * 新增 7 个正式 procedures（getAnchor / beginSession / saveCheckpoint /
 * completeSession / clearAnchor / promoteDraftToWork / getWorkProgressBatch），
 * 经 lib/server/playbackSession.ts facade 对外提供（完整业务实现按 M5-05+ 推进，
 * 本项 facade 为 fail-closed 占位，不写坏数据）。
 * 旧 getProgress / saveProgress / clearProgress 作为 compatibility procedures
 * 暂时保留（M9 删除），行为不动。
 */

import { router, guardedProcedure } from '../init';
import {
  beginPlaybackSessionInputSchema,
  clearPlaybackAnchorInputSchema,
  completePlaybackSessionInputSchema,
  getWorkPlaybackProgressBatchInputSchema,
  promoteDraftPlaybackToWorkInputSchema,
  savePlaybackCheckpointInputSchema,
  savePlaybackProgressInputSchema,
} from '../schemas/playback';
import {
  getPlaybackProgressForSubject,
  savePlaybackProgressForSubject,
  clearPlaybackProgressForSubject,
} from '@/lib/server/playbackProgress';
import {
  beginPlaybackSessionForSubject,
  clearPlaybackAnchorForSubject,
  completePlaybackSessionForSubject,
  getPlaybackAnchorForSubject,
  getWorkPlaybackProgressBatchForSubject,
  promoteDraftPlaybackToWorkForSubject,
  savePlaybackCheckpointForSubject,
} from '@/lib/server/playbackSession';
import { resolveSubject } from '@/lib/server/subject';
import { enforceProcedureRateLimit } from '@/lib/server/rateLimit';

export const playbackRouter = router({
  /**
   * 读取当前主体（登录用户或具名访客）的段落播放进度。
   *
   * @deprecated compatibility procedure（M9 删除）；新客户端请用 playback.getAnchor。
   */
  getProgress: guardedProcedure.query(async ({ ctx }) => {
    const subject = resolveSubject(ctx);
    return getPlaybackProgressForSubject(subject);
  }),

  /**
   * 保存当前主体（登录用户或具名访客）的段落播放进度。
   *
   * @deprecated compatibility procedure（M9 删除）；新客户端请用 playback.saveCheckpoint。
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
   *
   * @deprecated compatibility procedure（M9 删除）；新客户端请用 playback.clearAnchor。
   */
  clearProgress: guardedProcedure.mutation(async ({ ctx }) => {
    const subject = resolveSubject(ctx);
    await clearPlaybackProgressForSubject(subject);
    return { success: true as const };
  }),

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
   * §22 playback.getWorkProgressBatch：M3 消费的 Work 进度批量视图。
   */
  getWorkProgressBatch: guardedProcedure
    .input(getWorkPlaybackProgressBatchInputSchema)
    .query(async ({ ctx, input }) => {
      const subject = resolveSubject(ctx);
      return getWorkPlaybackProgressBatchForSubject(subject, input);
    }),
});
