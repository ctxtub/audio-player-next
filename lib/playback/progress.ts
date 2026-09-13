/**
 * M5-01 Work Playback Progress / Continuation 纯领域契约
 *（spec §3.4 / §7 / §7.1 / §11 / §12 / §37）
 *
 * - Server 不额外存易漂移的 status 字段，Work 状态一律由 Progress 推导（§7）。
 * - progress 为 paragraph-level，不伪装秒级精度；duration 加权留给 M8（§7.1）。
 * - isOneShot 收敛为 PlaybackContinuationMode finite|extendable（§11）；
 *   所有持久化 Anchor 重水合后一律视为 finite（§12 安全边界）。
 * - contentHash / segmentation 唯一 SSOT 为 utils/segmentation.ts：
 *   本文件只引用 re-export，绝不复制第二套算法（§37）。
 *
 * 本文件为纯领域层：无 DB / store / API / Prisma 依赖。
 */

import {
  SEGMENTATION_VERSION,
  computeStoryContentHash,
  normalizeStoryText,
  segmentStoryText,
} from '@/utils/segmentation';

/** hash/segmentation 唯一 SSOT re-export（引用，不复制，不改算法行为）。 */
export {
  SEGMENTATION_VERSION,
  computeStoryContentHash,
  normalizeStoryText,
  segmentStoryText,
};

/** Work 播放状态（§7：由 Progress 有无与 next/total 推导，绝不另存 status 列）。 */
export type WorkPlaybackState = 'not_started' | 'in_progress' | 'completed';

/** 续写模式（§11）：当前内容播完后是否允许向 AI 请求新故事内容。 */
export type PlaybackContinuationMode = 'finite' | 'extendable';

/** Work 进度位置（纯数据：秒级 offset 不在 M5 记录，见 §6.3）。 */
export interface WorkPlaybackPosition {
  lastCompletedParagraphIndex: number;
  nextParagraphIndex: number;
  totalParagraphs: number;
  /** 历史上至少完整听完过一次的时间；重播保留，位置重置（§8 产品拍板 M5-P01）。 */
  completedAt: string | null;
}

/** totalParagraphs 归一化下限（持久化缺省为 1，除零守卫）。 */
const MIN_TOTAL_PARAGRAPHS = 1;

function normalizeTotalParagraphs(total: unknown): number {
  if (typeof total !== 'number' || !Number.isFinite(total)) return MIN_TOTAL_PARAGRAPHS;
  const floored = Math.floor(total);
  return floored >= MIN_TOTAL_PARAGRAPHS ? floored : MIN_TOTAL_PARAGRAPHS;
}

/**
 * 推导 Work 播放状态（§7）：
 * - 无 Progress row → not_started；
 * - nextParagraphIndex < totalParagraphs → in_progress；
 * - nextParagraphIndex >= totalParagraphs → completed。
 * 注意：completedAt 仅表示“历史上听完过”，不参与本次状态推导；
 * 重播停在 40% 时状态为 in_progress 但 completedAt 仍保留（§8）。
 */
export function deriveWorkPlaybackState(
  position: WorkPlaybackPosition | null | undefined,
): WorkPlaybackState {
  if (position === null || position === undefined) return 'not_started';
  const total = normalizeTotalParagraphs(position.totalParagraphs);
  const next =
    typeof position.nextParagraphIndex === 'number' &&
    Number.isFinite(position.nextParagraphIndex)
      ? Math.floor(position.nextParagraphIndex)
      : 0;
  if (next >= total) return 'completed';
  return 'in_progress';
}

/**
 * paragraph-level progress ratio（§7.1 V1）：
 * completedParagraphs = min(total, lastCompletedParagraphIndex + 1)，
 * progress = completedParagraphs / total，钳制于 [0, 1]。
 * 无 Progress 视为 0。
 */
export function computeWorkProgressRatio(
  position: WorkPlaybackPosition | null | undefined,
): number {
  if (position === null || position === undefined) return 0;
  const total = normalizeTotalParagraphs(position.totalParagraphs);
  const last =
    typeof position.lastCompletedParagraphIndex === 'number' &&
    Number.isFinite(position.lastCompletedParagraphIndex)
      ? Math.floor(position.lastCompletedParagraphIndex)
      : -1;
  const completedParagraphs = Math.min(total, Math.max(0, last + 1));
  const ratio = completedParagraphs / total;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

/** 续写模式解析输入 */
export interface ContinuationModeInput {
  /** 来源种类：work 永远 finite（§11）。 */
  kind: 'draft' | 'work';
  /** 是否来自持久化 Anchor 重水合：是则永远 finite（§12）。 */
  rehydrated: boolean;
  /** 仅实时生成链可显式要求 extendable（§11）。 */
  liveExtendable?: boolean;
}

/**
 * 解析续写模式（§11 / §12）：
 * - work → finite（恒）；
 * - rehydrated draft → finite（恒；即使关闭时是 extendable，reload 后也不自动续写）；
 * - live draft + 明确要求 extendable → extendable；
 * - 其余 live draft → finite（默认安全边界）。
 */
export function resolveContinuationMode(input: ContinuationModeInput): PlaybackContinuationMode {
  if (input.kind === 'work') return 'finite';
  if (input.rehydrated) return 'finite';
  if (input.liveExtendable === true) return 'extendable';
  return 'finite';
}

/** 重水合续写模式（§12 invariant 的显式命名：永远 finite）。 */
export function rehydratedContinuationMode(): PlaybackContinuationMode {
  return 'finite';
}

/**
 * 新域 → 旧物理列兼容写（§11.1）：
 * continuationMode === finite → old isOneShot = true；
 * extendable → false。M9 前旧列保留，新域不再读取它。
 * 反向（old → new）为有损映射，故此处有意不提供，避免把历史歧义编码进新契约。
 */
export function continuationModeToLegacyIsOneShot(mode: PlaybackContinuationMode): boolean {
  return mode === 'finite';
}

/**
 * M5-08 Subject remap 可迁移进度形状（spec §31.4，纯数据，不触库）。
 * completedAt / lastPlayedAt 为 ISO 字符串或 null（DB Date 的传输形）。
 */
export interface RemappableWorkProgress {
  contentHash: string;
  segmentationVersion: string;
  lastCompletedParagraphIndex: number;
  nextParagraphIndex: number;
  totalParagraphs: number;
  completedAt: string | null;
  lastPlayedAt: string | null;
}

const normalizeRemapNext = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  return floored < 0 ? 0 : floored;
};

const laterPlayedAt = (a: string | null, b: string | null): string | null => {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN;
  const tb = typeof b === 'string' ? Date.parse(b) : NaN;
  const validA = Number.isFinite(ta);
  const validB = Number.isFinite(tb);
  if (validA && validB) return ta >= tb ? a : b;
  if (validA) return a;
  if (validB) return b;
  return null;
};

/**
 * M5-08 Subject remap 进度合并（spec §31.4 + 任务 4g，纯函数，不触库）。
 *
 * User 侧已有同 work 进度时不覆盖：取 newer/更完整者（按 max(nextParagraphIndex)，
 * 持平取 User 既有 existing，register 重试幂等）；位置五元组
 * （contentHash/segmentationVersion/last/next/total）整体取胜者，
 * 不跨行拼凑；completedAt 取首个非空（首完保留，与 §41 complete 幂等一致）；
 * lastPlayedAt 取更晚者。
 */
export function mergeRemappedWorkProgress(
  existing: RemappableWorkProgress,
  incoming: RemappableWorkProgress,
): RemappableWorkProgress {
  const existingNext = normalizeRemapNext(existing.nextParagraphIndex);
  const incomingNext = normalizeRemapNext(incoming.nextParagraphIndex);
  const winner = incomingNext > existingNext ? incoming : existing;
  return {
    contentHash: winner.contentHash,
    segmentationVersion: winner.segmentationVersion,
    lastCompletedParagraphIndex: winner.lastCompletedParagraphIndex,
    nextParagraphIndex: winner.nextParagraphIndex,
    totalParagraphs: winner.totalParagraphs,
    completedAt: existing.completedAt ?? incoming.completedAt,
    lastPlayedAt: laterPlayedAt(existing.lastPlayedAt, incoming.lastPlayedAt),
  };
}

/**
 * Draft→Work 提升断点取舍（§3.4）：
 * 仅当两侧 contentHash 均非空且严格相等时迁移旧断点；
 * 不一致（含任一为空）→ 安全回退 paragraph 0，不迁移旧断点。
 */
export function shouldPreserveDraftBreakpointOnPromote(
  draftContentHash: string,
  workContentHash: string,
): boolean {
  if (typeof draftContentHash !== 'string' || typeof workContentHash !== 'string') return false;
  if (draftContentHash.length === 0 || workContentHash.length === 0) return false;
  return draftContentHash === workContentHash;
}

/**
 * 提升后 nextParagraphIndex 解析：保留则沿用 draft 位置（钳制到 [0, workTotal]），
 * 否则回退 0。sessionId / 音频 / 段落 / 播放状态保持不变，
 * 替换的仅是 source identity / title / contentHash / voiceId（§3.4）。
 */
export function resolvePromotedNextParagraphIndex(
  draftNextParagraphIndex: number,
  draftContentHash: string,
  workContentHash: string,
  workTotalParagraphs: number,
): number {
  if (
    !shouldPreserveDraftBreakpointOnPromote(draftContentHash, workContentHash)
  ) {
    return 0;
  }
  const total = normalizeTotalParagraphs(workTotalParagraphs);
  if (typeof draftNextParagraphIndex !== 'number' || !Number.isFinite(draftNextParagraphIndex)) {
    return 0;
  }
  const floored = Math.floor(draftNextParagraphIndex);
  if (floored < 0) return 0;
  if (floored > total) return total;
  return floored;
}
