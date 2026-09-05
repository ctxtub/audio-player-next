import { z } from 'zod';

export const playbackSourceTypeSchema = z.enum(['chat', 'generation']);
export type PlaybackSourceType = z.infer<typeof playbackSourceTypeSchema>;

export const playbackProgressDTOSchema = z.object({
  sourceType: playbackSourceTypeSchema,
  sourceId: z.string().min(1).max(128),
  sessionId: z.string().max(128).nullable().optional(),
  title: z.string().min(1).max(100),
  contentHash: z.string().default(''),
  segmentationVersion: z.string().default('v1'),
  lastCompletedParagraphIndex: z.number().int().min(-1),
  nextParagraphIndex: z.number().int().min(0),
  totalParagraphs: z.number().int().min(1),
  voiceId: z.string().max(64).default(''),
  speed: z.number().min(0.25).max(4.0).default(1.0),
  remainingAllowedMs: z.number().int().min(0).nullable().optional(),
  totalAllowedMs: z.number().int().min(0).nullable().optional(),
  isOneShot: z.boolean().default(false),
  updatedAt: z.string(), // ISO 8601 字符串
});

export type PlaybackProgressDTO = z.infer<typeof playbackProgressDTOSchema>;

export const savePlaybackProgressInputSchema = z.object({
  sourceType: playbackSourceTypeSchema,
  sourceId: z.string().min(1).max(128),
  sessionId: z.string().max(128).nullable().optional(),
  title: z.string().min(1).max(100),
  contentHash: z.string().min(1).max(64),
  segmentationVersion: z.string().max(16).default('v1'),
  lastCompletedParagraphIndex: z.number().int().min(-1),
  nextParagraphIndex: z.number().int().min(0),
  totalParagraphs: z.number().int().min(1),
  voiceId: z.string().max(64).optional(),
  speed: z.number().min(0.25).max(4.0).optional(),
  remainingAllowedMs: z.number().int().min(0).nullable().optional(),
  totalAllowedMs: z.number().int().min(0).nullable().optional(),
  isOneShot: z.boolean().optional(),
  /// 显式强制重置意图（用户主动点击“从头重播”时置为 true，绕过服务端单调递增检查）
  forceReset: z.boolean().optional(),
});

export type SavePlaybackProgressInput = z.infer<typeof savePlaybackProgressInputSchema>;
