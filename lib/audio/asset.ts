/**
 *   StoryAudio 单轨资产纯领域层（spec §4）。
 *
 * 只放类型、常量与纯函数：identity、内部 chunk 计划与校验、拼接、30 天滑动 TTL、
 * positionMs clamp/节流决策。不触 DB、不调 TTS、不读 storage，可被 server/测试共用。
 */

import { computeStoryContentHash } from '@/utils/segmentation';
import { getMp3DurationMs } from './duration';
import { CANONICAL_AUDIO_CONTENT_TYPE, type CanonicalAudioProfile } from './profile';

/** 30 天滑动 TTL（spec §4：ready Asset 30 天未授权访问即过期）。 */
export const SINGLE_TRACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** lastAccessedAt 刷新限频：授权读取距上次刷新不足此间隔不写库（防高频读放大写）。 */
export const SINGLE_TRACK_LAST_ACCESS_REFRESH_MS = 60 * 60 * 1000;

/** positionMs 常规落库节流 10 秒；暂停/切曲/结束/隐藏走 force。 */
export const SINGLE_TRACK_PROGRESS_THROTTLE_MS = 10_000;

/** 单 chunk 文本上限（TTS 单请求安全长度）；长文按句边界再按硬上限切分。 */
export const SINGLE_TRACK_MAX_CHUNK_CHARS = 180;

/** 内部临时 chunk 对象的 key 中段（无任何读取路由，spec §4）。 */
export const SINGLE_TRACK_CHUNK_KEY_SEGMENT = '/chunks/';

/** 单轨资产冻结身份（spec §3：contentHash + voice + provider/model/synthesisVersion + format；倍速不进入）。 */
export type AssetIdentity = {
  contentHash: string;
  voiceId: string;
  ttsBackendId: string;
  ttsModel: string;
  synthesisVersion: string;
  audioFormat: string;
};

/** 身份字段顺序（identity key 序列化唯一顺序；增减必须同步更新单测）。 */
export const ASSET_IDENTITY_FIELDS = [
  'contentHash',
  'voiceId',
  'ttsBackendId',
  'ttsModel',
  'synthesisVersion',
  'audioFormat',
] as const satisfies ReadonlyArray<keyof AssetIdentity>;

/** 由 Work 快照 + 冻结 profile 组合单轨 identity（纯函数）。 */
export function buildAssetIdentity(
  story: Pick<AssetIdentity, 'contentHash'>,
  profile: CanonicalAudioProfile,
): AssetIdentity {
  return {
    contentHash: story.contentHash,
    voiceId: profile.voiceId,
    ttsBackendId: profile.ttsBackendId,
    ttsModel: profile.ttsModel,
    synthesisVersion: profile.synthesisVersion,
    audioFormat: profile.audioFormat,
  };
}

/** 身份稳定 key（字段固定顺序 JSON）。 */
export function computeAssetIdentityKey(identity: AssetIdentity): string {
  const ordered: Record<string, string> = {};
  for (const field of ASSET_IDENTITY_FIELDS) ordered[field] = identity[field];
  return JSON.stringify(ordered);
}

/** 身份相等判定。 */
export function isSameAssetIdentity(a: AssetIdentity, b: AssetIdentity): boolean {
  return computeAssetIdentityKey(a) === computeAssetIdentityKey(b);
}

/** 冻结 TTS profile 的稳定 hash（落库 ttsProfileHash；短哈希足够，非安全用途）。 */
export function computeTtsProfileHash(profile: CanonicalAudioProfile): string {
  return computeStoryContentHash(
    JSON.stringify([
      profile.voiceId,
      profile.ttsBackendId,
      profile.ttsModel,
      profile.synthesisVersion,
      profile.audioFormat,
      profile.synthesisSpeed,
    ]),
  );
}

/** 发布对象 opaque key（不编码业务身份）。 */
export function buildAssetStorageKey(assetId: string): string {
  return `story-audio/${assetId}.mp3`;
}

/** 内部临时 chunk 对象 key（有独立前缀，无读取路由）。 */
export function buildAssetChunkStorageKey(assetId: string, index: number): string {
  return `story-audio/chunks/${assetId}/${index}.mp3`;
}

/** 唯一授权播放 URL（单资产读取路由）。 */
export function buildAssetPlaybackUrl(assetId: string): string {
  return `/api/audio/assets/${assetId}`;
}

/** 是否内部临时 chunk key（任何路由都不得据此授权）。 */
export function isInternalChunkStorageKey(key: string): boolean {
  return key.startsWith('story-audio/chunks/') || key.includes(SINGLE_TRACK_CHUNK_KEY_SEGMENT);
}

/**
 * 把正文切成内部 chunk（纯函数）。
 *
 * 规则：先按句末标点/换行切句，再按 `maxChars` 贪心聚合；超长单句硬切。
 * **不变式**：`plan.join('') === text`（调用方必须校验），保证拼接不丢字。
 * @param text 规整后的正文
 * @param maxChars 单 chunk 上限
 * @returns 非空 chunk 文本数组（空正文返回 []）
 */
export function planAssetTextChunks(
  text: string,
  maxChars: number = SINGLE_TRACK_MAX_CHUNK_CHARS,
): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : SINGLE_TRACK_MAX_CHUNK_CHARS;
  const sentences = text.split(/(?<=[。！？!?；;\n])/);
  const chunks: string[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer.length > 0) {
      chunks.push(buffer);
      buffer = '';
    }
  };
  for (const sentence of sentences) {
    if (sentence.length === 0) continue;
    if (sentence.length > limit) {
      flush();
      for (let i = 0; i < sentence.length; i += limit) {
        chunks.push(sentence.slice(i, i + limit));
      }
      continue;
    }
    if (buffer.length + sentence.length > limit) flush();
    buffer += sentence;
  }
  flush();
  return chunks;
}

/** chunk 计划不变式校验（纯函数）：非空、逐项非空、拼接守恒。 */
export function isValidChunkPlan(text: string, chunks: string[]): boolean {
  if (!Array.isArray(chunks) || chunks.length === 0) return false;
  if (chunks.some((c) => typeof c !== 'string' || c.length === 0)) return false;
  return chunks.join('') === text;
}

/** chunk 音频格式校验结果。 */
export type ChunkValidation =
  | { ok: true; durationMs: number; byteLength: number }
  | { ok: false; reason: string };

/**
 * 校验单个 TTS chunk 音频（纯函数）：非空 + 可解析出有效 MP3 帧时长。
 * @param bytes TTS 返回的音频字节
 */
export function validateChunkAudio(bytes: Uint8Array): ChunkValidation {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return { ok: false, reason: 'EMPTY_CHUNK_AUDIO' };
  }
  try {
    const durationMs = getMp3DurationMs(bytes);
    return { ok: true, durationMs, byteLength: bytes.length };
  } catch {
    return { ok: false, reason: 'INVALID_CHUNK_AUDIO' };
  }
}

/**
 * 拼接内部 chunk 为单一整轨字节（纯函数）。
 * MP3 为帧流，逐 chunk 顺序拼接后 `getMp3DurationMs` 可连续扫描得到总时长。
 * @param chunks 已校验通过的 chunk 字节
 * @throws {Error} 空输入（调用方必须先逐 chunk 校验）
 */
export function concatAudioChunks(chunks: Uint8Array[]): Uint8Array {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('concatAudioChunks: empty chunks');
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

/** canonical content-type 出口（与 profile 同源）。 */
export const SINGLE_TRACK_CONTENT_TYPE = CANONICAL_AUDIO_CONTENT_TYPE;

/** TTL 锚点：优先最近授权访问时间，缺省 fallback 到 readyAt。 */
export function resolveTtlAnchor(
  readyAt: Date | null | undefined,
  lastAccessedAt: Date | null | undefined,
): Date | null {
  return lastAccessedAt ?? readyAt ?? null;
}

/**
 * ready 资产是否已过 30 天滑动 TTL（纯函数）。
 * 无锚点（未 ready）视为未过期（由 status 决定）。
 */
export function isSingleTrackAssetExpired(input: {
  readyAt: Date | null | undefined;
  lastAccessedAt: Date | null | undefined;
  now: Date;
  ttlMs?: number;
}): boolean {
  const anchor = resolveTtlAnchor(input.readyAt, input.lastAccessedAt);
  if (anchor === null) return false;
  const ttl = input.ttlMs ?? SINGLE_TRACK_TTL_MS;
  return input.now.getTime() - anchor.getTime() >= ttl;
}

/** 授权读取是否应刷新 lastAccessedAt（限频；null 首次读取也应刷新）。 */
export function shouldRefreshLastAccess(
  lastAccessedAt: Date | null | undefined,
  now: Date,
  refreshMs: number = SINGLE_TRACK_LAST_ACCESS_REFRESH_MS,
): boolean {
  if (!lastAccessedAt) return true;
  return now.getTime() - lastAccessedAt.getTime() >= refreshMs;
}

/** positionMs clamp 到 `[0, durationMs]`（非有限数归零）。 */
export function clampPositionMs(
  positionMs: number,
  durationMs: number | null | undefined,
): number {
  if (typeof positionMs !== 'number' || !Number.isFinite(positionMs) || positionMs < 0) return 0;
  const floor = Math.floor(positionMs);
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    return Math.min(floor, Math.floor(durationMs));
  }
  return floor;
}

/**
 * 是否应把本次进度写入 DB（纯函数）：单调守卫 + 节流 + force（暂停/切曲/结束/隐藏）。
 * @returns true 表示应写
 */
export function shouldPersistPosition(input: {
  positionMs: number;
  previousPositionMs: number | null | undefined;
  lastWriteAt: Date | null | undefined;
  now: Date;
  force?: boolean;
  throttleMs?: number;
}): boolean {
  if (
    typeof input.previousPositionMs === 'number' &&
    Number.isFinite(input.previousPositionMs) &&
    input.positionMs < input.previousPositionMs
  ) {
    return false;
  }
  if (input.force === true) return true;
  if (!input.lastWriteAt) return true;
  const throttle = input.throttleMs ?? SINGLE_TRACK_PROGRESS_THROTTLE_MS;
  return input.now.getTime() - input.lastWriteAt.getTime() >= throttle;
}
