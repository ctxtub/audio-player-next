/**
 * M5-01 Playback Identity 纯领域契约：PlaybackSourceRef（spec §3）
 *
 * 业务层唯一合法的播放来源标识。不再使用弱类型：
 * `{ sourceType: string; sourceId: string }`，
 * 更不允许 `generation sourceId = String(123)` 这类隐式字符串化 identity。
 *
 * - Draft：尚未拥有稳定 StoryWork identity 的 Chat Story Artifact，
 *   identity 为 ChatMessage.messageId；不拥有长期 Per-Work Progress（§3.2）。
 * - Work：M2 已持久化完成的 StoryWork，identity 为 StoryWork.id（§3.3）。
 *   title / storyText / voiceId / contentHash 全部以 StoryWork 为准，
 *   播放层不得再用 prompt.slice / '音频故事' / '作品回放' 推导 identity。
 *
 * 本文件为纯领域层：无 DB / store / API / Prisma 依赖。
 * Legacy 文本解析（chat|generation|draft|work）见 ./legacy.ts。
 */

/** 播放来源种类：draft（Chat Artifact）| work（StoryWork） */
export type PlaybackSourceKind = 'draft' | 'work';

/**
 * 播放来源引用（discriminated union）。
 * kind 收窄后另一分支字段不可访问，彻底消除弱类型 sourceId 混用。
 */
export type PlaybackSourceRef =
  | {
      kind: 'draft';
      messageId: string;
    }
  | {
      kind: 'work';
      workId: number;
    };

/** 瞬态回放 ID 前缀：绝不允许成为持久化 Draft identity（fail-closed，见 §38）。 */
export const REPLAY_TEXT_PREFIX = 'replay-text-';

/**
 * workId 合法性：仅 positive int（§3.3 / §38）。
 * 拒绝 0 / 负数 / 小数 / NaN / Infinity / 非 number / 非安全整数。
 */
export function isValidWorkId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    (value as number) > 0
  );
}

/**
 * draft messageId 合法性：非空（去空白后仍非空）且禁止 replay-text-* 前缀。
 */
export function isValidDraftMessageId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !value.startsWith(REPLAY_TEXT_PREFIX)
  );
}

/**
 * 构造 Draft source。非法 messageId（空串 / 全空白 / replay-text-*）直接抛错，
 * fail-closed，调用方不得降级为“先建再说”。
 */
export function createDraftSource(messageId: string): PlaybackSourceRef {
  if (!isValidDraftMessageId(messageId)) {
    throw new Error(
      `[playback-identity] invalid draft messageId: ${JSON.stringify(messageId)}`,
    );
  }
  return { kind: 'draft', messageId };
}

/**
 * 构造 Work source。非 positive int 直接抛错（fail-closed）。
 */
export function createWorkSource(workId: number): PlaybackSourceRef {
  if (!isValidWorkId(workId)) {
    throw new Error(`[playback-identity] invalid workId: ${String(workId)}`);
  }
  return { kind: 'work', workId };
}

/**
 * PlaybackSourceRef 类型守卫（fail-closed）：
 * 未知 kind、缺字段、非法 workId、replay-text-* draft 全部判 false。
 */
export function isPlaybackSourceRef(value: unknown): value is PlaybackSourceRef {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'draft') {
    return isValidDraftMessageId(record.messageId);
  }
  if (record.kind === 'work') {
    return isValidWorkId(record.workId);
  }
  return false;
}

/**
 * 规范化复制：返回与输入语义完全相同的全新对象（防御性拷贝）。
 * 输入非法直接抛错，不做任何静默修正。
 */
export function normalizePlaybackSourceRef(source: PlaybackSourceRef): PlaybackSourceRef {
  if (!isPlaybackSourceRef(source)) {
    throw new Error('[playback-identity] invalid PlaybackSourceRef');
  }
  return source.kind === 'draft'
    ? { kind: 'draft', messageId: source.messageId }
    : { kind: 'work', workId: source.workId };
}

/** 来源相等性：同 kind 且同 identity 才相等。 */
export function equalPlaybackSource(
  a: PlaybackSourceRef | null | undefined,
  b: PlaybackSourceRef | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (!isPlaybackSourceRef(a) || !isPlaybackSourceRef(b)) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === 'draft'
    ? a.messageId === (b as { messageId: string }).messageId
    : a.workId === (b as { workId: number }).workId;
}

/**
 * 稳定key：`draft:<messageId>` / `work:<workId>`。
 * 供 lastSavedKey / 去重 / 日志使用，不进入持久化列。
 */
export function playbackSourceKey(source: PlaybackSourceRef): string {
  if (!isPlaybackSourceRef(source)) {
    throw new Error('[playback-identity] invalid PlaybackSourceRef');
  }
  return source.kind === 'draft' ? `draft:${source.messageId}` : `work:${source.workId}`;
}

/**
 * 持久化对序列化：映射到 Anchor 列对（sourceKind / sourceId）。
 * work 侧 `String(workId)` 是此处唯一的合法字符串化点；
 * draft 侧 sourceId 即 messageId 原样。
 * 注意：本函数只做纯序列化，不触及 Prisma schema（M5-02+ 才动库）。
 */
export function serializePlaybackSource(source: PlaybackSourceRef): {
  kind: PlaybackSourceKind;
  sourceId: string;
} {
  if (!isPlaybackSourceRef(source)) {
    throw new Error('[playback-identity] invalid PlaybackSourceRef');
  }
  return source.kind === 'draft'
    ? { kind: 'draft', sourceId: source.messageId }
    : { kind: 'work', sourceId: String(source.workId) };
}
