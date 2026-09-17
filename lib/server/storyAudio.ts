/**
 *  Canonical Audio 写入面：Manifest 创建 + ensureSegment（spec §10–§18/§20–§21/§26/§45–§56；）。
 *
 * 核心链路（仍然不切  正式 Work playback，那是）：
 * ```text
 * Work + segmentIndex → frozen Manifest → lease → canonical TTS 1.0
 * → duration/checksum → storage.put → DB ready
 * ```
 *
 * 关键约束（写死）：
 * - Manifest 创建零 TTS cost：resolve Subject-owned Work → active 校验
 *   → normalizeStoryText → verify contentHash → 当次 segmentStoryText() 只跑一次
 *   → 冻结全部 segment text/textHash → 冻结 voice/model/backend/profile
 *   → 创建 Manifest + 全部 Segment 行；此时不得调用 TTS。
 * - 绝对禁止 SQLite transaction 跨 TTS 网络调用：
 *   DB transaction commit → transaction 外 TTS → storage.put → DB ready。
 *   本文件 claim 仅用单条 updateMany（无 transaction），synthesis/storage 均在
 *   transaction 之外，ready/fail 回写另起短事务/单条更新。
 * - 写入顺序：stable DB row + stable storageKey → TTS → duration/checksum
 *   → storage.put（同一 key 覆盖写）→ DB ready；DB ready 更新失败的 retry
 *   必须 overwrite 同一 key，不生成第二个 object（全程复用 segment.storageKey，
 *   synthesis 路径绝不调用 buildSegmentStorageKey / randomUUID 新 key）。
 * - API 输入严格 `{ workId, segmentIndex, sessionId }`：不接 client 的
 *   text/audio/profile/storageKey；Canonical input 全由 server 推导。
 * - Trash 规则：Active owned Work → allowed；Trash Work → 仅当前  Anchor
 *   匹配 workId+sessionId → allowed；否则 → WORK_UNAVAILABLE。
 * - totalDurationMs=Σduration、totalByteLength=Σbytes 只是可信 metadata；
 *   不得顺手实现 story-level timeline（ 禁项）。
 */

import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { prisma } from '@/lib/db';
import type { Subject } from '@/lib/server/subject';
import {
  computeStoryContentHash,
  normalizeStoryText,
  segmentStoryText,
  SEGMENTATION_VERSION,
} from '@/utils/segmentation';
import {
  buildFrozenSegmentInputs,
  deriveManifestStatusFromSegments,
} from '@/lib/audio/manifest';
import {
  CANONICAL_AUDIO_CONTENT_TYPE,
  CANONICAL_SYNTHESIS_SPEED,
  freezeCanonicalAudioProfile,
  resolveManifestVoiceId,
  resolveTtsBackendId,
  resolveTtsModel,
} from '@/lib/audio/profile';
import { computeAudioChecksum } from '@/lib/audio/checksum';
import { getMp3DurationMs } from '@/lib/audio/duration';
import { getAudioAssetStorage } from '@/lib/audio/storage';
import type { AudioAssetStorage } from '@/lib/audio/storage/types';
import {
  AUDIO_DELETION_DEFAULT_LIMIT,
  cleanupAudioStorageDeletions,
} from '@/lib/server/audioStorageCleanup';
import { isValidPlaybackSessionId } from '@/lib/playback/session';
import {
  getTtsConfig,
  synthesizeSpeechWithProfile,
  type CanonicalTtsSynthesizer,
} from '@/lib/server/openai';
import { buildAssetPlaybackUrl } from '@/lib/audio/asset';
import {
  getStoryAudioAssetProjectionForSubject,
  STORY_AUDIO_ASSET_VERSION,
  type StoryAudioAssetDTO,
} from '@/lib/server/storyAudioAsset';

/** Canonical Manifest 世代（V1 StoryWork 内容不可改，正常恒 1； 只建 v1） */
export const STORY_AUDIO_MANIFEST_VERSION = 1;

/** Segment synthesis 租约 TTL（ms；过期后下一次 ensure 可重新 claim，spec §15.4） */
export const STORY_AUDIO_LEASE_TTL_MS = 60_000;

/** Lease 持有时的客户端重试提示（ms；spec §15.3 固定 500） */
export const STORY_AUDIO_RETRY_AFTER_MS = 500;

/** ensureSegment 输入（严格三字段；多传 text/audio/profile/storageKey 由 zod strict 拒绝） */
export type EnsureStoryAudioSegmentInput = {
  workId: number;
  segmentIndex: number;
  sessionId: string;
};

/** getPlaybackManifest 输入 */
export type GetPlaybackManifestInput = {
  workId: number;
};

/** 可注入依赖（Fake TTS fixtures/tests 用；真实 OpenAI 禁止进入自动测试） */
export type StoryAudioDeps = {
  /** 存储后端（缺省 getAudioAssetStorage() 单例） */
  storage?: AudioAssetStorage;
  /** Canonical 合成器（缺省 synthesizeSpeechWithProfile，测试可注入 fake 计数/失败桩） */
  synthesize?: CanonicalTtsSynthesizer;
  /** 时间源（缺省 () => new Date()；lease 过期测试可注入） */
  now?: () => Date;
  /** ID 生成器（缺省 crypto.randomUUID；Manifest 创建确定性测试可注入） */
  generateId?: () => string;
};

function resolveDeps(deps: StoryAudioDeps = {}): Required<StoryAudioDeps> {
  return {
    storage: deps.storage ?? getAudioAssetStorage(),
    synthesize: deps.synthesize ?? synthesizeSpeechWithProfile,
    now: deps.now ?? (() => new Date()),
    generateId: deps.generateId ?? randomUUID,
  };
}

function throwDomain(
  domain: string,
  trpcCode: 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST' | 'INTERNAL_SERVER_ERROR' | 'BAD_GATEWAY'
): never {
  throw new TRPCError({ code: trpcCode, message: domain });
}

/** 稳定 playback URL（opaque segmentId；浏览器永不直接获取 storageKey，spec §19） */
export function buildSegmentPlaybackUrl(segmentId: string): string {
  return `/api/audio/segments/${segmentId}`;
}

// ============================================================================
// Opportunistic bounded tombstone cleanup（ production closure）
// ============================================================================

/**
 * 两次机会清理之间的最小间隔（ms）。
 *
 * 低频节流：ensureSegment 是高频读路径，禁止每次请求全表扫描；只有距离上次
 * 触发超过本间隔才跑一次有界消费。module 级时间戳（单测经 reset 函数归零）。
 */
export const OPPORTUNISTIC_AUDIO_CLEANUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

let opportunisticAudioCleanupLastRunMs = 0;
let opportunisticAudioCleanupRunnerOverride:
  | (() => Promise<unknown>)
  | null = null;

/** 单测注入机会清理 runner（null = 恢复缺省冻结引擎；生产永不调用）。 */
export function setOpportunisticAudioCleanupRunnerForTests(
  runner: (() => Promise<unknown>) | null,
): void {
  opportunisticAudioCleanupRunnerOverride = runner;
}

/** 单测归零节流时间戳（生产永不调用）。 */
export function resetOpportunisticAudioCleanupThrottleForTests(): void {
  opportunisticAudioCleanupLastRunMs = 0;
}

/** 单测读取上次触发毫秒时间戳（生产永不调用）。 */
export function getOpportunisticAudioCleanupLastRunMsForTests(): number {
  return opportunisticAudioCleanupLastRunMs;
}

/**
 * 低频机会触发一次有界 tombstone 清理。
 *
 * - 节流：间隔内重复调用直接返回 false（零 DB/存储访问，禁止全表扫描）；
 * - 有界：复用冻结引擎 + DEFAULT limit（MAX 钳制由引擎内部保证）；
 * - 失败绝不影响调用方：捕获 + 日志 + 返回 true（已触发），永不抛错。
 *
 * @param nowMs 当前毫秒时间戳（缺省 Date.now()；单测注入虚拟时钟）
 * @returns 本次是否实际触发消费（节流跳过返回 false）
 */
export async function maybeRunOpportunisticAudioDeletionCleanup(
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (
    nowMs - opportunisticAudioCleanupLastRunMs <
    OPPORTUNISTIC_AUDIO_CLEANUP_MIN_INTERVAL_MS
  ) {
    return false;
  }
  opportunisticAudioCleanupLastRunMs = nowMs;
  const run =
    opportunisticAudioCleanupRunnerOverride ??
    (() =>
      cleanupAudioStorageDeletions({
        limit: AUDIO_DELETION_DEFAULT_LIMIT,
      }));
  try {
    await run();
  } catch (err) {
    try {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        '[storyAudio] opportunistic audio deletion cleanup failed (non-fatal)',
        detail,
      );
    } catch {
      // 日志失败亦吞掉，永不影响 ensureSegment 结果。
    }
  }
  return true;
}

// ============================================================================
// Work 解析与 Trash 门禁
// ============================================================================

type OwnedWork =
  | {
      kind: 'user';
      id: number;
      storyText: string;
      voiceId: string;
      contentHash: string;
      deletedAt: Date | null;
    }
  | {
      kind: 'guest';
      id: number;
      storyText: string;
      voiceId: string;
      contentHash: string;
      deletedAt: Date | null;
    };

/**
 * 解析 Subject-owned Work（User/Guest 对称；foreign/missing 统一 WORK_NOT_FOUND，不泄漏存在性）。
 */
async function resolveOwnedWork(
  subject: Subject,
  workId: number
): Promise<OwnedWork> {
  if (!Number.isInteger(workId) || workId <= 0) {
    throwDomain('WORK_NOT_FOUND', 'NOT_FOUND');
  }
  if (subject.type === 'user') {
    const row = await prisma.storyWork.findFirst({
      where: { id: workId, userId: subject.id },
      select: {
        id: true,
        storyText: true,
        voiceId: true,
        contentHash: true,
        deletedAt: true,
      },
    });
    if (!row) throwDomain('WORK_NOT_FOUND', 'NOT_FOUND');
    return { kind: 'user', ...row };
  }
  const row = await prisma.guestStoryWork.findFirst({
    where: { id: workId, guestId: subject.id },
    select: {
      id: true,
      storyText: true,
      voiceId: true,
      contentHash: true,
      deletedAt: true,
    },
  });
  if (!row) throwDomain('WORK_NOT_FOUND', 'NOT_FOUND');
  return { kind: 'guest', ...row };
}

/**
 * Trash ensureSegment 门禁（spec §21；纯判定 + DB Anchor 读取）。
 * - Active owned Work → allowed；
 * - Trash Work → 仅当前  Anchor 匹配 workId+sessionId → allowed；否则 WORK_UNAVAILABLE。
 */
async function enforceTrashGate(
  subject: Subject,
  work: OwnedWork,
  sessionId: string
): Promise<void> {
  if (work.deletedAt === null) return;
  if (!isValidPlaybackSessionId(sessionId)) {
    throwDomain('WORK_UNAVAILABLE', 'FORBIDDEN');
  }
  const wantSourceId = String(work.id);
  if (subject.type === 'user') {
    const anchor = await prisma.userPlaybackAnchor.findUnique({
      where: { userId: subject.id },
      select: { sourceKind: true, sourceId: true, sessionId: true },
    });
    const kindOk =
      anchor?.sourceKind === 'work' || anchor?.sourceKind === 'generation';
    if (
      anchor &&
      kindOk &&
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
  const kindOk =
    anchor?.sourceKind === 'work' || anchor?.sourceKind === 'generation';
  if (
    anchor &&
    kindOk &&
    anchor.sourceId === wantSourceId &&
    anchor.sessionId === sessionId
  ) {
    return;
  }
  throwDomain('WORK_UNAVAILABLE', 'FORBIDDEN');
}

// ============================================================================
// Manifest 创建（零 TTS cost，锁死）
// ============================================================================

type EnsuredManifest =
  | {
      kind: 'user';
      id: number;
      storyWorkId: number;
      status: string;
      contentHash: string;
      segmentationVersion: string;
      voiceId: string;
      ttsBackendId: string;
      ttsModel: string;
      synthesisVersion: string;
      synthesisSpeed: number;
      audioFormat: string;
      segmentCount: number;
      readySegmentCount: number;
      totalDurationMs: number | null;
      totalByteLength: number | null;
    }
  | {
      kind: 'guest';
      id: number;
      storyWorkId: number;
      status: string;
      contentHash: string;
      segmentationVersion: string;
      voiceId: string;
      ttsBackendId: string;
      ttsModel: string;
      synthesisVersion: string;
      synthesisSpeed: number;
      audioFormat: string;
      segmentCount: number;
      readySegmentCount: number;
      totalDurationMs: number | null;
      totalByteLength: number | null;
    };

function isP2002(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/**
 * 确保 Manifest 存在（不存在则创建；存在则直接返回）。
 * 全程零 TTS：segmentStoryText() 当次只跑一次，结果即冻结持久化。
 */
async function ensureUserManifest(
  work: Extract<OwnedWork, { kind: 'user' }>,
  generateId: () => string
): Promise<Extract<EnsuredManifest, { kind: 'user' }>> {
  const existing = await prisma.storyAudioManifest.findUnique({
    where: {
      storyWorkId_version: {
        storyWorkId: work.id,
        version: STORY_AUDIO_MANIFEST_VERSION,
      },
    },
  });
  if (existing) {
    return { kind: 'user', ...existing };
  }

  const normalized = normalizeStoryText(work.storyText);
  if (!normalized) throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');
  const expectedHash = computeStoryContentHash(normalized);
  if (work.contentHash && work.contentHash !== expectedHash) {
    throwDomain('WORK_UNAVAILABLE', 'FORBIDDEN');
  }
  const effectiveHash = work.contentHash || expectedHash;
  // 当次 segmentStoryText() 只跑一次（ 锁死；结果即冻结，不再重算）
  const segmentTexts = segmentStoryText(normalized);
  if (segmentTexts.length === 0) throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');

  let defaultVoice: string;
  try {
    defaultVoice = getTtsConfig().voiceId;
  } catch {
    throwDomain('AUDIO_PROFILE_UNAVAILABLE', 'INTERNAL_SERVER_ERROR');
  }
  const frozenVoice = resolveManifestVoiceId(work.voiceId, defaultVoice);
  const backendId = resolveTtsBackendId();
  const model = resolveTtsModel();
  const profile = freezeCanonicalAudioProfile({
    voiceId: frozenVoice,
    ttsBackendId: backendId,
    ttsModel: model,
  });
  const frozenInputs = buildFrozenSegmentInputs(segmentTexts, generateId);
  const needWorkBackfill =
    !work.contentHash || (work.voiceId ?? '').trim().length === 0;

  try {
    const created = await prisma.$transaction(async (tx) => {
      if (needWorkBackfill) {
        await tx.storyWork.update({
          where: { id: work.id },
          data: {
            ...(work.contentHash ? {} : { contentHash: effectiveHash }),
            ...((work.voiceId ?? '').trim().length === 0 &&
            frozenVoice.trim().length > 0
              ? { voiceId: frozenVoice }
              : {}),
          },
        });
      }
      const manifest = await tx.storyAudioManifest.create({
        data: {
          storyWorkId: work.id,
          version: STORY_AUDIO_MANIFEST_VERSION,
          status: 'missing',
          contentHash: effectiveHash,
          segmentationVersion: SEGMENTATION_VERSION,
          voiceId: profile.voiceId,
          ttsBackendId: profile.ttsBackendId,
          ttsModel: profile.ttsModel,
          synthesisVersion: profile.synthesisVersion,
          synthesisSpeed: CANONICAL_SYNTHESIS_SPEED,
          audioFormat: profile.audioFormat,
          segmentCount: frozenInputs.length,
          readySegmentCount: 0,
          totalDurationMs: null,
          totalByteLength: null,
        },
      });
      for (const seg of frozenInputs) {
        await tx.storyAudioSegment.create({
          data: {
            id: seg.id,
            manifestId: manifest.id,
            segmentIndex: seg.segmentIndex,
            text: seg.text,
            textHash: seg.textHash,
            status: 'missing',
            storageKey: seg.storageKey,
            contentType: CANONICAL_AUDIO_CONTENT_TYPE,
            attemptCount: 0,
          },
        });
      }
      return manifest;
    });
    return { kind: 'user', ...created };
  } catch (err) {
    // 并发创建 race：唯一约束冲突则取胜者已建行（spec §15.3 不重复 TTS 由 lease 续保）
    if (isP2002(err)) {
      const winner = await prisma.storyAudioManifest.findUnique({
        where: {
          storyWorkId_version: {
            storyWorkId: work.id,
            version: STORY_AUDIO_MANIFEST_VERSION,
          },
        },
      });
      if (winner) return { kind: 'user', ...winner };
    }
    throw err;
  }
}

async function ensureGuestManifest(
  work: Extract<OwnedWork, { kind: 'guest' }>,
  generateId: () => string
): Promise<Extract<EnsuredManifest, { kind: 'guest' }>> {
  const existing = await prisma.guestStoryAudioManifest.findUnique({
    where: {
      storyWorkId_version: {
        storyWorkId: work.id,
        version: STORY_AUDIO_MANIFEST_VERSION,
      },
    },
  });
  if (existing) {
    return { kind: 'guest', ...existing };
  }

  const normalized = normalizeStoryText(work.storyText);
  if (!normalized) throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');
  const expectedHash = computeStoryContentHash(normalized);
  if (work.contentHash && work.contentHash !== expectedHash) {
    throwDomain('WORK_UNAVAILABLE', 'FORBIDDEN');
  }
  const effectiveHash = work.contentHash || expectedHash;
  // 当次 segmentStoryText() 只跑一次（ 锁死）
  const segmentTexts = segmentStoryText(normalized);
  if (segmentTexts.length === 0) throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');

  let defaultVoice: string;
  try {
    defaultVoice = getTtsConfig().voiceId;
  } catch {
    throwDomain('AUDIO_PROFILE_UNAVAILABLE', 'INTERNAL_SERVER_ERROR');
  }
  const frozenVoice = resolveManifestVoiceId(work.voiceId, defaultVoice);
  const backendId = resolveTtsBackendId();
  const model = resolveTtsModel();
  const profile = freezeCanonicalAudioProfile({
    voiceId: frozenVoice,
    ttsBackendId: backendId,
    ttsModel: model,
  });
  const frozenInputs = buildFrozenSegmentInputs(segmentTexts, generateId);
  const needWorkBackfill =
    !work.contentHash || (work.voiceId ?? '').trim().length === 0;

  try {
    const created = await prisma.$transaction(async (tx) => {
      if (needWorkBackfill) {
        await tx.guestStoryWork.update({
          where: { id: work.id },
          data: {
            ...(work.contentHash ? {} : { contentHash: effectiveHash }),
            ...((work.voiceId ?? '').trim().length === 0 &&
            frozenVoice.trim().length > 0
              ? { voiceId: frozenVoice }
              : {}),
          },
        });
      }
      const manifest = await tx.guestStoryAudioManifest.create({
        data: {
          storyWorkId: work.id,
          version: STORY_AUDIO_MANIFEST_VERSION,
          status: 'missing',
          contentHash: effectiveHash,
          segmentationVersion: SEGMENTATION_VERSION,
          voiceId: profile.voiceId,
          ttsBackendId: profile.ttsBackendId,
          ttsModel: profile.ttsModel,
          synthesisVersion: profile.synthesisVersion,
          synthesisSpeed: CANONICAL_SYNTHESIS_SPEED,
          audioFormat: profile.audioFormat,
          segmentCount: frozenInputs.length,
          readySegmentCount: 0,
          totalDurationMs: null,
          totalByteLength: null,
        },
      });
      for (const seg of frozenInputs) {
        await tx.guestStoryAudioSegment.create({
          data: {
            id: seg.id,
            manifestId: manifest.id,
            segmentIndex: seg.segmentIndex,
            text: seg.text,
            textHash: seg.textHash,
            status: 'missing',
            storageKey: seg.storageKey,
            contentType: CANONICAL_AUDIO_CONTENT_TYPE,
            attemptCount: 0,
          },
        });
      }
      return manifest;
    });
    return { kind: 'guest', ...created };
  } catch (err) {
    if (isP2002(err)) {
      const winner = await prisma.guestStoryAudioManifest.findUnique({
        where: {
          storyWorkId_version: {
            storyWorkId: work.id,
            version: STORY_AUDIO_MANIFEST_VERSION,
          },
        },
      });
      if (winner) return { kind: 'guest', ...winner };
    }
    throw err;
  }
}

// ============================================================================
// Manifest 状态刷新（DB 侧聚合；短 DB transaction 内读+写原子完成，永不跨 TTS）
// ============================================================================
//
//  复审）：读取 segments → derive → Manifest update 必须在同一短
// transaction 内完成。内部无 TTS/storage/network（纯 DB 读+单写），不违反 §15.2。
// SQLite 写事务把不同 completion 的 aggregate commit 顺序序列化；后完成的 refresh
// 看到最新状态，旧 snapshot 不能覆盖新状态（杜绝 ready → preparing 回退）。

export async function refreshUserManifestState(
  manifestId: number,
  now: Date
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const segments = await tx.storyAudioSegment.findMany({
      where: { manifestId },
      select: {
        status: true,
        durationMs: true,
        byteLength: true,
        leaseExpiresAt: true,
        lastErrorCode: true,
        updatedAt: true,
      },
    });
    const derived = deriveManifestStatusFromSegments(segments, now);
    const manifest = await tx.storyAudioManifest.findUnique({
      where: { id: manifestId },
      select: { segmentCount: true },
    });
    const segmentCount = manifest?.segmentCount ?? segments.length;
    const readyRows = segments.filter((s) => s.status === 'ready');
    const readyCount = readyRows.length;
    const allHaveNumbers = readyRows.every(
      (r) =>
        typeof r.durationMs === 'number' &&
        Number.isInteger(r.durationMs) &&
        (r.durationMs as number) > 0 &&
        typeof r.byteLength === 'number' &&
        Number.isInteger(r.byteLength) &&
        (r.byteLength as number) >= 0
    );
    const isFullyReady =
      derived === 'ready' &&
      readyCount === segmentCount &&
      segmentCount > 0 &&
      allHaveNumbers;
    let totalDurationMs: number | null = null;
    let totalByteLength: number | null = null;
    let readyAt: Date | null = null;
    if (isFullyReady) {
      totalDurationMs = readyRows.reduce(
        (a, r) => a + (r.durationMs as number),
        0
      );
      totalByteLength = readyRows.reduce(
        (a, r) => a + (r.byteLength as number),
        0
      );
      readyAt = now;
    }
    let lastErrorCode: string | null = null;
    if (derived === 'failed') {
      const latestFailed = readyRows.length === segments.length
        ? null
        : segments
            .filter((s) => s.status === 'failed')
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
      lastErrorCode = latestFailed?.lastErrorCode ?? 'AUDIO_SYNTHESIS_FAILED';
    }
    await tx.storyAudioManifest.update({
      where: { id: manifestId },
      data: {
        status: isFullyReady ? 'ready' : derived,
        readySegmentCount: readyCount,
        totalDurationMs,
        totalByteLength,
        ...(isFullyReady ? { readyAt } : {}),
        ...(derived === 'failed' ? { lastErrorCode } : { lastErrorCode: null }),
      },
    });
  });
}

export async function refreshGuestManifestState(
  manifestId: number,
  now: Date
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const segments = await tx.guestStoryAudioSegment.findMany({
      where: { manifestId },
      select: {
        status: true,
        durationMs: true,
        byteLength: true,
        leaseExpiresAt: true,
        lastErrorCode: true,
        updatedAt: true,
      },
    });
    const derived = deriveManifestStatusFromSegments(segments, now);
    const manifest = await tx.guestStoryAudioManifest.findUnique({
      where: { id: manifestId },
      select: { segmentCount: true },
    });
    const segmentCount = manifest?.segmentCount ?? segments.length;
    const readyRows = segments.filter((s) => s.status === 'ready');
    const readyCount = readyRows.length;
    const allHaveNumbers = readyRows.every(
      (r) =>
        typeof r.durationMs === 'number' &&
        Number.isInteger(r.durationMs) &&
        (r.durationMs as number) > 0 &&
        typeof r.byteLength === 'number' &&
        Number.isInteger(r.byteLength) &&
        (r.byteLength as number) >= 0
    );
    const isFullyReady =
      derived === 'ready' &&
      readyCount === segmentCount &&
      segmentCount > 0 &&
      allHaveNumbers;
    let totalDurationMs: number | null = null;
    let totalByteLength: number | null = null;
    let readyAt: Date | null = null;
    if (isFullyReady) {
      totalDurationMs = readyRows.reduce(
        (a, r) => a + (r.durationMs as number),
        0
      );
      totalByteLength = readyRows.reduce(
        (a, r) => a + (r.byteLength as number),
        0
      );
      readyAt = now;
    }
    let lastErrorCode: string | null = null;
    if (derived === 'failed') {
      const latestFailed = readyRows.length === segments.length
        ? null
        : segments
            .filter((s) => s.status === 'failed')
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
      lastErrorCode = latestFailed?.lastErrorCode ?? 'AUDIO_SYNTHESIS_FAILED';
    }
    await tx.guestStoryAudioManifest.update({
      where: { id: manifestId },
      data: {
        status: isFullyReady ? 'ready' : derived,
        readySegmentCount: readyCount,
        totalDurationMs,
        totalByteLength,
        ...(isFullyReady ? { readyAt } : {}),
        ...(derived === 'failed' ? { lastErrorCode } : { lastErrorCode: null }),
      },
    });
  });
}

// ============================================================================
// ensureSegment
// ============================================================================

export type EnsureSegmentReadyResult = {
  status: 'ready';
  segment: {
    id: string;
    index: number;
    text: string;
    durationMs: number;
    byteLength: number;
    playbackUrl: string;
  };
  manifest: {
    status: string;
    segmentCount: number;
    readySegmentCount: number;
    totalDurationMs: number | null;
    totalByteLength: number | null;
  };
  /** 单轨资产投影（历史兼容字段；正式单轨 ensure 不再经本入口填充）。 */
  asset?: StoryAudioAssetDTO;
};

export type EnsureSegmentPreparingResult = {
  status: 'preparing';
  retryAfterMs: number;
  segment: { id: string; index: number };
  manifest: {
    status: string;
    segmentCount: number;
    readySegmentCount: number;
    totalDurationMs: number | null;
    totalByteLength: number | null;
  };
};

export type EnsureSegmentResult =
  | EnsureSegmentReadyResult
  | EnsureSegmentPreparingResult;

async function readUserManifestSnapshot(manifestId: number) {
  return prisma.storyAudioManifest.findUnique({ where: { id: manifestId } });
}

async function readGuestManifestSnapshot(manifestId: number) {
  return prisma.guestStoryAudioManifest.findUnique({
    where: { id: manifestId },
  });
}

/**
 * ensureSegment（ canonical 写入唯一入口）。
 *
 * 输入严格三字段；frozen text/profile/storageKey 全由 server 推导。
 * 并发：ready → 直接返回；有效 lease → preparing + retryAfter；
 * missing/failed/过期 lease → 原子 claim 后在 transaction 外合成。
 *
 * 历史兼容入口：ensureSegment 恒为旧多段 canonical 路径，仅服务既有数据；
 * 新 Work 正式播放一律走单轨 `storyAudio.ensure`，不再经本入口创建用户可见分段曲目。
 */
export async function ensureStoryAudioSegmentForSubject(
  subject: Subject,
  input: EnsureStoryAudioSegmentInput,
  depsInput: StoryAudioDeps = {}
): Promise<EnsureSegmentResult> {
  const deps = resolveDeps(depsInput);
  const now = deps.now();
  const { workId, segmentIndex, sessionId } = input;
  //  opportunistic bounded cleanup：低频节流 + 有界 + 失败吞错。
  // fire-and-forget（不 await），永不影响 ensureSegment 结果与延迟主路径。
  void maybeRunOpportunisticAudioDeletionCleanup();
  if (!Number.isInteger(workId) || workId <= 0) {
    throwDomain('WORK_NOT_FOUND', 'NOT_FOUND');
  }
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
    throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');
  }
  if (!isValidPlaybackSessionId(sessionId)) {
    throwDomain('WORK_UNAVAILABLE', 'FORBIDDEN');
  }

  const work = await resolveOwnedWork(subject, workId);
  await enforceTrashGate(subject, work, sessionId);

  if (work.kind === 'user') {
    return ensureUserSegment(subject, work, segmentIndex, deps, now);
  }
  return ensureGuestSegment(subject, work, segmentIndex, deps, now);
}

async function ensureUserSegment(
  _subject: Subject,
  work: Extract<OwnedWork, { kind: 'user' }>,
  segmentIndex: number,
  deps: Required<StoryAudioDeps>,
  now: Date
): Promise<EnsureSegmentResult> {
  const manifest = await ensureUserManifest(work, deps.generateId);
  if (segmentIndex >= manifest.segmentCount) {
    throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');
  }
  let segment = await prisma.storyAudioSegment.findFirst({
    where: { manifestId: manifest.id, segmentIndex },
  });
  if (!segment) throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');

  // ready 快路径（含 corruption 降级：DB ready 但 object 缺失 → failed，允许下一次重建，spec §45）
  if (segment.status === 'ready') {
    let exists: boolean;
    try {
      exists = await deps.storage.exists(segment.storageKey);
    } catch {
      throwDomain('AUDIO_STORAGE_FAILED', 'INTERNAL_SERVER_ERROR');
    }
    if (exists) {
      const snap = await readUserManifestSnapshot(manifest.id);
      return {
        status: 'ready',
        segment: {
          id: segment.id,
          index: segment.segmentIndex,
          text: segment.text,
          durationMs: segment.durationMs as number,
          byteLength: segment.byteLength as number,
          playbackUrl: buildSegmentPlaybackUrl(segment.id),
        },
        manifest: {
          status: snap?.status ?? manifest.status,
          segmentCount: snap?.segmentCount ?? manifest.segmentCount,
          readySegmentCount:
            snap?.readySegmentCount ?? manifest.readySegmentCount,
          totalDurationMs: snap?.totalDurationMs ?? null,
          totalByteLength: snap?.totalByteLength ?? null,
        },
      };
    }
    // corruption：降级后落到 claim 路径重建（同一 storageKey 覆盖写）
    await prisma.storyAudioSegment.update({
      where: { id: segment.id },
      data: {
        status: 'failed',
        lastErrorCode: 'AUDIO_OBJECT_MISSING',
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    await refreshUserManifestState(manifest.id, deps.now());
    segment = await prisma.storyAudioSegment.findFirst({
      where: { manifestId: manifest.id, segmentIndex },
    });
    if (!segment) throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');
  }

  // 有效 lease → preparing + retryAfter（不重复 TTS，spec §15.3）
  if (
    segment.status === 'preparing' &&
    segment.leaseExpiresAt instanceof Date &&
    segment.leaseExpiresAt.getTime() > deps.now().getTime()
  ) {
    const snap = await readUserManifestSnapshot(manifest.id);
    return {
      status: 'preparing',
      retryAfterMs: STORY_AUDIO_RETRY_AFTER_MS,
      segment: { id: segment.id, index: segment.segmentIndex },
      manifest: {
        status: snap?.status ?? 'preparing',
        segmentCount: snap?.segmentCount ?? manifest.segmentCount,
        readySegmentCount: snap?.readySegmentCount ?? manifest.readySegmentCount,
        totalDurationMs: snap?.totalDurationMs ?? null,
        totalByteLength: snap?.totalByteLength ?? null,
      },
    };
  }

  // 原子 claim（单条 updateMany，无 transaction；失败即有人持有效 lease → preparing）
  const leaseId = deps.generateId();
  const leaseExpiresAt = new Date(now.getTime() + STORY_AUDIO_LEASE_TTL_MS);
  const claim = await prisma.storyAudioSegment.updateMany({
    where: {
      id: segment.id,
      OR: [
        { status: 'missing' },
        { status: 'failed' },
        {
          status: 'preparing',
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
      ],
    },
    data: {
      status: 'preparing',
      leaseId,
      leaseExpiresAt,
      attemptCount: { increment: 1 },
      lastErrorCode: null,
    },
  });
  if (claim.count === 0) {
    const snap = await readUserManifestSnapshot(manifest.id);
    const cur = await prisma.storyAudioSegment.findFirst({
      where: { manifestId: manifest.id, segmentIndex },
    });
    return {
      status: 'preparing',
      retryAfterMs: STORY_AUDIO_RETRY_AFTER_MS,
      segment: { id: cur?.id ?? segment.id, index: segmentIndex },
      manifest: {
        status: snap?.status ?? 'preparing',
        segmentCount: snap?.segmentCount ?? manifest.segmentCount,
        readySegmentCount: snap?.readySegmentCount ?? manifest.readySegmentCount,
        totalDurationMs: snap?.totalDurationMs ?? null,
        totalByteLength: snap?.totalByteLength ?? null,
      },
    };
  }
  // claim 成功即 DB transaction 已 commit；以下 TTS/storage 均在 transaction 外（spec §15.2 绝对禁止持锁等网络）
  await prisma.storyAudioManifest.update({
    where: { id: manifest.id },
    data: { status: 'preparing' },
  });

  // Canonical input 全由 server 推导（frozen text + Manifest authoritative pin + 恒 1.0/mp3）
  const frozenText = segment.text;
  const storageKey = segment.storageKey;
  const contentType = segment.contentType || CANONICAL_AUDIO_CONTENT_TYPE;
  let audioBytes: Uint8Array;
  try {
    const res = await deps.synthesize({
      text: frozenText,
      model: manifest.ttsModel,
      voiceId: manifest.voiceId,
      speed: CANONICAL_SYNTHESIS_SPEED,
      format: manifest.audioFormat || 'mp3',
    });
    if (!res?.audioData || res.audioData.byteLength === 0) {
      throw new Error('empty tts audio');
    }
    audioBytes = new Uint8Array(res.audioData);
  } catch {
    await prisma.storyAudioSegment.updateMany({
      where: { id: segment.id, leaseId },
      data: {
        status: 'failed',
        lastErrorCode: 'AUDIO_SYNTHESIS_FAILED',
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    await refreshUserManifestState(manifest.id, deps.now());
    throwDomain('AUDIO_SYNTHESIS_FAILED', 'INTERNAL_SERVER_ERROR');
  }

  let durationMs: number;
  try {
    durationMs = getMp3DurationMs(audioBytes);
  } catch {
    await prisma.storyAudioSegment.updateMany({
      where: { id: segment.id, leaseId },
      data: {
        status: 'failed',
        lastErrorCode: 'AUDIO_SYNTHESIS_FAILED',
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    await refreshUserManifestState(manifest.id, deps.now());
    throwDomain('AUDIO_SYNTHESIS_FAILED', 'INTERNAL_SERVER_ERROR');
  }
  const checksum = computeAudioChecksum(audioBytes);
  const byteLength = audioBytes.byteLength;

  // ①：storage.put 之前原子 renew lease ownership（fencing）。
  // lease 过期≠旧 Node 已死：若已被他人接管（leaseId 已换），count=0 → 丢弃本次
  // bytes、不写 object、不改 DB，返回 preparing/RETRY。renew 成功才 put。
  // 有效 lease 内仍为同一 key 覆盖写（spec §18）；② put 后仍保留 WHERE leaseId
  // 的 DB CAS 作为第二层。
  const renewAt = deps.now();
  const renewed = await prisma.storyAudioSegment.updateMany({
    where: { id: segment.id, leaseId, status: 'preparing' },
    data: {
      leaseExpiresAt: new Date(renewAt.getTime() + STORY_AUDIO_LEASE_TTL_MS),
    },
  });
  if (renewed.count === 0) {
    const snap = await readUserManifestSnapshot(manifest.id);
    return {
      status: 'preparing',
      retryAfterMs: STORY_AUDIO_RETRY_AFTER_MS,
      segment: { id: segment.id, index: segmentIndex },
      manifest: {
        status: snap?.status ?? 'preparing',
        segmentCount: snap?.segmentCount ?? manifest.segmentCount,
        readySegmentCount: snap?.readySegmentCount ?? manifest.readySegmentCount,
        totalDurationMs: snap?.totalDurationMs ?? null,
        totalByteLength: snap?.totalByteLength ?? null,
      },
    };
  }

  // storage.put 同一 key 覆盖写（DB ready 更新失败的 retry 亦复用此 key，spec §18.1）
  try {
    await deps.storage.put({ key: storageKey, bytes: audioBytes, contentType });
  } catch {
    await prisma.storyAudioSegment.updateMany({
      where: { id: segment.id, leaseId },
      data: {
        status: 'failed',
        lastErrorCode: 'AUDIO_STORAGE_FAILED',
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    await refreshUserManifestState(manifest.id, deps.now());
    throwDomain('AUDIO_STORAGE_FAILED', 'INTERNAL_SERVER_ERROR');
  }

  // DB ready（条件 leaseId 防止覆盖过期后他人的新 lease；失败则下一次 overwrite 同一 key）
  const readyAt = deps.now();
  const marked = await prisma.storyAudioSegment.updateMany({
    where: { id: segment.id, leaseId },
    data: {
      status: 'ready',
      byteLength,
      durationMs,
      audioChecksum: checksum,
      readyAt,
      leaseId: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    },
  });
  if (marked.count === 0) {
    const snap = await readUserManifestSnapshot(manifest.id);
    return {
      status: 'preparing',
      retryAfterMs: STORY_AUDIO_RETRY_AFTER_MS,
      segment: { id: segment.id, index: segmentIndex },
      manifest: {
        status: snap?.status ?? 'preparing',
        segmentCount: snap?.segmentCount ?? manifest.segmentCount,
        readySegmentCount: snap?.readySegmentCount ?? manifest.readySegmentCount,
        totalDurationMs: snap?.totalDurationMs ?? null,
        totalByteLength: snap?.totalByteLength ?? null,
      },
    };
  }
  await refreshUserManifestState(manifest.id, readyAt);
  const snap = await readUserManifestSnapshot(manifest.id);
  return {
    status: 'ready',
    segment: {
      id: segment.id,
      index: segmentIndex,
      text: frozenText,
      durationMs,
      byteLength,
      playbackUrl: buildSegmentPlaybackUrl(segment.id),
    },
    manifest: {
      status: snap?.status ?? 'ready',
      segmentCount: snap?.segmentCount ?? manifest.segmentCount,
      readySegmentCount: snap?.readySegmentCount ?? manifest.readySegmentCount,
      totalDurationMs: snap?.totalDurationMs ?? null,
      totalByteLength: snap?.totalByteLength ?? null,
    },
  };
}

async function ensureGuestSegment(
  _subject: Subject,
  work: Extract<OwnedWork, { kind: 'guest' }>,
  segmentIndex: number,
  deps: Required<StoryAudioDeps>,
  now: Date
): Promise<EnsureSegmentResult> {
  const manifest = await ensureGuestManifest(work, deps.generateId);
  if (segmentIndex >= manifest.segmentCount) {
    throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');
  }
  let segment = await prisma.guestStoryAudioSegment.findFirst({
    where: { manifestId: manifest.id, segmentIndex },
  });
  if (!segment) throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');

  if (segment.status === 'ready') {
    let exists: boolean;
    try {
      exists = await deps.storage.exists(segment.storageKey);
    } catch {
      throwDomain('AUDIO_STORAGE_FAILED', 'INTERNAL_SERVER_ERROR');
    }
    if (exists) {
      const snap = await readGuestManifestSnapshot(manifest.id);
      return {
        status: 'ready',
        segment: {
          id: segment.id,
          index: segment.segmentIndex,
          text: segment.text,
          durationMs: segment.durationMs as number,
          byteLength: segment.byteLength as number,
          playbackUrl: buildSegmentPlaybackUrl(segment.id),
        },
        manifest: {
          status: snap?.status ?? manifest.status,
          segmentCount: snap?.segmentCount ?? manifest.segmentCount,
          readySegmentCount:
            snap?.readySegmentCount ?? manifest.readySegmentCount,
          totalDurationMs: snap?.totalDurationMs ?? null,
          totalByteLength: snap?.totalByteLength ?? null,
        },
      };
    }
    await prisma.guestStoryAudioSegment.update({
      where: { id: segment.id },
      data: {
        status: 'failed',
        lastErrorCode: 'AUDIO_OBJECT_MISSING',
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    await refreshGuestManifestState(manifest.id, deps.now());
    segment = await prisma.guestStoryAudioSegment.findFirst({
      where: { manifestId: manifest.id, segmentIndex },
    });
    if (!segment) throwDomain('INVALID_SEGMENT', 'BAD_REQUEST');
  }

  if (
    segment.status === 'preparing' &&
    segment.leaseExpiresAt instanceof Date &&
    segment.leaseExpiresAt.getTime() > deps.now().getTime()
  ) {
    const snap = await readGuestManifestSnapshot(manifest.id);
    return {
      status: 'preparing',
      retryAfterMs: STORY_AUDIO_RETRY_AFTER_MS,
      segment: { id: segment.id, index: segment.segmentIndex },
      manifest: {
        status: snap?.status ?? 'preparing',
        segmentCount: snap?.segmentCount ?? manifest.segmentCount,
        readySegmentCount: snap?.readySegmentCount ?? manifest.readySegmentCount,
        totalDurationMs: snap?.totalDurationMs ?? null,
        totalByteLength: snap?.totalByteLength ?? null,
      },
    };
  }

  const leaseId = deps.generateId();
  const leaseExpiresAt = new Date(now.getTime() + STORY_AUDIO_LEASE_TTL_MS);
  const claim = await prisma.guestStoryAudioSegment.updateMany({
    where: {
      id: segment.id,
      OR: [
        { status: 'missing' },
        { status: 'failed' },
        {
          status: 'preparing',
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
      ],
    },
    data: {
      status: 'preparing',
      leaseId,
      leaseExpiresAt,
      attemptCount: { increment: 1 },
      lastErrorCode: null,
    },
  });
  if (claim.count === 0) {
    const snap = await readGuestManifestSnapshot(manifest.id);
    const cur = await prisma.guestStoryAudioSegment.findFirst({
      where: { manifestId: manifest.id, segmentIndex },
    });
    return {
      status: 'preparing',
      retryAfterMs: STORY_AUDIO_RETRY_AFTER_MS,
      segment: { id: cur?.id ?? segment.id, index: segmentIndex },
      manifest: {
        status: snap?.status ?? 'preparing',
        segmentCount: snap?.segmentCount ?? manifest.segmentCount,
        readySegmentCount: snap?.readySegmentCount ?? manifest.readySegmentCount,
        totalDurationMs: snap?.totalDurationMs ?? null,
        totalByteLength: snap?.totalByteLength ?? null,
      },
    };
  }
  // claim 成功即 DB 已 commit；以下 TTS/storage 均在 transaction 外
  await prisma.guestStoryAudioManifest.update({
    where: { id: manifest.id },
    data: { status: 'preparing' },
  });

  const frozenText = segment.text;
  const storageKey = segment.storageKey;
  const contentType = segment.contentType || CANONICAL_AUDIO_CONTENT_TYPE;
  let audioBytes: Uint8Array;
  try {
    const res = await deps.synthesize({
      text: frozenText,
      model: manifest.ttsModel,
      voiceId: manifest.voiceId,
      speed: CANONICAL_SYNTHESIS_SPEED,
      format: manifest.audioFormat || 'mp3',
    });
    if (!res?.audioData || res.audioData.byteLength === 0) {
      throw new Error('empty tts audio');
    }
    audioBytes = new Uint8Array(res.audioData);
  } catch {
    await prisma.guestStoryAudioSegment.updateMany({
      where: { id: segment.id, leaseId },
      data: {
        status: 'failed',
        lastErrorCode: 'AUDIO_SYNTHESIS_FAILED',
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    await refreshGuestManifestState(manifest.id, deps.now());
    throwDomain('AUDIO_SYNTHESIS_FAILED', 'INTERNAL_SERVER_ERROR');
  }

  let durationMs: number;
  try {
    durationMs = getMp3DurationMs(audioBytes);
  } catch {
    await prisma.guestStoryAudioSegment.updateMany({
      where: { id: segment.id, leaseId },
      data: {
        status: 'failed',
        lastErrorCode: 'AUDIO_SYNTHESIS_FAILED',
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    await refreshGuestManifestState(manifest.id, deps.now());
    throwDomain('AUDIO_SYNTHESIS_FAILED', 'INTERNAL_SERVER_ERROR');
  }
  const checksum = computeAudioChecksum(audioBytes);
  const byteLength = audioBytes.byteLength;

  // ①（Guest 对称）：put 前原子 renew fencing；② put 后 WHERE leaseId CAS 保留。
  const renewAt = deps.now();
  const renewed = await prisma.guestStoryAudioSegment.updateMany({
    where: { id: segment.id, leaseId, status: 'preparing' },
    data: {
      leaseExpiresAt: new Date(renewAt.getTime() + STORY_AUDIO_LEASE_TTL_MS),
    },
  });
  if (renewed.count === 0) {
    const snap = await readGuestManifestSnapshot(manifest.id);
    return {
      status: 'preparing',
      retryAfterMs: STORY_AUDIO_RETRY_AFTER_MS,
      segment: { id: segment.id, index: segmentIndex },
      manifest: {
        status: snap?.status ?? 'preparing',
        segmentCount: snap?.segmentCount ?? manifest.segmentCount,
        readySegmentCount: snap?.readySegmentCount ?? manifest.readySegmentCount,
        totalDurationMs: snap?.totalDurationMs ?? null,
        totalByteLength: snap?.totalByteLength ?? null,
      },
    };
  }

  try {
    await deps.storage.put({ key: storageKey, bytes: audioBytes, contentType });
  } catch {
    await prisma.guestStoryAudioSegment.updateMany({
      where: { id: segment.id, leaseId },
      data: {
        status: 'failed',
        lastErrorCode: 'AUDIO_STORAGE_FAILED',
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    await refreshGuestManifestState(manifest.id, deps.now());
    throwDomain('AUDIO_STORAGE_FAILED', 'INTERNAL_SERVER_ERROR');
  }

  const readyAt = deps.now();
  const marked = await prisma.guestStoryAudioSegment.updateMany({
    where: { id: segment.id, leaseId },
    data: {
      status: 'ready',
      byteLength,
      durationMs,
      audioChecksum: checksum,
      readyAt,
      leaseId: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    },
  });
  if (marked.count === 0) {
    const snap = await readGuestManifestSnapshot(manifest.id);
    return {
      status: 'preparing',
      retryAfterMs: STORY_AUDIO_RETRY_AFTER_MS,
      segment: { id: segment.id, index: segmentIndex },
      manifest: {
        status: snap?.status ?? 'preparing',
        segmentCount: snap?.segmentCount ?? manifest.segmentCount,
        readySegmentCount: snap?.readySegmentCount ?? manifest.readySegmentCount,
        totalDurationMs: snap?.totalDurationMs ?? null,
        totalByteLength: snap?.totalByteLength ?? null,
      },
    };
  }
  await refreshGuestManifestState(manifest.id, readyAt);
  const snap = await readGuestManifestSnapshot(manifest.id);
  return {
    status: 'ready',
    segment: {
      id: segment.id,
      index: segmentIndex,
      text: frozenText,
      durationMs,
      byteLength,
      playbackUrl: buildSegmentPlaybackUrl(segment.id),
    },
    manifest: {
      status: snap?.status ?? 'ready',
      segmentCount: snap?.segmentCount ?? manifest.segmentCount,
      readySegmentCount: snap?.readySegmentCount ?? manifest.readySegmentCount,
      totalDurationMs: snap?.totalDurationMs ?? null,
      totalByteLength: snap?.totalByteLength ?? null,
    },
  };
}

// ============================================================================
// getPlaybackManifest（只读投影；不创建 Manifest、不调用 TTS）
// ============================================================================

export type PlaybackManifestSegmentDTO = {
  index: number;
  text: string;
  textHash: string;
  status: 'missing' | 'preparing' | 'ready' | 'failed';
  durationMs: number | null;
  playbackUrl: string | null;
};

export type PlaybackManifestDTO = {
  workId: number;
  status: 'missing' | 'preparing' | 'ready' | 'failed';
  contentHash: string;
  segmentationVersion: string;
  voiceId: string;
  segmentCount: number;
  readySegmentCount: number;
  totalDurationMs: number | null;
  totalByteLength: number | null;
  segments: PlaybackManifestSegmentDTO[];
  /** 单轨投影（正式默认；`segments` 同时为空，保证只暴露一条时间轴）。 */
  singleTrack?: StoryAudioAssetDTO | null;
};

/** 单轨投影 → 旧 PlaybackManifestDTO 形状（segments 空 + singleTrack）。 */
async function getSingleTrackPlaybackManifest(
  subject: Subject,
  input: GetPlaybackManifestInput
): Promise<PlaybackManifestDTO> {
  const projection = await getStoryAudioAssetProjectionForSubject(subject, {
    workId: input.workId,
  });
  const singleTrack: StoryAudioAssetDTO | null =
    projection.status === 'ready' && projection.assetId && projection.durationMs !== null && projection.byteLength !== null
      ? {
          assetId: projection.assetId,
          workId: projection.workId,
          status: 'ready',
          version: projection.version || STORY_AUDIO_ASSET_VERSION,
          contentHash: projection.contentHash,
          voiceId: projection.voiceId,
          ttsProfileHash: projection.ttsProfileHash,
          synthesisVersion: projection.synthesisVersion,
          audioFormat: projection.audioFormat,
          chunkCount: projection.chunkCount,
          durationMs: projection.durationMs,
          byteLength: projection.byteLength,
          checksum: projection.checksum ?? '',
          contentType: 'audio/mpeg',
          playbackUrl: projection.playbackUrl ?? buildAssetPlaybackUrl(projection.assetId),
          positionMs: projection.positionMs,
          readyAt: projection.readyAt ?? '',
        }
      : null;
  return {
    workId: projection.workId,
    status:
      projection.status === 'ready'
        ? 'ready'
        : (projection.status as PlaybackManifestDTO['status']),
    contentHash: projection.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    voiceId: projection.voiceId,
    segmentCount: singleTrack ? 1 : 0,
    readySegmentCount: singleTrack ? 1 : 0,
    totalDurationMs: projection.durationMs,
    totalByteLength: projection.byteLength,
    segments: [],
    singleTrack,
  };
}

/**
 * 读取播放用单轨投影（只读；正式默认单轨，segments 为空 + singleTrack，保证只暴露一条时间轴）。
 * 旧 Segment/Manifest 行仅作历史兼容数据保留，不再经本入口暴露为用户可见分段曲目。
 * Trash Work 的已有 asset 仍允许读取（trash 门禁仅约束 ensure 写）。
 */
export async function getPlaybackManifestForSubject(
  subject: Subject,
  input: GetPlaybackManifestInput
): Promise<PlaybackManifestDTO> {
  return getSingleTrackPlaybackManifest(subject, input);
}
