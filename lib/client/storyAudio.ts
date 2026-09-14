/**
 * M8 Canonical Audio Client Facade（M8-03）。
 *
 * 仅透出 storyAudio 两个 canonical procedures 的类型安全门面：
 * - getPlaybackManifest({ workId })：只读投影；
 * - ensureSegment({ workId, segmentIndex, sessionId })：lazy 按需就绪。
 *
 * 约束：客户端只发 workId/segmentIndex/sessionId，永不构造、不持久化
 * text/audio/profile/storageKey；storageKey 不作为 DTO/API 字段暴露。
 */

import { trpc } from '@/lib/trpc/client';

export type {
  EnsureStoryAudioSegmentInput,
  GetPlaybackManifestInput,
  PlaybackManifest,
  PlaybackManifestSegment,
  StoryAudioStatus,
  EnsureSegmentOutput,
  EnsureSegmentReady,
  EnsureSegmentPreparing,
} from '@/lib/trpc/schemas/storyAudio';

/**
 * 读取播放用 Manifest 投影（纯结构体入参）。
 */
export const getPlaybackManifest = async (input: {
  workId: number;
}): Promise<
  import('@/lib/trpc/schemas/storyAudio').PlaybackManifest
> => {
  return trpc.storyAudio.getPlaybackManifest.query(input);
};

/**
 * 按需确保单 Segment canonical 就绪（纯结构体入参）。
 */
export const ensureSegment = async (input: {
  workId: number;
  segmentIndex: number;
  sessionId: string;
}): Promise<import('@/lib/trpc/schemas/storyAudio').EnsureSegmentOutput> => {
  return trpc.storyAudio.ensureSegment.mutate(input);
};

export const storyAudioClient = {
  getPlaybackManifest,
  ensureSegment,
};
