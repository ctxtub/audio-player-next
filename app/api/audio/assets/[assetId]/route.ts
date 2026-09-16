/**
 * M9-C1 T3 StoryAudio 单轨资产授权读取路由（spec §3/§4）。
 *
 * ```text
 * GET /api/audio/assets/:assetId
 * ```
 *
 * - 流程：resolve Subject → Asset（User/Guest 对称）→ Work ownership 校验 → ready
 *   门禁 → 允许才读；Trash Work 的已有 ready asset 仍允许读取；非 ready / 未知 /
 *   内部 chunk 路径 → 404。
 * - Local：200 / 206 Range（Accept-Ranges / Content-Range / Content-Length）。
 * - S3：ownership 通过 → 短时 signed URL → 307。
 * - storageKey 不作为 DTO/API 字段暴露；错误体仅固定 code。
 */

import {
  AudioObjectNotFoundError,
  StorageRangeNotSatisfiableError,
} from '@/lib/audio/storage/types';
import { getAudioAssetStorage } from '@/lib/audio/storage';
import {
  AudioAssetAccessError,
  resolveReadableAudioAssetForSubject,
  resolveSubjectFromRequest,
} from '@/lib/server/audioAssetRead';

/** 强制动态渲染（鉴权 + 按请求读存储，不可预渲染） */
export const dynamic = 'force-dynamic';

/** Node 运行时（需文件系统 / S3 SDK / Prisma） */
export const runtime = 'nodejs';

function jsonError(
  httpStatus: number,
  code: string,
  headers?: Record<string, string>,
): Response {
  return Response.json({ error: { code } }, { status: httpStatus, headers });
}

/** GET /api/audio/assets/:assetId（Next 15 params 为 Promise） */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ assetId: string }> },
): Promise<Response> {
  let assetId = '';
  try {
    assetId = (await ctx.params)?.assetId ?? '';
  } catch {
    return jsonError(404, 'ASSET_NOT_FOUND');
  }

  const subject = resolveSubjectFromRequest(req);
  if (!subject) return jsonError(401, 'UNAUTHORIZED');

  let asset;
  try {
    asset = await resolveReadableAudioAssetForSubject(subject, assetId);
  } catch (err) {
    if (err instanceof AudioAssetAccessError) return jsonError(err.httpStatus, err.code);
    return jsonError(500, 'AUDIO_READ_FAILED');
  }

  let storage;
  try {
    storage = getAudioAssetStorage();
  } catch {
    return jsonError(500, 'AUDIO_STORAGE_MISCONFIGURED');
  }

  let meta;
  try {
    meta = await storage.getMetadata(asset.storageKey);
  } catch {
    return jsonError(500, 'AUDIO_READ_FAILED');
  }
  if (!meta) return jsonError(404, 'AUDIO_OBJECT_MISSING');

  let read;
  try {
    read = await storage.resolveRead(asset.storageKey, req.headers.get('range'));
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

  if (read.kind === 'redirect') {
    return new Response(null, {
      status: 307,
      headers: { Location: read.url, 'Cache-Control': 'no-store' },
    });
  }

  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': read.contentType,
    'Content-Length': String(read.bytes.byteLength),
    'Cache-Control': 'private, max-age=3600',
  });
  if (read.range) {
    headers.set('Content-Range', `bytes ${read.range.start}-${read.range.end}/${read.totalSize}`);
    return new Response(read.bytes, { status: 206, headers });
  }
  return new Response(read.bytes, { status: 200, headers });
}
