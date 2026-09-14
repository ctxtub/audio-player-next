import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import type { AudioDeletionTx } from '../../../lib/server/audioStorageCleanup';
import {
  AUDIO_DELETION_DEFAULT_LIMIT,
  AUDIO_DELETION_MAX_LAST_ERROR_CHARS,
  AUDIO_DELETION_MAX_LIMIT,
  AUDIO_DELETION_RETRY_BASE_MS,
  cleanupAudioStorageDeletions,
  cleanupAudioStorageKeys,
  computeDeletionRetryAt,
  enqueueAudioDeletionTombstones,
  isMissingObjectDeletionError,
  normalizeDeletionCleanupLimit,
  sanitizeDeletionErrorMessage,
} from '../../../lib/server/audioStorageCleanup';
import { AudioObjectNotFoundError } from '../../../lib/audio/storage/types';
import type { AudioAssetStorage } from '../../../lib/audio/storage/types';

/**
 * M8-05-01 Audio Deletion Tombstone & Cleanup Engine 单元测试（无需真库）。
 *
 * 锁定（与任务可测验收对应）：
 * 1. enqueue 同 key 两次幂等（count == 1，不重置 retry 位）；
 * 2. memory 对象 + tombstone → cleanup → 对象与 tombstone 双 gone；
 * 3. delete 抛错 → tombstone 保留、attempts == 1、nextAttemptAt > now、lastError 脱敏；
 * 4. nextAttemptAt > now → 本轮不调用 delete；
 * 5. 时钟推进到 due → retry success → tombstone gone；
 * 6. 对象本来 missing → cleanup success → tombstone gone；
 * 7. 双后端形态 lifecycle 语义相同；
 * 8. 静态 oracle：cleanup 不触 owner/会话/路由层，不直连远端 SDK，bounded 消费。
 * 12. 404 窄分类：NoSuchKey+404=missing 成功清行；NoSuchBucket+404/generic-404=retry 保留。
 */

type TombstoneRow = {
  id: number;
  storageKey: string;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function createFakeDeletionDb(baseMs: number) {
  const rows = new Map<string, TombstoneRow>();
  let seq = 1;
  const db = {
    rows,
    audioStorageDeletion: {
      async upsert(args: {
        where: { storageKey: string };
        create: { storageKey: string };
        update: Record<string, never>;
      }) {
        const key = args.where.storageKey;
        const existing = rows.get(key);
        if (existing) return existing;
        const row: TombstoneRow = {
          id: seq,
          storageKey: key,
          attempts: 0,
          nextAttemptAt: null,
          lastError: null,
          createdAt: new Date(baseMs + seq * 10),
          updatedAt: new Date(baseMs + seq * 10),
        };
        seq += 1;
        rows.set(key, row);
        return row;
      },
      async findMany(args: {
        where?: {
          OR?: Array<{ nextAttemptAt?: null | { lte: Date } }>;
        };
        orderBy?: unknown;
        take?: number;
      }) {
        let now: Date | null = null;
        const orList = args.where?.OR ?? [];
        for (const cond of orList) {
          const lte = (cond.nextAttemptAt as { lte?: Date } | null | undefined)
            ?.lte;
          if (lte instanceof Date) now = lte;
        }
        const effectiveNow = now ?? new Date(baseMs);
        let out = [...rows.values()].filter(
          (r) =>
            r.nextAttemptAt === null ||
            (r.nextAttemptAt instanceof Date &&
              r.nextAttemptAt.getTime() <= effectiveNow.getTime()),
        );
        out.sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id,
        );
        if (typeof args.take === 'number') out = out.slice(0, args.take);
        return out.map((r) => ({ ...r }));
      },
      async delete(args: { where: { storageKey: string } }) {
        const row = rows.get(args.where.storageKey);
        if (!row) {
          const err = new Error('Record to delete does not exist.');
          (err as { code?: string }).code = 'P2025';
          throw err;
        }
        rows.delete(args.where.storageKey);
        return row;
      },
      async update(args: {
        where: { storageKey: string };
        data: {
          attempts?: { increment: number } | number;
          lastError?: string | null;
          nextAttemptAt?: Date | null;
        };
      }) {
        const row = rows.get(args.where.storageKey);
        if (!row) {
          const err = new Error('Record to update not found.');
          (err as { code?: string }).code = 'P2025';
          throw err;
        }
        if (
          typeof args.data.attempts === 'object' &&
          args.data.attempts !== null &&
          'increment' in args.data.attempts
        ) {
          row.attempts += args.data.attempts.increment;
        } else if (typeof args.data.attempts === 'number') {
          row.attempts = args.data.attempts;
        }
        if ('lastError' in args.data) row.lastError = args.data.lastError ?? null;
        if ('nextAttemptAt' in args.data) {
          row.nextAttemptAt = args.data.nextAttemptAt ?? null;
        }
        row.updatedAt = new Date();
        return { ...row };
      },
      async count() {
        return rows.size;
      },
    },
  };
  return db;
}

type FakeDb = ReturnType<typeof createFakeDeletionDb>;

/** 本地盘形态内存后端（delete 幂等，missing 亦成功）。 */
function createMemoryBackend(): AudioAssetStorage & {
  objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  const storage: AudioAssetStorage & { objects: Map<string, Uint8Array> } = {
    objects,
    async put(input) {
      objects.set(input.key, input.bytes.slice());
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async getMetadata(key) {
      const found = objects.get(key);
      if (!found) return null;
      return { size: found.byteLength, contentType: 'audio/mpeg' };
    },
    async resolveRead(key) {
      const found = objects.get(key);
      if (!found) throw new AudioObjectNotFoundError(key);
      return {
        kind: 'bytes',
        bytes: found.slice(),
        contentType: 'audio/mpeg',
        totalSize: found.byteLength,
        range: null,
      };
    },
  };
  return storage;
}

/** 远端形态内存后端（delete/覆盖语义与本地一致，读取形态为 redirect）。 */
function createRemoteLikeBackend(): AudioAssetStorage & {
  objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  const storage: AudioAssetStorage & { objects: Map<string, Uint8Array> } = {
    objects,
    async put(input) {
      objects.set(input.key, input.bytes.slice());
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async getMetadata(key) {
      const found = objects.get(key);
      if (!found) return null;
      return { size: found.byteLength, contentType: 'audio/mpeg' };
    },
    async resolveRead(key) {
      const found = objects.get(key);
      if (!found) throw new AudioObjectNotFoundError(key);
      return {
        kind: 'redirect',
        url: `https://example.test/signed/${key}?X-Amz-Expires=900`,
      };
    },
  };
  return storage;
}

function createThrowingBackend(
  inner: AudioAssetStorage,
  onDelete: () => Promise<void>,
): AudioAssetStorage & { deleteCalls: string[] } {
  const deleteCalls: string[] = [];
  const storage = {
    deleteCalls,
    async put(input: { key: string; bytes: Uint8Array; contentType: string }) {
      return inner.put(input);
    },
    async exists(key: string) {
      return inner.exists(key);
    },
    async delete(key: string) {
      deleteCalls.push(key);
      await onDelete();
    },
    async getMetadata(key: string) {
      return inner.getMetadata(key);
    },
    async resolveRead(key: string, rangeHeader?: string | null) {
      return inner.resolveRead(key, rangeHeader);
    },
  };
  return storage;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
}

async function runAudioStorageCleanupUnitTests() {
  const baseMs = new Date('2026-09-12T00:00:00.000Z').getTime();
  const baseNow = new Date(baseMs);

  console.log('=== 1. enqueue 幂等：同 key 两次 → count == 1 ===');
  {
    const db = createFakeDeletionDb(baseMs);
    const key = 'story-audio/m805-unit-idempotent.mp3';
    await enqueueAudioDeletionTombstones(db, [key]);
    await enqueueAudioDeletionTombstones(db, [key]);
    assert.strictEqual(db.rows.size, 1, '重复 enqueue 必须幂等为 1 行');
    const row = db.rows.get(key)!;
    assert.strictEqual(row.attempts, 0, '幂等 enqueue 不得碰 attempts');
    assert.strictEqual(row.nextAttemptAt, null, '幂等 enqueue 不得设 retry');
    // 同批重复亦幂等
    await enqueueAudioDeletionTombstones(db, [key, key]);
    assert.strictEqual(db.rows.size, 1, '同批重复亦幂等');
    // 空输入零写
    const res = await enqueueAudioDeletionTombstones(db, []);
    assert.strictEqual(res.enqueued, 0, '空输入 enqueued == 0');
    assert.strictEqual(db.rows.size, 1, '空输入不新增');
    console.log('PASS: 1. enqueue 幂等通过');
  }

  console.log('=== 2. memory 对象 + tombstone → cleanup 双 gone ===');
  {
    const db = createFakeDeletionDb(baseMs);
    const storage = createMemoryBackend();
    const key = 'story-audio/m805-unit-lifecycle.mp3';
    await storage.put({
      key,
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentType: 'audio/mpeg',
    });
    await enqueueAudioDeletionTombstones(db, [key]);
    assert.strictEqual(await storage.exists(key), true, '对象预置存在');
    const res = await cleanupAudioStorageDeletions({
      storage,
      now: baseNow,
      db: db as unknown as AudioDeletionTx,
    });
    assert.strictEqual(res.attempted, 1, 'attempted == 1');
    assert.strictEqual(res.succeeded, 1, 'succeeded == 1');
    assert.strictEqual(res.failed, 0, 'failed == 0');
    assert.strictEqual(await storage.exists(key), false, '对象 gone');
    assert.strictEqual(db.rows.size, 0, 'tombstone gone');
    console.log('PASS: 2. 成功清理通过');
  }

  console.log('=== 3. delete 抛错 → 保留 + attempts=1 + 下次未来 + 脱敏 ===');
  {
    const db = createFakeDeletionDb(baseMs);
    const inner = createMemoryBackend();
    const key = 'story-audio/m805-unit-retry.mp3';
    await inner.put({
      key,
      bytes: new Uint8Array([9, 9]),
      contentType: 'audio/mpeg',
    });
    const secretMark = 'unit-only-fake-secret-7c1d';
    const signedMark = 'https://example.test/signed/story-audio/x.mp3?X-Amz-Signature=fake123';
    const boom = new Error(
      `fake remote boom secret=${secretMark} url=${signedMark}`,
    );
    const storage = createThrowingBackend(inner, async () => {
      throw boom;
    });
    await enqueueAudioDeletionTombstones(db, [key]);
    const res = await cleanupAudioStorageDeletions({
      storage,
      now: baseNow,
      db: db as unknown as AudioDeletionTx,
    });
    assert.strictEqual(res.succeeded, 0, '失败不得计 succeeded');
    assert.strictEqual(res.failed, 1, 'failed == 1');
    assert.strictEqual(db.rows.size, 1, 'tombstone 保留');
    const row = db.rows.get(key)!;
    assert.strictEqual(row.attempts, 1, 'attempts == 1');
    assert.ok(
      row.nextAttemptAt instanceof Date &&
        row.nextAttemptAt.getTime() > baseNow.getTime(),
      'nextAttemptAt 必须 > now',
    );
    assert.ok(
      typeof row.lastError === 'string' && row.lastError.length > 0,
      'lastError 非空',
    );
    assert.strictEqual(
      row.lastError!.includes(secretMark),
      false,
      'lastError 不得存 secret 明文',
    );
    assert.strictEqual(
      row.lastError!.includes('X-Amz-Signature=fake123'),
      false,
      'lastError 不得存签名 URL 明文',
    );
    assert.ok(
      row.lastError!.length <= AUDIO_DELETION_MAX_LAST_ERROR_CHARS,
      'lastError 可截断上限',
    );
    // 对象仍在（未删掉）
    assert.strictEqual(await inner.exists(key), true, '失败对象保留');
    console.log('PASS: 3. 失败重试位通过');
  }

  console.log('=== 4. nextAttemptAt > now → 本轮不调用 delete ===');
  {
    const db = createFakeDeletionDb(baseMs);
    const inner = createMemoryBackend();
    const key = 'story-audio/m805-unit-notdue.mp3';
    await inner.put({
      key,
      bytes: new Uint8Array([5]),
      contentType: 'audio/mpeg',
    });
    await enqueueAudioDeletionTombstones(db, [key]);
    const row = db.rows.get(key)!;
    row.nextAttemptAt = new Date(baseMs + 60 * 60 * 1000);
    row.attempts = 1;
    const storage = createThrowingBackend(inner, async () => {
      throw new Error('must-not-be-called');
    });
    storage.deleteCalls.length = 0;
    const res = await cleanupAudioStorageDeletions({
      storage,
      now: baseNow,
      db: db as unknown as AudioDeletionTx,
    });
    assert.strictEqual(res.attempted, 0, '未到期 attempted == 0');
    assert.deepStrictEqual(storage.deleteCalls, [], '未到期不得调用 delete');
    assert.strictEqual(db.rows.size, 1, '未到期 tombstone 保留');
    console.log('PASS: 4. 未到期跳过通过');
  }

  console.log('=== 5. 时钟推进到 due → retry success → gone ===');
  {
    const db = createFakeDeletionDb(baseMs);
    const inner = createMemoryBackend();
    const key = 'story-audio/m805-unit-retry-success.mp3';
    await inner.put({
      key,
      bytes: new Uint8Array([7, 7, 7]),
      contentType: 'audio/mpeg',
    });
    await enqueueAudioDeletionTombstones(db, [key]);
    // 首轮失败
    let shouldThrow = true;
    const flaky = createThrowingBackend(inner, async () => {
      if (shouldThrow) throw new Error('fake transient boom');
      await inner.delete(key);
    });
    const first = await cleanupAudioStorageDeletions({
      storage: flaky,
      now: baseNow,
      db: db as unknown as AudioDeletionTx,
    });
    assert.strictEqual(first.failed, 1, '首轮失败');
    const afterFail = db.rows.get(key)!;
    assert.ok(
      afterFail.nextAttemptAt!.getTime() > baseNow.getTime(),
      '失败后下次为未来',
    );
    // 未到期重试仍跳过
    flaky.deleteCalls.length = 0;
    const skipped = await cleanupAudioStorageDeletions({
      storage: flaky,
      now: baseNow,
      db: db as unknown as AudioDeletionTx,
    });
    assert.strictEqual(skipped.attempted, 0, '未到期跳过');
    // 时钟推进到 due 且后端恢复 → 成功
    shouldThrow = false;
    const dueNow = new Date(afterFail.nextAttemptAt!.getTime() + 1);
    const second = await cleanupAudioStorageDeletions({
      storage: flaky,
      now: dueNow,
      db: db as unknown as AudioDeletionTx,
    });
    assert.strictEqual(second.succeeded, 1, '到期重试成功');
    assert.strictEqual(db.rows.size, 0, 'tombstone gone');
    assert.strictEqual(await inner.exists(key), false, '对象 gone');
    console.log('PASS: 5. 到期重试通过');
  }

  console.log('=== 6. 对象本来 missing → cleanup success → gone ===');
  {
    const db = createFakeDeletionDb(baseMs);
    const storage = createMemoryBackend();
    const key = 'story-audio/m805-unit-missing.mp3';
    assert.strictEqual(await storage.exists(key), false, '对象预置缺失');
    await enqueueAudioDeletionTombstones(db, [key]);
    const res = await cleanupAudioStorageDeletions({
      storage,
      now: baseNow,
      db: db as unknown as AudioDeletionTx,
    });
    assert.strictEqual(res.succeeded, 1, 'missing 即 success');
    assert.strictEqual(res.failed, 0, 'missing 不计 failed');
    assert.strictEqual(db.rows.size, 0, 'tombstone gone');
    // typed missing 抛错亦视为 success
    const db2 = createFakeDeletionDb(baseMs);
    const missingKey = 'story-audio/m805-unit-missing-typed.mp3';
    await enqueueAudioDeletionTombstones(db2, [missingKey]);
    const notFoundThrower = createThrowingBackend(
      createMemoryBackend(),
      async () => {
        throw new AudioObjectNotFoundError(missingKey);
      },
    );
    const res2 = await cleanupAudioStorageDeletions({
      storage: notFoundThrower,
      now: baseNow,
      db: db2 as unknown as AudioDeletionTx,
    });
    assert.strictEqual(res2.succeeded, 1, 'typed missing 即 success');
    assert.strictEqual(db2.rows.size, 0, 'typed missing tombstone gone');
    console.log('PASS: 6. missing=success 通过');
  }

  console.log('=== 7. 双后端形态 lifecycle 语义相同 ===');
  {
    for (const [label, makeBackend] of [
      ['disk-like', createMemoryBackend],
      ['remote-like', createRemoteLikeBackend],
    ] as const) {
      const db = createFakeDeletionDb(baseMs);
      const storage = makeBackend();
      const key = `story-audio/m805-unit-parity-${label}.mp3`;
      await storage.put({
        key,
        bytes: new Uint8Array([1, 1, 1]),
        contentType: 'audio/mpeg',
      });
      await enqueueAudioDeletionTombstones(db, [key]);
      const res = await cleanupAudioStorageDeletions({
        storage,
        now: baseNow,
        db: db as unknown as AudioDeletionTx,
      });
      assert.strictEqual(res.succeeded, 1, `${label} 成功语义一致`);
      assert.strictEqual(db.rows.size, 0, `${label} tombstone gone`);
      // missing 语义一致
      const missingKey = `story-audio/m805-unit-parity-${label}-missing.mp3`;
      await enqueueAudioDeletionTombstones(db, [missingKey]);
      const resMissing = await cleanupAudioStorageDeletions({
        storage,
        now: baseNow,
        db: db as unknown as AudioDeletionTx,
      });
      assert.strictEqual(resMissing.succeeded, 1, `${label} missing 语义一致`);
      assert.strictEqual(db.rows.size, 0, `${label} missing tombstone gone`);
    }
    console.log('PASS: 7. 双后端一致通过');
  }

  console.log('=== 8. bounded：limit 钳制且消费有界 ===');
  {
    assert.strictEqual(
      normalizeDeletionCleanupLimit(undefined),
      AUDIO_DELETION_DEFAULT_LIMIT,
      '缺省 limit',
    );
    assert.strictEqual(
      normalizeDeletionCleanupLimit(9999),
      AUDIO_DELETION_MAX_LIMIT,
      '超上限钳制到 MAX',
    );
    assert.strictEqual(
      normalizeDeletionCleanupLimit(0),
      AUDIO_DELETION_DEFAULT_LIMIT,
      '非法回落缺省',
    );
    const db = createFakeDeletionDb(baseMs);
    const storage = createMemoryBackend();
    const keys = Array.from(
      { length: 5 },
      (_, i) => `story-audio/m805-unit-bounded-${i}.mp3`,
    );
    for (const key of keys) {
      await storage.put({
        key,
        bytes: new Uint8Array([1]),
        contentType: 'audio/mpeg',
      });
    }
    await enqueueAudioDeletionTombstones(db, keys);
    const res = await cleanupAudioStorageDeletions({
      storage,
      now: baseNow,
      limit: 2,
      db: db as unknown as AudioDeletionTx,
    });
    assert.strictEqual(res.attempted, 2, '一次消费 bounded == limit');
    assert.strictEqual(db.rows.size, 3, '剩余 3 行待下轮');
    console.log('PASS: 8. bounded 通过');
  }

  console.log('=== 9. 纯函数：脱敏 / 重试 / 缺失判定 ===');
  {
    const secretMark = 'unit-only-fake-secret-2ab9';
    const sanitized = sanitizeDeletionErrorMessage(
      new Error(
        `boom secret=${secretMark} https://example.test/o/k.mp3?X-Amz-Signature=zzz`,
      ),
    );
    assert.strictEqual(sanitized.includes(secretMark), false, '脱敏去 secret');
    assert.strictEqual(
      sanitized.includes('X-Amz-Signature=zzz'),
      false,
      '脱敏去签名',
    );
    const long = sanitizeDeletionErrorMessage(new Error('e'.repeat(5000)));
    assert.ok(
      long.length <= AUDIO_DELETION_MAX_LAST_ERROR_CHARS,
      '超长截断',
    );
    const t0 = new Date(baseMs);
    const r1 = computeDeletionRetryAt(t0, 1);
    assert.ok(r1.getTime() > t0.getTime(), '重试为未来时间');
    assert.strictEqual(
      r1.getTime() - t0.getTime(),
      AUDIO_DELETION_RETRY_BASE_MS,
      '首退 base 延迟',
    );
    assert.strictEqual(
      isMissingObjectDeletionError(new AudioObjectNotFoundError('k')),
      true,
      'typed missing 识别',
    );
    assert.strictEqual(
      isMissingObjectDeletionError(new Error('fake remote boom')),
      false,
      '普通失败不误判 missing',
    );
    assert.strictEqual(
      isMissingObjectDeletionError(
        Object.assign(new Error('gone'), { code: 'ENOENT' }),
      ),
      true,
      'ENOENT 识别',
    );
    console.log('PASS: 9. 纯函数通过');
  }

  console.log('=== 10. directed：cleanupAudioStorageKeys best-effort ===');
  {
    const db = createFakeDeletionDb(baseMs);
    const storage = createMemoryBackend();
    const okKey = 'story-audio/m805-unit-directed-ok.mp3';
    await storage.put({
      key: okKey,
      bytes: new Uint8Array([3]),
      contentType: 'audio/mpeg',
    });
    await enqueueAudioDeletionTombstones(db, [okKey]);
    const res = await cleanupAudioStorageKeys(
      [okKey],
      {
        storage,
        db: db as unknown as AudioDeletionTx,
      },
    );
    assert.strictEqual(res.succeeded, 1, 'directed 成功');
    assert.strictEqual(await storage.exists(okKey), false, '对象 gone');
    assert.strictEqual(db.rows.size, 0, 'tombstone gone');
    // 失败吞掉不抛，tombstone 留给 bounded 重试
    const db2 = createFakeDeletionDb(baseMs);
    const failKey = 'story-audio/m805-unit-directed-fail.mp3';
    await enqueueAudioDeletionTombstones(db2, [failKey]);
    const failing = createThrowingBackend(createMemoryBackend(), async () => {
      throw new Error('fake directed boom');
    });
    const res2 = await cleanupAudioStorageKeys(
      [failKey],
      {
        storage: failing,
        db: db2 as unknown as AudioDeletionTx,
      },
    );
    assert.strictEqual(res2.failed, 1, 'directed 失败计数');
    assert.strictEqual(db2.rows.size, 1, 'directed 失败保留 tombstone');
    console.log('PASS: 10. directed 通过');
  }

  console.log('=== 12. 404 窄分类：NoSuchKey=missing / NoSuchBucket,generic=retry ===');
  {
    const noSuchKey404 = Object.assign(new Error('NoSuchKey: key gone'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    const noSuchBucket404 = Object.assign(
      new Error('NoSuchBucket: wrong bucket'),
      { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } },
    );
    const generic404 = Object.assign(new Error('SomeBackendError boom'), {
      name: 'SomeBackendError',
      $metadata: { httpStatusCode: 404 },
    });
    assert.strictEqual(
      isMissingObjectDeletionError(noSuchKey404),
      true,
      'NoSuchKey+404 必须判 missing',
    );
    assert.strictEqual(
      isMissingObjectDeletionError(noSuchBucket404),
      false,
      'NoSuchBucket+404 不得判 missing（retry）',
    );
    assert.strictEqual(
      isMissingObjectDeletionError(generic404),
      false,
      'generic-404 不得判 missing（retry）',
    );
    // cleanup 行为对锁：NoSuchKey → missing success → tombstone gone
    {
      const db = createFakeDeletionDb(baseMs);
      const key = 'story-audio/m805-unit-narrow-nosuchkey.mp3';
      await enqueueAudioDeletionTombstones(db, [key]);
      const throwing = createThrowingBackend(
        createMemoryBackend(),
        async () => {
          throw noSuchKey404;
        },
      );
      const res = await cleanupAudioStorageDeletions({
        storage: throwing,
        now: baseNow,
        db: db as unknown as AudioDeletionTx,
      });
      assert.strictEqual(res.succeeded, 1, 'NoSuchKey 即 success');
      assert.strictEqual(res.failed, 0, 'NoSuchKey 不计 failed');
      assert.strictEqual(db.rows.size, 0, 'NoSuchKey tombstone gone');
    }
    // NoSuchBucket → failed=1、tombstone 保留、attempts=1、nextAttemptAt > now
    {
      const db = createFakeDeletionDb(baseMs);
      const key = 'story-audio/m805-unit-narrow-nosuchbucket.mp3';
      await enqueueAudioDeletionTombstones(db, [key]);
      const throwing = createThrowingBackend(
        createMemoryBackend(),
        async () => {
          throw noSuchBucket404;
        },
      );
      const res = await cleanupAudioStorageDeletions({
        storage: throwing,
        now: baseNow,
        db: db as unknown as AudioDeletionTx,
      });
      assert.strictEqual(res.succeeded, 0, 'NoSuchBucket 不得计 success');
      assert.strictEqual(res.failed, 1, 'NoSuchBucket failed == 1');
      assert.strictEqual(db.rows.size, 1, 'NoSuchBucket tombstone 保留');
      const row = db.rows.get(key)!;
      assert.strictEqual(row.attempts, 1, 'NoSuchBucket attempts == 1');
      assert.ok(
        row.nextAttemptAt instanceof Date &&
          row.nextAttemptAt.getTime() > baseNow.getTime(),
        'NoSuchBucket nextAttemptAt > now',
      );
    }
    // generic-404 → retry，不得清 tombstone
    {
      const db = createFakeDeletionDb(baseMs);
      const key = 'story-audio/m805-unit-narrow-generic404.mp3';
      await enqueueAudioDeletionTombstones(db, [key]);
      const throwing = createThrowingBackend(
        createMemoryBackend(),
        async () => {
          throw generic404;
        },
      );
      const res = await cleanupAudioStorageDeletions({
        storage: throwing,
        now: baseNow,
        db: db as unknown as AudioDeletionTx,
      });
      assert.strictEqual(res.failed, 1, 'generic-404 failed == 1');
      assert.strictEqual(db.rows.size, 1, 'generic-404 tombstone 保留');
      assert.strictEqual(
        db.rows.get(key)!.attempts,
        1,
        'generic-404 attempts == 1',
      );
    }
    console.log('PASS: 12. 404 窄分类通过');
  }

  console.log('=== 11. 静态 oracle：领域隔离 + 后端中立 + 有界消费 ===');
  {
    const repoRoot = process.cwd();
    const source = fs.readFileSync(
      path.join(repoRoot, 'lib/server/audioStorageCleanup.ts'),
      'utf-8',
    );
    const code = stripComments(source);
    for (const pat of [
      /from\s+['"][^'"]*storyWork[^'"]*['"]/i,
      /from\s+['"][^'"]*playback[^'"]*['"]/i,
      /from\s+['"][^'"]*guestGc[^'"]*['"]/i,
      /from\s+['"][^'"]*retention[^'"]*['"]/i,
      /from\s+['"][^'"]*ensureSegment[^'"]*['"]/i,
      /@aws-sdk/,
      /from\s+['"][^'"]*storage\/s3['"]/,
      /from\s+['"][^'"]*storage\/local['"]/,
      /S3Client/,
      /GetObjectCommand/,
    ]) {
      assert.strictEqual(
        pat.test(code),
        false,
        `cleanup 不得触达禁区：${String(pat)}`,
      );
    }
    assert.ok(
      /getAudioAssetStorage/.test(code),
      '默认后端经 canonical 单例装配',
    );
    assert.ok(/AudioAssetStorage/.test(code), '依赖中立存储契约');
    assert.ok(/audioStorageDeletion/.test(code), '仅操作删除 tombstone 表');
    assert.ok(/take/.test(code), '消费必须 bounded take');
    assert.ok(
      /AUDIO_DELETION_MAX_LIMIT/.test(code),
      '上限常量锁死',
    );
    assert.ok(/nextAttemptAt/.test(code), '消费仅到期行');
    assert.ok(/lte/.test(code), '到期谓词 lte');
    assert.ok(
      /sanitizeDeletionErrorMessage/.test(code),
      '失败必须脱敏落盘',
    );
    assert.ok(/attempts/.test(code), '失败必须 attempts+1');
    console.log('PASS: 11. 静态 oracle 通过');
  }

  console.log('ALL AUDIO STORAGE CLEANUP UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioStorageCleanupUnitTests()
  .then(() => {
    console.log('ALL AUDIO STORAGE CLEANUP UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
