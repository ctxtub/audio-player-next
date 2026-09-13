/**
 * M5-05 Playback Session 服务端 Facade（spec §14 / §15 / §16 / §33 / §36）。
 *
 * 本文件是 Session API 在 server 侧的正式暴露层，逐步替代
 * lib/server/playbackProgress.ts（旧 CRUD Progress 实现保留兼容，不删除）。
 *
 * M5-05 定调：getAnchor 与 beginSession 落真逻辑；其余 5 procedures
 *（saveCheckpoint / completeSession / clearAnchor / promoteDraftToWork /
 * getWorkProgressBatch）保持 fail-closed skeleton，留给 M5-06+。
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
 *
 * Router（lib/trpc/routers/playback.ts）只经由本 facade 对外提供
 * 7 个新 procedures，Subject 鉴权与 rate limit 仍由 router 层复用。
 */

import { prisma } from '@/lib/db';
import { TRPCError } from '@/lib/trpc/init';
import type { Subject } from '@/lib/server/subject';
import { getStoryWorkForSubject } from '@/lib/server/storyWork';
import {
  createPlaybackSessionId,
  isValidPlaybackSessionId,
} from '@/lib/playback/session';
import {
  REPLAY_TEXT_PREFIX,
  isValidDraftMessageId,
} from '@/lib/playback/source';
import {
  canonicalizeSourceKind,
  parseLegacyWorkId,
} from '@/lib/playback/legacy';
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
 * 占位统一失败：尚未落地的 Session 业务逻辑一律 fail-closed。
 * 不读不写任何持久化状态。
 */
const notYetImplemented = (procedure: string): never => {
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `[playback-session] ${procedure} 尚未就绪（M5-06+ 落地），fail-closed，拒绝脏写`,
  });
};

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
    try {
      parseLegacyWorkId(row.sourceId);
    } catch {
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

/** §17 playback.saveCheckpoint：Session 归属 + 单调守卫后更新 Anchor（M5-06 落地）。 */
export const savePlaybackCheckpointForSubject = async (
  subject: Subject,
  input: SavePlaybackCheckpointInput,
): Promise<SavePlaybackCheckpointResult> => {
  void subject;
  void input;
  return notYetImplemented('playback.saveCheckpoint');
};

/** §19 playback.completeSession：完播收尾（保留 ended Anchor，M5-0x 落地）。 */
export const completePlaybackSessionForSubject = async (
  subject: Subject,
  input: CompletePlaybackSessionInput,
): Promise<PlaybackAnchorDTO | null> => {
  void subject;
  void input;
  return notYetImplemented('playback.completeSession');
};

/** §21 playback.clearAnchor：仅清理当前 session（不匹配则 no-op，M5-0x 落地）。 */
export const clearPlaybackAnchorForSubject = async (
  subject: Subject,
  input: ClearPlaybackAnchorInput,
): Promise<ClearPlaybackAnchorOutput> => {
  void subject;
  void input;
  return notYetImplemented('playback.clearAnchor');
};

/** §24 playback.promoteDraftToWork：Draft→Work 提升（M5-0x 落地）。 */
export const promoteDraftPlaybackToWorkForSubject = async (
  subject: Subject,
  input: PromoteDraftPlaybackToWorkInput,
): Promise<PlaybackAnchorDTO> => {
  void subject;
  void input;
  return notYetImplemented('playback.promoteDraftToWork');
};

/** §22 playback.getWorkProgressBatch：M3 消费的 Work 进度批量视图（M5-0x 落地）。 */
export const getWorkPlaybackProgressBatchForSubject = async (
  subject: Subject,
  input: GetWorkPlaybackProgressBatchInput,
): Promise<GetWorkPlaybackProgressBatchOutput> => {
  void subject;
  void input;
  return notYetImplemented('playback.getWorkProgressBatch');
};
