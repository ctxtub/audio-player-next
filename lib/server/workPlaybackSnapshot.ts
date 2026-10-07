import { prisma } from '@/lib/db';
import type { Subject } from '@/lib/server/subject';
import type { WorkPlaybackSnapshot } from '@/lib/trpc/schemas/library';
import { SEGMENTATION_VERSION, segmentStoryText } from '@/utils/segmentation';

/** Called only after the caller has resolved an owned Work. Old rows remain read-only. */
export async function resolveWorkPlaybackSnapshot(
  subject: Subject,
  workId: number,
  storyText: string,
): Promise<WorkPlaybackSnapshot> {
  const query = {
    where: { storyWorkId_version: { storyWorkId: workId, version: 1 } },
    select: {
      segmentationVersion: true,
      segmentCount: true,
      segments: {
        orderBy: { segmentIndex: 'asc' as const },
        select: { segmentIndex: true, text: true },
      },
    },
  };
  const row = subject.type === 'user'
    ? await prisma.storyAudioManifest.findUnique(query)
    : await prisma.guestStoryAudioManifest.findUnique(query);
  const localParagraphs = segmentStoryText(storyText);
  if (!row) {
    return {
      paragraphs: localParagraphs,
      segmentationVersion: SEGMENTATION_VERSION,
      totalParagraphs: Math.max(1, localParagraphs.length),
    };
  }
  const totalParagraphs = Number.isFinite(row.segmentCount) && row.segmentCount >= 1
    ? Math.floor(row.segmentCount)
    : Math.max(1, localParagraphs.length);
  if (row.segments.length !== totalParagraphs ||
      row.segments.some((segment, index) => segment.segmentIndex !== index)) {
    throw new Error('Work playback snapshot is incomplete');
  }
  return {
    paragraphs: row.segments.map(segment => segment.text),
    segmentationVersion: row.segmentationVersion || SEGMENTATION_VERSION,
    totalParagraphs,
  };
}
