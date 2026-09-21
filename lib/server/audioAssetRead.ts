/**
 *   单轨资产授权读取服务（spec §3/§4）。
 *
 * 流程：resolve Subject → StoryAudioAsset（User/Guest 对称）→ Work ownership 校验
 * → ready 门禁 → 允许才读。只做“读取已有资产”，不 synthesize、不写进度。
 *
 * 内部 chunk 防御：chunk 为 `story-audio/chunks/<assetId>/<i>.mp3` 对象，**没有独立
 * 路由**；本函数只接受 Asset 公开 id（UUID），任何 chunk 路径串都查不到行 → 404。
 * Trash Work 的已有 ready asset 仍允许读取（与  §19.1 一致）。
 */

import { prisma } from '@/lib/db';
import { isSingleTrackAssetExpired, shouldRefreshLastAccess } from '@/lib/audio/asset';
import { isSingleTrackServerEnabled } from '@/lib/audio/singleTrackFlag';
import type { Subject } from '@/lib/server/subject';
import { decodeGuestCookie, decodeSession, SESSION_COOKIE } from '@/lib/session';
import { GUEST_COOKIE } from '@/lib/trpc/context';

/** 可读单轨资产解析结果（只暴露播放所需最小字段）。 */
export type ReadableAudioAsset = {
  assetId: string;
  workId: number;
  storageKey: string;
  contentType: string;
};

/** 读取拒绝（route 按 httpStatus 映射；message 为固定文案）。 */
export class AudioAssetAccessError extends Error {
  readonly httpStatus: 401 | 403 | 404;
  readonly code: string;
  constructor(httpStatus: 401 | 403 | 404, code: string) {
    super(code);
    this.name = 'AudioAssetAccessError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

function parseCookiesFromHeader(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const item of cookieHeader.split(';')) {
    const [rawKey, ...rawVal] = item.trim().split('=');
    if (rawKey) result[rawKey] = decodeURIComponent(rawVal.join('='));
  }
  return result;
}

/** 由请求 Cookie 解析 Subject（与 tRPC createContext 同口径）。 */
export function resolveSubjectFromRequest(req: Request): Subject | null {
  const cookies = parseCookiesFromHeader(req.headers.get('cookie'));
  const session = cookies[SESSION_COOKIE] ? decodeSession(cookies[SESSION_COOKIE]) : null;
  if (session) return { type: 'user', id: session.userId };
  const guestId = cookies[GUEST_COOKIE] ? decodeGuestCookie(cookies[GUEST_COOKIE]) : null;
  if (guestId) return { type: 'guest', id: guestId };
  return null;
}

/**
 * 解析当前 Subject 可读的单轨资产（User/Guest 对称）。
 * @throws {AudioAssetAccessError} 401 未鉴权 / 403 非 owner / 404 未知·未 ready·内部 chunk
 */
export async function resolveReadableAudioAssetForSubject(
  subject: Subject | null,
  assetId: string,
): Promise<ReadableAudioAsset> {
  //  去耦：服务端单轨 flag 关闭 → 读取路由一律 404（不产生单轨流量，fail closed）。
  if (!isSingleTrackServerEnabled()) {
    throw new AudioAssetAccessError(404, 'ASSET_NOT_FOUND');
  }
  if (!subject) throw new AudioAssetAccessError(401, 'UNAUTHORIZED');
  if (typeof assetId !== 'string' || assetId.trim().length === 0) {
    throw new AudioAssetAccessError(404, 'ASSET_NOT_FOUND');
  }
  const id = assetId.trim();

  const [userAsset, guestAsset] = await Promise.all([
    prisma.storyAudioAsset.findUnique({ where: { id } }),
    prisma.guestStoryAudioAsset.findUnique({ where: { id } }),
  ]);
  if (!userAsset && !guestAsset) {
    throw new AudioAssetAccessError(404, 'ASSET_NOT_FOUND');
  }

  if (userAsset) {
    if (subject.type !== 'user') throw new AudioAssetAccessError(403, 'FORBIDDEN');
    const work = await prisma.storyWork.findUnique({
      where: { id: userAsset.storyWorkId },
      select: { id: true, userId: true },
    });
    if (!work) throw new AudioAssetAccessError(404, 'ASSET_NOT_FOUND');
    if (work.userId !== subject.id) throw new AudioAssetAccessError(403, 'FORBIDDEN');
    if (userAsset.status !== 'ready' || !userAsset.storageKey) {
      throw new AudioAssetAccessError(404, 'ASSET_NOT_READY');
    }
    const now = new Date();
    if (
      isSingleTrackAssetExpired({
        readyAt: userAsset.readyAt,
        lastAccessedAt: userAsset.lastAccessedAt,
        now,
      })
    ) {
      throw new AudioAssetAccessError(404, 'ASSET_NOT_READY');
    }
    if (shouldRefreshLastAccess(userAsset.lastAccessedAt, now)) {
      await prisma.storyAudioAsset.updateMany({
        where: { id: userAsset.id, status: 'ready' },
        data: { lastAccessedAt: now },
      });
    }
    return {
      assetId: userAsset.id,
      workId: userAsset.storyWorkId,
      storageKey: userAsset.storageKey,
      contentType: userAsset.contentType,
    };
  }

  if (subject.type !== 'guest') throw new AudioAssetAccessError(403, 'FORBIDDEN');
  const guestWork = await prisma.guestStoryWork.findUnique({
    where: { id: guestAsset!.storyWorkId },
    select: { id: true, guestId: true },
  });
  if (!guestWork) throw new AudioAssetAccessError(404, 'ASSET_NOT_FOUND');
  if (guestWork.guestId !== subject.id) throw new AudioAssetAccessError(403, 'FORBIDDEN');
  if (guestAsset!.status !== 'ready' || !guestAsset!.storageKey) {
    throw new AudioAssetAccessError(404, 'ASSET_NOT_READY');
  }
  const now = new Date();
  if (
    isSingleTrackAssetExpired({
      readyAt: guestAsset!.readyAt,
      lastAccessedAt: guestAsset!.lastAccessedAt,
      now,
    })
  ) {
    throw new AudioAssetAccessError(404, 'ASSET_NOT_READY');
  }
  if (shouldRefreshLastAccess(guestAsset!.lastAccessedAt, now)) {
    await prisma.guestStoryAudioAsset.updateMany({
      where: { id: guestAsset!.id, status: 'ready' },
      data: { lastAccessedAt: now },
    });
  }
  return {
    assetId: guestAsset!.id,
    workId: guestAsset!.storyWorkId,
    storageKey: guestAsset!.storageKey,
    contentType: guestAsset!.contentType,
  };
}
