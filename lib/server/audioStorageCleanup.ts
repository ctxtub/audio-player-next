/**
 * M8-05-01 Audio deletion tombstone and cleanup engine (spec section 29).
 *
 * Scope (this item only):
 * - Record one tombstone row per opaque object key inside the caller's DB
 *   transaction, so a later physical removal can stay atomic at the DB layer.
 * - Bounded background consumption of due tombstones: call object delete,
 *   remove the row on success, keep and reschedule the row on failure.
 * - Best-effort directed cleanup for immediate post-commit attempts.
 *
 * Hard boundaries (locked by unit static oracle):
 * - Backend-neutral: only depends on the neutral `AudioAssetStorage` contract
 *   (`delete`), never on concrete backend modules or vendor SDKs.
 * - No cross-domain imports: this file must not import owner-record, session,
 *   anchor, chat, library, or route layers. It only touches the deletion
 *   tombstone table plus the neutral storage contract.
 * - Never hold a DB transaction across object calls: enqueue runs inside the
 *   caller's transaction (single delegated write per key); consumption reads
 *   due rows first, then calls object delete outside any transaction, then
 *   applies one short row write per key.
 */

import { prisma } from '@/lib/db';
import { getAudioAssetStorage } from '@/lib/audio/storage';
import {
  AudioObjectNotFoundError,
  type AudioAssetStorage,
} from '@/lib/audio/storage/types';

/** Default bounded batch size for one consumption pass. */
export const AUDIO_DELETION_DEFAULT_LIMIT = 50;

/** Hard upper bound for one consumption pass (unbounded full-table scans forbidden). */
export const AUDIO_DELETION_MAX_LIMIT = 100;

/** Base retry delay after the first failure (5 minutes). */
export const AUDIO_DELETION_RETRY_BASE_MS = 5 * 60 * 1000;

/** Upper bound for a single retry delay (24 hours). */
export const AUDIO_DELETION_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

/** Max stored chars for sanitized failure text. */
export const AUDIO_DELETION_MAX_LAST_ERROR_CHARS = 500;

/**
 * Minimal DB surface used by this engine (satisfied by the global client and
 * by a transaction client, so the enqueue entry can be called inside a
 * caller-owned transaction without touching the global client).
 *
 * Deliberately narrow (only the four tombstone operations this file needs),
 * so in-memory fakes can substitute it in unit scope without a real store.
 * Delegate args are loosely typed on purpose: the concrete Prisma delegate
 * carries generic conditional args that a minimal fake cannot name, and a
 * narrow fake shape cannot accept the concrete delegate under strict
 * contravariance. Loose args keep both directions assignable.
 */
export type AudioDeletionTombstoneRow = {
  storageKey: string;
  attempts: number;
  nextAttemptAt: Date | null;
};

export type AudioDeletionTx = {
  audioStorageDeletion: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args?: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update(args: any): Promise<any>;
  };
};

/** Options for bounded consumption. */
export type CleanupAudioStorageDeletionsOptions = {
  /** Object backend (defaults to the configured canonical singleton). */
  storage?: AudioAssetStorage;
  /** Clock (defaults to current time; tests inject a fake clock). */
  now?: Date;
  /** Desired batch size (clamped to [1, MAX]; defaults to DEFAULT). */
  limit?: number;
  /** DB surface (defaults to global client; tests may inject a fake). */
  db?: AudioDeletionTx;
};

/** Options for directed best-effort cleanup. */
export type CleanupAudioStorageKeysOptions = {
  /** Object backend (defaults to the configured canonical singleton). */
  storage?: AudioAssetStorage;
  /** DB surface (defaults to global client; tests may inject a fake). */
  db?: AudioDeletionTx;
};

/** Result of bounded consumption. */
export type CleanupAudioStorageDeletionsResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  attemptedKeys: string[];
};

/** Result of directed best-effort cleanup. */
export type CleanupAudioStorageKeysResult = {
  attempted: number;
  succeeded: number;
  failed: number;
};

/**
 * Sanitize a caught object error into short tombstone text.
 *
 * Must never persist credential material or location-bearing values:
 * absolute URLs (including short-lived signed query strings), file URLs,
 * query strings, bearer material, and `key=value` credential shapes are
 * redacted, then the text is truncated.
 */
export function sanitizeDeletionErrorMessage(err: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message;
  } else if (typeof err === 'string') {
    raw = err;
  } else {
    try {
      raw = String(err);
    } catch {
      raw = 'unknown object deletion error';
    }
  }
  if (!raw || raw.trim().length === 0) {
    return 'object deletion failed';
  }
  let out = raw;
  out = out.replace(/https?:\/\/[^\s'"`<>]+/gi, '<url-redacted>');
  out = out.replace(/file:[^\s'"`<>]+/gi, 'file:<redacted>');
  out = out.replace(
    /(secret|password|passwd|pwd|token|signature|credential|access[_-]?key|api[_-]?key)(\s*[:=]\s*)[^\s,;'"`]+/gi,
    '$1$2<redacted>',
  );
  out = out.replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer <redacted>');
  out = out.replace(/\?[^\s'"`<>]*/g, '?<redacted>');
  out = out.trim();
  if (out.length > AUDIO_DELETION_MAX_LAST_ERROR_CHARS) {
    out = out.slice(0, AUDIO_DELETION_MAX_LAST_ERROR_CHARS);
  }
  return out.length > 0 ? out : 'object deletion failed';
}

/**
 * Compute the next retry time after a failure.
 *
 * Exponential backoff on the post-increment attempt count with a fixed base
 * and a daily cap; the result is always strictly in the future.
 */
export function computeDeletionRetryAt(
  now: Date,
  attemptsAfterIncrement: number,
): Date {
  const safeAttempt =
    Number.isFinite(attemptsAfterIncrement) && attemptsAfterIncrement > 0
      ? Math.floor(attemptsAfterIncrement)
      : 1;
  const exponent = Math.min(safeAttempt - 1, 10);
  const delayMs = Math.min(
    AUDIO_DELETION_RETRY_BASE_MS * 2 ** exponent,
    AUDIO_DELETION_RETRY_MAX_MS,
  );
  return new Date(now.getTime() + delayMs);
}

/**
 * Normalize a requested batch size into the bounded range.
 */
export function normalizeDeletionCleanupLimit(limit?: number | null): number {
  if (limit === undefined || limit === null) {
    return AUDIO_DELETION_DEFAULT_LIMIT;
  }
  const parsed = Math.floor(Number(limit));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return AUDIO_DELETION_DEFAULT_LIMIT;
  }
  return Math.min(parsed, AUDIO_DELETION_MAX_LIMIT);
}

/**
 * Decide whether an object-delete failure means "already gone" (cleanup
 * success, row must go away) rather than a retryable failure.
 *
 * Both backends delete idempotently, so this path is a safety net for
 * drivers that surface typed/absent markers instead of silent success.
 */
export function isMissingObjectDeletionError(err: unknown): boolean {
  if (err instanceof AudioObjectNotFoundError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (
    candidate.name === 'AudioObjectNotFoundError' ||
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey'
  ) {
    return true;
  }
  if (
    candidate.code === 'ENOENT' ||
    candidate.code === 'ENOTDIR' ||
    candidate.code === 'NotFound' ||
    candidate.code === 'NoSuchKey'
  ) {
    return true;
  }
  const status = candidate.$metadata?.httpStatusCode;
  if (status === 404) return true;
  if (typeof candidate.message === 'string') {
    if (/NoSuchKey|\bNotFound\b/i.test(candidate.message)) {
      return true;
    }
  }
  return false;
}

function dedupeStorageKeys(storageKeys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of storageKeys) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Record one tombstone per object key inside the caller's transaction.
 *
 * Idempotent per key: repeating the same key (in one call or across calls)
 * leaves exactly one row and never resets retry bookkeeping.
 */
export async function enqueueAudioDeletionTombstones(
  tx: AudioDeletionTx,
  storageKeys: string[],
): Promise<{ enqueued: number }> {
  const keys = dedupeStorageKeys(storageKeys ?? []);
  for (const storageKey of keys) {
    await tx.audioStorageDeletion.upsert({
      where: { storageKey },
      create: { storageKey },
      update: {},
    });
  }
  return { enqueued: keys.length };
}

/**
 * Bounded consumption of due tombstones.
 *
 * Only rows with `nextAttemptAt IS NULL OR nextAttemptAt <= now` are
 * attempted, oldest first, at most the normalized limit. Per row:
 * - object delete success (including already-gone markers) removes the row;
 * - any other failure keeps the row with `attempts + 1`, sanitized
 *   `lastError`, and a future `nextAttemptAt`.
 */
export async function cleanupAudioStorageDeletions(
  options: CleanupAudioStorageDeletionsOptions = {},
): Promise<CleanupAudioStorageDeletionsResult> {
  const effectiveLimit = normalizeDeletionCleanupLimit(options.limit);
  const now = options.now ?? new Date();
  const storage = options.storage ?? getAudioAssetStorage();
  const db = options.db ?? prisma;

  const due = await db.audioStorageDeletion.findMany({
    where: {
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: effectiveLimit,
  });

  let succeeded = 0;
  let failed = 0;
  for (const row of due) {
    const storageKey = row.storageKey;
    try {
      await storage.delete(storageKey);
    } catch (err) {
      if (!isMissingObjectDeletionError(err)) {
        const attemptsAfter = (row.attempts ?? 0) + 1;
        try {
          await db.audioStorageDeletion.update({
            where: { storageKey },
            data: {
              attempts: { increment: 1 },
              lastError: sanitizeDeletionErrorMessage(err),
              nextAttemptAt: computeDeletionRetryAt(now, attemptsAfter),
            },
          });
        } catch {
          // Bookkeeping is best-effort; the row stays for the next pass.
        }
        failed += 1;
        continue;
      }
    }
    try {
      await db.audioStorageDeletion.delete({ where: { storageKey } });
    } catch {
      // Row already gone (concurrent pass); treat as success.
    }
    succeeded += 1;
  }

  return {
    attempted: due.length,
    succeeded,
    failed,
    attemptedKeys: due.map((row: AudioDeletionTombstoneRow) => row.storageKey),
  };
}

/**
 * Directed best-effort object cleanup for an explicit key set.
 *
 * Used for immediate post-commit attempts: success (including already-gone)
 * also clears the matching tombstone row when present; any other failure is
 * swallowed so the bounded pass can retry it later with bookkeeping.
 */
export async function cleanupAudioStorageKeys(
  storageKeys: string[],
  options: CleanupAudioStorageKeysOptions = {},
): Promise<CleanupAudioStorageKeysResult> {
  const keys = dedupeStorageKeys(storageKeys ?? []);
  const storage = options.storage ?? getAudioAssetStorage();
  const db = options.db ?? prisma;

  let succeeded = 0;
  let failed = 0;
  for (const storageKey of keys) {
    try {
      await storage.delete(storageKey);
    } catch (err) {
      if (!isMissingObjectDeletionError(err)) {
        failed += 1;
        continue;
      }
    }
    try {
      await db.audioStorageDeletion.delete({ where: { storageKey } });
    } catch {
      // Missing row is fine for a directed attempt.
    }
    succeeded += 1;
  }
  return { attempted: keys.length, succeeded, failed };
}
