/**
 * 断点播放进度服务端服务层
 *
 * 实现了基于 Subject (用户或具名访客) 的段落断点保存、读取与清除。
 * 内置服务端单调递增并发谓词与显式重播判定。
 */

import { prisma } from '@/lib/db';
import type { Subject } from '@/lib/server/subject';
import type {
  PlaybackProgressDTO,
  SavePlaybackProgressInput,
  PlaybackSourceType,
} from '@/lib/trpc/schemas/playback';

type PlaybackProgressRow = {
  sourceType: string;
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
  sourceType: row.sourceType as PlaybackSourceType,
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
    const row = await prisma.userPlaybackProgress.findUnique({
      where: { userId: subject.id },
    });
    return row ? toDto(row) : null;
  }
  const row = await prisma.guestPlaybackProgress.findUnique({
    where: { guestId: subject.id },
  });
  return row ? toDto(row) : null;
};

export const savePlaybackProgressForSubject = async (
  subject: Subject,
  input: SavePlaybackProgressInput
): Promise<PlaybackProgressDTO> => {
  if (subject.type === 'user') {
    const existing = await prisma.userPlaybackProgress.findUnique({
      where: { userId: subject.id },
    });

    if (existing && existing.sourceType === input.sourceType && existing.sourceId === input.sourceId) {
      if (!input.forceReset && input.nextParagraphIndex < existing.nextParagraphIndex) {
        return toDto(existing);
      }
    }

    const data = {
      sourceType: input.sourceType,
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

    const saved = await prisma.userPlaybackProgress.upsert({
      where: { userId: subject.id },
      create: {
        userId: subject.id,
        ...data,
      },
      update: data,
    });
    return toDto(saved);
  }

  const existing = await prisma.guestPlaybackProgress.findUnique({
    where: { guestId: subject.id },
  });

  if (existing && existing.sourceType === input.sourceType && existing.sourceId === input.sourceId) {
    if (!input.forceReset && input.nextParagraphIndex < existing.nextParagraphIndex) {
      return toDto(existing);
    }
  }

  const data = {
    sourceType: input.sourceType,
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

  const saved = await prisma.guestPlaybackProgress.upsert({
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
    await prisma.userPlaybackProgress.deleteMany({
      where: { userId: subject.id },
    });
    return true;
  }
  await prisma.guestPlaybackProgress.deleteMany({
    where: { guestId: subject.id },
  });
  return true;
};
