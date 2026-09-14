import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../../../lib/db';
import { LocalFilesystemStorage } from '../../../lib/audio/storage/local';
import { AudioObjectNotFoundError } from '../../../lib/audio/storage/types';
import type { AudioAssetStorage } from '../../../lib/audio/storage/types';
import {
  cleanupAudioStorageDeletions,
  cleanupAudioStorageKeys,
  enqueueAudioDeletionTombstones,
} from '../../../lib/server/audioStorageCleanup';

/**
 * M8-05-01 Audio Deletion Tombstone & Cleanup Engine 集成测试（真库 + 真目录）。
 *
 * 锁定（与任务可测验收对应，真库口径）：
 * 1. 真事务内 enqueue 同 key 两次 → count == 1（tx 可调用性）；
 * 2. Local 真对象 + tombstone → cleanup → 对象与 tombstone 双 gone；
 * 3. fake 远端 delete 抛错 → 保留、attempts == 1、nextAttemptAt > now；
 * 4. nextAttemptAt > now → 本轮不调用 delete；
 * 5. 时钟推进到 due → retry success → gone；
 * 6. 对象本来 missing → success → gone；
 * 7. Local / fake 远端 lifecycle 语义相同；
 * 8. bounded：limit == 2 时只消费 2 行；
 * 9. directed：成功清行、失败保留。
 */

const TAG = `m805_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function keyOf(name: string): string {
  return `story-audio/${TAG}-${name}.mp3`;
}

function sampleBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 7 + 3) % 256;
  return out;
}

/** fake 远端后端（内存实现；delete 幂等，读取为 redirect 形态）。 */
function createFakeRemoteBackend(): AudioAssetStorage & {
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

function createCountingBackend(
  inner: AudioAssetStorage,
  behavior: { throwOnDelete?: Error | null } = {},
): AudioAssetStorage & { deleteCalls: string[] } {
  const deleteCalls: string[] = [];
  return {
    deleteCalls,
    async put(input) {
      return inner.put(input);
    },
    async exists(key) {
      return inner.exists(key);
    },
    async delete(key) {
      deleteCalls.push(key);
      if (behavior.throwOnDelete) throw behavior.throwOnDelete;
      return inner.delete(key);
    },
    async getMetadata(key) {
      return inner.getMetadata(key);
    },
    async resolveRead(key, rangeHeader) {
      return inner.resolveRead(key, rangeHeader);
    },
  };
}

async function countTombstones(keys: string[]): Promise<number> {
  return prisma.audioStorageDeletion.count({
    where: { storageKey: { in: keys } },
  });
}

async function wipeTombstones(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await prisma.audioStorageDeletion.deleteMany({
    where: { storageKey: { in: keys } },
  });
}

async function runAudioStorageCleanupIntegrationTests() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm805-cleanup-'));
  try {
    console.log('=== 1. 真事务内 enqueue 幂等：同 key 两次 → count == 1 ===');
    {
      const key = keyOf('idempotent');
      await wipeTombstones([key]);
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [key]);
      });
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [key]);
      });
      assert.strictEqual(await countTombstones([key]), 1, '真事务重复 enqueue 必须为 1 行');
      const row = await prisma.audioStorageDeletion.findUnique({
        where: { storageKey: key },
      });
      assert.strictEqual(row!.attempts, 0, '幂等不碰 attempts');
      assert.strictEqual(row!.nextAttemptAt, null, '幂等不设 retry');
      await wipeTombstones([key]);
      console.log('PASS: 1. 真事务幂等通过');
    }

    console.log('=== 2. Local 真对象 + tombstone → cleanup 双 gone ===');
    {
      const storage = new LocalFilesystemStorage({ root: tmpRoot });
      const key = keyOf('local-lifecycle');
      await wipeTombstones([key]);
      await storage.put({
        key,
        bytes: sampleBytes(64),
        contentType: 'audio/mpeg',
      });
      assert.strictEqual(await storage.exists(key), true, '对象预置存在');
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [key]);
      });
      const res = await cleanupAudioStorageDeletions({
        storage,
        now: new Date(),
      });
      assert.ok(res.attempted >= 1, '至少消费 1 行');
      assert.strictEqual(await storage.exists(key), false, 'Local 对象 gone');
      assert.strictEqual(await countTombstones([key]), 0, 'tombstone gone');
      await wipeTombstones([key]);
      console.log('PASS: 2. Local 成功清理通过');
    }

    console.log('=== 3. fake 远端 delete 抛错 → 保留 + attempts=1 + 未来重试 ===');
    {
      const baseNow = new Date();
      const remote = createFakeRemoteBackend();
      const key = keyOf('remote-retry');
      await wipeTombstones([key]);
      await remote.put({
        key,
        bytes: sampleBytes(32),
        contentType: 'audio/mpeg',
      });
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [key]);
      });
      const secretMark = 'integration-only-fake-secret-4e2a';
      const counting = createCountingBackend(remote, {
        throwOnDelete: new Error(
          `fake remote boom secret=${secretMark} https://example.test/signed/x.mp3?X-Amz-Signature=zzz`,
        ),
      });
      const res = await cleanupAudioStorageDeletions({
        storage: counting,
        now: baseNow,
      });
      assert.strictEqual(res.failed, 1, '失败计数 1');
      assert.strictEqual(await countTombstones([key]), 1, 'tombstone 保留');
      const row = await prisma.audioStorageDeletion.findUnique({
        where: { storageKey: key },
      });
      assert.strictEqual(row!.attempts, 1, 'attempts == 1');
      assert.ok(
        row!.nextAttemptAt instanceof Date &&
          (row!.nextAttemptAt as Date).getTime() > baseNow.getTime(),
        'nextAttemptAt > now',
      );
      assert.ok(
        typeof row!.lastError === 'string' &&
          !row!.lastError.includes(secretMark) &&
          !row!.lastError.includes('X-Amz-Signature=zzz'),
        'lastError 脱敏（无 secret/签名）',
      );
      assert.strictEqual(await remote.exists(key), true, '失败对象保留');
      await wipeTombstones([key]);
      console.log('PASS: 3. 远端失败重试位通过');
    }

    console.log('=== 4. nextAttemptAt > now → 本轮不调用 delete ===');
    {
      const baseNow = new Date();
      const storage = new LocalFilesystemStorage({ root: tmpRoot });
      const key = keyOf('notdue');
      await wipeTombstones([key]);
      await storage.put({
        key,
        bytes: sampleBytes(16),
        contentType: 'audio/mpeg',
      });
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [key]);
      });
      await prisma.audioStorageDeletion.update({
        where: { storageKey: key },
        data: {
          attempts: 1,
          nextAttemptAt: new Date(baseNow.getTime() + 60 * 60 * 1000),
          lastError: 'fake prior boom',
        },
      });
      const counting = createCountingBackend(storage);
      const res = await cleanupAudioStorageDeletions({
        storage: counting,
        now: baseNow,
      });
      assert.strictEqual(res.attempted, 0, '未到期 attempted == 0');
      assert.deepStrictEqual(counting.deleteCalls, [], '未到期不得调用 delete');
      assert.strictEqual(await countTombstones([key]), 1, '未到期保留');
      // 清理：删对象 + tombstone，避免污染后继
      await storage.delete(key);
      await wipeTombstones([key]);
      console.log('PASS: 4. 未到期跳过通过');
    }

    console.log('=== 5. 时钟推进到 due → retry success → gone ===');
    {
      const baseNow = new Date();
      const remote = createFakeRemoteBackend();
      const key = keyOf('retry-success');
      await wipeTombstones([key]);
      await remote.put({
        key,
        bytes: sampleBytes(48),
        contentType: 'audio/mpeg',
      });
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [key]);
      });
      const flakyInner = remote;
      let shouldThrow = true;
      const flaky: AudioAssetStorage & { deleteCalls: string[] } = {
        deleteCalls: [],
        async put(input) {
          return flakyInner.put(input);
        },
        async exists(k) {
          return flakyInner.exists(k);
        },
        async delete(k) {
          (this as { deleteCalls: string[] }).deleteCalls.push(k);
          if (shouldThrow) throw new Error('fake transient boom');
          return flakyInner.delete(k);
        },
        async getMetadata(k) {
          return flakyInner.getMetadata(k);
        },
        async resolveRead(k, r) {
          return flakyInner.resolveRead(k, r);
        },
      };
      const first = await cleanupAudioStorageDeletions({
        storage: flaky,
        now: baseNow,
      });
      assert.strictEqual(first.failed, 1, '首轮失败');
      const afterFail = await prisma.audioStorageDeletion.findUnique({
        where: { storageKey: key },
      });
      assert.ok(
        (afterFail!.nextAttemptAt as Date).getTime() > baseNow.getTime(),
        '失败后为未来',
      );
      shouldThrow = false;
      const dueNow = new Date(
        (afterFail!.nextAttemptAt as Date).getTime() + 1000,
      );
      const second = await cleanupAudioStorageDeletions({
        storage: flaky,
        now: dueNow,
      });
      assert.strictEqual(second.succeeded, 1, '到期重试成功');
      assert.strictEqual(await countTombstones([key]), 0, 'tombstone gone');
      assert.strictEqual(await remote.exists(key), false, '对象 gone');
      await wipeTombstones([key]);
      console.log('PASS: 5. 到期重试通过');
    }

    console.log('=== 6. 对象本来 missing → cleanup success → gone ===');
    {
      // 生产恒为单一 canonical 后端；双形态逐个隔离验证，避免同库跨后端串扰。
      const local = new LocalFilesystemStorage({ root: tmpRoot });
      const remote = createFakeRemoteBackend();
      const localKey = keyOf('missing-local');
      const remoteKey = keyOf('missing-remote');
      await wipeTombstones([localKey, remoteKey]);
      assert.strictEqual(await local.exists(localKey), false, 'Local 预置缺失');
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [localKey]);
      });
      const resLocal = await cleanupAudioStorageDeletions({
        storage: local,
        now: new Date(),
        limit: 100,
      });
      assert.strictEqual(resLocal.succeeded, 1, 'Local missing 即 success');
      assert.strictEqual(await countTombstones([localKey]), 0, 'Local tombstone gone');
      assert.strictEqual(await remote.exists(remoteKey), false, '远端预置缺失');
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [remoteKey]);
      });
      const resRemote = await cleanupAudioStorageDeletions({
        storage: remote,
        now: new Date(),
      });
      assert.strictEqual(resRemote.succeeded, 1, '远端 missing 即 success');
      assert.strictEqual(await countTombstones([remoteKey]), 0, '远端 tombstone gone');
      await wipeTombstones([localKey, remoteKey]);
      console.log('PASS: 6. missing=success 通过');
    }

    console.log('=== 7. Local / fake 远端 lifecycle 语义相同 ===');
    {
      // 同上：逐后端隔离走完 put → tombstone → cleanup 全链，断言语义一致。
      const local = new LocalFilesystemStorage({ root: tmpRoot });
      const remote = createFakeRemoteBackend();
      const localKey = keyOf('parity-local');
      const remoteKey = keyOf('parity-remote');
      await wipeTombstones([localKey, remoteKey]);
      await local.put({
        key: localKey,
        bytes: sampleBytes(24),
        contentType: 'audio/mpeg',
      });
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [localKey]);
      });
      const resLocal = await cleanupAudioStorageDeletions({
        storage: local,
        now: new Date(),
        limit: 100,
      });
      assert.strictEqual(resLocal.succeeded, 1, 'Local 成功');
      assert.strictEqual(await local.exists(localKey), false, 'Local gone');
      assert.strictEqual(await countTombstones([localKey]), 0, 'Local tombstone gone');
      await remote.put({
        key: remoteKey,
        bytes: sampleBytes(24),
        contentType: 'audio/mpeg',
      });
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [remoteKey]);
      });
      const resRemote = await cleanupAudioStorageDeletions({
        storage: remote,
        now: new Date(),
      });
      assert.strictEqual(resRemote.succeeded, 1, '远端成功语义一致');
      assert.strictEqual(await remote.exists(remoteKey), false, '远端 gone');
      assert.strictEqual(
        await countTombstones([remoteKey]),
        0,
        '远端 tombstone gone',
      );
      await wipeTombstones([localKey, remoteKey]);
      console.log('PASS: 7. 双后端一致通过');
    }

    console.log('=== 8. bounded：limit == 2 只消费 2 行 ===');
    {
      const storage = new LocalFilesystemStorage({ root: tmpRoot });
      const keys = Array.from({ length: 5 }, (_, i) => keyOf(`bounded-${i}`));
      await wipeTombstones(keys);
      for (const key of keys) {
        await storage.put({
          key,
          bytes: sampleBytes(8),
          contentType: 'audio/mpeg',
        });
      }
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, keys);
      });
      assert.strictEqual(await countTombstones(keys), 5, '预置 5 行');
      const res = await cleanupAudioStorageDeletions({
        storage,
        now: new Date(),
        limit: 2,
      });
      assert.strictEqual(res.attempted, 2, 'bounded attempted == 2');
      assert.strictEqual(await countTombstones(keys), 3, '剩余 3 行');
      // 收尾：不限量清掉剩余，避免污染
      const rest = await cleanupAudioStorageDeletions({
        storage,
        now: new Date(),
        limit: 100,
      });
      assert.strictEqual(rest.attempted, 3, '收尾 3 行');
      assert.strictEqual(await countTombstones(keys), 0, '全部 gone');
      console.log('PASS: 8. bounded 通过');
    }

    console.log('=== 9. directed：成功清行、失败保留 ===');
    {
      const storage = new LocalFilesystemStorage({ root: tmpRoot });
      const okKey = keyOf('directed-ok');
      const failKey = keyOf('directed-fail');
      await wipeTombstones([okKey, failKey]);
      await storage.put({
        key: okKey,
        bytes: sampleBytes(10),
        contentType: 'audio/mpeg',
      });
      await prisma.$transaction(async (tx) => {
        await enqueueAudioDeletionTombstones(tx, [okKey, failKey]);
      });
      const okRes = await cleanupAudioStorageKeys([okKey], { storage });
      assert.strictEqual(okRes.succeeded, 1, 'directed 成功');
      assert.strictEqual(await storage.exists(okKey), false, '对象 gone');
      assert.strictEqual(await countTombstones([okKey]), 0, 'tombstone gone');
      // 失败：远端抛错吞掉，tombstone 留给 bounded
      const remote = createFakeRemoteBackend();
      await remote.put({
        key: failKey,
        bytes: sampleBytes(10),
        contentType: 'audio/mpeg',
      });
      const failing = createCountingBackend(remote, {
        throwOnDelete: new Error('fake directed boom'),
      });
      const failRes = await cleanupAudioStorageKeys([failKey], {
        storage: failing,
      });
      assert.strictEqual(failRes.failed, 1, 'directed 失败计数');
      assert.strictEqual(await countTombstones([failKey]), 1, '失败保留');
      // 收尾：真删
      await cleanupAudioStorageKeys([failKey], { storage: remote });
      assert.strictEqual(await countTombstones([failKey]), 0, '收尾 gone');
      await wipeTombstones([okKey, failKey]);
      console.log('PASS: 9. directed 通过');
    }
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    await prisma.audioStorageDeletion.deleteMany({
      where: { storageKey: { startsWith: `story-audio/${TAG}-` } },
    });
  }

  console.log('ALL AUDIO STORAGE CLEANUP INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioStorageCleanupIntegrationTests()
  .then(() => {
    console.log('ALL AUDIO STORAGE CLEANUP INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
