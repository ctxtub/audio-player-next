/**
 *  Canonical Audio 授权读取路由（spec §19/§19.1–§19.3；）。
 *
 * ```text
 * GET /api/audio/segments/:segmentId
 * ```
 *
 * - 流程：resolve Subject → Segment（User/Guest 对称）→ Manifest → StoryWork
 *   ownership 校验 → 允许才读；Trash Work 的已有 ready asset 仍允许读取，
 *   Permanent deleted（row 不存在）→ 404。
 * - Local 后端：200 / 206 Range 流（Accept-Ranges / Content-Range /
 *   Content-Length / Content-Type；非法 Range → 416）。
 * - S3 后端：ownership 通过 → 短时 signed URL → 307 redirect（App 不代理 bytes）。
 * - storageKey 不作为 DTO/API 字段暴露；客户端不构造、不持久化 storageKey；
 *   S3 signed redirect 的 Location 可包含 opaque 对象 key（UUID）。错误体仅固定 code。
 */

import {
  AudioObjectNotFoundError,
  StorageRangeNotSatisfiableError,
} from '@/lib/audio/storage/types';
import { getAudioAssetStorage } from '@/lib/audio/storage';
import {
  AudioSegmentAccessError,
  resolveReadableAudioSegmentForSubject,
  resolveSubjectFromRequest,
} from '@/lib/server/audioSegmentRead';

/** 强制动态渲染（鉴权 + 按请求读存储，不可预渲染） */
export const dynamic = 'force-dynamic';

/** Node 运行时（需文件系统 / S3 SDK / Prisma） */
export const runtime = 'nodejs';

function jsonError(
  httpStatus: number,
  code: string,
  headers?: Record<string, string>
): Response {
  // 中文注释：错误体仅固定 code，不携带 storageKey/路径等任何内部标识。
  return Response.json({ error: { code } }, { status: httpStatus, headers });
}

/**
 * GET /api/audio/segments/:segmentId（Next 15 params 为 Promise）
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ segmentId: string }> }
): Promise<Response> {
  let segmentId = '';
  try {
    segmentId = (await ctx.params)?.segmentId ?? '';
  } catch {
    return jsonError(404, 'SEGMENT_NOT_FOUND');
  }

  const subject = resolveSubjectFromRequest(req);
  if (!subject) {
    return jsonError(401, 'UNAUTHORIZED');
  }

  let segment;
  try {
    segment = await resolveReadableAudioSegmentForSubject(subject, segmentId);
  } catch (err) {
    if (err instanceof AudioSegmentAccessError) {
      return jsonError(err.httpStatus, err.code);
    }
    return jsonError(500, 'AUDIO_READ_FAILED');
  }

  let storage;
  try {
    storage = getAudioAssetStorage();
  } catch {
    return jsonError(500, 'AUDIO_STORAGE_MISCONFIGURED');
  }

  // 中文注释：DB ready 但 object 缺失视为 corruption → 404，且不改写任何 DB 状态
  //（ 只读已有资产；recovery 留）。
  // getMetadata 抛错 = 存储故障（非 corruption）→ 500，不得降级为 404（spec §45）。
  let meta;
  try {
    meta = await storage.getMetadata(segment.storageKey);
  } catch {
    return jsonError(500, 'AUDIO_READ_FAILED');
  }
  if (!meta) {
    return jsonError(404, 'AUDIO_OBJECT_MISSING');
  }

  let read;
  try {
    read = await storage.resolveRead(segment.storageKey, req.headers.get('range'));
  } catch (err) {
    if (err instanceof AudioObjectNotFoundError) {
      return jsonError(404, 'AUDIO_OBJECT_MISSING');
    }
    if (err instanceof StorageRangeNotSatisfiableError) {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${err.totalSize}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }
    return jsonError(500, 'AUDIO_READ_FAILED');
  }

  // S3 后端：307 短时签名 redirect（App 不代理 S3 bytes，spec §19.3）
  if (read.kind === 'redirect') {
    return new Response(null, {
      status: 307,
      headers: {
        Location: read.url,
        'Cache-Control': 'no-store',
      },
    });
  }

  // Local 后端：200 / 206 Range 流（spec §19.2）
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': read.contentType,
    'Content-Length': String(read.bytes.byteLength),
    'Cache-Control': 'private, max-age=3600',
  });
  if (read.range) {
    headers.set(
      'Content-Range',
      `bytes ${read.range.start}-${read.range.end}/${read.totalSize}`
    );
    return new Response(read.bytes, { status: 206, headers });
  }
  return new Response(read.bytes, { status: 200, headers });
}
