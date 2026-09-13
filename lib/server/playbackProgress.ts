/**
 * 断点播放进度服务端服务层
 *
 * 实现了基于 Subject (用户或具名访客) 的段落断点保存、读取与清除。
 * 内置服务端单调递增并发谓词与显式重播判定。
 */

import { prisma } from '@/lib/db';
import type { Subject } from '@/lib/server/subject';
import { canonicalizeSourceKind } from '@/lib/playback/legacy';
import type {
  PlaybackProgressDTO,
  SavePlaybackProgressInput,
  PlaybackSourceType,
} from '@/lib/trpc/schemas/playback';

type PlaybackProgressRow = {
  // M5-02：Prisma 逻辑字段已 rename 为 sourceKind（物理列仍为 sourceType，经 @map 保留）。
  // DTO 仍为 sourceType（lib/trpc 契约后续 slice 才演进），此处做机械映射，行为语义不变。
  sourceKind: string;
  sourceId: string;
  sessionId: string | null;
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
  isOneShot: boolean;
  updatedAt: Date;
};

const toDto = (row: PlaybackProgressRow): PlaybackProgressDTO => ({
  // M5-03 reader 兼容：DB canonical 为 draft|work，旧值 chat|generation 仍原样透传
  //（DTO schema 已放宽至四值，至少一个兼容周期；不对读出做 canonical 改写，避免掩盖迁移状态）。
  sourceType: row.sourceKind as PlaybackSourceType,
  sourceId: row.sourceId,
  sessionId: row.sessionId,
  title: row.title,
  contentHash: row.contentHash,
  segmentationVersion: row.segmentationVersion,
  lastCompletedParagraphIndex: row.lastCompletedParagraphIndex,
  nextParagraphIndex: row.nextParagraphIndex,
  totalParagraphs: row.totalParagraphs,
  voiceId: row.voiceId,
  speed: row.speed,
  remainingAllowedMs: row.remainingAllowedMs,
  totalAllowedMs: row.totalAllowedMs,
  isOneShot: row.isOneShot,
  updatedAt: row.updatedAt.toISOString(),
});

export const getPlaybackProgressForSubject = async (
  subject: Subject
): Promise<PlaybackProgressDTO | null> => {
  if (subject.type === 'user') {
    // M5-02：逻辑模型 UserPlaybackProgress → UserPlaybackAnchor（物理表不变）。
    const row = await prisma.userPlaybackAnchor.findUnique({
      where: { userId: subject.id },
    });
    return row ? toDto(row) : null;
  }
  const row = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: subject.id },
  });
  return row ? toDto(row) : null;
};

export const savePlaybackProgressForSubject = async (
  subject: Subject,
  input: SavePlaybackProgressInput
): Promise<PlaybackProgressDTO> => {
  // M5-03 new writer canonical 锁定点：所有新写库路径只写 draft|work（server side）。
  // input 仍接受四值（兼容旧客户端），此处经 canonicalizeSourceKind 收敛后落库；
  // 单调比较两侧同样先 canonicalize，避免 chat/draft 或 generation/work 同源被误判为不同源。
  // sessionId 本项不动（§33 repair 属 M5-05，此处原样透传）。
  const canonicalKind = canonicalizeSourceKind(input.sourceType);
  const canonicalizeExisting = (value: unknown): string | null => {
    try {
      if (typeof value !== 'string') return null;
      return canonicalizeSourceKind(value);
    } catch {
      // 存量脏值（未知 kind）视为不同源，允许本次 canonical 写覆盖修复，不抛错。
      return null;
    }
  };
  if (subject.type === 'user') {
    const existing = await prisma.userPlaybackAnchor.findUnique({
      where: { userId: subject.id },
    });

    if (
      existing &&
      canonicalizeExisting(existing.sourceKind) === canonicalKind &&
      existing.sourceId === input.sourceId
    ) {
      if (!input.forceReset && input.nextParagraphIndex < existing.nextParagraphIndex) {
        return toDto(existing);
      }
    }

    const data = {
      sourceKind: canonicalKind,
      sourceId: input.sourceId,
      sessionId: input.sessionId ?? null,
      title: input.title,
      contentHash: input.contentHash,
      segmentationVersion: input.segmentationVersion ?? 'v1',
      lastCompletedParagraphIndex: input.lastCompletedParagraphIndex,
      nextParagraphIndex: input.nextParagraphIndex,
      totalParagraphs: input.totalParagraphs,
      voiceId: input.voiceId ?? '',
      speed: input.speed ?? 1.0,
      remainingAllowedMs: input.remainingAllowedMs ?? null,
      totalAllowedMs: input.totalAllowedMs ?? null,
      isOneShot: input.isOneShot ?? false,
    };

    const saved = await prisma.userPlaybackAnchor.upsert({
      where: { userId: subject.id },
      create: {
        userId: subject.id,
        ...data,
      },
      update: data,
    });
    return toDto(saved);
  }

  const existing = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: subject.id },
  });

  if (
    existing &&
    canonicalizeExisting(existing.sourceKind) === canonicalKind &&
    existing.sourceId === input.sourceId
  ) {
    if (!input.forceReset && input.nextParagraphIndex < existing.nextParagraphIndex) {
      return toDto(existing);
    }
  }

  const data = {
    sourceKind: canonicalKind,
    sourceId: input.sourceId,
    sessionId: input.sessionId ?? null,
    title: input.title,
    contentHash: input.contentHash,
    segmentationVersion: input.segmentationVersion ?? 'v1',
    lastCompletedParagraphIndex: input.lastCompletedParagraphIndex,
    nextParagraphIndex: input.nextParagraphIndex,
    totalParagraphs: input.totalParagraphs,
    voiceId: input.voiceId ?? '',
    speed: input.speed ?? 1.0,
    remainingAllowedMs: input.remainingAllowedMs ?? null,
    totalAllowedMs: input.totalAllowedMs ?? null,
    isOneShot: input.isOneShot ?? false,
  };

  const saved = await prisma.guestPlaybackAnchor.upsert({
    where: { guestId: subject.id },
    create: {
      guestId: subject.id,
      ...data,
    },
    update: data,
  });
  return toDto(saved);
};

export const clearPlaybackProgressForSubject = async (
  subject: Subject
): Promise<boolean> => {
  if (subject.type === 'user') {
    await prisma.userPlaybackAnchor.deleteMany({
      where: { userId: subject.id },
    });
    return true;
  }
  await prisma.guestPlaybackAnchor.deleteMany({
    where: { guestId: subject.id },
  });
  return true;
};
