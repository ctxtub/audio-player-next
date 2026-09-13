/**
 * M5-07 Playback Session 服务端 Facade（spec §14 / §15 / §16 / §17 / §18 / §19 /
 * §21 / §22 / §24 / §30 / §33 / §36）。
 *
 * 本文件是 Session API 在 server 侧的正式暴露层，逐步替代
 * lib/server/playbackProgress.ts（旧 CRUD Progress 实现保留兼容，不删除）。
 *
 * M5-07 定调：getAnchor / beginSession（M5-05）与 saveCheckpoint（M5-06）语义冻结
 * 不动；completeSession / clearAnchor / promoteDraftToWork / getWorkProgressBatch
 * 落真逻辑（§19 / §21 / §22 / §24 / §30）。
 *
 * M5-08 §29 生命周期边界（CAS 内核不动，只收 trash/dangling 外环）：
 * getAnchor 对不可解析 work Anchor（trash/missing/foreign/已删）删行 + null；
 * saveCheckpoint / completeSession 对 trash 自有 Work 仍走同一 CAS 面（不复活）；
 * beginSession trash 仍经 M2 统一 NOT_FOUND（即 WORK_UNAVAILABLE 的 wire 形）；
 * 另提供 invalidatePlaybackReferencesForWork 供 permanent delete 后清理（不自动接入）。
 *
 * - getAnchor（§15 / §33）：读取当前 Subject 唯一 Anchor；legacy
 *   chat→draft / generation→work 归一；sessionId null/invalid UUID 则生成
 *   UUID 写回；新写入全部要求 UUID（M5-01 isValidPlaybackSessionId）。
 * - beginSession（§16 / §36）：Work metadata 一律经 M2
 *   getStoryWorkForSubject（subject, workId），不得重算 title、不得重定义
 *   contentHash、不得直查 GenerationHistory；paragraph count 经现有
 *   normalizeStoryText / segmentStoryText 计算；不信任客户端 Story metadata
 *  （draftSnapshot 仅限 Draft，Work 携带即 BAD_REQUEST）；resume 做
 *   hash/version 校验（不一致→reset 0 + 更新 Progress hash/version）；
 *   restart 位置→0、保留 completedAt、创建新 sessionId（input.sessionId）；
 *   Draft 验证 ChatMessage.messageId 属于当前 Subject，server 拒绝
 *   replay-text-* 瞬态 ID 持久化（§16.4 server contract）。
 * - saveCheckpoint（§17 / §17.1 / §17.2 / §18）：input 严格 8 字段
 *   sessionId/contentHash/segmentationVersion/lastCompletedParagraphIndex/
 *   nextParagraphIndex/totalParagraphs/speed/remainingAllowedMs/totalAllowedMs，
 *   不收 source/title（Source 由 Anchor.sessionId 决定）；Stale Guard
 *   anchor.sessionId !== input.sessionId → {accepted:false,reason:'STALE_SESSION'}
 *   绝不覆盖（含无 Anchor/dangling/并发删除）；Monotonic Guard 同 Session
 *   incoming.next < existing.next → 不回退（保持旧 server 保护性质，原样返回
 *   现有 Anchor，accepted:true，新 input 根本无此字段，
 *   透传亦忽略）；预读仅 fast-path，权威判定下沉 conditional write CAS
 *   （WHERE sessionId + next lte，以 DB 当前值为准，消除 TOCTOU）；
 *   M5-07 FIXUP 再绑 content identity（WHERE contentHash +
 *   segmentationVersion，同一原子子句）：seamless promotion 是唯一 source
 *   identity 改变而 sessionId 不变的 transition，promotion 前发出的旧包晚到时
 *   必须因 identity 失配 CAS 失败而 no-op，绝不把 Anchor 拉回旧 hash/next
 *   （§24.1）；hash/version 完全一致的 seamless 老包不受影响，继续被吸收；
 *   Work 时同一事务内先 CAS Anchor、成功才 UPSERT Progress
 *   （prisma.$transaction，用户/访客对称，completedAt 保留，lastPlayedAt=now）；
 *   Draft 按 Anchor identity 只 conditional 更新 Anchor，不做 Work progress。
 * - completeSession（§19 / §30 / §41）：session 匹配才收尾；Work 时同一事务内
 *   CAS Anchor（next=total/last=total-1/state=ended）+ UPSERT Progress
 *   （next=total/completedAt=首完时间/lastPlayedAt=now，重复 complete 保留首完，
 *   不删 completion history）；Draft 仅 CAS 置 Anchor ended，不建 Work progress。
 * - clearAnchor（§21）：deleteMany WHERE sessionId（CAS 原子，不匹配 no-op
 *   cleared:false）；不校验 Work 存在（trash/missing 照清），User/Guest 对称。
 * - promoteDraftToWork（§24 / §24.1 / §45）：三校验 fail-closed（session 匹配 +
 *   当前 source=draft + StoryWork.sourceMessageId==draft.messageId）；成功则
 *   Anchor source→work/title/hash/voiceId 取 Work（sessionId 不变，total 重算），
 *   hash 一致沿用 draft 段落（钳制），不一致 reset 0；同一事务内 UPSERT Work
 *   progress（completedAt 保留，lastPlayedAt=now）。
 * - getWorkProgressBatch（§22 / §40）：只读批量视图，每个 workId 必有结果
 *   （无 row/非自有 → not_started 默认行）；state/progress 经
 *   lib/playback/progress.ts 推导；绝不写库、不覆盖其它 work。
 *
 * Router（lib/trpc/routers/playback.ts）只经由本 facade 对外提供
 * 7 个新 procedures，Subject 鉴权与 rate limit 仍由 router 层复用。
 */

import { prisma } from '@/lib/db';
import { TRPCError } from '@/lib/trpc/init';
import type { Subject } from '@/lib/server/subject';
import { getStoryWorkForSubject, isStoryWorkTrashedForSubject } from '@/lib/server/storyWork';
import {
  STALE_SESSION,
  createPlaybackSessionId,
  isValidPlaybackSessionId,
} from '@/lib/playback/session';
import {
  REPLAY_TEXT_PREFIX,
  equalPlaybackSource,
  isValidDraftMessageId,
  type PlaybackSourceRef,
} from '@/lib/playback/source';
import {
  canonicalizeSourceKind,
  parseLegacyWorkId,
  tryParseLegacyPlaybackSource,
} from '@/lib/playback/legacy';
import {
  computeWorkProgressRatio,
  deriveWorkPlaybackState,
  resolvePromotedNextParagraphIndex,
  shouldPreserveDraftBreakpointOnPromote,
} from '@/lib/playback/progress';
import {
  SEGMENTATION_VERSION,
  normalizeStoryText,
  segmentStoryText,
} from '@/utils/segmentation';
import type {
  BeginPlaybackSessionInput,
  ClearPlaybackAnchorOutput,
  CompletePlaybackSessionInput,
  ClearPlaybackAnchorInput,
  GetPlaybackAnchorOutput,
  GetWorkPlaybackProgressBatchInput,
  GetWorkPlaybackProgressBatchOutput,
  PlaybackAnchorDTO,
  PromoteDraftPlaybackToWorkInput,
  SavePlaybackCheckpointInput,
  SavePlaybackCheckpointResult,
} from '@/lib/trpc/schemas/playback';

/**
 * M5-07 已落地全部 7 procedures：本占位不再使用（保留注释说明分态历史）。
 * 所有未知/非法输入一律在各 procedure 内 fail-closed（BAD_REQUEST / NOT_FOUND /
 * STALE_SESSION / no-op），绝不脏写。
 */

type AnchorRow = {
  sourceKind: string;
  sourceId: string;
  sessionId: string | null;
  anchorState: string;
  title: string;
  contentHash: string;
  segmentationVersion: string;
  lastCompletedParagraphIndex: number;
  nextParagraphIndex: number;
  totalParagraphs: number;
  voiceId: string;
  speed: number;
  remainingAllowedMs: number | null;
  totalAllowedMs: number | null;
  updatedAt: Date;
};

/**
 * Anchor 行 → PlaybackAnchorDTO（fail-closed 纯映射，不触库）。
 * kind 未知 / sourceId 非法（含 replay-text-*）/ sessionId 非法 /
 * state 非法回退外的一律返回 null（dangling，不抛错，由调用方按 null 处理）。
 */
const toAnchorDto = (row: AnchorRow): PlaybackAnchorDTO | null => {
  let canonicalKind: 'draft' | 'work';
  try {
    canonicalKind = canonicalizeSourceKind(row.sourceKind);
  } catch {
    return null;
  }
  if (!isValidPlaybackSessionId(row.sessionId)) return null;
  let source: PlaybackAnchorDTO['source'];
  if (canonicalKind === 'draft') {
    if (!isValidDraftMessageId(row.sourceId)) return null;
    source = { kind: 'draft', messageId: row.sourceId };
  } else {
    let workId: number;
    try {
      workId = parseLegacyWorkId(row.sourceId);
    } catch {
      return null;
    }
    source = { kind: 'work', workId };
  }
  const state = row.anchorState === 'ended' ? 'ended' : 'ready';
  if (typeof row.title !== 'string' || row.title.length < 1 || row.title.length > 100) {
    return null;
  }
  if (typeof row.contentHash !== 'string' || row.contentHash.length > 64) return null;
  if (
    typeof row.segmentationVersion !== 'string' ||
    row.segmentationVersion.length < 1 ||
    row.segmentationVersion.length > 16
  ) {
    return null;
  }
  if (!Number.isInteger(row.lastCompletedParagraphIndex) || row.lastCompletedParagraphIndex < -1) {
    return null;
  }
  if (!Number.isInteger(row.nextParagraphIndex) || row.nextParagraphIndex < 0) return null;
  if (!Number.isInteger(row.totalParagraphs) || row.totalParagraphs < 1) return null;
  if (typeof row.voiceId !== 'string' || row.voiceId.length > 64) return null;
  if (typeof row.speed !== 'number' || !(row.speed >= 0.25 && row.speed <= 4.0)) return null;
  return {
    sessionId: row.sessionId,
    source,
    state,
    title: row.title,
    contentHash: row.contentHash,
    segmentationVersion: row.segmentationVersion,
    lastCompletedParagraphIndex: row.lastCompletedParagraphIndex,
    nextParagraphIndex: row.nextParagraphIndex,
    totalParagraphs: row.totalParagraphs,
    voiceId: row.voiceId,
    speed: row.speed,
    remainingAllowedMs: row.remainingAllowedMs ?? null,
    totalAllowedMs: row.totalAllowedMs ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
};

/**
 * §4 / §30 begin 新会话 identity 守卫（纯 helper，不触库）。
 *
 * 有 current Anchor（currentSessionId 合法）时最终规则：
 * - same source + resume → requestedSessionId === currentSessionId（必须保持）
 * - same source + restart → requestedSessionId !== currentSessionId（必须新）
 * - different source → requestedSessionId !== currentSessionId（必须新，mode 无关）
 *
 * 无 current Anchor（null 行）或 currentSessionId 为空/非法时直接放行
 * （首次 begin 不挡；非法 session 由 getAnchor §33 repair 负责，不在此抢 ownership）。
 * server 不生成 UUID（API 已要求 client 提供 v4），只拒绝 illegal transition。
 * dangling Anchor（source 不可解析 → null）视为 different source：
 * 同 session resume 亦拒绝（fail-closed），restart 同 session 本就拒绝。
 */
export type BeginSessionTransitionArgs = {
  currentSessionId: string | null | undefined;
  currentSource: PlaybackSourceRef | null | undefined;
  requestedSessionId: string;
  requestedSource: PlaybackSourceRef;
  mode: 'resume' | 'restart';
};

export const assertValidBeginSessionTransition = (args: BeginSessionTransitionArgs): void => {
  const { currentSessionId, currentSource, requestedSessionId, requestedSource, mode } = args;
  if (currentSessionId == null) return;
  if (!isValidPlaybackSessionId(currentSessionId)) return;
  const sameSource = equalPlaybackSource(currentSource, requestedSource);
  const sameSession = requestedSessionId === currentSessionId;
  // same source + resume → 必须保持当前 session；换 UUID 即 BAD_REQUEST
  //（§4 stale ownership 安全边界：A/S1 播放中→pause→resume 传 S2 会使 S1 未完成
  // async TTS/checkpoint 全部 stale，且使 resume 与开新 Session 服务端不可区分）。
  if (mode === 'resume' && sameSource && !sameSession) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '[playback-session] resume must preserve current playback session（§4 session ownership），拒绝换 sessionId',
    });
  }
  // 同一 sessionId 被复用：restart 一律拒绝（§30 new-session identity）。
  if (mode === 'restart' && sameSession) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '[playback-session] restart 必须使用新 sessionId（§30 new-session identity），拒绝 session reuse',
    });
  }
  // 同一 sessionId 被复用：source 切换一律拒绝（§4 source-switch invariant）。
  if (sameSession && !sameSource) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '[playback-session] 切换 source 必须使用新 sessionId（§4 source-switch invariant），拒绝 session reuse',
    });
  }
};

/** §15 playback.getAnchor：读取当前 Subject 唯一 Anchor（含 legacy repair，M5-05 落地）。 */
export const getPlaybackAnchorForSubject = async (
  subject: Subject,
): Promise<GetPlaybackAnchorOutput> => {
  const row =
    subject.type === 'user'
      ? await prisma.userPlaybackAnchor.findUnique({ where: { userId: subject.id } })
      : await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: subject.id } });
  if (!row) return null;

  // 先做 source 合法性判定：未知 kind / 非法 sourceId（含 replay-text-*）一律
  // fail-closed 返回 null，不执行 repair 写（不给 dangling 行续命）。
  let canonicalKind: 'draft' | 'work';
  try {
    canonicalKind = canonicalizeSourceKind(row.sourceKind);
  } catch {
    return null;
  }
  if (canonicalKind === 'draft') {
    if (!isValidDraftMessageId(row.sourceId)) return null;
  } else {
    let workId: number;
    try {
      workId = parseLegacyWorkId(row.sourceId);
    } catch {
      return null;
    }
    // M5-08 §29.2（M5-P03）/ §29.3：work Anchor 可解析性门禁。
    // getStoryWorkForSubject 仅放行 active（deletedAt IS NULL）自有 Work；trash /
    // missing / foreign / 已物理删除统一 NOT_FOUND（M2 no-leak 不可区分面）→
    // fail-closed：删除 dangling Anchor 行，返回 null 不 rehydrate。
    // Draft 无 trash 概念，不在此判定。本删除只清 Anchor 行（M5 半径 Anchor 层），
    // Per-Work Progress 由 Work FK / GC 处理，不连带删。
    try {
      await getStoryWorkForSubject(subject, workId);
    } catch (err) {
      const code = (err as { code?: unknown } | null | undefined)?.code;
      if (code !== 'NOT_FOUND') throw err;
      try {
        if (subject.type === 'user') {
          await prisma.userPlaybackAnchor.deleteMany({ where: { userId: subject.id } });
        } else {
          await prisma.guestPlaybackAnchor.deleteMany({ where: { guestId: subject.id } });
        }
      } catch {
        // 清理写失败不掩盖 fail-closed 语义：仍返回 null（下次 getAnchor 重试清理）。
      }
      return null;
    }
  }

  // §33 repair：sessionId null/invalid UUID → 生成 UUID 写回。
  // 同时把 legacy chat/generation 收敛为 canonical draft/work 写回，
  // 非法 anchorState（非 ready|ended）收敛为 ready 写回；三者合并为一次 update。
  const needsSessionRepair = !isValidPlaybackSessionId(row.sessionId);
  const needsKindRepair = row.sourceKind !== canonicalKind;
  const needsStateRepair = row.anchorState !== 'ready' && row.anchorState !== 'ended';
  if (!needsSessionRepair && !needsKindRepair && !needsStateRepair) {
    return toAnchorDto(row);
  }
  const repairedSessionId = needsSessionRepair ? createPlaybackSessionId() : (row.sessionId as string);
  const repairedAnchorState = needsStateRepair
    ? 'ready'
    : (row.anchorState as 'ready' | 'ended');
  try {
    const updated =
      subject.type === 'user'
        ? await prisma.userPlaybackAnchor.update({
            where: { userId: subject.id },
            data: {
              sessionId: repairedSessionId,
              sourceKind: canonicalKind,
              anchorState: repairedAnchorState,
            },
          })
        : await prisma.guestPlaybackAnchor.update({
            where: { guestId: subject.id },
            data: {
              sessionId: repairedSessionId,
              sourceKind: canonicalKind,
              anchorState: repairedAnchorState,
            },
          });
    return toAnchorDto(updated);
  } catch {
    // 竞态下行被并发删除：按无 Anchor 处理（fail-closed 返回 null）。
    return null;
  }
};

/**
 * 经现有分段算法计算 Work 总段落数（§16.1，不信任客户端）。
 * 空文本兜底为 1（与 store / progress 推导的 MIN_TOTAL_PARAGRAPHS 一致）。
 */
const computeWorkTotalParagraphs = (storyText: string): number => {
  const normalized = normalizeStoryText(storyText);
  const segments = segmentStoryText(normalized);
  return Math.max(1, segments.length);
};

/** §16 playback.beginSession：创建新 Session 并落 Anchor（M5-05 落地）。 */
export const beginPlaybackSessionForSubject = async (
  subject: Subject,
  input: BeginPlaybackSessionInput,
): Promise<PlaybackAnchorDTO> => {
  // 新写入全部要求 UUID（router zod 已校验，此处再做领域锁形，双保险 fail-closed）。
  if (!isValidPlaybackSessionId(input.sessionId)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '非法 sessionId（须为 UUID v4）' });
  }
  // §4 / §30 begin identity guard：读取当期 Subject Anchor 后、
  // 任何 restart Progress reset 之前执行（拒绝回归 DB unchanged 断言依赖此顺序）。
  // 有 current Anchor：same source + resume → 必须保持（换 UUID 即 BAD_REQUEST）；
  // same source + restart → 必须新；different source → 必须新（mode 无关）。
  // 无 Anchor 或 current sessionId 非法时放行（首次 begin 不挡）。server 不生成 UUID。
  const currentAnchorRow =
    subject.type === 'user'
      ? await prisma.userPlaybackAnchor.findUnique({ where: { userId: subject.id } })
      : await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: subject.id } });
  if (currentAnchorRow) {
    assertValidBeginSessionTransition({
      currentSessionId: currentAnchorRow.sessionId,
      currentSource: tryParseLegacyPlaybackSource(
        currentAnchorRow.sourceKind,
        currentAnchorRow.sourceId,
      ),
      requestedSessionId: input.sessionId,
      requestedSource: input.source,
      mode: input.mode,
    });
  }
  const remainingAllowedMs = input.remainingAllowedMs ?? null;
  const totalAllowedMs = input.totalAllowedMs ?? null;

  if (input.source.kind === 'work') {
    // draftSnapshot 只允许 Draft 使用（§16，Work 侧不信任客户端快照）。
    if (input.draftSnapshot !== undefined) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'draftSnapshot 仅允许 Draft begin 使用',
      });
    }
    // §36 边界：Work metadata 只经 M2 getStoryWorkForSubject（subject, workId）；
    // 不得重算 title、不得重定义 contentHash、不得直查 GenerationHistory。
    // getStoryWorkForSubject 对 missing / foreign / trash 统一抛 NOT_FOUND，原样透出。
    const work = await getStoryWorkForSubject(subject, input.source.workId);
    const totalParagraphs = computeWorkTotalParagraphs(work.storyText);

    // 读取 Per-Work 长期进度（ownership 经 StoryWork → Subject，不重复存 userId/guestId，§6.2）。
    const existingProgress =
      subject.type === 'user'
        ? await prisma.storyPlaybackProgress.findUnique({
            where: { storyWorkId: work.id },
          })
        : await prisma.guestStoryPlaybackProgress.findUnique({
            where: { storyWorkId: work.id },
          });

    let lastCompletedParagraphIndex = -1;
    let nextParagraphIndex = 0;

    if (input.mode === 'restart') {
      // §16.3 / §30：position → 0、保留 completedAt、创建新 sessionId（input.sessionId）。
      const preservedCompletedAt = existingProgress?.completedAt ?? null;
      const progressData = {
        contentHash: work.contentHash,
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: -1,
        nextParagraphIndex: 0,
        totalParagraphs,
        completedAt: preservedCompletedAt,
        lastPlayedAt: new Date(),
      };
      if (existingProgress) {
        if (subject.type === 'user') {
          await prisma.storyPlaybackProgress.update({
            where: { storyWorkId: work.id },
            data: progressData,
          });
        } else {
          await prisma.guestStoryPlaybackProgress.update({
            where: { storyWorkId: work.id },
            data: progressData,
          });
        }
      } else {
        if (subject.type === 'user') {
          await prisma.storyPlaybackProgress.create({
            data: { storyWorkId: work.id, ...progressData },
          });
        } else {
          await prisma.guestStoryPlaybackProgress.create({
            data: { storyWorkId: work.id, ...progressData },
          });
        }
      }
      lastCompletedParagraphIndex = -1;
      nextParagraphIndex = 0;
    } else if (existingProgress) {
      // §16.2 Work Resume：校验 hash + segmentationVersion。
      const hashMatch = existingProgress.contentHash === work.contentHash;
      const versionMatch = existingProgress.segmentationVersion === SEGMENTATION_VERSION;
      if (hashMatch && versionMatch) {
        // 一致：继续（位置钳制到当前 total，避免越界脏读）。
        const clampedNext = Math.max(0, Math.min(existingProgress.nextParagraphIndex, totalParagraphs));
        const clampedLast = Math.max(-1, Math.min(existingProgress.lastCompletedParagraphIndex, totalParagraphs - 1));
        lastCompletedParagraphIndex = clampedLast;
        nextParagraphIndex = clampedNext;
      } else {
        // 不一致：reset paragraph 0 + 更新 Progress hash/version（保留 completedAt）。
        const preservedCompletedAt = existingProgress.completedAt ?? null;
        const resetData = {
          contentHash: work.contentHash,
          segmentationVersion: SEGMENTATION_VERSION,
          lastCompletedParagraphIndex: -1,
          nextParagraphIndex: 0,
          totalParagraphs,
          completedAt: preservedCompletedAt,
          lastPlayedAt: new Date(),
        };
        if (subject.type === 'user') {
          await prisma.storyPlaybackProgress.update({
            where: { storyWorkId: work.id },
            data: resetData,
          });
        } else {
          await prisma.guestStoryPlaybackProgress.update({
            where: { storyWorkId: work.id },
            data: resetData,
          });
        }
        lastCompletedParagraphIndex = -1;
        nextParagraphIndex = 0;
      }
    } else {
      // 无 Progress：从 0 建立（Progress 行留给 saveCheckpoint UPSERT，不在此预建）。
      lastCompletedParagraphIndex = -1;
      nextParagraphIndex = 0;
    }

    const anchorData = {
      sourceKind: 'work' as const,
      sourceId: String(work.id),
      sessionId: input.sessionId,
      anchorState: 'ready' as const,
      title: work.title,
      contentHash: work.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex,
      nextParagraphIndex,
      totalParagraphs,
      voiceId: work.voiceId ?? '',
      speed: input.speed,
      remainingAllowedMs,
      totalAllowedMs,
      isOneShot: true,
    };
    const saved =
      subject.type === 'user'
        ? await prisma.userPlaybackAnchor.upsert({
            where: { userId: subject.id },
            create: { userId: subject.id, ...anchorData },
            update: anchorData,
          })
        : await prisma.guestPlaybackAnchor.upsert({
            where: { guestId: subject.id },
            create: { guestId: subject.id, ...anchorData },
            update: anchorData,
          });
    const dto = toAnchorDto(saved);
    if (!dto) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: '[playback-session] Work Anchor 落库后映射失败',
      });
    }
    return dto;
  }

  // —— Draft Begin（§16.4） ——
  const messageId = input.source.messageId;
  // server contract：拒绝 replay-text-* 等瞬态 ID 持久化（M5-01 门禁提升到 server）。
  if (!isValidDraftMessageId(messageId)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `非法 Draft messageId（禁止 ${REPLAY_TEXT_PREFIX}* 瞬态 ID 持久化）`,
    });
  }
  // Draft 必须验证 ChatMessage.messageId 属于当前 Subject（foreign/missing 统一 NOT_FOUND）。
  const owned =
    subject.type === 'user'
      ? await prisma.chatMessage.findFirst({
          where: { userId: subject.id, messageId },
          select: { id: true },
        })
      : await prisma.guestChatMessage.findFirst({
          where: { guestId: subject.id, messageId },
          select: { id: true },
        });
  if (!owned) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Draft 消息不存在或不属于当前主体',
    });
  }
  // Draft metadata 可以使用 client snapshot；缺省时给安全兜底（不触 Work 表）。
  const snapshot = input.draftSnapshot;
  const title = snapshot?.title ?? messageId.slice(0, 100);
  const contentHash = snapshot?.contentHash ?? '';
  const draftTotalParagraphs = snapshot?.totalParagraphs ?? 1;
  const voiceId = snapshot?.voiceId ?? '';
  const anchorData = {
    sourceKind: 'draft' as const,
    sourceId: messageId,
    sessionId: input.sessionId,
    anchorState: 'ready' as const,
    title,
    contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: -1,
    nextParagraphIndex: 0,
    totalParagraphs: draftTotalParagraphs,
    voiceId,
    speed: input.speed,
    remainingAllowedMs,
    totalAllowedMs,
    isOneShot: true,
  };
  const saved =
    subject.type === 'user'
      ? await prisma.userPlaybackAnchor.upsert({
          where: { userId: subject.id },
          create: { userId: subject.id, ...anchorData },
          update: anchorData,
        })
      : await prisma.guestPlaybackAnchor.upsert({
          where: { guestId: subject.id },
          create: { guestId: subject.id, ...anchorData },
          update: anchorData,
        });
  const dto = toAnchorDto(saved);
  if (!dto) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '[playback-session] Draft Anchor 落库后映射失败',
    });
  }
  return dto;
};

/**
 * M5-06 FIXUP conditional-write (CAS) helpers（评审 Blocking 1：消除 TOCTOU；
 * M5-07 FIXUP 再绑 content identity：消除 promotion 竞态）。
 *
 * 预读快照只做 fast-path 早退与 source 定路（不具权威性）；最终写入一律经
 * conditional updateMany 原子绑定，以数据库当前值（而非几毫秒前快照）为准：
 * - Stale CAS：anchor.sessionId === expectedSessionId
 * - Monotonic CAS：currentAnchor.nextParagraphIndex <= incomingNext
 * - Identity CAS（M5-07 FIXUP）：currentAnchor.contentHash === expectedContentHash
 *   AND currentAnchor.segmentationVersion === expectedSegmentationVersion
 * 三者同时下沉到同一 WHERE，count===1 方为成功，count===0 则按当前 DB 值
 * 区分 STALE_SESSION / identity no-op / monotonic no-op
 * （见 resolveConditionalCheckpointFailure）。
 */
export type CheckpointAnchorWriteData = {
  contentHash: string;
  segmentationVersion: string;
  lastCompletedParagraphIndex: number;
  nextParagraphIndex: number;
  totalParagraphs: number;
  speed: number;
  remainingAllowedMs: number | null;
  totalAllowedMs: number | null;
};

/**
 * 构造 CAS 子句（Stale + Monotonic + Content-Identity），调用方再拼 subject
 * identity（userId / guestId）即得完整 updateMany WHERE。Draft 直写与 Work
 * 事务内 CAS 共用同一构造，杜绝漂移。
 *
 * Identity 维度说明：checkpoint 不得变更 content identity（promotion 是唯一
 * 合法变更面，且由 promoteDraftToWork 专属执行）；旧包晚到时 DB identity 已
 * 变则本子句整体失配，调用方按 DB 当前值 no-op，绝不复活旧 hash/next。
 */
export const buildConditionalAnchorCasClause = (
  expectedSessionId: string,
  incomingNextParagraphIndex: number,
  expectedContentHash: string,
  expectedSegmentationVersion: string,
) => ({
  sessionId: expectedSessionId,
  nextParagraphIndex: { lte: incomingNextParagraphIndex },
  contentHash: expectedContentHash,
  segmentationVersion: expectedSegmentationVersion,
});

/**
 * 非事务 conditional anchor 更新（Draft 路径与 regression 直验共用）。
 * 返回命中行数：1 为 CAS 成功，0 为 CAS 失败（调用方再读区分原因）。
 *
 * Identity 绑定由 data 自带（data.contentHash / data.segmentationVersion 即
 * input 原样透传的待写值）：签名保持四参，R1/R2 直验不受影响，且 Draft/Work
 * 两路不可能出现“写值与期望值分离”的漂移。
 */
export const conditionalUpdatePlaybackAnchorForSubject = async (
  subject: Subject,
  expectedSessionId: string,
  incomingNextParagraphIndex: number,
  data: CheckpointAnchorWriteData,
): Promise<number> => {
  const cas = buildConditionalAnchorCasClause(
    expectedSessionId,
    incomingNextParagraphIndex,
    data.contentHash,
    data.segmentationVersion,
  );
  const res =
    subject.type === 'user'
      ? await prisma.userPlaybackAnchor.updateMany({
          where: { userId: subject.id, ...cas },
          data,
        })
      : await prisma.guestPlaybackAnchor.updateMany({
          where: { guestId: subject.id, ...cas },
          data,
        });
  return res.count;
};

/**
 * CAS 失败后按数据库当前值区分原因（绝不写；不扩 API reason、不改 M5-04
 * contract：identity 失配与 monotonic 落后统一为 accepted:true + 当前 Anchor）：
 * - 无行 / session 已变化 → {accepted:false, reason:'STALE_SESSION'}
 * - session 相同但 contentHash / segmentationVersion 已变化（promotion 唯一
 *   合法变更面，§24.1）→ {accepted:true} + 当前 Anchor（安全 no-op，不伪装成
 *   STALE；hash/version 一致的 seamless 老包走不到这里，早被 CAS 吸收）
 * - session/hash/version 相同（CAS 失败即 DB next > incoming，或异常交错下
 *   收敛）→ {accepted:true} + 当前 Anchor（维持 monotonic no-op 语义）。
 */
const resolveConditionalCheckpointFailureForSubject = async (
  subject: Subject,
  expectedSessionId: string,
  incomingNextParagraphIndex: number,
  expectedContentHash: string,
  expectedSegmentationVersion: string,
): Promise<SavePlaybackCheckpointResult> => {
  const latest =
    subject.type === 'user'
      ? await prisma.userPlaybackAnchor.findUnique({ where: { userId: subject.id } })
      : await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: subject.id } });
  if (!latest) {
    return { accepted: false, reason: STALE_SESSION };
  }
  if (latest.sessionId !== expectedSessionId) {
    return { accepted: false, reason: STALE_SESSION };
  }
  const latestSource = tryParseLegacyPlaybackSource(latest.sourceKind, latest.sourceId);
  if (!latestSource) {
    return { accepted: false, reason: STALE_SESSION };
  }
  const latestDto = toAnchorDto(latest);
  if (!latestDto) {
    return { accepted: false, reason: STALE_SESSION };
  }
  // session 相同但 content identity 已变化 → 安全 no-op（accepted:true + 当前
  // Anchor，不复活旧 hash/next；异常交错下 DB 值即权威，只读返回）。
  if (
    latest.contentHash !== expectedContentHash ||
    latest.segmentationVersion !== expectedSegmentationVersion
  ) {
    return { accepted: true, anchor: latestDto };
  }
  // session/hash/version 相同：monotonic no-op（CAS 失败即 DB next > incoming；
  // 异常交错下 DB next <= incoming 亦只读返回当前值）。
  if (latest.nextParagraphIndex > incomingNextParagraphIndex) {
    return { accepted: true, anchor: latestDto };
  }
  return { accepted: true, anchor: latestDto };
};

/**
 * §17 playback.saveCheckpoint：Session 归属 + 单调守卫后更新 Anchor（M5-06 落地，
 * M5-06 FIXUP 原子绑定：预读仅 fast-path，权威判定下沉 conditional write CAS）。
 *
 * 顺序冻结（§17.1 → §17.2 → §18）：
 * 1. Stale Guard：无 Anchor / anchor.sessionId !== input.sessionId（含 null/非法
 *    legacy、dangling source 不可解析、DTO 映射失败）→
 *    {accepted:false, reason:'STALE_SESSION'}，绝不覆盖（late save 不得影响新
 *    Anchor/Progress；input.sessionId 非法亦 STALE，fail-closed）。
 *    预读未命中直接返回；预读命中仍须经 CAS 以 DB 当前值复核（防 TOCTOU 穿透）。
 * 2. Monotonic Guard：同 Session incoming.nextParagraphIndex < existing.next →
 *    不允许回退（保持旧 server 保护性质；accepted:true + 现有 Anchor 原样返回，
 *    不写 Anchor、不碰 Progress；新 input 无此字段，透传亦忽略）。
 *    预读回退直接 no-op 返回；预读放行仍须经 CAS lte 子句复核（防同 Session 竞争回写）。
 * 2b. Content-Identity Guard（M5-07 FIXUP）：同 Session 但 incoming
 *    contentHash / segmentationVersion 与现有 Anchor 不一致 → 安全 no-op
 *    （accepted:true + 现有 Anchor 原样返回，不写 Anchor、不碰 Progress，
 *    不伪装成 STALE_SESSION）。promotion 是唯一合法变更面（§24.1）；
 *    hash/version 一致的 seamless 老包不受影响，继续下沉 CAS 吸收。
 *    预读失配直接 no-op 返回；预读放行仍须经 CAS identity 子句以 DB 当前值
 *    复核（防 guard 后 promotion 穿透）。
 * 3. Work 行为（§18）：source.kind==work 时一事务内先 conditional CAS Anchor，
 *    CAS 成功才 UPSERT Progress，CAS 失败绝不碰 Progress
 *    （prisma.$transaction；completedAt 保留，lastPlayedAt=now；用户/
 *    访客对称；ownership 经 M2 getStoryWorkForSubject，不直查 Work 表）。
 *    Draft 按 Anchor identity 只 conditional 更新 Anchor，不做 Work progress。
 */
export const savePlaybackCheckpointForSubject = async (
  subject: Subject,
  input: SavePlaybackCheckpointInput,
): Promise<SavePlaybackCheckpointResult> => {
  // 新 input 无 forceReset：即使 JS 透传亦忽略（解构只取契约字段，绝不读该旁路开关）。
  const {
    sessionId,
    contentHash,
    segmentationVersion,
    lastCompletedParagraphIndex,
    nextParagraphIndex,
    totalParagraphs,
    speed,
    remainingAllowedMs,
    totalAllowedMs,
  } = input;
  // Fail-closed：input session 非法（router zod 已拦，直调 facade 仍守）→ STALE，不写。
  if (!isValidPlaybackSessionId(sessionId)) {
    return { accepted: false, reason: STALE_SESSION };
  }

  // 预读 fast-path（非权威）：定 source 路由与早退，权威判定一律下沉 CAS。
  const currentRow =
    subject.type === 'user'
      ? await prisma.userPlaybackAnchor.findUnique({ where: { userId: subject.id } })
      : await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: subject.id } });
  // §17.1：无 Anchor → STALE（绝不凭空创建）。
  if (!currentRow) {
    return { accepted: false, reason: STALE_SESSION };
  }
  // §17.1：sessionId 写权限——Anchor.sessionId !== input.sessionId → STALE，绝不覆盖。
  // 命中此分支直接返回（无写）；未命中仍须经 CAS 复核，防 guard 后 write 前切换。
  if (currentRow.sessionId !== sessionId) {
    return { accepted: false, reason: STALE_SESSION };
  }
  // Dangling Anchor（source 不可解析）视为 STALE：不给不可信行续命，不覆盖。
  const source = tryParseLegacyPlaybackSource(currentRow.sourceKind, currentRow.sourceId);
  if (!source) {
    return { accepted: false, reason: STALE_SESSION };
  }
  const existingDto = toAnchorDto(currentRow);
  if (!existingDto) {
    return { accepted: false, reason: STALE_SESSION };
  }
  // §17.2：同 Session 单调守卫 fast-path——incoming.next < existing.next → 不回退。
  // 保持旧 server 保护性质：不写 Anchor、不碰 Progress，原样返回现有 Anchor。
  // 放行（>=）仍须经 CAS lte 子句以 DB 当前值复核，防同 Session 竞争回写。
  // Content-identity fast-path（M5-07 FIXUP，与 CAS 同判定，非权威）：
  // session 相同但 DB hash/version 已与 input 不一致（promotion 唯一合法变更面，
  // §24.1）→ accepted:true + 现有 Anchor 安全 no-op，不伪装 STALE；hash/version
  // 一致的 seamless 老包不受影响，继续下沉 CAS 吸收。放行仍须经 CAS identity
  // 子句复核，防 guard 后 promotion 穿透。
  if (
    currentRow.contentHash !== contentHash ||
    currentRow.segmentationVersion !== segmentationVersion
  ) {
    return { accepted: true, anchor: existingDto };
  }
  if (nextParagraphIndex < currentRow.nextParagraphIndex) {
    return { accepted: true, anchor: existingDto };
  }

  const anchorData: CheckpointAnchorWriteData = {
    contentHash,
    segmentationVersion,
    lastCompletedParagraphIndex,
    nextParagraphIndex,
    totalParagraphs,
    speed,
    remainingAllowedMs: remainingAllowedMs ?? null,
    totalAllowedMs: totalAllowedMs ?? null,
  };

  // —— Draft checkpoint：按 Anchor identity conditional 只更新 Anchor，不做 Work progress ——
  if (source.kind === 'draft') {
    const casCount = await conditionalUpdatePlaybackAnchorForSubject(
      subject,
      sessionId,
      nextParagraphIndex,
      anchorData,
    );
    if (casCount === 0) {
      return resolveConditionalCheckpointFailureForSubject(
        subject,
        sessionId,
        nextParagraphIndex,
        contentHash,
        segmentationVersion,
      );
    }
    const fresh =
      subject.type === 'user'
        ? await prisma.userPlaybackAnchor.findUnique({ where: { userId: subject.id } })
        : await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: subject.id } });
    if (!fresh) {
      return { accepted: false, reason: STALE_SESSION };
    }
    const dto = toAnchorDto(fresh);
    if (!dto) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: '[playback-session] Draft checkpoint 落库后映射失败',
      });
    }
    return { accepted: true, anchor: dto };
  }

  // —— Work checkpoint（§18 + M5-08 §29.1）：同一事务内 conditional CAS Anchor + UPSERT Progress ——
  const workId = source.workId;
  // Ownership 经 M2（subject, workId），不直查 Work 表、不重算 title/hash；
  // missing/foreign 统一 NOT_FOUND 原样透出（fail-closed，无 partial 写）。
  // M5-08 trash 边界：在播 Session 的 Work 被 moveToTrash 后，内存播放不被打断，
  // 同一 Session 的 checkpoint 仍经同一 CAS 面落库（Stale/Monotonic/Identity 全绑，
  // 写值取 input/Anchor，不取 trash 行元数据，不复活无辜行）；仅当 Work 非 trash
  //（missing/foreign/已物理删除）才 NOT_FOUND。trash 判定只读 deletedAt 信号
  //（isStoryWorkTrashedForSubject，§36 边界）；trash 后一旦 getAnchor 刷新即 null，
  // 后续 checkpoint 即 STALE（§29.2，不复活）。
  try {
    await getStoryWorkForSubject(subject, workId);
  } catch (err) {
    let trashed = false;
    try {
      trashed = await isStoryWorkTrashedForSubject(subject, workId);
    } catch {
      // trash 判定自身失败：按原错透出，不掩盖、不写。
      throw err;
    }
    if (!trashed) throw err;
    // trash 自有：在播 Session checkpoint 继续下沉同一 CAS 事务（见下）。
  }
  const casTx = await prisma.$transaction(async (tx) => {
    const cas = buildConditionalAnchorCasClause(
      sessionId,
      nextParagraphIndex,
      contentHash,
      segmentationVersion,
    );
    const casRes =
      subject.type === 'user'
        ? await tx.userPlaybackAnchor.updateMany({
            where: { userId: subject.id, ...cas },
            data: anchorData,
          })
        : await tx.guestPlaybackAnchor.updateMany({
            where: { guestId: subject.id, ...cas },
            data: anchorData,
          });
    // CAS 失败绝不碰 WorkProgress，直接返回，由外层按当前 DB 值区分原因。
    if (casRes.count === 0) {
      return { casApplied: false as const };
    }
    const progressCreateBase = {
      storyWorkId: workId,
      contentHash,
      segmentationVersion,
      lastCompletedParagraphIndex,
      nextParagraphIndex,
      totalParagraphs,
      completedAt: null,
      lastPlayedAt: new Date(),
    };
    const progressUpdateBase = {
      contentHash,
      segmentationVersion,
      lastCompletedParagraphIndex,
      nextParagraphIndex,
      totalParagraphs,
      lastPlayedAt: new Date(),
    };
    if (subject.type === 'user') {
      await tx.storyPlaybackProgress.upsert({
        where: { storyWorkId: workId },
        create: progressCreateBase,
        update: progressUpdateBase,
      });
    } else {
      await tx.guestStoryPlaybackProgress.upsert({
        where: { storyWorkId: workId },
        create: progressCreateBase,
        update: progressUpdateBase,
      });
    }
    const fresh =
      subject.type === 'user'
        ? await tx.userPlaybackAnchor.findUnique({ where: { userId: subject.id } })
        : await tx.guestPlaybackAnchor.findUnique({ where: { guestId: subject.id } });
    return { casApplied: true as const, row: fresh };
  });
  if (!casTx.casApplied) {
    return resolveConditionalCheckpointFailureForSubject(
      subject,
      sessionId,
      nextParagraphIndex,
      contentHash,
      segmentationVersion,
    );
  }
  if (!casTx.row) {
    return { accepted: false, reason: STALE_SESSION };
  }
  const dto = toAnchorDto(casTx.row);
  if (!dto) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '[playback-session] Work checkpoint 落库后映射失败',
    });
  }
  return { accepted: true, anchor: dto };
};

/**
 * §19 playback.completeSession：完播收尾（保留 ended Anchor，M5-07 落地）。
 *
 * - 无 Anchor → null（不建不写）；dangling source 不可解析 → null（不给脏行续命）。
 * - input.sessionId 非法 → BAD_REQUEST（fail-closed，不写）。
 * - anchor.sessionId !== input.sessionId → BAD_REQUEST（stale complete 拒绝覆盖
 *   新会话；与 saveCheckpoint 的 STALE_SESSION 同源，但 complete 输出无 accepted
 *   通道，故以 fail-closed 抛错，绝不覆盖）。
 * - Draft：CAS（WHERE sessionId）置 anchorState=ended，不建 Work progress；
 *   重复 complete 幂等（已 ended 仍返回同一 ended Anchor，不破坏位置）。
 * - Work：先经 M2 getStoryWorkForSubject（subject, workId）鉴权
 *   （missing/foreign/trash 统一 NOT_FOUND，原样透出，无 partial 写）；
 *   total 经 computeWorkTotalParagraphs（work.storyText）权威计算；
 *   同一事务内 CAS Anchor（WHERE sessionId + sourceId，position→total、
 *   state→ended）+ UPSERT Progress（next=total/last=total-1、
 *   completedAt=首完保留、lastPlayedAt=now）；CAS 失败（并发切换）→
 *   BAD_REQUEST，绝不碰 Progress；重复 complete 保留首个 completedAt
 *   （不删 completion history，§41）。
 * - User/Guest 对称。
 */
export const completePlaybackSessionForSubject = async (
  subject: Subject,
  input: CompletePlaybackSessionInput,
): Promise<PlaybackAnchorDTO | null> => {
  const { sessionId } = input;
  if (!isValidPlaybackSessionId(sessionId)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '非法 sessionId（须为 UUID v4）' });
  }
  const currentRow =
    subject.type === 'user'
      ? await prisma.userPlaybackAnchor.findUnique({ where: { userId: subject.id } })
      : await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: subject.id } });
  if (!currentRow) return null;
  if (currentRow.sessionId !== sessionId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '[playback-session] completeSession session 不匹配（STALE_SESSION），fail-closed，拒绝覆盖新会话',
    });
  }
  const source = tryParseLegacyPlaybackSource(currentRow.sourceKind, currentRow.sourceId);
  if (!source) return null;
  const existingDto = toAnchorDto(currentRow);
  if (!existingDto) return null;

  // —— Draft complete：仅 ended Anchor，不建 Work progress ——
  if (source.kind === 'draft') {
    if (currentRow.anchorState === 'ended') return existingDto;
    const casRes =
      subject.type === 'user'
        ? await prisma.userPlaybackAnchor.updateMany({
            where: { userId: subject.id, sessionId },
            data: { anchorState: 'ended' },
          })
        : await prisma.guestPlaybackAnchor.updateMany({
            where: { guestId: subject.id, sessionId },
            data: { anchorState: 'ended' },
          });
    if (casRes.count === 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '[playback-session] completeSession 并发切换（STALE_SESSION），fail-closed',
      });
    }
    const fresh =
      subject.type === 'user'
        ? await prisma.userPlaybackAnchor.findUnique({ where: { userId: subject.id } })
        : await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: subject.id } });
    if (!fresh) return null;
    const dto = toAnchorDto(fresh);
    if (!dto) return null;
    return dto;
  }

  // —— Work complete（§19 / §30 / §41 + M5-08 §29.1）：ended + Progress next=total + completedAt ——
  const workId = source.workId;
  // M5-08 trash 边界：在播 Session 的 Work 被 moveToTrash 后，completion 仍允许；
  // trash 自有时 total/content 取 Anchor 已存值（frozen，不重算、不取 trash 行元数据），
  // 同一 CAS 面落库；非 trash 的 missing/foreign/已物理删除仍 NOT_FOUND 原样透出。
  let workTotal: number;
  let workHashForProgress: string;
  let workVersionForProgress: string;
  try {
    const work = await getStoryWorkForSubject(subject, workId);
    workTotal = computeWorkTotalParagraphs(work.storyText);
    workHashForProgress = typeof work.contentHash === 'string' ? work.contentHash : '';
    workVersionForProgress = SEGMENTATION_VERSION;
  } catch (err) {
    let trashed = false;
    try {
      trashed = await isStoryWorkTrashedForSubject(subject, workId);
    } catch {
      throw err;
    }
    if (!trashed) throw err;
    workTotal = currentRow.totalParagraphs;
    workHashForProgress = typeof currentRow.contentHash === 'string' ? currentRow.contentHash : '';
    workVersionForProgress =
      typeof currentRow.segmentationVersion === 'string' && currentRow.segmentationVersion.length > 0
        ? currentRow.segmentationVersion
        : SEGMENTATION_VERSION;
  }
  const completedLast = workTotal - 1;
  const now = new Date();
  const txResult = await prisma.$transaction(async (tx) => {
    const casRes =
      subject.type === 'user'
        ? await tx.userPlaybackAnchor.updateMany({
            where: { userId: subject.id, sessionId, sourceId: String(workId) },
            data: {
              lastCompletedParagraphIndex: completedLast,
              nextParagraphIndex: workTotal,
              totalParagraphs: workTotal,
              anchorState: 'ended',
            },
          })
        : await tx.guestPlaybackAnchor.updateMany({
            where: { guestId: subject.id, sessionId, sourceId: String(workId) },
            data: {
              lastCompletedParagraphIndex: completedLast,
              nextParagraphIndex: workTotal,
              totalParagraphs: workTotal,
              anchorState: 'ended',
            },
          });
    if (casRes.count === 0) {
      return { applied: false as const };
    }
    const existingProgress =
      subject.type === 'user'
        ? await tx.storyPlaybackProgress.findUnique({ where: { storyWorkId: workId } })
        : await tx.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: workId } });
    // 幂等：重复 complete 保留首个 completedAt，不刷新、不删除 history。
    const preservedCompletedAt = existingProgress?.completedAt ?? now;
    const progressCreateBase = {
      storyWorkId: workId,
      contentHash: workHashForProgress,
      segmentationVersion: workVersionForProgress,
      lastCompletedParagraphIndex: completedLast,
      nextParagraphIndex: workTotal,
      totalParagraphs: workTotal,
      completedAt: preservedCompletedAt,
      lastPlayedAt: now,
    };
    const progressUpdateBase = {
      contentHash: workHashForProgress,
      segmentationVersion: workVersionForProgress,
      lastCompletedParagraphIndex: completedLast,
      nextParagraphIndex: workTotal,
      totalParagraphs: workTotal,
      completedAt: preservedCompletedAt,
      lastPlayedAt: now,
    };
    if (subject.type === 'user') {
      await tx.storyPlaybackProgress.upsert({
        where: { storyWorkId: workId },
        create: progressCreateBase,
        update: progressUpdateBase,
      });
    } else {
      await tx.guestStoryPlaybackProgress.upsert({
        where: { storyWorkId: workId },
        create: progressCreateBase,
        update: progressUpdateBase,
      });
    }
    const fresh =
      subject.type === 'user'
        ? await tx.userPlaybackAnchor.findUnique({ where: { userId: subject.id } })
        : await tx.guestPlaybackAnchor.findUnique({ where: { guestId: subject.id } });
    return { applied: true as const, row: fresh };
  });
  if (!txResult.applied) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '[playback-session] completeSession 并发切换（STALE_SESSION），fail-closed',
    });
  }
  if (!txResult.row) return null;
  const dto = toAnchorDto(txResult.row);
  if (!dto) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '[playback-session] Work complete 落库后映射失败',
    });
  }
  return dto;
};

/**
 * §21 playback.clearAnchor：仅清理当前 session（不匹配则 no-op，M5-07 落地）。
 *
 * - deleteMany WHERE sessionId（CAS 原子，count 判定 cleared）；
 * - 无 Anchor / session 不匹配 / input session 非法 → {success:true, cleared:false}
 *  （no-op，绝不误删新会话；沿用 M5-04 router 注释契约）；
 * - 不校验 Work 存在与否（已 trash/missing 的 Anchor 照清，Trash invalidation 最小面）；
 * - dangling source 亦照 session 清（session 匹配即删，不给脏行续命但允许清理）；
 * - 已 ended 的 Anchor 同样可清（session 匹配即删）；
 * - User/Guest 对称。
 */
export const clearPlaybackAnchorForSubject = async (
  subject: Subject,
  input: ClearPlaybackAnchorInput,
): Promise<ClearPlaybackAnchorOutput> => {
  const { sessionId } = input;
  if (!isValidPlaybackSessionId(sessionId)) {
    return { success: true as const, cleared: false };
  }
  const res =
    subject.type === 'user'
      ? await prisma.userPlaybackAnchor.deleteMany({
          where: { userId: subject.id, sessionId },
        })
      : await prisma.guestPlaybackAnchor.deleteMany({
          where: { guestId: subject.id, sessionId },
        });
  return { success: true as const, cleared: res.count > 0 };
};

/**
 * M5-08 §29.3 domain hook：清理某 Subject 下指向指定 Work 的 PlaybackAnchor。
 *
 * Permanent delete 后 Anchor 视为 dangling（无法再 resolve Source），本 hook 提供
 * Anchor 层 fail-closed 清理路径：
 * - subject-scoped（User/Guest 表 id 序列独立，绝不全局按 sourceId 删除）；
 * - 仅删 sourceKind work（含 legacy generation 兼容值）且 sourceId 为 String(workId) 的行；
 * - draft Anchor 不动；Per-Work Progress 由 Work FK CASCADE 接管（M5-02 schema），本 hook 不碰；
 * - 非法 workId → { cleared:false } no-op，不抛错。
 *
 * M5 半径内仅提供路径，不自动接入任何删除流程（不做大规模删除；“已在播不打断”由
 * getAnchor 懒清理 + checkpoint/complete 的 trash 容忍承接，刷新后自然 fail-closed）。
 */
export const invalidatePlaybackReferencesForWork = async (
  subject: Subject,
  workId: number,
): Promise<{ cleared: boolean }> => {
  if (typeof workId !== 'number' || !Number.isSafeInteger(workId) || workId <= 0) {
    return { cleared: false };
  }
  const res =
    subject.type === 'user'
      ? await prisma.userPlaybackAnchor.deleteMany({
          where: {
            userId: subject.id,
            sourceKind: { in: ['work', 'generation'] },
            sourceId: String(workId),
          },
        })
      : await prisma.guestPlaybackAnchor.deleteMany({
          where: {
            guestId: subject.id,
            sourceKind: { in: ['work', 'generation'] },
            sourceId: String(workId),
          },
        });
  return { cleared: res.count > 0 };
};

/**
 * §24 playback.promoteDraftToWork：Draft→Work 提升（M5-07 落地）。
 *
 * 三校验 fail-closed（任一失败绝不写库）：
 * 1. Anchor.sessionId === input.sessionId（不匹配 → BAD_REQUEST）；
 * 2. 当前 Source 必须是 draft（含 legacy chat 归一；已是 work/dangling → BAD_REQUEST）；
 * 3. StoryWork.sourceMessageId === draft.messageId（经 M2
 *    getStoryWorkForSubject 加载，missing/foreign/trash 统一 NOT_FOUND；
 *    sourceMessageId 缺失/不一致 → BAD_REQUEST）。
 *
 * 成功（同一事务内 CAS Anchor + UPSERT Progress）：
 * - Anchor：source→work(workId)/title→work.title/contentHash→work.contentHash/
 *   voiceId→work.voiceId/segmentationVersion→current/total→work 重算；
 *   **sessionId 不变**（§45 audio 不重启的 server 侧保证；client 维持播放）；
 *   position：hash 一致沿用 draft 段落（钳制到 [0,total]/[-1,total-1]），
 *   不一致（§24.1，含任一空 hash）→ reset 0（last=-1/next=0，不许旧段落套新正文）；
 *   speed/timers/state 原样保留。
 * - Progress：UPSERT work 进度（hash/version/total 取 Work 当前值，
 *   completedAt 保留既有、lastPlayedAt=now）。
 * - CAS：updateMany WHERE sessionId + sourceId(draftMessageId)，count===0 →
 *   BAD_REQUEST（并发切换穿透防护）；User/Guest 对称。
 */
export const promoteDraftPlaybackToWorkForSubject = async (
  subject: Subject,
  input: PromoteDraftPlaybackToWorkInput,
): Promise<PlaybackAnchorDTO> => {
  const { sessionId, workId } = input;
  if (!isValidPlaybackSessionId(sessionId)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '非法 sessionId（须为 UUID v4）' });
  }
  if (typeof workId !== 'number' || !Number.isSafeInteger(workId) || workId <= 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: '作品不存在' });
  }
  const currentRow =
    subject.type === 'user'
      ? await prisma.userPlaybackAnchor.findUnique({ where: { userId: subject.id } })
      : await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: subject.id } });
  if (!currentRow) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '[playback-session] 无当前 Anchor，无法 promotion',
    });
  }
  if (currentRow.sessionId !== sessionId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '[playback-session] promote session 不匹配（STALE_SESSION），fail-closed',
    });
  }
  const draftSource = tryParseLegacyPlaybackSource(currentRow.sourceKind, currentRow.sourceId);
  if (!draftSource || draftSource.kind !== 'draft') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '[playback-session] 当前 Source 非 draft，拒绝 promotion',
    });
  }
  const draftMessageId = draftSource.messageId;
  const draftHash = typeof currentRow.contentHash === 'string' ? currentRow.contentHash : '';
  const draftNext = currentRow.nextParagraphIndex;
  const draftLast = currentRow.lastCompletedParagraphIndex;

  // Work 鉴权与权威 metadata 一律经 M2（不直查表、不重算 title/hash）。
  const work = await getStoryWorkForSubject(subject, workId);
  if (!work.sourceMessageId || work.sourceMessageId !== draftMessageId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '[playback-session] StoryWork.sourceMessageId 与 Draft.messageId 不一致，拒绝 promotion',
    });
  }
  const workTotal = computeWorkTotalParagraphs(work.storyText);
  const workHash = typeof work.contentHash === 'string' ? work.contentHash : '';
  const preserve = shouldPreserveDraftBreakpointOnPromote(draftHash, workHash);
  const promotedNext = resolvePromotedNextParagraphIndex(draftNext, draftHash, workHash, workTotal);
  const promotedLast = preserve ? Math.max(-1, Math.min(draftLast, workTotal - 1)) : -1;
  const now = new Date();

  const freshRow = await prisma.$transaction(async (tx) => {
    const anchorData = {
      sourceKind: 'work',
      sourceId: String(work.id),
      title: work.title,
      contentHash: workHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: promotedLast,
      nextParagraphIndex: promotedNext,
      totalParagraphs: workTotal,
      voiceId: work.voiceId ?? '',
    };
    const casRes =
      subject.type === 'user'
        ? await tx.userPlaybackAnchor.updateMany({
            where: { userId: subject.id, sessionId, sourceId: draftMessageId },
            data: anchorData,
          })
        : await tx.guestPlaybackAnchor.updateMany({
            where: { guestId: subject.id, sessionId, sourceId: draftMessageId },
            data: anchorData,
          });
    if (casRes.count === 0) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '[playback-session] promote 并发切换（STALE_SESSION），fail-closed',
      });
    }
    const existingProgress =
      subject.type === 'user'
        ? await tx.storyPlaybackProgress.findUnique({ where: { storyWorkId: work.id } })
        : await tx.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: work.id } });
    const preservedCompletedAt = existingProgress?.completedAt ?? null;
    if (subject.type === 'user') {
      await tx.storyPlaybackProgress.upsert({
        where: { storyWorkId: work.id },
        create: {
          storyWorkId: work.id,
          contentHash: workHash,
          segmentationVersion: SEGMENTATION_VERSION,
          lastCompletedParagraphIndex: promotedLast,
          nextParagraphIndex: promotedNext,
          totalParagraphs: workTotal,
          completedAt: preservedCompletedAt,
          lastPlayedAt: now,
        },
        update: {
          contentHash: workHash,
          segmentationVersion: SEGMENTATION_VERSION,
          lastCompletedParagraphIndex: promotedLast,
          nextParagraphIndex: promotedNext,
          totalParagraphs: workTotal,
          lastPlayedAt: now,
        },
      });
      return tx.userPlaybackAnchor.findUnique({ where: { userId: subject.id } });
    }
    await tx.guestStoryPlaybackProgress.upsert({
      where: { storyWorkId: work.id },
      create: {
        storyWorkId: work.id,
        contentHash: workHash,
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: promotedLast,
        nextParagraphIndex: promotedNext,
        totalParagraphs: workTotal,
        completedAt: preservedCompletedAt,
        lastPlayedAt: now,
      },
      update: {
        contentHash: workHash,
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: promotedLast,
        nextParagraphIndex: promotedNext,
        totalParagraphs: workTotal,
        lastPlayedAt: now,
      },
    });
    return tx.guestPlaybackAnchor.findUnique({ where: { guestId: subject.id } });
  });

  if (!freshRow) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '[playback-session] promotion 落库后 Anchor 缺失',
    });
  }
  const dto = toAnchorDto(freshRow);
  if (!dto) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '[playback-session] promotion 落库后映射失败',
    });
  }
  if (dto.sessionId !== sessionId) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '[playback-session] promotion 不得变更 sessionId',
    });
  }
  return dto;
};

/**
 * §22 playback.getWorkProgressBatch：M3 消费的 Work 进度批量视图（M5-07 落地）。
 *
 * - 只读：绝不创建/更新/删除任何 Anchor 或 Progress 行；
 * - 每个输入 workId 必有对应输出（顺序与输入一致；重复 id 逐项返回）；
 * - 无 Progress row 或 work 非当前 Subject 自有（missing/foreign 一律 fail-closed
 *   为 not_started，不抛错不泄漏；trash 本项不做 invalidation，原样返回进度，
 *   留 M5-08）→ state=not_started/progress=0/last=-1/next=0/total=1/
 *   completedAt=null/lastPlayedAt=null；
 * - 有自有 Progress row → state/progress 经 lib/playback/progress.ts
 *   deriveWorkPlaybackState / computeWorkProgressRatio 推导（绝不另存 status 列，
 *   §7），位置与 completedAt/lastPlayedAt 原样透传；
 * - 因此播放 Work D 绝不触碰 A/B 的长期 Progress（§40 后半）；
 * - User/Guest 对称（读各自 Progress 表 + 各自 Work 表做 ownership 过滤）。
 */
export const getWorkPlaybackProgressBatchForSubject = async (
  subject: Subject,
  input: GetWorkPlaybackProgressBatchInput,
): Promise<GetWorkPlaybackProgressBatchOutput> => {
  const { workIds } = input;
  for (const id of workIds) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: '非法 workId' });
    }
  }
  const ownedRows =
    subject.type === 'user'
      ? await prisma.storyWork.findMany({
          where: { id: { in: workIds }, userId: subject.id },
          select: { id: true },
        })
      : await prisma.guestStoryWork.findMany({
          where: { id: { in: workIds }, guestId: subject.id },
          select: { id: true },
        });
  const ownedSet = new Set(ownedRows.map((r) => r.id));
  const progressRows =
    subject.type === 'user'
      ? await prisma.storyPlaybackProgress.findMany({
          where: { storyWorkId: { in: workIds } },
        })
      : await prisma.guestStoryPlaybackProgress.findMany({
          where: { storyWorkId: { in: workIds } },
        });
  const progressById = new Map(progressRows.map((r) => [r.storyWorkId, r]));
  const items = workIds.map((workId) => {
    if (!ownedSet.has(workId)) {
      return {
        workId,
        state: 'not_started' as const,
        progress: 0,
        lastCompletedParagraphIndex: -1,
        nextParagraphIndex: 0,
        totalParagraphs: 1,
        completedAt: null as string | null,
        lastPlayedAt: null as string | null,
      };
    }
    const row = progressById.get(workId);
    if (!row) {
      return {
        workId,
        state: 'not_started' as const,
        progress: 0,
        lastCompletedParagraphIndex: -1,
        nextParagraphIndex: 0,
        totalParagraphs: 1,
        completedAt: null as string | null,
        lastPlayedAt: null as string | null,
      };
    }
    const position = {
      lastCompletedParagraphIndex: row.lastCompletedParagraphIndex,
      nextParagraphIndex: row.nextParagraphIndex,
      totalParagraphs: row.totalParagraphs,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    };
    return {
      workId,
      state: deriveWorkPlaybackState(position),
      progress: computeWorkProgressRatio(position),
      lastCompletedParagraphIndex: row.lastCompletedParagraphIndex,
      nextParagraphIndex: row.nextParagraphIndex,
      totalParagraphs: row.totalParagraphs,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      lastPlayedAt: row.lastPlayedAt ? row.lastPlayedAt.toISOString() : null,
    };
  });
  return { items };
};
