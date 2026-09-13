/**
 * M5-01 Playback Session 纯领域契约（spec §4 / §4.1）
 *
 * sessionId 不再等于 messageId，而是真正的 Playback Session identity：
 * `crypto.randomUUID()`，每次“开始新 Work / 从头播放 / 切换 Source”创建新值；
 * pause→resume / 刷新 rehydrate / 跨页面导航保持原值。
 *
 * 核心作用是防止异步 stale write（§4.1）：
 * 只有 sessionId 与当前 PlaybackAnchor.sessionId 相同的 checkpoint
 * 才有权更新当前 Anchor，旧 Session 晚到以 STALE_SESSION 忽略。
 *
 * 本文件为纯领域层：无 DB / store / API 依赖。
 */

/** stale 会话拒绝原因码（服务端忽略旧 Session 晚到写入的唯一依据）。 */
export const STALE_SESSION = 'STALE_SESSION' as const;

/** checkpoint 准入判决原因 */
export type CheckpointRejectReason = typeof STALE_SESSION;

/** checkpoint 准入判决结果 */
export type CheckpointDecision =
  | { accepted: true }
  | { accepted: false; reason: CheckpointRejectReason };

/** UUID 文本格式（大小写不敏感的标准 8-4-4-4-12 十六进制）。 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 创建新的 Playback Session identity（§4：每次新会话 crypto.randomUUID()）。 */
export function createPlaybackSessionId(): string {
  return crypto.randomUUID();
}

/** sessionId 合法性：须为标准 UUID 文本。null / 空串 / messageId 均判 false。 */
export function isValidPlaybackSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * 会话修复（§33 纯逻辑部分）：合法则原样返回，否则生成新 UUID。
 * 物理写回由 M5-02+ 服务端完成，本函数不触库。
 */
export function ensurePlaybackSessionId(value: unknown): string {
  if (isValidPlaybackSessionId(value)) return value;
  return createPlaybackSessionId();
}

/**
 * checkpoint 准入判决（§4.1 服务端规则的纯判定部分）：
 * - 当前 Anchor sessionId 缺失 / 非法（legacy null）：接受（走修复路径，非 stale）；
 * - checkpoint sessionId 非法：拒绝为 STALE_SESSION（fail-closed，不覆盖新 Now Playing）；
 * - 双方合法且严格相等：接受；
 * - 否则：拒绝为 STALE_SESSION，直接忽略，绝不覆盖新 Anchor。
 */
export function decideCheckpointAcceptance(
  checkpointSessionId: unknown,
  currentAnchorSessionId: unknown,
): CheckpointDecision {
  if (!isValidPlaybackSessionId(currentAnchorSessionId)) {
    return { accepted: true };
  }
  if (!isValidPlaybackSessionId(checkpointSessionId)) {
    return { accepted: false, reason: STALE_SESSION };
  }
  if (checkpointSessionId === currentAnchorSessionId) {
    return { accepted: true };
  }
  return { accepted: false, reason: STALE_SESSION };
}

/** 便捷谓词：checkpoint 是否为 stale（应被忽略）。 */
export function isStaleSession(
  checkpointSessionId: unknown,
  currentAnchorSessionId: unknown,
): boolean {
  return !decideCheckpointAcceptance(checkpointSessionId, currentAnchorSessionId).accepted;
}
