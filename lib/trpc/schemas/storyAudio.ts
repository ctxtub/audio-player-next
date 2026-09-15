/**
 * M8 Canonical Audio storyAudio Router Schemas（spec §20/§26；M8-03）。
 *
 * 输入严格三字段 `{ workId, segmentIndex, sessionId }`：
 * 不接 client 的 text/audio/profile/storageKey；Canonical input 全由 server 推导。
 * 输出 playbackUrl 仅为 `/api/audio/segments/<opaque-id>`，永不暴露 storageKey。
 */

import { z } from 'zod';
import { playbackSessionIdSchema } from './playback';

/** Canonical 音频状态四态（Manifest 与 Segment 共用；spec §12） */
export const storyAudioStatusSchema = z.enum([
  'missing',
  'preparing',
  'ready',
  'failed',
]);
export type StoryAudioStatus = z.infer<typeof storyAudioStatusSchema>;

/**
 * storyAudio.getPlaybackManifest 输入（spec §20.1）。
 */
export const getPlaybackManifestInputSchema = z
  .object({
    workId: z.number().int().positive('workId 必须为正整数'),
  })
  .strict();
export type GetPlaybackManifestInput = z.infer<
  typeof getPlaybackManifestInputSchema
>;

/**
 * storyAudio.ensureSegment 输入（spec §20.2/§26；严格三字段，strict 拒绝 text/audio/profile/storageKey）。
 */
export const ensureStoryAudioSegmentInputSchema = z
  .object({
    workId: z.number().int().positive('workId 必须为正整数'),
    segmentIndex: z.number().int().min(0, 'segmentIndex 必须为非负整数'),
    sessionId: playbackSessionIdSchema,
  })
  .strict();
export type EnsureStoryAudioSegmentInput = z.infer<
  typeof ensureStoryAudioSegmentInputSchema
>;

/** Manifest 投影段 DTO */
export const playbackManifestSegmentSchema = z.object({
  index: z.number().int().min(0),
  text: z.string(),
  textHash: z.string(),
  status: storyAudioStatusSchema,
  durationMs: z.number().int().positive().nullable(),
  playbackUrl: z.string().nullable(),
});
export type PlaybackManifestSegment = z.infer<
  typeof playbackManifestSegmentSchema
>;

/** getPlaybackManifest 输出 DTO（spec §20.1；totalByteLength 为可信 metadata 增补） */
export const playbackManifestSchema = z.object({
  workId: z.number().int().positive(),
  status: storyAudioStatusSchema,
  contentHash: z.string(),
  segmentationVersion: z.string(),
  voiceId: z.string(),
  segmentCount: z.number().int().min(0),
  readySegmentCount: z.number().int().min(0),
  totalDurationMs: z.number().int().positive().nullable(),
  totalByteLength: z.number().int().min(0).nullable(),
  segments: z.array(playbackManifestSegmentSchema),
});
export type PlaybackManifest = z.infer<typeof playbackManifestSchema>;

/** ensureSegment ready 输出（spec §20.2） */
export const ensureSegmentReadySchema = z.object({
  status: z.literal('ready'),
  segment: z.object({
    index: z.number().int().min(0),
    text: z.string(),
    durationMs: z.number().int().positive(),
    playbackUrl: z.string(),
  }),
  manifest: z.object({
    status: storyAudioStatusSchema,
    readySegmentCount: z.number().int().min(0),
    segmentCount: z.number().int().min(0),
    totalDurationMs: z.number().int().positive().nullable(),
  }),
});
export type EnsureSegmentReady = z.infer<typeof ensureSegmentReadySchema>;

/** ensureSegment preparing 输出（spec §15.3；retryAfterMs 恒 500） */
export const ensureSegmentPreparingSchema = z.object({
  status: z.literal('preparing'),
  retryAfterMs: z.literal(500),
});
export type EnsureSegmentPreparing = z.infer<
  typeof ensureSegmentPreparingSchema
>;

/** ensureSegment 输出联合 */
export const ensureSegmentOutputSchema = z.union([
  ensureSegmentReadySchema,
  ensureSegmentPreparingSchema,
]);
export type EnsureSegmentOutput = z.infer<typeof ensureSegmentOutputSchema>;
