import { TRPCError } from '@trpc/server';
import type { Prisma, StoryAudioAsset, GuestStoryAudioAsset } from '@/lib/generated/prisma/client';

type Asset = StoryAudioAsset | GuestStoryAudioAsset;

function activeLease(asset: Asset, now: Date): boolean {
  return asset.status === 'preparing' && Boolean(asset.leaseId) &&
    asset.leaseExpiresAt !== null && asset.leaseExpiresAt > now;
}

function equivalent(guest: Asset, user: Asset): boolean {
  const fields = [
    'version', 'status', 'contentHash', 'voiceId', 'ttsProfileHash',
    'synthesisVersion', 'audioFormat', 'chunkCount', 'storageKey',
    'contentType', 'byteLength', 'durationMs', 'checksum', 'lastErrorCode',
  ] as const;
  return fields.every(field => guest[field] === user[field]) &&
    guest.supersededAt?.getTime() === user.supersededAt?.getTime();
}

/** Ownership moves within the caller's transaction; object bytes are never touched. */
export async function transferGuestSingleTrackAssetsTx(
  tx: Prisma.TransactionClient,
  guestWorkId: number,
  userWorkId: number,
): Promise<void> {
  const guestWork = await tx.guestStoryWork.findUnique({ where: { id: guestWorkId } });
  const userWork = await tx.storyWork.findUnique({ where: { id: userWorkId } });
  if (!guestWork || !userWork || guestWork.contentHash !== userWork.contentHash) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Audio migration requires matching owned Works' });
  }
  const assets = await tx.guestStoryAudioAsset.findMany({
    where: { storyWorkId: guestWorkId }, orderBy: { version: 'asc' },
  });
  for (const guest of assets) {
    const now = new Date();
    const user = await tx.storyAudioAsset.findUnique({
      where: { storyWorkId_version: { storyWorkId: userWorkId, version: guest.version } },
    });
    if (activeLease(guest, now) || (user && activeLease(user, now))) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Audio is still being prepared; retry registration later' });
    }
    if (user && !equivalent(guest, user)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Existing Work audio differs from guest audio' });
    }
    if (!user) {
      await tx.storyAudioAsset.create({
        data: { ...guest, storyWorkId: userWorkId, leaseId: null, leaseExpiresAt: null },
      });
    } else {
      const guestAccess = guest.lastAccessedAt ?? guest.readyAt;
      const userAccess = user.lastAccessedAt ?? user.readyAt;
      const newerAccess = guestAccess && (!userAccess || guestAccess > userAccess);
      if (newerAccess || user.leaseId || user.leaseExpiresAt) {
        await tx.storyAudioAsset.update({
          where: { id: user.id },
          data: {
            ...(newerAccess ? { lastAccessedAt: guestAccess } : {}),
            leaseId: null, leaseExpiresAt: null,
          },
        });
      }
    }
    // Recheck at the ownership cutover. An active worker must retain its row.
    const removed = await tx.guestStoryAudioAsset.deleteMany({
      where: {
        id: guest.id,
        OR: [
          { status: { not: 'preparing' } },
          { leaseId: null },
          { leaseId: '' },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: new Date() } },
        ],
      },
    });
    if (removed.count !== 1) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Audio ownership changed; retry registration later' });
    }
  }
}

/** Copy exact milliseconds; an existing User position (including restart zero) wins. */
export async function migrateGuestSingleTrackProgressTx(
  tx: Prisma.TransactionClient,
  guestWorkId: number,
  userWorkId: number,
  userId: number,
): Promise<void> {
  const guest = await tx.guestStoryAudioProgress.findUnique({ where: { storyWorkId: guestWorkId } });
  if (!guest) return;
  const existing = await tx.storyAudioProgress.findUnique({ where: { storyWorkId: userWorkId } });
  const anchor = await tx.userPlaybackAnchor.findUnique({ where: { userId } });
  const sessionId = anchor?.sourceKind === 'work' && anchor.sourceId === String(userWorkId)
    ? anchor.sessionId ?? ''
    : existing?.sessionId ?? guest.sessionId;
  if (existing) {
    if (existing.sessionId !== sessionId) {
      await tx.storyAudioProgress.update({ where: { storyWorkId: userWorkId }, data: { sessionId } });
    }
    return;
  }
  await tx.storyAudioProgress.create({ data: {
    storyWorkId: userWorkId, sessionId,
    positionMs: guest.positionMs, durationMs: guest.durationMs,
    completedAt: guest.completedAt, lastPlayedAt: guest.lastPlayedAt,
    createdAt: guest.createdAt, updatedAt: guest.updatedAt,
  } });
}
