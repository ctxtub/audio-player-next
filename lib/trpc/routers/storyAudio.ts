/**
 * M8 Canonical Audio storyAudio Router（spec §20/§21/§26；M8-03）。
 *
 * - 输入严格 `{ workId, segmentIndex, sessionId }`（ensure）/ `{ workId }`（get）：
 *   不接 client 的 text/audio/profile/storageKey；Canonical input 全由 server 推导。
 * - 不切 M5 正式 Work playback（M8-04 才接 playback source；本项仅提供 ensure + 投影）。
 * - 错误以稳定 domain code 为 message（WORK_NOT_FOUND / WORK_UNAVAILABLE /
 *   INVALID_SEGMENT / AUDIO_SYNTHESIS_FAILED / AUDIO_STORAGE_FAILED /
 *   AUDIO_PROFILE_UNAVAILABLE），不暴露 Provider 原始报文。
 */

import { router, guardedProcedure } from '../init';
import {
  ensureStoryAudioSegmentInputSchema,
  getPlaybackManifestInputSchema,
} from '../schemas/storyAudio';
import {
  ensureStoryAudioSegmentForSubject,
  getPlaybackManifestForSubject,
} from '@/lib/server/storyAudio';
import { resolveSubject } from '@/lib/server/subject';
import { enforceProcedureRateLimit } from '@/lib/server/rateLimit';

export const storyAudioRouter = router({
  /**
   * 读取播放用 Manifest 投影（只读；无 Manifest → missing 空投影）。
   */
  getPlaybackManifest: guardedProcedure
    .input(getPlaybackManifestInputSchema)
    .query(async ({ ctx, input }) => {
      const subject = resolveSubject(ctx);
      return getPlaybackManifestForSubject(subject, input);
    }),

  /**
   * 按需确保单 Segment canonical 就绪（lazy per-segment materialization）。
   *
   * - ready → 直接返回（含 playbackUrl）；
   * - 有效 lease → `{ status:'preparing', retryAfterMs: 500 }`；
   * - missing/failed/过期 lease → 原子 claim 后合成（同一 storageKey 覆盖写）。
   */
  ensureSegment: guardedProcedure
    .input(ensureStoryAudioSegmentInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceProcedureRateLimit('storyAudio:ensureSegment', ctx, {
        guestLimit: 30,
        authedLimit: 90,
      });
      const subject = resolveSubject(ctx);
      const result = await ensureStoryAudioSegmentForSubject(subject, input);
      if (result.status === 'ready') {
        return {
          status: 'ready' as const,
          segment: {
            index: result.segment.index,
            text: result.segment.text,
            durationMs: result.segment.durationMs,
            playbackUrl: result.segment.playbackUrl,
          },
          manifest: {
            status: result.manifest.status as
              | 'missing'
              | 'preparing'
              | 'ready'
              | 'failed',
            readySegmentCount: result.manifest.readySegmentCount,
            segmentCount: result.manifest.segmentCount,
            totalDurationMs: result.manifest.totalDurationMs,
          },
        };
      }
      return {
        status: 'preparing' as const,
        retryAfterMs: 500 as const,
      };
    }),
});
