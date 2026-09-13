/**
 * M5-09 Client Rehydrate 纯领域 helpers（spec §25.3 / §25.4 / §25.5）。
 *
 * 本文件为纯领域层：无 DB / store / API / Prisma 依赖。
 * 统一 SSOT 为 utils/segmentation.ts（normalizeStoryText /
 * computeStoryContentHash / SEGMENTATION_VERSION），此处只引用、不复制算法。
 *
 * 覆盖：
 * - §25.3 Hash Validation：currentHash != savedHash OR version change → reset 0；
 * - §25.4 Title 变化：live title 与 Anchor snapshot 不同 → 更新 title，不重置 progress；
 * - §25.5 Rehydrate 最终状态：transport idle 断言（isPlaying=false/audioUrl=null/currentTime=0/duration=0，不 autoplay）。
 */

import {
  SEGMENTATION_VERSION,
  computeStoryContentHash,
  normalizeStoryText,
} from '@/utils/segmentation';

export { SEGMENTATION_VERSION, computeStoryContentHash, normalizeStoryText };

/** 重水合位置输入（saved 为 Anchor 快照，current 为 Source resolve 后实时值）。 */
export interface RehydratedPositionInput {
  savedNextParagraphIndex: number;
  savedLastCompletedParagraphIndex: number;
  savedContentHash: string;
  savedSegmentationVersion: string;
  currentContentHash: string;
  totalParagraphs: number;
}

/** 重水合位置输出。 */
export interface RehydratedPosition {
  nextParagraphIndex: number;
  lastCompletedParagraphIndex: number;
  /** 是否发生漂移（hash 或 version 不一致 → 已 reset 0）。 */
  drifted: boolean;
}

const MIN_TOTAL_PARAGRAPHS = 1;

function normalizeTotal(total: unknown): number {
  if (typeof total !== 'number' || !Number.isFinite(total)) return MIN_TOTAL_PARAGRAPHS;
  const floored = Math.floor(total);
  return floored >= MIN_TOTAL_PARAGRAPHS ? floored : MIN_TOTAL_PARAGRAPHS;
}

function clampNext(next: unknown, total: number): number {
  if (typeof next !== 'number' || !Number.isFinite(next)) return 0;
  const floored = Math.floor(next);
  if (floored < 0) return 0;
  // 与旧 playbackProgressStore.hydrateFromDTO 一致：越界钳制到最后一合法段，
  // 避免 next >= total 的脏读直接越界（§25.3 保留行为）。
  if (floored >= total) return Math.max(0, total - 1);
  return floored;
}

function clampLast(last: unknown, total: number): number {
  if (typeof last !== 'number' || !Number.isFinite(last)) return -1;
  const floored = Math.floor(last);
  if (floored < -1) return -1;
  if (floored >= total) return total - 1;
  return floored;
}

/**
 * 重水合位置决策（§25.3 纯函数，保留 M2 已有逻辑）：
 * currentHash != savedHash OR savedVersion != SEGMENTATION_VERSION
 * → reset paragraph 0（next=0/last=-1/drifted=true）；
 * 否则沿用 saved 位置（越界钳制，不抛错）。
 */
export function decideRehydratedPosition(input: RehydratedPositionInput): RehydratedPosition {
  const total = normalizeTotal(input.totalParagraphs);
  const drifted =
    input.currentContentHash !== input.savedContentHash ||
    input.savedSegmentationVersion !== SEGMENTATION_VERSION;
  if (drifted) {
    return { nextParagraphIndex: 0, lastCompletedParagraphIndex: -1, drifted: true };
  }
  return {
    nextParagraphIndex: clampNext(input.savedNextParagraphIndex, total),
    lastCompletedParagraphIndex: clampLast(input.savedLastCompletedParagraphIndex, total),
    drifted: false,
  };
}

/**
 * 重水合标题决策（§25.4 纯函数）：
 * liveTitle 非空且与 anchorTitle 不同 → 采用 liveTitle；
 * 否则保留 anchorTitle。调用方不得因此重置 progress
 *（Title 属于 metadata，不属于 content identity）。
 */
export function resolveRehydratedTitle(anchorTitle: string, liveTitle: string | null | undefined): string {
  if (typeof liveTitle === 'string' && liveTitle.length > 0 && liveTitle !== anchorTitle) {
    return liveTitle;
  }
  return anchorTitle;
}

/** §25.5 transport idle 期望（rehydrate 成功后唯一合法态，不 autoplay）。 */
export const REHYDRATE_TRANSPORT_IDLE = {
  isPlaying: false,
  audioUrl: null,
  currentTime: 0,
  duration: 0,
} as const;

/** transport 状态快照（供断言 §25.5 用）。 */
export interface TransportSnapshot {
  isPlaying: boolean;
  audioUrl: string | null;
  currentTime: number;
  duration: number;
}

/**
 * 断言 transport 是否处于 §25.5 idle 态：
 * isPlaying=false 且 audioUrl=null 且 currentTime=0 且 duration=0。
 */
export function isRehydrateTransportIdle(snapshot: TransportSnapshot): boolean {
  return (
    snapshot.isPlaying === false &&
    snapshot.audioUrl === null &&
    snapshot.currentTime === 0 &&
    snapshot.duration === 0
  );
}
