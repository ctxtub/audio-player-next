import { z } from 'zod';

import { STALE_SESSION } from '@/lib/playback/session';

/**
 *  reader 兼容：DB canonical 为 draft|work（§5.3 / §32 Step 2 已迁移），
 * 但读路径（DTO 输出 + input 兼容）仍接受四值 chat|generation|draft|work
 * 至少一个兼容周期（对齐 lib/playback/legacy.ts canonicalizeSourceKind）。
 * 未知 kind 由 server canonicalize 侧 fail-closed，不在此静默丢弃。
 */
export const playbackSourceTypeSchema = z.enum(['chat', 'generation', 'draft', 'work']);
export type PlaybackSourceType = z.infer<typeof playbackSourceTypeSchema>;

/**
 *  new writer canonical 锁定点（文档锚）：server 落库只写 draft|work。
 * 本 schema 仅作类型标注与未来收紧入口； 起旧 CRUD 已删，
 * canonical 收敛统一在 lib/server/playbackSession.ts + unifiedMigration.ts
 * 经 canonicalizeSourceKind 落库前完成（旧值透传兼容，新值原样，绝不存 chat|generation）。
 */
export const playbackCanonicalSourceTypeSchema = z.enum(['draft', 'work']);
export type PlaybackCanonicalSourceType = z.infer<typeof playbackCanonicalSourceTypeSchema>;

/**
 *  identity invariant 的 Session API 继承点（评审 锁死）：
 * Session API 的全部 sessionId 输入/输出必须为 UUID v4 + RFC variant
 *（ lib/playback/session.ts isValidPlaybackSessionId 契约），
 * nil UUID / v1 / v7 / 坏 variant 一律拒绝。
 * 集中单一定義：六处（AnchorDTO + begin/save/complete/clear/promote）
 * 统一复用本导出，禁止各自复制 regex / z.string().uuid()。
 */
export const playbackSessionIdSchema = z.uuidv4();
export type PlaybackSessionId = z.infer<typeof playbackSessionIdSchema>;

/* 旧 getProgress/saveProgress/clearProgress 专用 DTO/Input 已删除
 *（PlaybackProgressDTO / SavePlaybackProgressInput，无合法 consumer）。
 * DB canonical reader 兼容（chat|generation → draft|work）仍由
 * playbackSourceTypeSchema + lib/playback/legacy.ts 承载，不在此动。
 */

/* ------------------------------------------------------------------ */
/*  Playback Session API 契约冻结（spec §13 / §14）。               */
/*                                                                     */
/* - Source schema 严格按 §13.1（discriminatedUnion draft/work）。       */
/* - Anchor DTO 严格按 §13.2（14 字段；绝不含 storyText / audioUrl /     */
/*   currentTime / isPlaying，也不含旧 CRUD 形态的 sourceType /          */
/*   sourceId / isOneShot）。                                           */
/* - WorkProgress DTO 严格按 §13.3（ 只消费此 View DTO）。             */
/* - 上方 legacy 四值 parser（chat|generation|draft|work）原样保留作      */
/*   DB canonical reader 兼容；旧 getProgress/saveProgress/clearProgress */
/*   专用 DTO/Input 已在  删除（无合法 consumer）。                 */
/* - 本项只冻结 surface；完整业务实现按 + 推进。                    */
/* ------------------------------------------------------------------ */

/**
 * §13.1 播放来源 schema（spec 原文逐字对齐）。
 */
export const playbackSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('draft'),
    messageId: z.string().min(1).max(128),
  }),

  z.object({
    kind: z.literal('work'),
    workId: z.number().int().positive(),
  }),
]);

export type PlaybackSourceRef = z.infer<typeof playbackSourceSchema>;

/** §13.2 Anchor resting state：运行态 playing/synthesizing/error 不持久化。 */
export const playbackAnchorStateSchema = z.enum(['ready', 'ended']);
export type PlaybackAnchorState = z.infer<typeof playbackAnchorStateSchema>;

/**
 *  Sleep Timer 三态（spec §22）：off（不限制）| minutes（播放 N 分钟后暂停）|
 * story_end（当前 Work 完播停止）。story_end 仅 Work（§22.1/§24）。
 *（前置声明：AnchorDTO / begin / checkpoint / setSleepTimer 共用。）
 */
export const sleepTimerModeSchema = z.enum(['off', 'minutes', 'story_end']);
export type SleepTimerMode = z.infer<typeof sleepTimerModeSchema>;

/**
 * §13.2 PlaybackAnchorDTO（14 字段逐字对齐）。
 * 不包含：storyText / audioUrl / currentTime / isPlaying。
 */
export const playbackAnchorDTOSchema = z.object({
  sessionId: playbackSessionIdSchema,

  source: playbackSourceSchema,

  state: playbackAnchorStateSchema,

  title: z.string().min(1).max(100),

  contentHash: z.string().max(64),
  segmentationVersion: z.string().min(1).max(16),

  lastCompletedParagraphIndex: z.number().int().min(-1),
  nextParagraphIndex: z.number().int().min(0),
  totalParagraphs: z.number().int().min(1),

  voiceId: z.string().max(64),
  speed: z.number().min(0.25).max(4.0),

  remainingAllowedMs: z.number().int().min(0).nullable(),
  totalAllowedMs: z.number().int().min(0).nullable(),

  /**
   *  Sleep Timer 三态（spec §23  Anchor 增补）。
   * Legacy 行由 migration + getAnchor repair 按 remainingAllowedMs 回填
   *（非 null→minutes，null→off，§23.1），新写入一律显式。
   */
  sleepTimerMode: sleepTimerModeSchema,

  updatedAt: z.string().min(1), // ISO 8601 字符串
});

export type PlaybackAnchorDTO = z.infer<typeof playbackAnchorDTOSchema>;

/** §13.3 Work 播放状态（由 Progress 推导，绝不另存 status 列；见 lib/playback/progress.ts）。 */
export const workPlaybackStateSchema = z.enum(['not_started', 'in_progress', 'completed']);
export type WorkPlaybackState = z.infer<typeof workPlaybackStateSchema>;

/* ----------------  playback.setSleepTimer（spec §24 / §24.1） ---------------- */

/**
 * §13.3 WorkPlaybackProgressDTO（ 只消费此 View DTO）。
 */
export const workPlaybackProgressDTOSchema = z.object({
  workId: z.number().int().positive(),

  state: workPlaybackStateSchema,

  progress: z.number().min(0).max(1),

  lastCompletedParagraphIndex: z.number().int().min(-1),
  nextParagraphIndex: z.number().int().min(0),
  totalParagraphs: z.number().int().min(1),

  completedAt: z.string().nullable(),
  lastPlayedAt: z.string().nullable(),
});

export type WorkPlaybackProgressDTO = z.infer<typeof workPlaybackProgressDTOSchema>;

/* ---------------- §14 procedures 输入/输出（§15–§24 对齐） ---------------- */

/** §15 playback.getAnchor：无输入，输出 Anchor | null。 */
export const getPlaybackAnchorOutputSchema = playbackAnchorDTOSchema.nullable();
export type GetPlaybackAnchorOutput = z.infer<typeof getPlaybackAnchorOutputSchema>;

/**
 * §16 playback.beginSession 输入。
 * Work 侧 title/contentHash/voiceId 以服务端 StoryWork 为准（不信任客户端）；
 * Draft 侧 metadata 经 draftSnapshot 传入，且 replay-text-* 由服务端拒绝。
 */
export const beginPlaybackSessionInputSchema = z.object({
  sessionId: playbackSessionIdSchema,

  source: playbackSourceSchema,

  mode: z.enum(['resume', 'restart']),

  speed: z.number().min(0.25).max(4.0),

  remainingAllowedMs: z.number().int().min(0).nullable().optional(),
  totalAllowedMs: z.number().int().min(0).nullable().optional(),

  /**
   *  Sleep Timer 三态（spec §23；可选以兼容旧客户端 begin）。
   * 缺省时 server 按 Legacy 规则派生（remaining!=null→minutes，否则 off，§23.1）。
   */
  sleepTimerMode: sleepTimerModeSchema.optional(),

  // 仅 Draft begin 携带；Work begin 不得信任客户端快照。
  draftSnapshot: z
    .object({
      title: z.string().min(1).max(100),
      contentHash: z.string().min(1).max(64),
      totalParagraphs: z.number().int().min(1),
      voiceId: z.string().max(64),
    })
    .optional(),
});

export type BeginPlaybackSessionInput = z.infer<typeof beginPlaybackSessionInputSchema>;

/**
 * §17 playback.saveCheckpoint 输入。
 * 不再由客户端发送 source / title：当前 Source 由 Anchor.sessionId 决定。
 * 增补可选 sleepTimerMode（缺省保持 Anchor 现值，旧客户端不覆盖 Timer；
 * 到期/切换/off 等 Timer 变更必须显式携带，否则会被 dedupe 语义吞掉）。
 */
export const savePlaybackCheckpointInputSchema = z.object({
  sessionId: playbackSessionIdSchema,

  contentHash: z.string().min(1).max(64),
  segmentationVersion: z.string().min(1).max(16),

  lastCompletedParagraphIndex: z.number().int().min(-1),
  nextParagraphIndex: z.number().int().min(0),
  totalParagraphs: z.number().int().min(1),

  speed: z.number().min(0.25).max(4.0),

  remainingAllowedMs: z.number().int().min(0).nullable().optional(),
  totalAllowedMs: z.number().int().min(0).nullable().optional(),

  sleepTimerMode: sleepTimerModeSchema.optional(),
});

export type SavePlaybackCheckpointInput = z.infer<typeof savePlaybackCheckpointInputSchema>;

/**
 * §17.1 saveCheckpoint 输出：stale 直接返回 accepted:false（绝不覆盖）；
 * 同 Session 接受时回传最新 Anchor。
 */
export const savePlaybackCheckpointResultSchema = z.discriminatedUnion('accepted', [
  z.object({
    accepted: z.literal(true),
    anchor: playbackAnchorDTOSchema,
  }),
  z.object({
    accepted: z.literal(false),
    reason: z.literal(STALE_SESSION),
  }),
]);

export type SavePlaybackCheckpointResult = z.infer<typeof savePlaybackCheckpointResultSchema>;

/** §19 playback.completeSession 输入；输出为保留的 ended Anchor（无 Anchor 时为 null）。 */
export const completePlaybackSessionInputSchema = z.object({
  sessionId: playbackSessionIdSchema,
});

export type CompletePlaybackSessionInput = z.infer<typeof completePlaybackSessionInputSchema>;

/**
 * §21 playback.clearAnchor 输入：只能清理当前 session；
 * sessionId 不匹配时 no-op（cleared:false），避免旧异步 cleanup 误删新会话。
 */
export const clearPlaybackAnchorInputSchema = z.object({
  sessionId: playbackSessionIdSchema,
});

export type ClearPlaybackAnchorInput = z.infer<typeof clearPlaybackAnchorInputSchema>;

export const clearPlaybackAnchorOutputSchema = z.object({
  success: z.literal(true),
  cleared: z.boolean(),
});

export type ClearPlaybackAnchorOutput = z.infer<typeof clearPlaybackAnchorOutputSchema>;

/** §24 playback.promoteDraftToWork 输入。 */
export const promoteDraftPlaybackToWorkInputSchema = z.object({
  sessionId: playbackSessionIdSchema,
  workId: z.number().int().positive(),
});

export type PromoteDraftPlaybackToWorkInput = z.infer<typeof promoteDraftPlaybackToWorkInputSchema>;

/* ----------------  playback.setSleepTimer（spec §24 / §24.1） ---------------- */

/**
 * setSleepTimer 输入（spec §24）：
 * - off → remaining=null, total=null；
 * - minutes → minutes 必填（10–120），remaining=total=minutes×60_000；
 * - story_end → 仅 Work（Draft 由 server 拒绝），remaining=null, total=null。
 * minutes 缺省/非法由 zod 拒绝（fail-closed，不落库）。
 */
export const setSleepTimerInputSchema = z
  .object({
    sessionId: playbackSessionIdSchema,
    mode: sleepTimerModeSchema,
    minutes: z.number().int().min(10).max(120).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'minutes' && val.minutes === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SLEEP_TIMER_MINUTES_REQUIRED',
        path: ['minutes'],
      });
    }
  });

export type SetSleepTimerInput = z.infer<typeof setSleepTimerInputSchema>;

/**
 * setSleepTimer 输出：stale 直接返回 accepted:false（绝不覆盖新 Session timer，
 * §24.1 与 saveCheckpoint 同源）；同 Session 接受时回传最新 Anchor。
 */
export const setSleepTimerResultSchema = z.discriminatedUnion('accepted', [
  z.object({
    accepted: z.literal(true),
    anchor: playbackAnchorDTOSchema,
  }),
  z.object({
    accepted: z.literal(false),
    reason: z.literal(STALE_SESSION),
  }),
]);

export type SetSleepTimerResult = z.infer<typeof setSleepTimerResultSchema>;

/** §22 playback.getWorkProgressBatch 输入（1..50）与输出（每个 workId 都有结果，无 row 即 not_started）。 */
export const getWorkPlaybackProgressBatchInputSchema = z.object({
  workIds: z.array(z.number().int().positive()).min(1).max(50),
});

export type GetWorkPlaybackProgressBatchInput = z.infer<
  typeof getWorkPlaybackProgressBatchInputSchema
>;

export const getWorkPlaybackProgressBatchOutputSchema = z.object({
  items: z.array(workPlaybackProgressDTOSchema),
});

export type GetWorkPlaybackProgressBatchOutput = z.infer<
  typeof getWorkPlaybackProgressBatchOutputSchema
>;
