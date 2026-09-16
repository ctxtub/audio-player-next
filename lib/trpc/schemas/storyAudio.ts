/**
 *  Canonical Audio storyAudio Router Schemas（spec §20/§26；）。
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

/** 单轨资产投影 DTO（一个授权 Asset / 总时长 / 时间轴）。 */
export const storyAudioAssetSchema = z.object({
  assetId: z.string(),
  workId: z.number().int().positive(),
  status: z.literal('ready'),
  version: z.number().int().min(1),
  contentHash: z.string(),
  voiceId: z.string(),
  ttsProfileHash: z.string(),
  synthesisVersion: z.string(),
  audioFormat: z.string(),
  chunkCount: z.number().int().min(1),
  durationMs: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  checksum: z.string(),
  contentType: z.string(),
  playbackUrl: z.string(),
  positionMs: z.number().int().min(0),
  readyAt: z.string(),
});
export type StoryAudioAsset = z.infer<typeof storyAudioAssetSchema>;

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
  /**  单轨投影（开关开启时非 null；与空 segments 互斥，保证只暴露一条时间轴）。 */
  singleTrack: storyAudioAssetSchema.nullable().optional(),
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
  /**  单轨：开关开启时附单资产投影（`segment` 恒为唯一 asset）。 */
  asset: storyAudioAssetSchema.optional(),
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

// ---------------------------------------------------------------------------
//   单轨资产输入/输出（DTO 定义见文件顶部以支持前向引用）
// ---------------------------------------------------------------------------

/** storyAudio.ensure 输入（无 segmentIndex；严格 `{workId, sessionId}`）。 */
export const ensureStoryAudioInputSchema = z
  .object({
    workId: z.number().int().positive('workId 必须为正整数'),
    sessionId: playbackSessionIdSchema,
  })
  .strict();
export type EnsureStoryAudioInput = z.infer<typeof ensureStoryAudioInputSchema>;

/** 单轨 ensure 输出（ready 携带单资产；preparing 携带 retryAfterMs）。 */
export const ensureStoryAudioReadySchema = z.object({
  status: z.literal('ready'),
  asset: storyAudioAssetSchema,
  manifest: z.object({
    status: storyAudioStatusSchema,
    segmentCount: z.literal(1),
    readySegmentCount: z.literal(1),
    totalDurationMs: z.number().int().positive(),
    totalByteLength: z.number().int().positive(),
  }),
});
export const ensureStoryAudioPreparingSchema = z.object({
  status: z.literal('preparing'),
  retryAfterMs: z.number().int().positive(),
});
export const ensureStoryAudioOutputSchema = z.union([
  ensureStoryAudioReadySchema,
  ensureStoryAudioPreparingSchema,
]);
export type EnsureStoryAudioOutput = z.infer<typeof ensureStoryAudioOutputSchema>;

/** storyAudio.getProjection 输出（无资产 → missing 空投影）。 */
export const storyAudioAssetProjectionSchema = z.object({
  workId: z.number().int().positive(),
  status: storyAudioStatusSchema,
  assetId: z.string().nullable(),
  version: z.number().int().min(1),
  contentHash: z.string(),
  voiceId: z.string(),
  ttsProfileHash: z.string(),
  synthesisVersion: z.string(),
  audioFormat: z.string(),
  chunkCount: z.number().int().min(0),
  durationMs: z.number().int().positive().nullable(),
  byteLength: z.number().int().min(0).nullable(),
  checksum: z.string().nullable(),
  positionMs: z.number().int().min(0),
  completedAt: z.string().nullable(),
  playbackUrl: z.string().nullable(),
  readyAt: z.string().nullable(),
});
export type StoryAudioAssetProjection = z.infer<typeof storyAudioAssetProjectionSchema>;

/** storyAudio.saveProgress 输入（positionMs 节流 + 服务端 clamp/单调守卫）。 */
export const saveStoryAudioProgressInputSchema = z
  .object({
    workId: z.number().int().positive('workId 必须为正整数'),
    sessionId: playbackSessionIdSchema,
    positionMs: z.number().int().min(0),
    durationMs: z.number().int().min(0).nullable().optional(),
    force: z.boolean().optional(),
  })
  .strict();
export type SaveStoryAudioProgressInput = z.infer<
  typeof saveStoryAudioProgressInputSchema
>;
