import { z } from 'zod';

/**
 * M5-03 reader 兼容：DB canonical 为 draft|work（§5.3 / §32 Step 2 已迁移），
 * 但读路径（DTO 输出 + input 兼容）仍接受四值 chat|generation|draft|work
 * 至少一个兼容周期（对齐 lib/playback/legacy.ts canonicalizeSourceKind）。
 * 未知 kind 由 server canonicalize 侧 fail-closed，不在此静默丢弃。
 */
export const playbackSourceTypeSchema = z.enum(['chat', 'generation', 'draft', 'work']);
export type PlaybackSourceType = z.infer<typeof playbackSourceTypeSchema>;

/**
 * M5-03 new writer canonical 锁定点（文档锚）：server 落库只写 draft|work。
 * 本 schema 仅作类型标注与未来收紧入口；当前 input 仍接受四值以兼容旧客户端，
 * canonical 收敛统一在 lib/server/playbackProgress.ts + unifiedMigration.ts
 * 经 canonicalizeSourceKind 落库前完成（旧值透传兼容，新值原样，绝不存 chat|generation）。
 */
export const playbackCanonicalSourceTypeSchema = z.enum(['draft', 'work']);
export type PlaybackCanonicalSourceType = z.infer<typeof playbackCanonicalSourceTypeSchema>;

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
