/**
 * M5-01 Legacy 来源解析器（spec §3 / §5.3 / §32 Step 2 / §38）
 *
 * 兼容输入（至少保留一个兼容周期）：
 *   chat       → draft
 *   generation → work
 *   draft      → draft
 *   work       → work
 * 数据库 sourceKind 正式值为 draft|work（物理列名可仍为 sourceType，
 * Prisma 侧用 sourceKind @map("sourceType")，M5-02+ 才动 schema）。
 *
 * fail-closed：未知 kind / 非法 workId / replay-text-* draft 一律抛错或返回 null，
 * 绝不静默降级、绝不截断修正。缺映射 work anchor 丢弃（§31.3）由 M5-02+ 消费本解析器实现。
 *
 * 本文件为纯领域层：无 DB / store / API / Prisma 依赖。
 */

import {
  createDraftSource,
  createWorkSource,
  isValidWorkId,
  type PlaybackSourceRef,
} from './source';

/** legacy（含已规范化）来源类型全集 */
export type LegacyPlaybackSourceType = 'chat' | 'generation' | 'draft' | 'work';

const LEGACY_SOURCE_TYPES: readonly LegacyPlaybackSourceType[] = [
  'chat',
  'generation',
  'draft',
  'work',
];

/** 是否为已知的 legacy 来源类型（大小写敏感，未知即 false）。 */
export function isLegacyPlaybackSourceType(value: unknown): value is LegacyPlaybackSourceType {
  return (
    typeof value === 'string' &&
    (LEGACY_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

/**
 * 来源类型规范化（§5.3 migration 语义的纯函数版）：
 * chat → draft；generation → work；draft → draft；work → work。
 * 未知类型抛错（fail-closed）。
 */
export function canonicalizeSourceKind(sourceType: string): 'draft' | 'work' {
  if (sourceType === 'chat' || sourceType === 'draft') return 'draft';
  if (sourceType === 'generation' || sourceType === 'work') return 'work';
  throw new Error(`[playback-identity] unknown sourceType: ${JSON.stringify(sourceType)}`);
}

/**
 * legacy work sourceId 解析：仅接受 canonical 十进制 positive int 文本。
 * 即 `String(workId)` 的逆操作；'0' / '-1' / '1.5' / 'abc' / '' / '1e3' / '0x10'
 * 全部抛错。首尾空白容忍（trim），其余一字不改。
 */
export function parseLegacyWorkId(sourceId: string): number {
  if (typeof sourceId !== 'string') {
    throw new Error('[playback-identity] invalid work sourceId: non-string');
  }
  const trimmed = sourceId.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
    throw new Error(
      `[playback-identity] invalid work sourceId: ${JSON.stringify(sourceId)}`,
    );
  }
  const parsed = Number(trimmed);
  if (!isValidWorkId(parsed)) {
    throw new Error(
      `[playback-identity] invalid work sourceId: ${JSON.stringify(sourceId)}`,
    );
  }
  return parsed;
}

/**
 * legacy 来源解析（§38 Identity 组）：
 * chat(sourceId=messageId) → draft；generation(sourceId=String(workId)) → work；
 * draft / work 透传同语义。非法输入抛错（fail-closed）。
 */
export function parseLegacyPlaybackSource(
  sourceType: string,
  sourceId: string,
): PlaybackSourceRef {
  const kind = canonicalizeSourceKind(sourceType);
  if (kind === 'draft') {
    // createDraftSource 内含 replay-text-* 拒绝（fail-closed）。
    if (typeof sourceId !== 'string') {
      throw new Error('[playback-identity] invalid draft sourceId: non-string');
    }
    return createDraftSource(sourceId);
  }
  return createWorkSource(parseLegacyWorkId(sourceId));
}

/**
 * 非抛错版 legacy 解析：合法返回 PlaybackSourceRef，非法返回 null。
 * 调用方须对 null 走丢弃 / 重置路径，不得回退猜测。
 */
export function tryParseLegacyPlaybackSource(
  sourceType: unknown,
  sourceId: unknown,
): PlaybackSourceRef | null {
  try {
    if (typeof sourceType !== 'string' || typeof sourceId !== 'string') return null;
    return parseLegacyPlaybackSource(sourceType, sourceId);
  } catch {
    return null;
  }
}
