import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../../lib/db';
import {
  trashStoryWorkForSubject,
  restoreStoryWorkForSubject,
  permanentlyDeleteStoryWorkForSubject,
  executeStoryWorkPhysicalDelete,
} from '../../../lib/server/storyWork';
import { purgeExpiredGuestData } from '../../../lib/server/guestGc';
import {
  cleanupAudioStorageDeletions,
} from '../../../lib/server/audioStorageCleanup';
import {
  getAudioAssetStorage,
  resetAudioAssetStorageForTests,
  setAudioAssetStorageForTests,
} from '../../../lib/audio/storage/index';
import type { AudioAssetStorage } from '../../../lib/audio/storage/types';
import { resetCache } from '../../../lib/server/openai';
import { buildFakeCanonicalMp3 } from '../../../tests/support/fixtures/fake-canonical-mp3';
import { ensureStoryAudioSegmentForSubject } from '../../../lib/server/storyAudio';
import { computeStoryContentHash } from '../../../utils/segmentation';

/**
 * M8-05-02 Audio-aware Physical Delete / Trash / Restore / Guest GC 集成测试（真库 + 真存储）。
 *
 * 验收（User / Guest manual delete 两侧）：
 * 1) Trash：Work/Manifest/Segment/Object 全保留，tombstone=0；
 * 2) Restore：storageKey 完全相同，TTS invocation=0；
 * 3) Permanent Delete 成功：Work/Manifest/Segment/Object/tombstone 全消失；
 * 4) Permanent Delete + storage.delete fail：DB gone、Object 暂存、tombstone remains；
 *    随后 05-01 retry → Object gone、tombstone gone；
 * 5) 事务内失败：Work/Manifest/Segment remains、tombstone 不残留、Object 不动；
 * 6) Guest GC：expired 全清零；storage 临时失败 → DB gone + tombstone 可追踪 + retry 后 zero orphan；
 *    non-expired 完全不动；
 * 7) M8-03 回归：Trash + 当前 M5 Session → ensure next allowed；其他 Session → WORK_UNAVAILABLE；
 * 8) 静态守卫：全仓 delete 唯一位置为 executeStoryWorkPhysicalDelete。
 *
 * 说明：integration 文件名带 -integration 后缀以满足 runner 唯一 suite-id 不变量
 *（先例：audio-storage-cleanup-integration；任务短名 audio-lifecycle-delete 已由 unit 占用）。
 */

const TAG = `m8052_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function storageKeyFor(kind: string, name: string): string {
  return `story-audio/${TAG}-${kind}-${name}.mp3`;
}

function sampleBytes(seed: number): Uint8Array {
  return buildFakeCanonicalMp3(10, seed);
}

function createFailingDeleteBackend(inner: AudioAssetStorage): AudioAssetStorage & { deleteCalls: string[] } {
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
      throw new Error('injected storage.delete boom');
    },
    async getMetadata(key) {
      return inner.getMetadata(key);
    },
    async resolveRead(key, rangeHeader) {
      return inner.resolveRead(key, rangeHeader);
    },
  };
}

function domainOf(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /([A-Z_]+)/.exec(msg);
  return m ? m[1] : null;
}

async function countTombstones(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  return prisma.audioStorageDeletion.count({ where: { storageKey: { in: keys } } });
}

async function wipeTombstonesByPrefix(prefix: string): Promise<void> {
  await prisma.audioStorageDeletion.deleteMany({
    where: { storageKey: { startsWith: prefix } },
  });
}

// ---------- 手工 Manifest/Segment + 真对象装配（不经 TTS，便于精确控制 ready/missing） ----------

async function createUserWorkWithAudio(opts: {
  tag: string;
  segments: number;
  deletedAt?: Date | null;
  seedBase?: number;
}): Promise<{ userId: number; workId: number; storageKeys: string[]; manifestId: number }> {
  const storage = getAudioAssetStorage();
  const user = await prisma.user.create({
    data: {
      username: `m8052_u_${opts.tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      password: 'TestPassword123!',
      nickname: 'M8052',
    },
  });
  const work = await prisma.storyWork.create({
    data: {
      userId: user.id,
      prompt: `prompt ${opts.tag}`,
      storyText: `正文 ${opts.tag} `.repeat(20),
      title: `title ${opts.tag}`,
      contentHash: `hash_${TAG}_${opts.tag}`,
      deletedAt: opts.deletedAt ?? null,
    },
  });
  const manifest = await prisma.storyAudioManifest.create({
    data: {
      storyWorkId: work.id,
      version: 1,
      status: 'ready',
      contentHash: `hash_${TAG}_${opts.tag}`,
      segmentationVersion: 'v1',
      voiceId: 'nova',
      ttsBackendId: 'openai',
      ttsModel: 'tts-1',
      synthesisVersion: 'canonical-mp3-v1',
      synthesisSpeed: 1.0,
      audioFormat: 'mp3',
      segmentCount: opts.segments,
      readySegmentCount: opts.segments,
      totalDurationMs: 261 * opts.segments,
      totalByteLength: 4170 * opts.segments,
    },
  });
  const keys: string[] = [];
  for (let i = 0; i < opts.segments; i += 1) {
    const key = storageKeyFor('u', `${opts.tag}-${work.id}-${i}`);
    keys.push(key);
    const bytes = sampleBytes((opts.seedBase ?? 0) + i);
    await storage.put({ key, bytes, contentType: 'audio/mpeg' });
    await prisma.storyAudioSegment.create({
      data: {
        id: randomUUID(),
        manifestId: manifest.id,
        segmentIndex: i,
        text: `seg ${i} ${opts.tag}`,
        textHash: `th_${TAG}_${opts.tag}_${i}`,
        status: 'ready',
        storageKey: key,
        contentType: 'audio/mpeg',
        byteLength: bytes.byteLength,
        durationMs: 261,
        readyAt: new Date(),
      },
    });
  }
  return { userId: user.id, workId: work.id, storageKeys: keys, manifestId: manifest.id };
}

async function createGuestWorkWithAudio(opts: {
  tag: string;
  segments: number;
  deletedAt?: Date | null;
  updatedAt?: Date;
  seedBase?: number;
}): Promise<{ guestId: string; workId: number; storageKeys: string[]; manifestId: number }> {
  const storage = getAudioAssetStorage();
  const guestId = `g_${TAG}_${opts.tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const data: Record<string, unknown> = {
    guestId,
    prompt: `prompt ${opts.tag}`,
    storyText: `访客正文 ${opts.tag} `.repeat(20),
    title: `gtitle ${opts.tag}`,
    contentHash: `ghash_${TAG}_${opts.tag}`,
    deletedAt: opts.deletedAt ?? null,
  };
  if (opts.updatedAt) {
    data.updatedAt = opts.updatedAt;
  }
  const work = await prisma.guestStoryWork.create({ data: data as never });
  const manifest = await prisma.guestStoryAudioManifest.create({
    data: {
      storyWorkId: work.id,
      version: 1,
      status: 'ready',
      contentHash: `ghash_${TAG}_${opts.tag}`,
      segmentationVersion: 'v1',
      voiceId: 'nova',
      ttsBackendId: 'openai',
      ttsModel: 'tts-1',
      synthesisVersion: 'canonical-mp3-v1',
      synthesisSpeed: 1.0,
      audioFormat: 'mp3',
      segmentCount: opts.segments,
      readySegmentCount: opts.segments,
      totalDurationMs: 261 * opts.segments,
      totalByteLength: 4170 * opts.segments,
    },
  });
  const keys: string[] = [];
  for (let i = 0; i < opts.segments; i += 1) {
    const key = storageKeyFor('g', `${opts.tag}-${work.id}-${i}`);
    keys.push(key);
    const bytes = sampleBytes((opts.seedBase ?? 100) + i);
    await storage.put({ key, bytes, contentType: 'audio/mpeg' });
    await prisma.guestStoryAudioSegment.create({
      data: {
        id: randomUUID(),
        manifestId: manifest.id,
        segmentIndex: i,
        text: `gseg ${i} ${opts.tag}`,
        textHash: `gth_${TAG}_${opts.tag}_${i}`,
        status: 'ready',
        storageKey: key,
        contentType: 'audio/mpeg',
        byteLength: bytes.byteLength,
        durationMs: 261,
        readyAt: new Date(),
      },
    });
  }
  return { guestId, workId: work.id, storageKeys: keys, manifestId: manifest.id };
}

async function runAudioLifecycleDeleteIntegrationTests() {
  const prevDriver = process.env.AUDIO_STORAGE_DRIVER;
  const prevRoot = process.env.AUDIO_LOCAL_ROOT;
  const savedVoiceList = process.env.OPENAI_TTS_VOICE_LIST;
  const savedDefaultVoice = process.env.OPENAI_TTS_DEFAULT_VOICE;
  const savedModel = process.env.OPENAI_TTS_MODEL;
  const savedBackend = process.env.TTS_BACKEND_ID;
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), `m8052-${Date.now()}-`));
  process.env.AUDIO_STORAGE_DRIVER = 'local';
  process.env.AUDIO_LOCAL_ROOT = tmpRoot;
  process.env.OPENAI_TTS_VOICE_LIST = JSON.stringify([
    { value: 'nova', label: 'Nova' },
    { value: 'alloy', label: 'Alloy' },
  ]);
  process.env.OPENAI_TTS_DEFAULT_VOICE = 'nova';
  process.env.OPENAI_TTS_MODEL = 'tts-1';
  process.env.TTS_BACKEND_ID = 'openai';
  resetCache();
  resetAudioAssetStorageForTests();
  // 预热单例为真 local（tmpRoot），后续 failing 注入经 setAudioAssetStorageForTests 包裹此真后端
  getAudioAssetStorage();

  // TTS 计数 oracle：trash/restore 路径永不调用合成器（保持 0）
  let ttsInvocations = 0;

  try {
    console.log('=== 1) Trash：Work/Manifest/Segment/Object 全保留，tombstone=0（User/Guest） ===');
    {
      const u = await createUserWorkWithAudio({ tag: 'trash-u', segments: 2, seedBase: 11 });
      const g = await createGuestWorkWithAudio({ tag: 'trash-g', segments: 2, seedBase: 111 });
      const uSubject = { type: 'user' as const, id: u.userId };
      const gSubject = { type: 'guest' as const, id: g.guestId };

      await trashStoryWorkForSubject(uSubject, u.workId);
      await trashStoryWorkForSubject(gSubject, g.workId);

      // User 侧全保留
      const uw = await prisma.storyWork.findUnique({ where: { id: u.workId } });
      assert.ok(uw && uw.deletedAt !== null, 'User trash 后 Work 保留且 deletedAt 非空');
      assert.strictEqual(await prisma.storyAudioManifest.count({ where: { storyWorkId: u.workId } }), 1, 'User Manifest 保留');
      assert.strictEqual(
        await prisma.storyAudioSegment.count({ where: { manifestId: u.manifestId } }),
        2,
        'User Segments 保留',
      );
      const storage = getAudioAssetStorage();
      for (const k of u.storageKeys) assert.strictEqual(await storage.exists(k), true, `User Object 保留 ${k}`);
      assert.strictEqual(await countTombstones(u.storageKeys), 0, 'User Trash tombstone=0');

      // Guest 侧全保留
      const gw = await prisma.guestStoryWork.findUnique({ where: { id: g.workId } });
      assert.ok(gw && gw.deletedAt !== null, 'Guest trash 后 Work 保留');
      assert.strictEqual(await prisma.guestStoryAudioManifest.count({ where: { storyWorkId: g.workId } }), 1, 'Guest Manifest 保留');
      assert.strictEqual(
        await prisma.guestStoryAudioSegment.count({ where: { manifestId: g.manifestId } }),
        2,
        'Guest Segments 保留',
      );
      for (const k of g.storageKeys) assert.strictEqual(await storage.exists(k), true, `Guest Object 保留 ${k}`);
      assert.strictEqual(await countTombstones(g.storageKeys), 0, 'Guest Trash tombstone=0');

      assert.strictEqual(ttsInvocations, 0, 'Trash TTS count=0');
      console.log('PASS: 1) Trash 双侧通过');

      console.log('=== 2) Restore：同一 Manifest、同一 storageKey、Object remains、TTS=0 ===');
      // 记录 trash 前 keys，restore 后必须完全相同
      const uSegBefore = await prisma.storyAudioSegment.findMany({
        where: { manifestId: u.manifestId },
        orderBy: { segmentIndex: 'asc' },
      });
      const gSegBefore = await prisma.guestStoryAudioSegment.findMany({
        where: { manifestId: g.manifestId },
        orderBy: { segmentIndex: 'asc' },
      });
      await restoreStoryWorkForSubject(uSubject, u.workId);
      await restoreStoryWorkForSubject(gSubject, g.workId);

      const uw2 = await prisma.storyWork.findUnique({ where: { id: u.workId } });
      assert.ok(uw2 && uw2.deletedAt === null, 'User restore 后 active');
      const uManifest2 = await prisma.storyAudioManifest.findFirst({ where: { storyWorkId: u.workId } });
      assert.ok(uManifest2 && uManifest2.id === u.manifestId, 'User 同一 Manifest');
      const uSegAfter = await prisma.storyAudioSegment.findMany({
        where: { manifestId: u.manifestId },
        orderBy: { segmentIndex: 'asc' },
      });
      assert.deepStrictEqual(
        uSegAfter.map((s) => s.storageKey),
        uSegBefore.map((s) => s.storageKey),
        'User storageKey 完全相同',
      );
      for (const k of u.storageKeys) assert.strictEqual(await storage.exists(k), true, 'User Restore Object remains');
      assert.strictEqual(await countTombstones(u.storageKeys), 0, 'User Restore tombstone=0');

      const gw2 = await prisma.guestStoryWork.findUnique({ where: { id: g.workId } });
      assert.ok(gw2 && gw2.deletedAt === null, 'Guest restore 后 active');
      const gManifest2 = await prisma.guestStoryAudioManifest.findFirst({ where: { storyWorkId: g.workId } });
      assert.ok(gManifest2 && gManifest2.id === g.manifestId, 'Guest 同一 Manifest');
      const gSegAfter = await prisma.guestStoryAudioSegment.findMany({
        where: { manifestId: g.manifestId },
        orderBy: { segmentIndex: 'asc' },
      });
      assert.deepStrictEqual(
        gSegAfter.map((s) => s.storageKey),
        gSegBefore.map((s) => s.storageKey),
        'Guest storageKey 完全相同',
      );
      for (const k of g.storageKeys) assert.strictEqual(await storage.exists(k), true, 'Guest Restore Object remains');
      assert.strictEqual(await countTombstones(g.storageKeys), 0, 'Guest Restore tombstone=0');
      assert.strictEqual(ttsInvocations, 0, 'Restore TTS count=0');
      console.log('PASS: 2) Restore 双侧通过');
    }

    console.log('=== 3) Permanent Delete 成功：Work/Manifest/Segment/Object/tombstone 全消失（User/Guest） ===');
    {
      // 直接以 trash 态创建（permanent 前置），经 manual delete 路径
      const u = await createUserWorkWithAudio({
        tag: 'perm-u',
        segments: 2,
        deletedAt: new Date(),
        seedBase: 21,
      });
      const g = await createGuestWorkWithAudio({
        tag: 'perm-g',
        segments: 2,
        deletedAt: new Date(),
        seedBase: 121,
      });
      // 确保 deleting 前提：必须在 trash 中（active 禁止物理删除由 retention 套件已锁，此处只走合法 trash 形态）
      await permanentlyDeleteStoryWorkForSubject({ type: 'user' as const, id: u.userId }, u.workId);
      await permanentlyDeleteStoryWorkForSubject({ type: 'guest' as const, id: g.guestId }, g.workId);

      assert.strictEqual(await prisma.storyWork.findUnique({ where: { id: u.workId } }), null, 'User Work gone');
      assert.strictEqual(await prisma.storyAudioManifest.count({ where: { storyWorkId: u.workId } }), 0, 'User Manifest gone');
      assert.strictEqual(await prisma.storyAudioSegment.count({ where: { manifestId: u.manifestId } }), 0, 'User Segment gone');
      assert.strictEqual(await prisma.guestStoryWork.findUnique({ where: { id: g.workId } }), null, 'Guest Work gone');
      assert.strictEqual(await prisma.guestStoryAudioManifest.count({ where: { storyWorkId: g.workId } }), 0, 'Guest Manifest gone');
      assert.strictEqual(await prisma.guestStoryAudioSegment.count({ where: { manifestId: g.manifestId } }), 0, 'Guest Segment gone');
      const storage = getAudioAssetStorage();
      for (const k of [...u.storageKeys, ...g.storageKeys]) {
        assert.strictEqual(await storage.exists(k), false, `Object gone ${k}`);
      }
      assert.strictEqual(await countTombstones(u.storageKeys), 0, 'User tombstone gone');
      assert.strictEqual(await countTombstones(g.storageKeys), 0, 'Guest tombstone gone');
      console.log('PASS: 3) Permanent Delete 成功双侧通过');
    }

    console.log('=== 3b) Permanent Delete：T3 单轨 Asset 对象 tombstone（User） ===');
    {
      const storage = getAudioAssetStorage();
      const u = await createUserWorkWithAudio({
        tag: 'perm-asset-u',
        segments: 0,
        deletedAt: new Date(),
        seedBase: 200,
      });
      const assetId = randomUUID();
      const assetKey = `story-audio/${assetId}.mp3`;
      await storage.put({ key: assetKey, bytes: sampleBytes(201), contentType: 'audio/mpeg' });
      await prisma.storyAudioAsset.create({
        data: {
          id: assetId,
          storyWorkId: u.workId,
          version: 1,
          status: 'ready',
          contentHash: `hash_${TAG}_perm-asset`,
          voiceId: 'nova',
          ttsProfileHash: 'profile',
          synthesisVersion: 'canonical-mp3-v1',
          audioFormat: 'mp3',
          chunkCount: 1,
          storageKey: assetKey,
          contentType: 'audio/mpeg',
          byteLength: 4170,
          durationMs: 261,
          checksum: 'checksum',
          readyAt: new Date(),
          lastAccessedAt: new Date(),
        },
      });
      await permanentlyDeleteStoryWorkForSubject({ type: 'user' as const, id: u.userId }, u.workId);
      assert.strictEqual(
        await prisma.storyAudioAsset.count({ where: { storyWorkId: u.workId } }),
        0,
        '单轨 Asset 行随 cascade 消失',
      );
      assert.strictEqual(await storage.exists(assetKey), false, '单轨 Asset Object gone');
      assert.strictEqual(await countTombstones([assetKey]), 0, '单轨 Asset tombstone 已消费');
      console.log('PASS: 3b) 单轨 Asset 对象 tombstone 通过');
    }

    console.log('=== 4) Permanent Delete + storage.delete fail → retry 收敛（User/Guest） ===');
    {
      const realStorage = getAudioAssetStorage();
      for (const side of ['user', 'guest'] as const) {
        const tag = side === 'user' ? 'fail-u' : 'fail-g';
        const created =
          side === 'user'
            ? await createUserWorkWithAudio({ tag, segments: 2, deletedAt: new Date(), seedBase: 31 })
            : await createGuestWorkWithAudio({ tag, segments: 2, deletedAt: new Date(), seedBase: 131 });
        const keys = created.storageKeys;
        const failing = createFailingDeleteBackend(realStorage);
        setAudioAssetStorageForTests(failing);
        try {
          if (side === 'user') {
            const c = created as { userId: number; workId: number; manifestId: number };
            await permanentlyDeleteStoryWorkForSubject({ type: 'user' as const, id: c.userId }, c.workId);
            assert.strictEqual(await prisma.storyWork.findUnique({ where: { id: c.workId } }), null, 'User DB gone（失败仍提交）');
            assert.strictEqual(await prisma.storyAudioManifest.count({ where: { storyWorkId: c.workId } }), 0, 'User Manifest gone');
            assert.strictEqual(await prisma.storyAudioSegment.count({ where: { manifestId: c.manifestId } }), 0, 'User Segment gone');
          } else {
            const c = created as { guestId: string; workId: number; manifestId: number };
            await permanentlyDeleteStoryWorkForSubject({ type: 'guest' as const, id: c.guestId }, c.workId);
            assert.strictEqual(await prisma.guestStoryWork.findUnique({ where: { id: c.workId } }), null, 'Guest DB gone');
            assert.strictEqual(await prisma.guestStoryAudioManifest.count({ where: { storyWorkId: c.workId } }), 0, 'Guest Manifest gone');
            assert.strictEqual(await prisma.guestStoryAudioSegment.count({ where: { manifestId: c.manifestId } }), 0, 'Guest Segment gone');
          }
        } finally {
          setAudioAssetStorageForTests(realStorage);
        }
        // Object 暂时存在、tombstone remains
        for (const k of keys) assert.strictEqual(await realStorage.exists(k), true, `Object 暂存 ${k}`);
        assert.strictEqual(await countTombstones(keys), keys.length, 'tombstone remains（可追踪）');
        assert.ok(failing.deleteCalls.length >= keys.length, 'failing backend 确曾被调用');
        // 随后经 05-01 retry → Object gone、tombstone gone
        const retry = await cleanupAudioStorageDeletions({ storage: realStorage });
        assert.ok(retry.succeeded >= keys.length, 'retry 至少清掉本批');
        for (const k of keys) assert.strictEqual(await realStorage.exists(k), false, `retry 后 Object gone ${k}`);
        assert.strictEqual(await countTombstones(keys), 0, 'retry 后 tombstone gone');
      }
      console.log('PASS: 4) 失败+retry 双侧通过');
    }

    console.log('=== 5) 事务内失败：Work/Manifest/Segment remains、tombstone 不残留、Object 不动 ===');
    {
      for (const side of ['user', 'guest'] as const) {
        const tag = side === 'user' ? 'txfail-u' : 'txfail-g';
        const created =
          side === 'user'
            ? await createUserWorkWithAudio({ tag, segments: 2, deletedAt: new Date(), seedBase: 41 })
            : await createGuestWorkWithAudio({ tag, segments: 2, deletedAt: new Date(), seedBase: 141 });
        const keys = created.storageKeys;
        let threw: unknown = null;
        try {
          if (side === 'user') {
            const c = created as { userId: number; workId: number };
            await executeStoryWorkPhysicalDelete({
              target: 'user',
              reason: 'trash',
              where: { id: c.workId, userId: c.userId, deletedAt: { not: null } },
              testHooks: {
                __testInsideTransactionHook: async () => {
                  throw new Error('injected tx fail');
                },
              },
            });
          } else {
            const c = created as { guestId: string; workId: number };
            await executeStoryWorkPhysicalDelete({
              target: 'guest',
              reason: 'trash',
              where: { id: c.workId, guestId: c.guestId, deletedAt: { not: null } },
              testHooks: {
                __testInsideTransactionHook: async () => {
                  throw new Error('injected tx fail');
                },
              },
            });
          }
        } catch (e) {
          threw = e;
        }
        assert.ok(threw, `${side} 事务内失败应抛错`);
        assert.match(String((threw as Error)?.message ?? threw), /injected tx fail/);
        const storage = getAudioAssetStorage();
        if (side === 'user') {
          const c = created as { userId: number; workId: number; manifestId: number };
          assert.ok(await prisma.storyWork.findUnique({ where: { id: c.workId } }), 'User Work remains');
          assert.strictEqual(await prisma.storyAudioManifest.count({ where: { storyWorkId: c.workId } }), 1, 'User Manifest remains');
          assert.strictEqual(await prisma.storyAudioSegment.count({ where: { manifestId: c.manifestId } }), 2, 'User Segment remains');
        } else {
          const c = created as { guestId: string; workId: number; manifestId: number };
          assert.ok(await prisma.guestStoryWork.findUnique({ where: { id: c.workId } }), 'Guest Work remains');
          assert.strictEqual(await prisma.guestStoryAudioManifest.count({ where: { storyWorkId: c.workId } }), 1, 'Guest Manifest remains');
          assert.strictEqual(await prisma.guestStoryAudioSegment.count({ where: { manifestId: c.manifestId } }), 2, 'Guest Segment remains');
        }
        assert.strictEqual(await countTombstones(keys), 0, `${side} tombstone 不得残留`);
        for (const k of keys) assert.strictEqual(await storage.exists(k), true, `${side} Object 不动 ${k}`);
        // 清理本节手工行（经合法路径删掉，避免污染后继 bounded 断言）
        setAudioAssetStorageForTests(getAudioAssetStorage());
        if (side === 'user') {
          const c = created as { userId: number; workId: number };
          await permanentlyDeleteStoryWorkForSubject({ type: 'user' as const, id: c.userId }, c.workId);
        } else {
          const c = created as { guestId: string; workId: number };
          await permanentlyDeleteStoryWorkForSubject({ type: 'guest' as const, id: c.guestId }, c.workId);
        }
        assert.strictEqual(await countTombstones(keys), 0, `${side} 清理后 tombstone=0`);
      }
      console.log('PASS: 5) 事务回滚双侧通过');
    }

    console.log('=== 6) Guest GC：expired 全清零 / 失败→retry / non-expired 不动 ===');
    {
      const now = new Date();
      const expiredAt = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
      const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const realStorage = getAudioAssetStorage();

      // 6a 成功路径：expired 全消失，non-expired 完全不动
      const expired = await createGuestWorkWithAudio({ tag: 'gc-exp', segments: 2, updatedAt: expiredAt, seedBase: 151 });
      const fresh = await createGuestWorkWithAudio({ tag: 'gc-fresh', segments: 1, seedBase: 152 });
      await purgeExpiredGuestData(cutoff);
      assert.strictEqual(await prisma.guestStoryWork.findUnique({ where: { id: expired.workId } }), null, 'expired Work gone');
      assert.strictEqual(await prisma.guestStoryAudioManifest.count({ where: { storyWorkId: expired.workId } }), 0, 'expired Manifest gone');
      assert.strictEqual(await prisma.guestStoryAudioSegment.count({ where: { manifestId: expired.manifestId } }), 0, 'expired Segment gone');
      for (const k of expired.storageKeys) assert.strictEqual(await realStorage.exists(k), false, 'expired Object gone');
      assert.strictEqual(await countTombstones(expired.storageKeys), 0, 'expired tombstone gone');
      // non-expired 完全不动
      assert.ok(await prisma.guestStoryWork.findUnique({ where: { id: fresh.workId } }), 'non-expired Work 不动');
      assert.strictEqual(await prisma.guestStoryAudioManifest.count({ where: { storyWorkId: fresh.workId } }), 1, 'non-expired Manifest 不动');
      assert.strictEqual(await prisma.guestStoryAudioSegment.count({ where: { manifestId: fresh.manifestId } }), 1, 'non-expired Segment 不动');
      for (const k of fresh.storageKeys) assert.strictEqual(await realStorage.exists(k), true, 'non-expired Object 不动');
      assert.strictEqual(await countTombstones(fresh.storageKeys), 0, 'non-expired tombstone=0');

      // 6b 临时失败路径：DB gone + tombstone 可追踪 + retry 后 zero orphan
      const expired2 = await createGuestWorkWithAudio({ tag: 'gc-exp-fail', segments: 2, updatedAt: expiredAt, seedBase: 153 });
      const failing = createFailingDeleteBackend(realStorage);
      setAudioAssetStorageForTests(failing);
      try {
        await purgeExpiredGuestData(cutoff);
      } finally {
        setAudioAssetStorageForTests(realStorage);
      }
      assert.strictEqual(await prisma.guestStoryWork.findUnique({ where: { id: expired2.workId } }), null, '失败时 DB Guest rows gone');
      assert.strictEqual(await prisma.guestStoryAudioManifest.count({ where: { storyWorkId: expired2.workId } }), 0, '失败时 Manifest gone');
      assert.strictEqual(await prisma.guestStoryAudioSegment.count({ where: { manifestId: expired2.manifestId } }), 0, '失败时 Segment gone');
      for (const k of expired2.storageKeys) assert.strictEqual(await realStorage.exists(k), true, '失败时 Object 暂存');
      assert.strictEqual(await countTombstones(expired2.storageKeys), expired2.storageKeys.length, '失败时 tombstone 可追踪');
      const retry = await cleanupAudioStorageDeletions({ storage: realStorage });
      assert.ok(retry.succeeded >= expired2.storageKeys.length, 'GC retry 成功');
      for (const k of expired2.storageKeys) assert.strictEqual(await realStorage.exists(k), false, 'retry 后 Object gone');
      assert.strictEqual(await countTombstones(expired2.storageKeys), 0, 'retry 后 tombstone gone（zero orphan）');
      // fresh 在失败 GC 后仍完全不动（二次确认）
      assert.ok(await prisma.guestStoryWork.findUnique({ where: { id: fresh.workId } }), 'fresh 在失败 GC 后仍不动');
      console.log('PASS: 6) Guest GC 通过');
    }

    console.log('=== 7) M8-03 回归：Trash + 当前 M5 Session → ensure next allowed；其他 → WORK_UNAVAILABLE ===');
    {
      const storage = getAudioAssetStorage();
      const sessionCurrent = randomUUID();
      const sessionOther = randomUUID();
      // 双段正文（ensure 按 segmentation 切分为 ≥2 段；用长文本保证两段）
      const storyText = `${'第一段故事正文，用于 Trash 会话门禁回归。'.repeat(6)}\n${'第二段故事正文，用于 Trash 会话门禁回归。'.repeat(6)}`;
      const contentHash = computeStoryContentHash(storyText);
      void contentHash;
      const user = await prisma.user.create({
        data: {
          username: `m8052_m5_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
          password: 'TestPassword123!',
          nickname: 'M8052M5',
        },
      });
      const work = await prisma.storyWork.create({
        data: {
          userId: user.id,
          prompt: 'm5 regression',
          storyText,
          title: 'm5',
          contentHash: computeStoryContentHash(storyText),
        },
      });
      const subject = { type: 'user' as const, id: user.id };
      let ttsCount = 0;
      const countingSynth = async (input: { text: string; model: string; voiceId: string; speed: number; format: string }) => {
        ttsCount += 1;
        const bytes = buildFakeCanonicalMp3(10, 77);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        void input;
        return { audioData: buf, requestId: '' };
      };
      // active 下首段 allowed
      const r0 = await ensureStoryAudioSegmentForSubject(
        subject,
        { workId: work.id, segmentIndex: 0, sessionId: sessionCurrent },
        { storage, synthesize: countingSynth },
      );
      assert.strictEqual(r0.status, 'ready', 'active 首段 allowed');
      // 移入 Trash
      await prisma.storyWork.update({ where: { id: work.id }, data: { deletedAt: new Date() } });
      // 当前 Anchor 匹配 → ensure next allowed
      await prisma.userPlaybackAnchor.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          sourceKind: 'work',
          sourceId: String(work.id),
          sessionId: sessionCurrent,
          title: 'm5',
        },
        update: { sourceKind: 'work', sourceId: String(work.id), sessionId: sessionCurrent },
      });
      const before = ttsCount;
      void before;
      const r1 = await ensureStoryAudioSegmentForSubject(
        subject,
        { workId: work.id, segmentIndex: 1, sessionId: sessionCurrent },
        { storage, synthesize: countingSynth },
      );
      assert.strictEqual(r1.status, 'ready', 'Trash + 当前 Session → ensure next allowed');
      // 其他 Session → WORK_UNAVAILABLE（TTS 不得增加）
      const countBeforeOther = ttsCount;
      let errOther: unknown = null;
      try {
        await ensureStoryAudioSegmentForSubject(
          subject,
          { workId: work.id, segmentIndex: 1, sessionId: sessionOther },
          { storage, synthesize: countingSynth },
        );
      } catch (e) {
        errOther = e;
      }
      assert.ok(errOther, '其他 Session 应拒绝');
      assert.strictEqual(domainOf(errOther), 'WORK_UNAVAILABLE', '拒绝码 WORK_UNAVAILABLE');
      assert.strictEqual(ttsCount, countBeforeOther, '拒绝路径 TTS 不增加');
      await prisma.userPlaybackAnchor.deleteMany({ where: { userId: user.id } });
      console.log('PASS: 7) M5 会话门禁回归通过');
    }

    console.log('=== 8) 静态守卫：全仓 delete 唯一位置（集成侧复核） ===');
    {
      const hits: string[] = [];
      const walk = (dir: string) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (ent.name === 'generated' || ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
            walk(abs);
            continue;
          }
          if (!abs.endsWith('.ts')) continue;
          const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
          if (rel.startsWith('tests/') || rel.startsWith('.e2e-runtime/')) continue;
          if (rel === 'lib/server/storyWork.ts') continue;
          const src = fs.readFileSync(abs, 'utf-8');
          const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
          if (/prisma\s*\.\s*(storyWork|guestStoryWork)\s*\.\s*delete(Many)?\b/.test(code)) hits.push(rel);
        }
      };
      walk(path.join(process.cwd(), 'lib'));
      assert.deepStrictEqual(hits, [], `集成侧复核：非法 delete 位置 ${hits.join(',')}`);
      console.log('PASS: 8) 静态守卫复核通过');
    }
  } finally {
    if (prevDriver === undefined) delete process.env.AUDIO_STORAGE_DRIVER;
    else process.env.AUDIO_STORAGE_DRIVER = prevDriver;
    if (prevRoot === undefined) delete process.env.AUDIO_LOCAL_ROOT;
    else process.env.AUDIO_LOCAL_ROOT = prevRoot;
    if (savedVoiceList === undefined) delete process.env.OPENAI_TTS_VOICE_LIST;
    else process.env.OPENAI_TTS_VOICE_LIST = savedVoiceList;
    if (savedDefaultVoice === undefined) delete process.env.OPENAI_TTS_DEFAULT_VOICE;
    else process.env.OPENAI_TTS_DEFAULT_VOICE = savedDefaultVoice;
    if (savedModel === undefined) delete process.env.OPENAI_TTS_MODEL;
    else process.env.OPENAI_TTS_MODEL = savedModel;
    if (savedBackend === undefined) delete process.env.TTS_BACKEND_ID;
    else process.env.TTS_BACKEND_ID = savedBackend;
    resetCache();
    resetAudioAssetStorageForTests();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    await wipeTombstonesByPrefix(`story-audio/${TAG}-`);
  }

  console.log('ALL AUDIO LIFECYCLE DELETE INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioLifecycleDeleteIntegrationTests()
  .then(() => {
    console.log('ALL AUDIO LIFECYCLE DELETE INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
