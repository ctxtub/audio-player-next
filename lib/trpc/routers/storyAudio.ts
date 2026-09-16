/**
 *  Canonical Audio storyAudio Router（spec §20/§21/§26；）。
 *
 * - 输入严格 `{ workId, segmentIndex, sessionId }`（ensure）/ `{ workId }`（get）：
 *   不接 client 的 text/audio/profile/storageKey；Canonical input 全由 server 推导。
 * - 不切  正式 Work playback（ 才接 playback source；本项仅提供 ensure + 投影）。
 * - 错误以稳定 domain code 为 message（WORK_NOT_FOUND / WORK_UNAVAILABLE /
 *   INVALID_SEGMENT / AUDIO_SYNTHESIS_FAILED / AUDIO_STORAGE_FAILED /
 *   AUDIO_PROFILE_UNAVAILABLE），不暴露 Provider 原始报文。
 */

import { router, guardedProcedure } from '../init';
import {
  ensureStoryAudioSegmentInputSchema,
  ensureStoryAudioInputSchema,
  getPlaybackManifestInputSchema,
  saveStoryAudioProgressInputSchema,
} from '../schemas/storyAudio';
import {
  ensureStoryAudioSegmentForSubject,
  getPlaybackManifestForSubject,
} from '@/lib/server/storyAudio';
import {
  ensureStoryAudioAssetForSubject,
  getStoryAudioAssetProjectionForSubject,
  saveStoryAudioProgressForSubject,
} from '@/lib/server/storyAudioAsset';
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
          ...(result.asset ? { asset: result.asset } : {}),
        };
      }
      return {
        status: 'preparing' as const,
        retryAfterMs: 500 as const,
      };
    }),

  /**
   *  单轨 ensure（`{ workId, sessionId }`，无 segmentIndex）。
   * 整篇长文内部 chunk 合成后拼接为一个 canonical 对象。
   */
  ensure: guardedProcedure
    .input(ensureStoryAudioInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceProcedureRateLimit('storyAudio:ensure', ctx, {
        guestLimit: 30,
        authedLimit: 90,
      });
      const subject = resolveSubject(ctx);
      const result = await ensureStoryAudioAssetForSubject(subject, input);
      if (result.status === 'ready') {
        return {
          status: 'ready' as const,
          asset: result.asset,
          manifest: {
            status: 'ready' as const,
            segmentCount: 1 as const,
            readySegmentCount: 1 as const,
            totalDurationMs: result.asset.durationMs,
            totalByteLength: result.asset.byteLength,
          },
        };
      }
      return { status: 'preparing' as const, retryAfterMs: result.retryAfterMs };
    }),

  /**
   *  单轨投影（只读；无资产 → missing 空投影）。
   */
  getProjection: guardedProcedure
    .input(getPlaybackManifestInputSchema)
    .query(async ({ ctx, input }) => {
      const subject = resolveSubject(ctx);
      return getStoryAudioAssetProjectionForSubject(subject, input);
    }),

  /**
   *  秒级进度的写入口（服务端 clamp + 单调守卫 + 节流决策）。
   */
  saveProgress: guardedProcedure
    .input(saveStoryAudioProgressInputSchema)
    .mutation(async ({ ctx, input }) => {
      const subject = resolveSubject(ctx);
      const written = await saveStoryAudioProgressForSubject(subject, input);
      return { written };
    }),
});
