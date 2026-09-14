import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../../lib/db';
import {
  getAudioAssetStorage,
  resetAudioAssetStorageForTests,
} from '../../../lib/audio/storage/index';
import type { AudioAssetStorage } from '../../../lib/audio/storage/types';
import { cleanupAudioStorageDeletions } from '../../../lib/server/audioStorageCleanup';
import { runStartupAudioDeletionCleanup } from '../../../lib/server/audioStorageStartup';
import {
  ensureStoryAudioSegmentForSubject,
  getOpportunisticAudioCleanupLastRunMsForTests,
  resetOpportunisticAudioCleanupThrottleForTests,
  setOpportunisticAudioCleanupRunnerForTests,
} from '../../../lib/server/storyAudio';
import { resetCache } from '../../../lib/server/openai';
import { computeStoryContentHash } from '../../../utils/segmentation';
import { buildFakeCanonicalMp3 } from '../../../tests/support/fixtures/fake-canonical-mp3';

/**
 * M8-05-04 Production Closure 触发器集成测试（真库口径）。
 *
 * 锁定：
 * 1. 启动清理真库消费：due tombstone + 真对象 → 对象与行双 gone；
 *    nextAttemptAt 未到期行本轮跳过；delete 失败行保留且 attempts+1；
 * 2. ensureSegment 在机会清理失败时仍成功返回 ready（失败绝不影响主结果）；
 * 3. 连续两次 ensure 只触发一次机会清理（低频节流真机验证）。
 */

const TAG = `m805_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function keyOf(name: string): string {
  return `story-audio/${TAG}-${name}.mp3`;
}

function createMemoryStorage(
  opts: { failDeleteKeys?: Set<string>; deleteCalls?: string[] } = {},
): AudioAssetStorage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const failKeys = opts.failDeleteKeys ?? new Set<string>();
  const storage: AudioAssetStorage & { objects: Map<string, Uint8Array> } = {
    objects,
    async put(input) {
      objects.set(input.key, input.bytes.slice());
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      opts.deleteCalls?.push(key);
      if (failKeys.has(key)) throw new Error('fake backend delete boom');
      objects.delete(key);
    },
    async getMetadata(key: string) {
      const found = objects.get(key);
      if (!found) return null;
      return { size: found.byteLength, contentType: 'audio/mpeg' };
    },
    async resolveRead(key: string) {
      const found = objects.get(key);
      if (!found) {
        const { AudioObjectNotFoundError } = await import(
          '../../../lib/audio/storage/types'
        );
        throw new AudioObjectNotFoundError(key);
      }
      return {
        kind: 'bytes' as const,
        bytes: found.slice(),
        contentType: 'audio/mpeg',
        totalSize: found.byteLength,
        range: null,
      };
    },
  };
  return storage;
}

async function wipeTombstones(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await prisma.audioStorageDeletion.deleteMany({
    where: { storageKey: { in: keys } },
  });
}

function makeFakeTts(seed: number) {
  return async () => {
    const bytes = buildFakeCanonicalMp3(10, seed);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return { audioData: buf, requestId: '' };
  };
}

async function createUserWork(storyText: string): Promise<{ userId: number; workId: number }> {
  const user = await prisma.user.create({
    data: {
      username: `m805_${TAG}_${Math.floor(Math.random() * 1e6)}`,
      password: 'TestPassword123!',
      nickname: 'M805',
    },
  });
  const work = await prisma.storyWork.create({
    data: {
      userId: user.id,
      prompt: '触发器测试提示词',
      storyText,
      voiceId: 'nova',
      title: '触发器测试作品',
      excerpt: '触发器测试摘要',
      contentHash: computeStoryContentHash(storyText),
    },
  });
  return { userId: user.id, workId: work.id };
}

async function runAudioCleanupTriggersIntegrationTests() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm805-audio-'));
  const savedDriver = process.env.AUDIO_STORAGE_DRIVER;
  const savedRoot = process.env.AUDIO_LOCAL_ROOT;
  const savedVoiceList = process.env.OPENAI_TTS_VOICE_LIST;
  const savedDefaultVoice = process.env.OPENAI_TTS_DEFAULT_VOICE;
  const savedModel = process.env.OPENAI_TTS_MODEL;
  const savedBackend = process.env.TTS_BACKEND_ID;
  process.env.AUDIO_STORAGE_DRIVER = 'local';
  process.env.AUDIO_LOCAL_ROOT = tmpRoot;
  process.env.OPENAI_TTS_VOICE_LIST = JSON.stringify([
    { value: 'nova', label: 'Nova' },
    { value: 'alloy', label: 'Alloy' },
  ]);
  process.env.OPENAI_TTS_DEFAULT_VOICE = 'nova';
  process.env.OPENAI_TTS_MODEL = 'model-A';
  process.env.TTS_BACKEND_ID = 'openai';
  resetCache();
  resetAudioAssetStorageForTests();
  resetOpportunisticAudioCleanupThrottleForTests();
  setOpportunisticAudioCleanupRunnerForTests(null);

  const ownedKeys: string[] = [];
  try {
    console.log('=== 1. 启动清理真库消费（due gone / 未到期跳过 / 失败保留） ===');
    {
      const storage = createMemoryStorage();
      const dueKeys = [keyOf('startup-a'), keyOf('startup-b')];
      for (const k of dueKeys) {
        await storage.put({ key: k, bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/mpeg' });
      }
      const futureKey = keyOf('startup-future');
      await storage.put({ key: futureKey, bytes: new Uint8Array([9]), contentType: 'audio/mpeg' });
      const failKey = keyOf('startup-fail');
      await storage.put({ key: failKey, bytes: new Uint8Array([8]), contentType: 'audio/mpeg' });
      storage.delete = (async (key: string) => {
        if (key === failKey) throw new Error('fake backend delete boom');
        storage.objects.delete(key);
      }) as typeof storage.delete;
      ownedKeys.push(...dueKeys, futureKey, failKey);

      for (const storageKey of dueKeys) {
        await prisma.audioStorageDeletion.upsert({
          where: { storageKey },
          create: { storageKey },
          update: {},
        });
      }
      await prisma.audioStorageDeletion.upsert({
        where: { storageKey: futureKey },
        create: { storageKey: futureKey, nextAttemptAt: new Date(Date.now() + 3600_000) },
        update: { nextAttemptAt: new Date(Date.now() + 3600_000) },
      });
      await prisma.audioStorageDeletion.upsert({
        where: { storageKey: failKey },
        create: { storageKey: failKey },
        update: {},
      });

      const silent = { warn: () => {}, info: () => {}, error: () => {} };
      const res = await runStartupAudioDeletionCleanup({
        logger: silent,
        runner: (opts) => cleanupAudioStorageDeletions({ storage, limit: opts.limit }),
      });
      assert.strictEqual(res.attempted, 3, 'due 2 + 失败 1 被消费，未到期跳过');
      assert.strictEqual(res.succeeded, 2, 'due 全部成功');
      assert.strictEqual(res.failed, 1, '失败计 1');
      for (const k of dueKeys) {
        assert.strictEqual(await storage.exists(k), false, `${k} 对象 gone`);
        assert.strictEqual(
          await prisma.audioStorageDeletion.count({ where: { storageKey: k } }),
          0,
          `${k} 行 gone`,
        );
      }
      assert.strictEqual(await storage.exists(futureKey), true, '未到期对象保留');
      assert.strictEqual(
        await prisma.audioStorageDeletion.count({ where: { storageKey: futureKey } }),
        1,
        '未到期行保留',
      );
      const kept = await prisma.audioStorageDeletion.findUnique({
        where: { storageKey: failKey },
      });
      assert.ok(kept, '失败行保留');
      assert.strictEqual(kept.attempts, 1, '失败 attempts+1');
      assert.ok(
        kept.nextAttemptAt instanceof Date && kept.nextAttemptAt.getTime() > Date.now(),
        '失败退避到未来',
      );
      console.log('PASS: 1. 启动清理真库消费通过');
    }

    console.log('=== 2. 机会清理失败时 ensureSegment 仍成功 ===');
    {
      const { userId, workId } = await createUserWork(
        '机会清理失败隔离正文，用于验证 ensure 不受影响。'.repeat(6),
      );
      const sessionId = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      resetOpportunisticAudioCleanupThrottleForTests();
      setOpportunisticAudioCleanupRunnerForTests(async () => {
        throw new Error('opportunistic backend down');
      });
      const origWarn = console.warn;
      console.warn = (() => {}) as typeof console.warn;
      try {
        const res = await ensureStoryAudioSegmentForSubject(
          subject,
          { workId, segmentIndex: 0, sessionId },
          { storage: getAudioAssetStorage(), synthesize: makeFakeTts(11) },
        );
        assert.strictEqual(res.status, 'ready', '清理失败 ensure 仍 ready');
        if (res.status !== 'ready') throw new Error('unreachable');
        assert.ok(
          res.segment.playbackUrl.startsWith('/api/audio/segments/'),
          'playbackUrl 形态正常',
        );
      } finally {
        console.warn = origWarn;
        setOpportunisticAudioCleanupRunnerForTests(null);
        resetOpportunisticAudioCleanupThrottleForTests();
      }
      console.log('PASS: 2. ensure 失败隔离通过');
    }

    console.log('=== 3. 连续 ensure 只触发一次机会清理 ===');
    {
      const { userId, workId } = await createUserWork(
        '机会清理节流正文，用于验证低频触发。'.repeat(6),
      );
      const sessionId = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      let runs = 0;
      resetOpportunisticAudioCleanupThrottleForTests();
      setOpportunisticAudioCleanupRunnerForTests(async () => {
        runs += 1;
      });
      try {
        const before = getOpportunisticAudioCleanupLastRunMsForTests();
        assert.strictEqual(before, 0, '节流起点归零');
        await ensureStoryAudioSegmentForSubject(
          subject,
          { workId, segmentIndex: 0, sessionId },
          { storage: getAudioAssetStorage(), synthesize: makeFakeTts(12) },
        );
        // fire-and-forget：在事件循环让出后断言（清理不阻塞主结果）。
        for (let i = 0; i < 50 && runs === 0; i += 1) {
          await new Promise((r) => setTimeout(r, 20));
        }
        await ensureStoryAudioSegmentForSubject(
          subject,
          { workId, segmentIndex: 0, sessionId },
          { storage: getAudioAssetStorage(), synthesize: makeFakeTts(12) },
        );
        for (let i = 0; i < 50 && runs < 1; i += 1) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.strictEqual(runs, 1, '连续 ensure 只触发一次机会清理');
        assert.ok(
          getOpportunisticAudioCleanupLastRunMsForTests() > 0,
          '触发时间戳已记录',
        );
      } finally {
        setOpportunisticAudioCleanupRunnerForTests(null);
        resetOpportunisticAudioCleanupThrottleForTests();
      }
      console.log('PASS: 3. 节流真机验证通过');
    }
  } finally {
    setOpportunisticAudioCleanupRunnerForTests(null);
    resetOpportunisticAudioCleanupThrottleForTests();
    await wipeTombstones(ownedKeys);
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    process.env.AUDIO_STORAGE_DRIVER = savedDriver;
    process.env.AUDIO_LOCAL_ROOT = savedRoot;
    process.env.OPENAI_TTS_VOICE_LIST = savedVoiceList;
    process.env.OPENAI_TTS_DEFAULT_VOICE = savedDefaultVoice;
    process.env.OPENAI_TTS_MODEL = savedModel;
    process.env.TTS_BACKEND_ID = savedBackend;
    resetCache();
    resetAudioAssetStorageForTests();
  }

  console.log('ALL AUDIO CLEANUP TRIGGERS INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioCleanupTriggersIntegrationTests()
  .then(() => {
    console.log('ALL AUDIO CLEANUP TRIGGERS INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
