/**
 * M9-C1 T3 StoryAudio 单轨资产服务（User/Guest 双主体）。
 *
 * 链路（spec §3/§4）：
 * ```text
 * Work → 冻结 identity → 复用/claim → 内部文本 chunk → 逐 chunk TTS+校验
 * → 临时对象暂存 → 拼接整轨 → duration/checksum → 单对象 put → CAS ready
 * → 清理临时 chunk；失败则整资产 failed + 清理临时对象
 * ```
 * 约束（写死）：
 * - 一 Work 一 canonical track：对外只暴露一个 assetId 与一条时间轴；
 * - **禁止 SQLite transaction 跨 TTS/网络**：claim 为单条 updateMany，合成/put 全在事务外；
 * - 内部 chunk 为临时对象（`story-audio/chunks/<assetId>/<i>.mp3`），无读取路由、
 *   不写进度、不刷新 TTL，发布/失败后必须清理；
 * - TTL = 30 天滑动（lastAccessedAt），授权读取限频刷新；GC 跳过 preparing/有效 lease；
 * - lease fencing：pre-put renew + post-put CAS，失败者不得覆盖新结果。
 */

import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { prisma } from '@/lib/db';
import type { Subject } from '@/lib/server/subject';
import { computeStoryContentHash, normalizeStoryText } from '@/utils/segmentation';
import {
  CANONICAL_SYNTHESIS_SPEED,
  freezeCanonicalAudioProfile,
  resolveManifestVoiceId,
  resolveTtsBackendId,
  resolveTtsModel,
  type CanonicalAudioProfile,
} from '@/lib/audio/profile';
import { computeAudioChecksum } from '@/lib/audio/checksum';
import { getMp3DurationMs } from '@/lib/audio/duration';
import { getAudioAssetStorage } from '@/lib/audio/storage';
import type { AudioAssetStorage } from '@/lib/audio/storage/types';
import {
  AUDIO_DELETION_DEFAULT_LIMIT,
  cleanupAudioStorageKeys,
  enqueueAudioDeletionTombstones,
} from '@/lib/server/audioStorageCleanup';
import { isValidPlaybackSessionId } from '@/lib/playback/session';
import {
  getTtsConfig,
  synthesizeSpeechWithProfile,
  type CanonicalTtsSynthesizer,
} from '@/lib/server/openai';
import {
  buildAssetChunkStorageKey,
  buildAssetIdentity,
  buildAssetPlaybackUrl,
  buildAssetStorageKey,
  clampPositionMs,
  computeAssetIdentityKey,
  computeTtsProfileHash,
  concatAudioChunks,
  isSingleTrackAssetExpired,
  isValidChunkPlan,
  planAssetTextChunks,
  shouldPersistPosition,
  shouldRefreshLastAccess,
  validateChunkAudio,
} from '@/lib/audio/asset';

/** 单轨资产世代（V1 内容不可改，正常恒 1）。 */
export const STORY_AUDIO_ASSET_VERSION = 1;

/** 合成租约 TTL（与 M8 同口径）。 */
export const STORY_AUDIO_ASSET_LEASE_TTL_MS = 60_000;

/** 竞态重试提示（客户端轮询间隔）。 */
export const STORY_AUDIO_ASSET_RETRY_AFTER_MS = 500;

/** 服务依赖（与 StoryAudioDeps 同形，便于在 ensureSegment 入口透传注入）。 */
export type StoryAudioAssetDeps = {
  storage?: AudioAssetStorage;
  synthesize?: CanonicalTtsSynthesizer;
  now?: () => Date;
  generateId?: () => string;
};

type ResolvedDeps = {
  storage: AudioAssetStorage;
  synthesize: CanonicalTtsSynthesizer;
  now: () => Date;
  generateId: () => string;
};

function resolveDeps(input: StoryAudioAssetDeps): ResolvedDeps {
  return {
    storage: input.storage ?? getAudioAssetStorage(),
    synthesize: input.synthesize ?? synthesizeSpeechWithProfile,
    now: input.now ?? (() => new Date()),
    generateId: input.generateId ?? randomUUID,
  };
}

function throwDomain(domain: string, code: TRPCError['code']): never {
  throw new TRPCError({ code, message: domain });
}

/**
 * Prisma User/Guest twin delegate 的结构同形最小面。
 * union 的两个 delegate 调用签名互不兼容（TS2349），故收敛为结构类型后按 subject 选择；
 * 运行时行为与逐分支调用完全一致（同表同列，仅表名不同）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- twin delegate 结构同形，无共享基类可引用 */
type TwinDelegate = {
  findUnique(args: any): Promise<any>;
  findMany(args: any): Promise<any[]>;
  updateMany(args: any): Promise<{ count: number }>;
  update(args: any): Promise<any>;
  create(args: any): Promise<any>;
  upsert(args: any): Promise<any>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function assetDelegate(subjectType: 'user' | 'guest'): TwinDelegate {
  return (
    subjectType === 'user' ? prisma.storyAudioAsset : prisma.guestStoryAudioAsset
  ) as unknown as TwinDelegate;
}

function progressDelegate(subjectType: 'user' | 'guest'): TwinDelegate {
  return (
    subjectType === 'user' ? prisma.storyAudioProgress : prisma.guestStoryAudioProgress
  ) as unknown as TwinDelegate;
}

type OwnedWork = {
  kind: 'user' | 'guest';
  id: number;
  storyText: string;
  voiceId: string;
  contentHash: string;
  deletedAt: Date | null;
};

async function resolveOwnedWork(subject: Subject, workId: number): Promise<OwnedWork> {
  if (subject.type === 'user') {
    const work = await prisma.storyWork.findFirst({
      where: { id: workId, userId: subject.id },
      select: {
        id: true,
        storyText: true,
        voiceId: true,
        contentHash: true,
        deletedAt: true,
      },
    });
    if (!work) throwDomain('WORK_NOT_FOUND', 'NOT_FOUND');
    return { kind: 'user', ...work };
  }
  const work = await prisma.guestStoryWork.findFirst({
    where: { id: workId, guestId: subject.id },
    select: {
      id: true,
      storyText: true,
      voiceId: true,
      contentHash: true,
      deletedAt: true,
    },
  });
  if (!work) throwDomain('WORK_NOT_FOUND', 'NOT_FOUND');
  return { kind: 'guest', ...work };
}

async function enforceTrashGate(
  subject: Subject,
  work: OwnedWork,
  sessionId: string,
): Promise<void> {
  if (work.deletedAt === null) return;
  if (!isValidPlaybackSessionId(sessionId)) throwDomain('WORK_UNAVAILABLE', 'FORBIDDEN');
  const wantSourceId = String(work.id);
  if (subject.type === 'user') {
    const anchor = await prisma.userPlaybackAnchor.findUnique({
      where: { userId: subject.id },
      select: { sourceKind: true, sourceId: true, sessionId: true },
    });
    if (
      anchor &&
      (anchor.sourceKind === 'work' || anchor.sourceKind === 'generation') &&
      anchor.sourceId === wantSourceId &&
      anchor.sessionId === sessionId
    ) {
      return;
    }
    throwDomain('WORK_UNAVAILABLE', 'FORBIDDEN');
  }
  const anchor = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: subject.id },
    select: { sourceKind: true, sourceId: true, sessionId: true },
  });
  if (
    anchor &&
    (anchor.sourceKind === 'work' || anchor.sourceKind === 'generation') &&
    anchor.sourceId === wantSourceId &&
    anchor.sessionId === sessionId
  ) {
    return;
  }
  throwDomain('WORK_UNAVAILABLE', 'FORBIDDEN');
}

/** 对外单轨资产投影（一个授权 Asset/总时长/时间轴）。 */
export type StoryAudioAssetDTO = {
  assetId: string;
  workId: number;
  status: 'ready';
  version: number;
  contentHash: string;
  voiceId: string;
  ttsProfileHash: string;
  synthesisVersion: string;
  audioFormat: string;
  chunkCount: number;
  durationMs: number;
  byteLength: number;
  checksum: string;
  contentType: string;
  playbackUrl: string;
  positionMs: number;
  readyAt: string;
};

export type EnsureStoryAudioAssetResult =
  | { status: 'ready'; asset: StoryAudioAssetDTO; retryAfterMs: null }
  | { status: 'preparing'; asset: null; retryAfterMs: number };

/** 读取投影（无资产 → missing 空投影；不回填）。 */
export type StoryAudioAssetProjectionDTO = {
  workId: number;
  status: 'missing' | 'preparing' | 'ready' | 'failed';
  assetId: string | null;
  version: number;
  contentHash: string;
  voiceId: string;
  ttsProfileHash: string;
  synthesisVersion: string;
  audioFormat: string;
  chunkCount: number;
  durationMs: number | null;
  byteLength: number | null;
  checksum: string | null;
  positionMs: number;
  completedAt: string | null;
  playbackUrl: string | null;
  readyAt: string | null;
};

function identityKeyFor(work: OwnedWork, profile: CanonicalAudioProfile): string {
  const identity = buildAssetIdentity({ contentHash: work.contentHash }, profile);
  return computeAssetIdentityKey(identity);
}

function resolveFrozenProfile(work: OwnedWork): CanonicalAudioProfile {
  let defaultVoice: string;
  try {
    defaultVoice = getTtsConfig().voiceId;
  } catch {
    throwDomain('AUDIO_PROFILE_UNAVAILABLE', 'INTERNAL_SERVER_ERROR');
  }
  const frozenVoice = resolveManifestVoiceId(work.voiceId, defaultVoice);
  return freezeCanonicalAudioProfile({
    voiceId: frozenVoice,
    ttsBackendId: resolveTtsBackendId(),
    ttsModel: resolveTtsModel(),
  });
}

function toAssetDTO(input: {
  assetId: string;
  workId: number;
  version: number;
  contentHash: string;
  voiceId: string;
  ttsProfileHash: string;
  synthesisVersion: string;
  audioFormat: string;
  chunkCount: number;
  durationMs: number;
  byteLength: number;
  checksum: string;
  contentType: string;
  positionMs: number;
  readyAt: Date;
}): StoryAudioAssetDTO {
  return {
    assetId: input.assetId,
    workId: input.workId,
    status: 'ready',
    version: input.version,
    contentHash: input.contentHash,
    voiceId: input.voiceId,
    ttsProfileHash: input.ttsProfileHash,
    synthesisVersion: input.synthesisVersion,
    audioFormat: input.audioFormat,
    chunkCount: input.chunkCount,
    durationMs: input.durationMs,
    byteLength: input.byteLength,
    checksum: input.checksum,
    contentType: input.contentType,
    playbackUrl: buildAssetPlaybackUrl(input.assetId),
    positionMs: input.positionMs,
    readyAt: input.readyAt.toISOString(),
  };
}

async function readProgressPosition(
  subject: Subject,
  workId: number,
): Promise<{ positionMs: number; completedAt: Date | null }> {
  if (subject.type === 'user') {
    const row = await prisma.storyAudioProgress.findUnique({
      where: { storyWorkId: workId },
      select: { positionMs: true, completedAt: true },
    });
    return { positionMs: row?.positionMs ?? 0, completedAt: row?.completedAt ?? null };
  }
  const row = await prisma.guestStoryAudioProgress.findUnique({
    where: { storyWorkId: workId },
    select: { positionMs: true, completedAt: true },
  });
  return { positionMs: row?.positionMs ?? 0, completedAt: row?.completedAt ?? null };
}

async function cleanupChunkObjects(
  storage: AudioAssetStorage,
  assetId: string,
  chunkCount: number,
): Promise<void> {
  if (chunkCount <= 0) return;
  const keys: string[] = [];
  for (let i = 0; i < chunkCount; i += 1) keys.push(buildAssetChunkStorageKey(assetId, i));
  try {
    await cleanupAudioStorageKeys(keys, { storage });
  } catch {
    // 清理失败留待 tombstone/机会式清理，不污染主结果
  }
}

// ---------------------------------------------------------------------------
// ensure（process 内 single-flight + DB lease fencing）
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<EnsureStoryAudioAssetResult>>();

/** 取消进行中的 single-flight（仅测试 hook 用）。 */
export function __resetStoryAudioAssetTestHooks(): void {
  inflight.clear();
}

/**
 * ensure 单轨资产（唯一写入口）。
 *
 * @param subject 身份主体
 * @param input `{ workId, sessionId }`（不接受 client text/profile/storageKey）
 * @param depsInput 可注入依赖（storage/synthesize/now/generateId）
 */
export async function ensureStoryAudioAssetForSubject(
  subject: Subject,
  input: { workId: number; sessionId: string },
  depsInput: StoryAudioAssetDeps = {},
): Promise<EnsureStoryAudioAssetResult> {
  const flightKey = `${subject.type}:${subject.id}:${input.workId}`;
  const existing = inflight.get(flightKey);
  if (existing) return existing;
  const run = ensureStoryAudioAssetInternal(subject, input, depsInput);
  const wrapped = run.finally(() => {
    if (inflight.get(flightKey) === wrapped) inflight.delete(flightKey);
  });
  inflight.set(flightKey, wrapped);
  return wrapped;
}

async function ensureStoryAudioAssetInternal(
  subject: Subject,
  input: { workId: number; sessionId: string },
  depsInput: StoryAudioAssetDeps,
): Promise<EnsureStoryAudioAssetResult> {
  const deps = resolveDeps(depsInput);
  const { workId, sessionId } = input;
  if (!Number.isInteger(workId) || workId <= 0) {
    throwDomain('WORK_NOT_FOUND', 'NOT_FOUND');
  }
  if (!isValidPlaybackSessionId(sessionId)) {
    throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');
  }
  const work = await resolveOwnedWork(subject, workId);
  await enforceTrashGate(subject, work, sessionId);

  const normalized = normalizeStoryText(work.storyText);
  const expectedHash = computeStoryContentHash(normalized);
  if (work.contentHash && work.contentHash !== expectedHash) {
    throwDomain('WORK_UNAVAILABLE', 'FORBIDDEN');
  }
  const contentHash = work.contentHash || expectedHash;
  const chunks = planAssetTextChunks(normalized);
  if (chunks.length === 0 || !isValidChunkPlan(normalized, chunks)) {
    throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');
  }
  const profile = resolveFrozenProfile(work);
  const ttsProfileHash = computeTtsProfileHash(profile);
  const identityKey = identityKeyFor({ ...work, contentHash }, profile);

  const table = assetDelegate(subject.type);
  const now = deps.now();

  let row = await table.findUnique({
    where: { storyWorkId_version: { storyWorkId: work.id, version: STORY_AUDIO_ASSET_VERSION } },
  });

  // ready 快速路径：identity 一致 + 未过期 + 对象存在 → 复用（限频刷新 lastAccessedAt）。
  if (
    row &&
    row.status === 'ready' &&
    row.storageKey &&
    row.durationMs !== null &&
    row.byteLength !== null &&
    row.checksum !== null
  ) {
    const sameIdentity = row.ttsProfileHash === ttsProfileHash && row.contentHash === contentHash;
    const expired = isSingleTrackAssetExpired({
      readyAt: row.readyAt,
      lastAccessedAt: row.lastAccessedAt,
      now,
    });
    if (sameIdentity && !expired) {
      const exists = await deps.storage.exists(row.storageKey);
      if (exists) {
        if (shouldRefreshLastAccess(row.lastAccessedAt, now)) {
          await table.updateMany({
            where: { id: row.id },
            data: { lastAccessedAt: now },
          });
        }
        const progress = await readProgressPosition(subject, work.id);
        return {
          status: 'ready',
          retryAfterMs: null,
          asset: toAssetDTO({
            assetId: row.id,
            workId: work.id,
            version: row.version,
            contentHash: row.contentHash,
            voiceId: row.voiceId,
            ttsProfileHash: row.ttsProfileHash,
            synthesisVersion: row.synthesisVersion,
            audioFormat: row.audioFormat,
            chunkCount: row.chunkCount,
            durationMs: row.durationMs,
            byteLength: row.byteLength,
            checksum: row.checksum,
            contentType: row.contentType,
            positionMs: progress.positionMs,
            readyAt: row.readyAt ?? now,
          }),
        };
      }
      // 对象缺失 = 损坏：降级 failed，落到 claim 重建。
      row = await table.update({
        where: { id: row.id },
        data: { status: 'failed', leaseId: null, leaseExpiresAt: null, lastErrorCode: 'AUDIO_OBJECT_MISSING' },
      });
    }
    // 过期或 identity 变化：降级 missing 以便重新 claim（旧对象保留至新对象发布）。
    if (row.status === 'ready') {
      row = await table.update({ where: { id: row.id }, data: { status: 'missing' } });
    }
  }

  // 有效 lease → 返回 preparing。
  if (row && row.status === 'preparing' && row.leaseExpiresAt && row.leaseExpiresAt.getTime() > now.getTime()) {
    return { status: 'preparing', asset: null, retryAfterMs: STORY_AUDIO_ASSET_RETRY_AFTER_MS };
  }

  // 无行 → 先建 missing 行（零 TTS）；P2002 竞态 → 读赢家。
  if (!row) {
    const newId = deps.generateId();
    try {
      row = await table.create({
        data: {
          id: newId,
          storyWorkId: work.id,
          version: STORY_AUDIO_ASSET_VERSION,
          status: 'missing',
          contentHash,
          voiceId: profile.voiceId,
          ttsProfileHash,
          synthesisVersion: profile.synthesisVersion,
          audioFormat: profile.audioFormat,
          chunkCount: chunks.length,
          storageKey: buildAssetStorageKey(newId),
          contentType: 'audio/mpeg',
        },
      });
    } catch {
      row = await table.findUnique({
        where: { storyWorkId_version: { storyWorkId: work.id, version: STORY_AUDIO_ASSET_VERSION } },
      });
      if (!row) throwDomain('AUDIO_STORAGE_FAILED', 'INTERNAL_SERVER_ERROR');
    }
  }

  // 原子 claim（单条 updateMany；无 transaction）。
  const leaseId = deps.generateId();
  const leaseExpiresAt = new Date(now.getTime() + STORY_AUDIO_ASSET_LEASE_TTL_MS);
  const claim = await table.updateMany({
    where: {
      id: row.id,
      OR: [
        { status: 'missing' },
        { status: 'failed' },
        { status: 'preparing', leaseExpiresAt: null },
        { status: 'preparing', leaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      status: 'preparing',
      leaseId,
      leaseExpiresAt,
      attemptCount: { increment: 1 },
      lastErrorCode: null,
      contentHash,
      voiceId: profile.voiceId,
      ttsProfileHash,
      synthesisVersion: profile.synthesisVersion,
      audioFormat: profile.audioFormat,
      chunkCount: chunks.length,
    },
  });
  if (claim.count === 0) {
    return { status: 'preparing', asset: null, retryAfterMs: STORY_AUDIO_ASSET_RETRY_AFTER_MS };
  }

  const claimed = await table.findUnique({ where: { id: row.id } });
  if (!claimed) throwDomain('AUDIO_STORAGE_FAILED', 'INTERNAL_SERVER_ERROR');
  const assetId = claimed.id;
  // 过期重建/identity 变化 → 换新 key，旧对象由旧行引用先保留。
  let storageKey = claimed.storageKey;
  if (
    claimed.contentHash !== contentHash ||
    claimed.ttsProfileHash !== ttsProfileHash ||
    !storageKey ||
    storageKey.length === 0
  ) {
    storageKey = buildAssetStorageKey(assetId);
  }
  void identityKey;

  const stagedChunkKeys: string[] = [];
  try {
    const chunkBytes: Uint8Array[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      let audioData: ArrayBuffer;
      try {
        const synth = await deps.synthesize({
          text: chunks[i],
          model: profile.ttsModel,
          voiceId: profile.voiceId,
          speed: CANONICAL_SYNTHESIS_SPEED,
          format: profile.audioFormat,
        });
        audioData = synth.audioData;
      } catch {
        throwDomain('AUDIO_SYNTHESIS_FAILED', 'INTERNAL_SERVER_ERROR');
      }
      const bytes = new Uint8Array(audioData);
      const validation = validateChunkAudio(bytes);
      if (!validation.ok) throwDomain('AUDIO_SYNTHESIS_FAILED', 'INTERNAL_SERVER_ERROR');
      const chunkKey = buildAssetChunkStorageKey(assetId, i);
      await deps.storage.put({ key: chunkKey, bytes, contentType: 'audio/mpeg' });
      stagedChunkKeys.push(chunkKey);
      chunkBytes.push(bytes);
    }

    const merged = concatAudioChunks(chunkBytes);
    let durationMs: number;
    try {
      durationMs = getMp3DurationMs(merged);
    } catch {
      throwDomain('AUDIO_SYNTHESIS_FAILED', 'INTERNAL_SERVER_ERROR');
    }
    const checksum = computeAudioChecksum(merged);
    const byteLength = merged.length;

    // pre-put fencing renew。
    const renew = await table.updateMany({
      where: { id: assetId, leaseId, status: 'preparing' },
      data: { leaseExpiresAt: new Date(deps.now().getTime() + STORY_AUDIO_ASSET_LEASE_TTL_MS) },
    });
    if (renew.count === 0) {
      await cleanupChunkObjects(deps.storage, assetId, chunks.length);
      return { status: 'preparing', asset: null, retryAfterMs: STORY_AUDIO_ASSET_RETRY_AFTER_MS };
    }

    try {
      await deps.storage.put({ key: storageKey, bytes: merged, contentType: 'audio/mpeg' });
    } catch {
      throwDomain('AUDIO_STORAGE_FAILED', 'INTERNAL_SERVER_ERROR');
    }

    const readyAt = deps.now();
    const cas = await table.updateMany({
      where: { id: assetId, leaseId },
      data: {
        status: 'ready',
        storageKey,
        byteLength,
        durationMs,
        checksum,
        contentType: 'audio/mpeg',
        readyAt,
        lastAccessedAt: readyAt,
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
      },
    });
    if (cas.count === 0) {
      await deps.storage.delete(storageKey).catch(() => undefined);
      await cleanupChunkObjects(deps.storage, assetId, chunks.length);
      return { status: 'preparing', asset: null, retryAfterMs: STORY_AUDIO_ASSET_RETRY_AFTER_MS };
    }

    await cleanupChunkObjects(deps.storage, assetId, chunks.length);
    const progress = await readProgressPosition(subject, work.id);
    return {
      status: 'ready',
      retryAfterMs: null,
      asset: toAssetDTO({
        assetId,
        workId: work.id,
        version: STORY_AUDIO_ASSET_VERSION,
        contentHash,
        voiceId: profile.voiceId,
        ttsProfileHash,
        synthesisVersion: profile.synthesisVersion,
        audioFormat: profile.audioFormat,
        chunkCount: chunks.length,
        durationMs,
        byteLength,
        checksum,
        contentType: 'audio/mpeg',
        positionMs: progress.positionMs,
        readyAt,
      }),
    };
  } catch (err) {
    await cleanupChunkObjects(deps.storage, assetId, chunks.length);
    await table
      .updateMany({
        where: { id: assetId, leaseId },
        data: { status: 'failed', leaseId: null, leaseExpiresAt: null, lastErrorCode: 'AUDIO_SYNTHESIS_FAILED' },
      })
      .catch(() => undefined);
    if (err instanceof TRPCError) throw err;
    throwDomain('AUDIO_SYNTHESIS_FAILED', 'INTERNAL_SERVER_ERROR');
  }
}

// ---------------------------------------------------------------------------
// 投影读取
// ---------------------------------------------------------------------------

/**
 * 读取单轨资产投影（只读；无资产 → missing 空投影）。
 * ready 且对象可用时按限频刷新 lastAccessedAt（滑动 TTL）。
 */
export async function getStoryAudioAssetProjectionForSubject(
  subject: Subject,
  input: { workId: number },
  depsInput: StoryAudioAssetDeps = {},
): Promise<StoryAudioAssetProjectionDTO> {
  const deps = resolveDeps(depsInput);
  const { workId } = input;
  if (!Number.isInteger(workId) || workId <= 0) throwDomain('WORK_NOT_FOUND', 'NOT_FOUND');
  const work = await resolveOwnedWork(subject, workId);
  const table = assetDelegate(subject.type);
  const row = await table.findUnique({
    where: { storyWorkId_version: { storyWorkId: work.id, version: STORY_AUDIO_ASSET_VERSION } },
  });
  const progress = await readProgressPosition(subject, work.id);
  if (!row) {
    return {
      workId: work.id,
      status: 'missing',
      assetId: null,
      version: STORY_AUDIO_ASSET_VERSION,
      contentHash: work.contentHash,
      voiceId: work.voiceId,
      ttsProfileHash: '',
      synthesisVersion: '',
      audioFormat: 'mp3',
      chunkCount: 0,
      durationMs: null,
      byteLength: null,
      checksum: null,
      positionMs: progress.positionMs,
      completedAt: progress.completedAt ? progress.completedAt.toISOString() : null,
      playbackUrl: null,
      readyAt: null,
    };
  }
  const now = deps.now();
  const ready = row.status === 'ready' && row.durationMs !== null && row.byteLength !== null;
  if (ready && shouldRefreshLastAccess(row.lastAccessedAt, now)) {
    await table.updateMany({ where: { id: row.id }, data: { lastAccessedAt: now } });
  }
  return {
    workId: work.id,
    status: row.status as StoryAudioAssetProjectionDTO['status'],
    assetId: ready ? row.id : null,
    version: row.version,
    contentHash: row.contentHash,
    voiceId: row.voiceId,
    ttsProfileHash: row.ttsProfileHash,
    synthesisVersion: row.synthesisVersion,
    audioFormat: row.audioFormat,
    chunkCount: row.chunkCount,
    durationMs: row.durationMs,
    byteLength: row.byteLength,
    checksum: row.checksum,
    positionMs: progress.positionMs,
    completedAt: progress.completedAt ? progress.completedAt.toISOString() : null,
    playbackUrl: ready ? buildAssetPlaybackUrl(row.id) : null,
    readyAt: row.readyAt ? row.readyAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// 秒级进度（positionMs）
// ---------------------------------------------------------------------------

/**
 * 写入 positionMs 进度（服务端 clamp + sessionId 校验 + 单调守卫 + 节流决策）。
 * @returns 是否实际写库
 */
export async function saveStoryAudioProgressForSubject(
  subject: Subject,
  input: { workId: number; sessionId: string; positionMs: number; durationMs?: number | null; force?: boolean },
  depsInput: StoryAudioAssetDeps = {},
): Promise<boolean> {
  const deps = resolveDeps(depsInput);
  const { workId, sessionId } = input;
  if (!Number.isInteger(workId) || workId <= 0) throwDomain('WORK_NOT_FOUND', 'NOT_FOUND');
  if (!isValidPlaybackSessionId(sessionId)) throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');
  const work = await resolveOwnedWork(subject, workId);
  await enforceTrashGate(subject, work, sessionId);
  const clamped = clampPositionMs(input.positionMs, input.durationMs ?? null);
  const now = deps.now();
  const table = progressDelegate(subject.type);
  const current = await table.findUnique({ where: { storyWorkId: work.id } });
  const decide = shouldPersistPosition({
    positionMs: clamped,
    previousPositionMs: current?.positionMs ?? null,
    lastWriteAt: current?.updatedAt ?? null,
    now,
    force: input.force,
  });
  if (!decide) return false;
  const completedAt =
    clamped >= (input.durationMs ?? Number.POSITIVE_INFINITY) ? now : (current?.completedAt ?? null);
  await table.upsert({
    where: { storyWorkId: work.id },
    create: {
      storyWorkId: work.id,
      positionMs: clamped,
      durationMs: input.durationMs ?? null,
      sessionId,
      completedAt,
      lastPlayedAt: now,
    },
    update: {
      positionMs: clamped,
      durationMs: input.durationMs ?? null,
      sessionId,
      completedAt,
      lastPlayedAt: now,
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// 30 天滑动 GC（tombstone outbox）
// ---------------------------------------------------------------------------

export type CleanupExpiredStoryAudioAssetsResult = {
  scanned: number;
  enqueued: number;
  deleted: number;
};

/**
 * 清扫过期单轨资产：ready 且 TTL 到期、非 preparing/有效 lease → 记 tombstone + 删对象。
 * **保留** Work/Collection/进度（仅清二进制）；由调用方按 limit 有界执行。
 */
export async function cleanupExpiredStoryAudioAssets(options: {
  now?: Date;
  limit?: number;
  storage?: AudioAssetStorage;
  isPlaying?: (workId: number) => boolean;
  subjectScope?: 'user' | 'guest' | 'all';
} = {}): Promise<CleanupExpiredStoryAudioAssetsResult> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(1, options.limit ?? AUDIO_DELETION_DEFAULT_LIMIT), 100);
  const storage = options.storage ?? getAudioAssetStorage();
  const scope = options.subjectScope ?? 'all';
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const result: CleanupExpiredStoryAudioAssetsResult = { scanned: 0, enqueued: 0, deleted: 0 };
  const tables: Array<'user' | 'guest'> = scope === 'all' ? ['user', 'guest'] : [scope];
  for (const kind of tables) {
    const table = assetDelegate(kind);
    const rows = await table.findMany({
      where: {
        status: 'ready',
        OR: [{ lastAccessedAt: { lt: cutoff } }, { lastAccessedAt: null, readyAt: { lt: cutoff } }],
      },
      orderBy: { lastAccessedAt: 'asc' },
      take: limit,
    });
    for (const row of rows) {
      result.scanned += 1;
      if (options.isPlaying && options.isPlaying(row.storyWorkId)) continue;
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [row.storageKey]);
      });
      result.enqueued += 1;
      const deletion = await cleanupAudioStorageKeys([row.storageKey], { storage });
      result.deleted += deletion.succeeded;
      await table.updateMany({
        where: { id: row.id, leaseId: null },
        data: { status: 'missing', storageKey: buildAssetStorageKey(row.id), byteLength: null, durationMs: null, checksum: null, readyAt: null, supersededAt: now },
      });
    }
  }
  return result;
}
