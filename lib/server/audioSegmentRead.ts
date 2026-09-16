/**
 *  Canonical Audio 授权读取服务（spec §19/§19.1；）。
 *
 * 流程：resolve Subject → Segment（User/Guest 对称）→ Manifest → StoryWork
 * ownership 校验 → 允许才读。只做“读取已有资产”：
 * - Trash Work 的已有 ready asset 仍允许读取（ 当前 Session 可继续语义）；
 * - Permanent deleted（row 不存在）→ 404；
 * - 非 ready（missing/preparing/failed）→ 404（生成归，本项不 synthesize、
 *   不更新 segment ready、不接）。
 *
 * 本模块只做 ownership 与 ready 门禁，不触 bytes（bytes 由 storage backend 经
 * route 传输；storageKey 不作为 DTO/API 字段暴露，客户端不构造、不持久化
 * storageKey；S3 signed redirect 的 Location 可包含 opaque 对象 key）。
 */

import { prisma } from '@/lib/db';
import type { Subject } from '@/lib/server/subject';
import { decodeGuestCookie, decodeSession, SESSION_COOKIE } from '@/lib/session';
import { GUEST_COOKIE } from '@/lib/trpc/context';

/** 可读 Segment 解析结果（仅暴露播放所需的最小字段；无 storageKey 外泄面由 route 保证） */
export type ReadableAudioSegment = {
  segmentId: string;
  storageKey: string;
  contentType: string;
};

/**
 * 读取拒绝（route 按 httpStatus 映射；message 为固定文案，不含任何内部标识）。
 */
export class AudioSegmentAccessError extends Error {
  readonly httpStatus: 401 | 403 | 404;
  readonly code: string;
  constructor(httpStatus: 401 | 403 | 404, code: string) {
    super(code);
    this.name = 'AudioSegmentAccessError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/**
 * 由请求 Cookie 解析 Subject（与 tRPC createContext 同口径：
 * 已登录 session 优先，其次具名访客；均无 → null）。
 */
export function resolveSubjectFromRequest(req: Request): Subject | null {
  const cookies = parseCookiesFromHeader(req.headers.get('cookie'));
  const session = cookies[SESSION_COOKIE]
    ? decodeSession(cookies[SESSION_COOKIE])
    : null;
  if (session) return { type: 'user', id: session.userId };
  const guestId = cookies[GUEST_COOKIE]
    ? decodeGuestCookie(cookies[GUEST_COOKIE])
    : null;
  if (guestId) return { type: 'guest', id: guestId };
  return null;
}

function parseCookiesFromHeader(
  cookieHeader: string | null
): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const item of cookieHeader.split(';')) {
    const [rawKey, ...rawVal] = item.trim().split('=');
    if (rawKey) {
      result[rawKey] = decodeURIComponent(rawVal.join('='));
    }
  }
  return result;
}

/**
 * 解析当前 Subject 可读的音频 Segment（User/Guest 对称）。
 *
 * @param subject 已鉴权主体（未鉴权调用方传 null → 401）
 * @param segmentId 不透明 Segment 公开 ID（URL path 参数）
 * @throws {AudioSegmentAccessError} 401 未鉴权 / 403 非 owner / 404 未知·已删·未 ready
 */
export async function resolveReadableAudioSegmentForSubject(
  subject: Subject | null,
  segmentId: string
): Promise<ReadableAudioSegment> {
  if (!subject) {
    throw new AudioSegmentAccessError(401, 'UNAUTHORIZED');
  }
  if (typeof segmentId !== 'string' || segmentId.trim().length === 0) {
    throw new AudioSegmentAccessError(404, 'SEGMENT_NOT_FOUND');
  }
  const id = segmentId.trim();

  const [userSegment, guestSegment] = await Promise.all([
    prisma.storyAudioSegment.findUnique({
      where: { id },
      include: { manifest: { select: { storyWorkId: true } } },
    }),
    prisma.guestStoryAudioSegment.findUnique({
      where: { id },
      include: { manifest: { select: { storyWorkId: true } } },
    }),
  ]);

  if (!userSegment && !guestSegment) {
    throw new AudioSegmentAccessError(404, 'SEGMENT_NOT_FOUND');
  }

  // User 侧资产：仅同 userId 的 Subject 可读（含 Trash；deletedAt 不过滤，spec §19.1）
  if (userSegment) {
    if (subject.type !== 'user') {
      throw new AudioSegmentAccessError(403, 'FORBIDDEN');
    }
    const work = await prisma.storyWork.findUnique({
      where: { id: userSegment.manifest.storyWorkId },
      select: { id: true, userId: true },
    });
    // 中文注释：Work 行已无（permanent delete 级联会连带删 Segment；此处为防御）→ 404，
    // 与“row 不存在”语义一致；存在但属他人 → 403。
    if (!work) {
      throw new AudioSegmentAccessError(404, 'SEGMENT_NOT_FOUND');
    }
    if (work.userId !== subject.id) {
      throw new AudioSegmentAccessError(403, 'FORBIDDEN');
    }
    if (userSegment.status !== 'ready') {
      throw new AudioSegmentAccessError(404, 'SEGMENT_NOT_READY');
    }
    return {
      segmentId: userSegment.id,
      storageKey: userSegment.storageKey,
      contentType: userSegment.contentType,
    };
  }

  // Guest 侧资产：与 User 严格对称
  if (subject.type !== 'guest') {
    throw new AudioSegmentAccessError(403, 'FORBIDDEN');
  }
  const guestWork = await prisma.guestStoryWork.findUnique({
    where: { id: guestSegment!.manifest.storyWorkId },
    select: { id: true, guestId: true },
  });
  if (!guestWork) {
    throw new AudioSegmentAccessError(404, 'SEGMENT_NOT_FOUND');
  }
  if (guestWork.guestId !== subject.id) {
    throw new AudioSegmentAccessError(403, 'FORBIDDEN');
  }
  if (guestSegment!.status !== 'ready') {
    throw new AudioSegmentAccessError(404, 'SEGMENT_NOT_READY');
  }
  return {
    segmentId: guestSegment!.id,
    storageKey: guestSegment!.storageKey,
    contentType: guestSegment!.contentType,
  };
}
