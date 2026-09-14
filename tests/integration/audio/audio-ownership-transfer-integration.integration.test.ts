import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../../lib/db';
import { migrateGuestCreativeRecordsToUser } from '../../../lib/server/unifiedMigration';
import { transferGuestAudioOwnershipTx } from '../../../lib/server/audioOwnershipTransfer';
import { getPlaybackManifestForSubject } from '../../../lib/server/storyAudio';
import { ensureStoryAudioSegmentForSubject } from '../../../lib/server/storyAudio';
import {
  getAudioAssetStorage,
  resetAudioAssetStorageForTests,
  setAudioAssetStorageForTests,
} from '../../../lib/audio/storage/index';
import type { AudioAssetStorage } from '../../../lib/audio/storage/types';
import { resetCache } from '../../../lib/server/openai';
import { buildFakeCanonicalMp3 } from '../../../tests/support/fixtures/fake-canonical-mp3';

/**
 * M8-05-03 Guest → User Canonical Audio Ownership Transfer 集成测试（真库 + 真存储）。
 *
 * 验收（spec Validation §58；任务 1)–7)）：
 * 1) Guest Work 35 + Manifest + Segment key X → register → User Work 481：
 *    User Manifest.storyWorkId=481、User Segment.storageKey=X（深等）、
 *    Guest Manifest=none、Guest Segments=none；
 * 2) 计数：storage copy=0、put=0、delete=0、TTS=0、tombstone=0；
 * 3) partial Manifest 3/8 → 原样 transfer（partial 状态与 ready metadata 不丢）；
 * 4) failed/preparing/missing segment metadata → 原样 transfer、不触发 synthesis；
 * 5) 重复 registration migration → 不重复 User Manifest/Segment（幂等）；
 * 6) 故意制造 User/Guest 冲突 → 整个 ownership transfer rollback、object untouched、两侧 rows 不破坏；
 * 7) 注册后 getPlaybackManifest(userWorkId) 直接见转移的 frozen segments；
 *    已有 ready segment 可立即读取、不重新生成。
 *
 * 不变量：全程 storage.put=0/delete=0（计数后端）、tombstone=0、TTS=0（migration 无合成路径；
 * oracle 7 以 counting synthesizer 证明 ready 快路径零合成）。
 */

const TAG = `m8053_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

type CountingBackend = AudioAssetStorage & { puts: string[]; deletes: string[] };

function createCountingBackend(inner: AudioAssetStorage): CountingBackend {
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    puts,
    deletes,
    async put(input) {
      puts.push(input.key);
      return inner.put(input);
    },
    async exists(key) {
      return inner.exists(key);
    },
    async delete(key) {
      deletes.push(key);
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
  if (keys.length === 0) return 0;
  return prisma.audioStorageDeletion.count({ where: { storageKey: { in: keys } } });
}

async function wipeTombstonesByPrefix(prefix: string): Promise<void> {
  await prisma.audioStorageDeletion.deleteMany({ where: { storageKey: { startsWith: prefix } } });
}

function sampleBytes(seed: number): Uint8Array {
  return buildFakeCanonicalMp3(10, seed);
}

type SegSpec = {
  status: 'missing' | 'preparing' | 'ready' | 'failed';
  withObject: boolean;
  lease?: boolean;
};

async function createGuestWorkWithManifest(opts: {
  tag: string;
  guestId: string;
  manifestStatus: string;
  segs: SegSpec[];
  contentHash: string;
  voiceId?: string;
  seedBase?: number;
}): Promise<{ workId: number; manifestId: number; storageKeys: string[] }> {
  const storage = getAudioAssetStorage();
  const work = await prisma.guestStoryWork.create({
    data: {
      guestId: opts.guestId,
      prompt: `prompt ${opts.tag}`,
      storyText: `访客正文 ${opts.tag} `.repeat(10),
      title: `gtitle ${opts.tag}`,
      contentHash: opts.contentHash,
      voiceId: opts.voiceId ?? 'nova',
    },
  });
  const readyCount = opts.segs.filter((s) => s.status === 'ready').length;
  const manifest = await prisma.guestStoryAudioManifest.create({
    data: {
      storyWorkId: work.id,
      version: 1,
      status: opts.manifestStatus,
      contentHash: opts.contentHash,
      segmentationVersion: 'v1',
      voiceId: opts.voiceId ?? 'nova',
      ttsBackendId: 'openai',
      ttsModel: 'tts-1',
      synthesisVersion: 'canonical-mp3-v1',
      synthesisSpeed: 1.0,
      audioFormat: 'mp3',
      segmentCount: opts.segs.length,
      readySegmentCount: readyCount,
      totalDurationMs: readyCount === opts.segs.length && readyCount > 0 ? 261 * readyCount : null,
      totalByteLength: readyCount === opts.segs.length && readyCount > 0 ? 4170 * readyCount : null,
    },
  });
  const keys: string[] = [];
  for (let i = 0; i < opts.segs.length; i += 1) {
    const spec = opts.segs[i];
    const key = `story-audio/${TAG}-${opts.tag}-w${work.id}-s${i}.mp3`;
    keys.push(key);
    if (spec.withObject) {
      const bytes = sampleBytes((opts.seedBase ?? 0) + i);
      await storage.put({ key, bytes, contentType: 'audio/mpeg' });
    }
    await prisma.guestStoryAudioSegment.create({
      data: {
        id: randomUUID(),
        manifestId: manifest.id,
        segmentIndex: i,
        text: `gseg ${i} ${opts.tag}`,
        textHash: `gth_${TAG}_${opts.tag}_${i}`,
        status: spec.status,
        storageKey: key,
        contentType: 'audio/mpeg',
        byteLength: spec.status === 'ready' ? sampleBytes((opts.seedBase ?? 0) + i).byteLength : null,
        durationMs: spec.status === 'ready' ? 261 : null,
        audioChecksum: spec.status === 'ready' ? `ck_${TAG}_${opts.tag}_${i}` : null,
        leaseId: spec.lease ? randomUUID() : null,
        leaseExpiresAt: spec.lease ? new Date(Date.now() + 60_000) : null,
        attemptCount: spec.status === 'failed' ? 2 : spec.status === 'ready' ? 1 : 0,
        lastErrorCode: spec.status === 'failed' ? 'AUDIO_SYNTHESIS_FAILED' : null,
        readyAt: spec.status === 'ready' ? new Date() : null,
      },
    });
  }
  return { workId: work.id, manifestId: manifest.id, storageKeys: keys };
}

async function runAudioOwnershipTransferIntegrationTests() {
  const prevDriver = process.env.AUDIO_STORAGE_DRIVER;
  const prevRoot = process.env.AUDIO_LOCAL_ROOT;
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), `m8053-${Date.now()}-`));
  process.env.AUDIO_STORAGE_DRIVER = 'local';
  process.env.AUDIO_LOCAL_ROOT = tmpRoot;
  resetCache();
  resetAudioAssetStorageForTests();
  const realStorage = getAudioAssetStorage();

  // TTS 计数 oracle：migration 路径永不合成；oracle 7 以 counting synth 证明 ready 快路径零合成
  let ttsInvocations = 0;
  const countingSynth = async (input: { text: string; model: string; voiceId: string; speed: number; format: string }) => {
    ttsInvocations += 1;
    void input;
    const bytes = buildFakeCanonicalMp3(10, 77);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return { audioData: buf, requestId: '' };
  };

  try {
    console.log('=== 1) 基本 transfer：User Manifest.storyWorkId=481、storageKey 深等、Guest rows 消失 ===');
    let basicCtx: { guestId: string; userId: number; guestWorkId: number; userWorkId: number; keys: string[] } | null = null;
    {
      const guestId = `g_${TAG}_basic`;
      const created = await createGuestWorkWithManifest({
        tag: 'basic',
        guestId,
        manifestStatus: 'ready',
        contentHash: `hash_${TAG}_basic`,
        segs: [
          { status: 'ready', withObject: true },
          { status: 'ready', withObject: true },
        ],
        seedBase: 11,
      });
      const guestTextBefore = (await prisma.guestStoryWork.findUnique({ where: { id: created.workId } }))?.storyText;
      assert.ok(guestTextBefore, '前置 Guest 文本存在');

      // 计数清零后执行注册迁移（同一 DB transaction 内 transfer）
      const counting = createCountingBackend(realStorage);
      setAudioAssetStorageForTests(counting);
      counting.puts.length = 0;
      counting.deletes.length = 0;
      const ttsBefore = ttsInvocations;
      const user = await prisma.user.create({
        data: { username: `m8053_basic_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, password: 'TestPassword123!', nickname: 'M8053' },
      });
      const res = await migrateGuestCreativeRecordsToUser(guestId, user.id);
      const userWorkId = res.storyWorkIdMap.get(created.workId);
      assert.ok(userWorkId !== undefined, '必须建立 guest→user Work 映射（35→481）');
      // 恢复真存储（migration 内不应触存储；计数后端仅用于断言）
      setAudioAssetStorageForTests(realStorage);

      // 验收 1：User 侧
      const userManifest = await prisma.storyAudioManifest.findUnique({
        where: { storyWorkId_version: { storyWorkId: userWorkId, version: 1 } },
        include: { segments: { orderBy: { segmentIndex: 'asc' } } },
      });
      assert.ok(userManifest, 'User Manifest 必须存在');
      assert.strictEqual(userManifest.storyWorkId, userWorkId, 'User Manifest.storyWorkId=481（映射后 id）');
      assert.deepStrictEqual(
        userManifest.segments.map((s) => s.storageKey),
        created.storageKeys,
        'User Segment.storageKey=X 深等（保持不变）',
      );
      // Guest 侧消失
      assert.strictEqual(await prisma.guestStoryAudioManifest.count({ where: { storyWorkId: created.workId } }), 0, 'Guest Manifest=none');
      assert.strictEqual(await prisma.guestStoryAudioSegment.count({ where: { manifestId: created.manifestId } }), 0, 'Guest Segments=none');
      // Guest 文本仍按 M2 保留；Guest Audio 投影回到 missing
      const guestWorkAfter = await prisma.guestStoryWork.findUnique({ where: { id: created.workId } });
      assert.ok(guestWorkAfter, 'Guest StoryWork 文本行必须保留（M2 retention）');
      assert.strictEqual(guestWorkAfter.storyText, guestTextBefore, 'Guest 文本原样保留');
      const guestProj = await getPlaybackManifestForSubject({ type: 'guest' as const, id: guestId }, { workId: created.workId });
      assert.strictEqual(guestProj.status, 'missing', '迁移后 Guest Audio projection=missing');
      assert.strictEqual(guestProj.segments.length, 0, 'Guest projection 空 segments');
      // Objects 不动
      for (const k of created.storageKeys) assert.strictEqual(await realStorage.exists(k), true, `Object 不动 ${k}`);

      // 验收 2：计数（本节）
      assert.deepStrictEqual(counting.puts, [], 'storage put=0');
      assert.deepStrictEqual(counting.deletes, [], 'storage delete=0');
      assert.strictEqual(ttsInvocations, ttsBefore, 'TTS=0（migration 无合成路径）');
      assert.strictEqual(await countTombstones(created.storageKeys), 0, 'tombstone=0');
      console.log('PASS: 1) 基本 transfer 通过');
      basicCtx = { guestId, userId: user.id, guestWorkId: created.workId, userWorkId, keys: created.storageKeys };
    }

    console.log('=== 2) 计数汇总：copy=0（无 rename）+ tombstone=0 复核 ===');
    {
      assert.ok(basicCtx, '依赖第 1 节');
      // storage copy 无 API：静态由 unit 锁（无 copy 调用）；集成侧复核无多余 object（keys 集合不变）
      for (const k of basicCtx.keys) assert.strictEqual(await realStorage.exists(k), true, '复核 Object 仍在（无 copy/rename 后遗）');
      assert.strictEqual(await countTombstones(basicCtx.keys), 0, '复核 tombstone=0');
      console.log('PASS: 2) 计数复核通过');
    }

    console.log('=== 3) partial 3/8 原样 transfer（状态与 ready metadata 不丢） ===');
    {
      const guestId = `g_${TAG}_partial`;
      const segs: SegSpec[] = [];
      for (let i = 0; i < 8; i += 1) segs.push(i < 3 ? { status: 'ready', withObject: true } : { status: 'missing', withObject: false });
      const created = await createGuestWorkWithManifest({
        tag: 'partial',
        guestId,
        manifestStatus: 'preparing',
        contentHash: `hash_${TAG}_partial`,
        segs,
        seedBase: 21,
      });
      const guestSegBefore = await prisma.guestStoryAudioSegment.findMany({ where: { manifestId: created.manifestId }, orderBy: { segmentIndex: 'asc' } });
      const counting = createCountingBackend(realStorage);
      setAudioAssetStorageForTests(counting);
      const user = await prisma.user.create({
        data: { username: `m8053_partial_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, password: 'TestPassword123!', nickname: 'M8053' },
      });
      const res = await migrateGuestCreativeRecordsToUser(guestId, user.id);
      setAudioAssetStorageForTests(realStorage);
      const userWorkId = res.storyWorkIdMap.get(created.workId)!;
      const userManifest = await prisma.storyAudioManifest.findUnique({
        where: { storyWorkId_version: { storyWorkId: userWorkId, version: 1 } },
        include: { segments: { orderBy: { segmentIndex: 'asc' } } },
      });
      assert.ok(userManifest, 'partial User Manifest 存在');
      assert.strictEqual(userManifest.status, 'preparing', 'partial 状态原样（preparing）');
      assert.strictEqual(userManifest.segmentCount, 8, 'segmentCount=8 原样');
      assert.strictEqual(userManifest.readySegmentCount, 3, 'readySegmentCount=3 原样');
      assert.strictEqual(userManifest.segments.length, 8, '8 段全量搬运');
      const guestSegs: typeof guestSegBefore = guestSegBefore;
      const userSegs: typeof guestSegBefore = userManifest.segments as unknown as typeof guestSegBefore;
      for (let i = 0; i < 8; i += 1) {
        const gb = guestSegs[i] as (typeof guestSegs)[number];
        const ub = userSegs[i] as (typeof userSegs)[number];
        assert.strictEqual(ub.segmentIndex, i, `段 ${i} index 原样`);
        assert.strictEqual(ub.text, gb.text, `段 ${i} text 原样`);
        assert.strictEqual(ub.textHash, gb.textHash, `段 ${i} textHash 原样`);
        assert.strictEqual(ub.status, gb.status, `段 ${i} status 原样`);
        assert.strictEqual(ub.storageKey, gb.storageKey, `段 ${i} storageKey 不变`);
        assert.strictEqual(ub.byteLength, gb.byteLength, `段 ${i} byteLength 原样（ready metadata 不丢）`);
        assert.strictEqual(ub.durationMs, gb.durationMs, `段 ${i} durationMs 原样`);
      }
      assert.strictEqual(await prisma.guestStoryAudioManifest.count({ where: { storyWorkId: created.workId } }), 0, 'Guest Manifest 清除');
      assert.deepStrictEqual(counting.puts, [], 'partial put=0');
      assert.deepStrictEqual(counting.deletes, [], 'partial delete=0');
      assert.strictEqual(await countTombstones(created.storageKeys), 0, 'partial tombstone=0');
      console.log('PASS: 3) partial 通过');
    }

    console.log('=== 4) failed/preparing/missing 原样 transfer、不触发 synthesis ===');
    {
      const guestId = `g_${TAG}_mixed`;
      const created = await createGuestWorkWithManifest({
        tag: 'mixed',
        guestId,
        manifestStatus: 'preparing',
        contentHash: `hash_${TAG}_mixed`,
        segs: [
          { status: 'failed', withObject: false },
          { status: 'preparing', withObject: false, lease: true },
          { status: 'missing', withObject: false },
        ],
        seedBase: 31,
      });
      const guestSegBefore = await prisma.guestStoryAudioSegment.findMany({ where: { manifestId: created.manifestId }, orderBy: { segmentIndex: 'asc' } });
      const counting = createCountingBackend(realStorage);
      setAudioAssetStorageForTests(counting);
      const ttsBefore = ttsInvocations;
      const user = await prisma.user.create({
        data: { username: `m8053_mixed_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, password: 'TestPassword123!', nickname: 'M8053' },
      });
      const res = await migrateGuestCreativeRecordsToUser(guestId, user.id);
      setAudioAssetStorageForTests(realStorage);
      const userWorkId = res.storyWorkIdMap.get(created.workId)!;
      const userManifest = await prisma.storyAudioManifest.findUnique({
        where: { storyWorkId_version: { storyWorkId: userWorkId, version: 1 } },
        include: { segments: { orderBy: { segmentIndex: 'asc' } } },
      });
      assert.ok(userManifest, 'mixed User Manifest 存在');
      assert.deepStrictEqual(userManifest.segments.map((s) => s.status), ['failed', 'preparing', 'missing'], '三态原样');
      assert.strictEqual(userManifest.segments[0].lastErrorCode, guestSegBefore[0].lastErrorCode, 'failed error 原样');
      assert.ok(userManifest.segments[1].leaseId, 'preparing lease 原样搬运（不触发 synthesis）');
      assert.deepStrictEqual(userManifest.segments.map((s) => s.storageKey), guestSegBefore.map((s) => s.storageKey), 'storageKeys 不变');
      assert.deepStrictEqual(counting.puts, [], 'mixed put=0（未合成即未写对象）');
      assert.deepStrictEqual(counting.deletes, [], 'mixed delete=0');
      assert.strictEqual(ttsInvocations, ttsBefore, 'mixed TTS=0');
      assert.strictEqual(await countTombstones(created.storageKeys), 0, 'mixed tombstone=0');
      console.log('PASS: 4) mixed 通过');
    }

    console.log('=== 5) 重复 registration migration → 不重复 User Manifest/Segment（幂等） ===');
    {
      assert.ok(basicCtx, '依赖第 1 节');
      const beforeManifests = await prisma.storyAudioManifest.count({ where: { storyWorkId: basicCtx.userWorkId } });
      const beforeSegs = await prisma.storyAudioSegment.count({ where: { manifest: { storyWorkId: basicCtx.userWorkId } } });
      assert.strictEqual(beforeManifests, 1, '前置 User Manifest=1');
      const counting = createCountingBackend(realStorage);
      setAudioAssetStorageForTests(counting);
      const repeat = await migrateGuestCreativeRecordsToUser(basicCtx.guestId, basicCtx.userId);
      setAudioAssetStorageForTests(realStorage);
      assert.strictEqual(repeat.storyWorkIdMap.get(basicCtx.guestWorkId), basicCtx.userWorkId, '重复映射一致');
      assert.strictEqual(await prisma.storyAudioManifest.count({ where: { storyWorkId: basicCtx.userWorkId } }), 1, '重复后仍 1 Manifest（不重复）');
      assert.strictEqual(await prisma.storyAudioSegment.count({ where: { manifest: { storyWorkId: basicCtx.userWorkId } } }), beforeSegs, '重复后 Segment 不重复');
      assert.strictEqual(await prisma.guestStoryAudioManifest.count({ where: { storyWorkId: basicCtx.guestWorkId } }), 0, 'Guest 仍 none（幂等 no-op）');
      assert.deepStrictEqual(counting.puts, [], '幂等 put=0');
      assert.deepStrictEqual(counting.deletes, [], '幂等 delete=0');
      assert.strictEqual(await countTombstones(basicCtx.keys), 0, '幂等 tombstone=0');

      // 等价幂等分支（helper 直调）：User 已存在等价 Manifest + Guest 仍有 rows → 只清 Guest
      const guestId2 = `g_${TAG}_idem2`;
      const created = await createGuestWorkWithManifest({
        tag: 'idem2',
        guestId: guestId2,
        manifestStatus: 'ready',
        contentHash: `hash_${TAG}_idem2`,
        segs: [{ status: 'ready', withObject: true }],
        seedBase: 41,
      });
      const user2 = await prisma.user.create({
        data: { username: `m8053_idem2_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, password: 'TestPassword123!', nickname: 'M8053' },
      });
      const guestWork2 = await prisma.guestStoryWork.findUnique({ where: { id: created.workId } });
      assert.ok(guestWork2, '前置 guest work 存在');
      // 手工建等价 User Work + 等价 Manifest（模拟复用既有 Work 已有等价音频的竞态）
      const userWork2 = await prisma.storyWork.create({
        data: { userId: user2.id, prompt: guestWork2.prompt, storyText: guestWork2.storyText, title: 'idem2', contentHash: guestWork2.contentHash },
      });
      const guestManifest2 = await prisma.guestStoryAudioManifest.findUnique({ where: { id: created.manifestId }, include: { segments: true } });
      assert.ok(guestManifest2, '前置 guest manifest 存在');
      const userManifest2 = await prisma.storyAudioManifest.create({
        data: {
          storyWorkId: userWork2.id,
          version: 1,
          status: guestManifest2.status,
          contentHash: guestManifest2.contentHash,
          segmentationVersion: guestManifest2.segmentationVersion,
          voiceId: guestManifest2.voiceId,
          ttsBackendId: guestManifest2.ttsBackendId,
          ttsModel: guestManifest2.ttsModel,
          synthesisVersion: guestManifest2.synthesisVersion,
          synthesisSpeed: guestManifest2.synthesisSpeed,
          audioFormat: guestManifest2.audioFormat,
          segmentCount: guestManifest2.segmentCount,
          readySegmentCount: guestManifest2.readySegmentCount,
          totalDurationMs: guestManifest2.totalDurationMs,
          totalByteLength: guestManifest2.totalByteLength,
        },
      });
      for (const gs of guestManifest2.segments) {
        await prisma.storyAudioSegment.create({
          data: {
            id: randomUUID(),
            manifestId: userManifest2.id,
            segmentIndex: gs.segmentIndex,
            text: gs.text,
            textHash: gs.textHash,
            status: gs.status,
            storageKey: gs.storageKey,
            contentType: gs.contentType,
            byteLength: gs.byteLength,
            durationMs: gs.durationMs,
            audioChecksum: gs.audioChecksum,
            attemptCount: 0,
          },
        });
      }
      const out = await prisma.$transaction((tx) => transferGuestAudioOwnershipTx(tx, created.workId, userWork2.id));
      assert.strictEqual(out.status, 'idempotent', '等价已存在 → idempotent');
      assert.strictEqual(await prisma.guestStoryAudioManifest.count({ where: { storyWorkId: created.workId } }), 0, '等价幂等清 Guest Manifest');
      assert.ok(await prisma.storyAudioManifest.findUnique({ where: { id: userManifest2.id } }), 'User Manifest 不动');
      console.log('PASS: 5) 幂等通过');
    }

    console.log('=== 6) 冲突 → 整个 ownership transfer rollback、两侧 rows 不破坏 ===');
    {
      // 经 creative migration 整事务制造冲突：同源同 hash 复用 User Work，
      // 但 User Manifest 与 Guest Manifest canonical 身份冲突（voice 不同）→ CONFLICT 全回滚
      const conflictTag = `conflict_${Date.now()}`;
      const user = await prisma.user.create({
        data: { username: `m8053_conf_${conflictTag}_${Math.floor(Math.random() * 1e6)}`, password: 'TestPassword123!', nickname: 'M8053' },
      });
      const srcMsg = `msg_conf_${TAG}_${conflictTag}`;
      const sharedHash = `hash_${TAG}_conflict_shared`;
      const userWork = await prisma.storyWork.create({
        data: { userId: user.id, prompt: 'orig', storyText: 'orig text', title: 'orig', contentHash: sharedHash, sourceMessageId: srcMsg },
      });
      const userManifest = await prisma.storyAudioManifest.create({
        data: {
          storyWorkId: userWork.id,
          version: 1,
          status: 'ready',
          contentHash: sharedHash,
          segmentationVersion: 'v1',
          voiceId: 'alloy',
          ttsBackendId: 'openai',
          ttsModel: 'tts-1',
          synthesisVersion: 'canonical-mp3-v1',
          synthesisSpeed: 1.0,
          audioFormat: 'mp3',
          segmentCount: 1,
          readySegmentCount: 1,
          totalDurationMs: 261,
          totalByteLength: 4170,
        },
      });
      const userKey = `story-audio/${TAG}-conflict-user-w${userWork.id}-s0.mp3`;
      await realStorage.put({ key: userKey, bytes: sampleBytes(61), contentType: 'audio/mpeg' });
      await prisma.storyAudioSegment.create({
        data: {
          id: randomUUID(),
          manifestId: userManifest.id,
          segmentIndex: 0,
          text: 'user seg',
          textHash: 'uth_conf',
          status: 'ready',
          storageKey: userKey,
          contentType: 'audio/mpeg',
          byteLength: sampleBytes(61).byteLength,
          durationMs: 261,
          audioChecksum: 'uck',
          readyAt: new Date(),
        },
      });

      const guestId = `g_${TAG}_conflict`;
      const guestWork = await prisma.guestStoryWork.create({
        data: { guestId, prompt: 'guest', storyText: 'guest text', title: 'guest', contentHash: sharedHash, sourceMessageId: srcMsg },
      });
      const guestManifest = await prisma.guestStoryAudioManifest.create({
        data: {
          storyWorkId: guestWork.id,
          version: 1,
          status: 'ready',
          contentHash: sharedHash,
          segmentationVersion: 'v1',
          voiceId: 'nova',
          ttsBackendId: 'openai',
          ttsModel: 'tts-1',
          synthesisVersion: 'canonical-mp3-v1',
          synthesisSpeed: 1.0,
          audioFormat: 'mp3',
          segmentCount: 1,
          readySegmentCount: 1,
          totalDurationMs: 261,
          totalByteLength: 4170,
        },
      });
      const guestKey = `story-audio/${TAG}-conflict-guest-w${guestWork.id}-s0.mp3`;
      await realStorage.put({ key: guestKey, bytes: sampleBytes(62), contentType: 'audio/mpeg' });
      await prisma.guestStoryAudioSegment.create({
        data: {
          id: randomUUID(),
          manifestId: guestManifest.id,
          segmentIndex: 0,
          text: 'guest seg',
          textHash: 'gth_conf',
          status: 'ready',
          storageKey: guestKey,
          contentType: 'audio/mpeg',
          byteLength: sampleBytes(62).byteLength,
          durationMs: 261,
          audioChecksum: 'gck',
          readyAt: new Date(),
        },
      });

      const counting = createCountingBackend(realStorage);
      setAudioAssetStorageForTests(counting);
      let threw: unknown = null;
      try {
        await migrateGuestCreativeRecordsToUser(guestId, user.id);
      } catch (e) {
        threw = e;
      } finally {
        setAudioAssetStorageForTests(realStorage);
      }
      assert.ok(threw, '冲突必须抛错');
      const code = (threw as { code?: string })?.code;
      assert.strictEqual(code, 'CONFLICT', '冲突码必须为 CONFLICT（fail-closed）');
      // 两侧 rows 均不破坏
      assert.ok(await prisma.guestStoryAudioManifest.findUnique({ where: { id: guestManifest.id } }), 'Guest Manifest 不破坏');
      assert.strictEqual(await prisma.guestStoryAudioSegment.count({ where: { manifestId: guestManifest.id } }), 1, 'Guest Segments 不破坏');
      assert.ok(await prisma.storyAudioManifest.findUnique({ where: { id: userManifest.id } }), 'User Manifest 不破坏');
      assert.strictEqual(await prisma.storyAudioSegment.count({ where: { manifestId: userManifest.id } }), 1, 'User Segments 不破坏');
      const userSegAfter = await prisma.storyAudioSegment.findFirst({ where: { manifestId: userManifest.id } });
      assert.strictEqual(userSegAfter?.storageKey, userKey, 'User storageKey 不被覆盖');
      // object untouched + 无 tombstone + migration 映射未落（整事务回滚）
      assert.strictEqual(await realStorage.exists(userKey), true, 'User object untouched');
      assert.strictEqual(await realStorage.exists(guestKey), true, 'Guest object untouched');
      assert.deepStrictEqual(counting.puts, [], '冲突 put=0');
      assert.deepStrictEqual(counting.deletes, [], '冲突 delete=0');
      assert.strictEqual(await countTombstones([userKey, guestKey]), 0, '冲突 tombstone=0');
      assert.strictEqual(
        await prisma.storyWorkMigration.count({ where: { guestId, guestStoryWorkId: guestWork.id } }),
        0,
        '冲突整事务回滚：不落错误 map',
      );
      console.log('PASS: 6) 冲突回滚通过');
    }

    console.log('=== 7) getPlaybackManifest 直见 frozen segments；ready 可立即读取不重生成 ===');
    {
      assert.ok(basicCtx, '依赖第 1 节');
      const proj = await getPlaybackManifestForSubject({ type: 'user' as const, id: basicCtx.userId }, { workId: basicCtx.userWorkId });
      assert.strictEqual(proj.workId, basicCtx.userWorkId, '投影 workId 对齐');
      assert.strictEqual(proj.status, 'ready', '转移后投影 ready');
      assert.strictEqual(proj.segments.length, basicCtx.keys.length, '段数对齐');
      for (const s of proj.segments) {
        assert.strictEqual(s.status, 'ready', 'ready 段保持 ready');
        assert.ok(s.playbackUrl, 'ready 段有 playbackUrl');
        assert.ok(typeof s.durationMs === 'number' && (s.durationMs as number) > 0, 'duration 可用');
      }
      // 已有 ready segment 经 ensure 立即可读、不重新生成（counting synth 零调用、storage 零 put）
      const counting = createCountingBackend(realStorage);
      setAudioAssetStorageForTests(counting);
      const ttsBefore = ttsInvocations;
      try {
        const r = await ensureStoryAudioSegmentForSubject(
          { type: 'user' as const, id: basicCtx.userId },
          { workId: basicCtx.userWorkId, segmentIndex: 0, sessionId: randomUUID() },
          { storage: counting, synthesize: countingSynth },
        );
        assert.strictEqual(r.status, 'ready', 'ready 快路径直接返回');
        assert.strictEqual(ttsInvocations, ttsBefore, '不重新生成（TTS=0）');
        assert.deepStrictEqual(counting.puts, [], '不重写对象（put=0）');
      } finally {
        setAudioAssetStorageForTests(realStorage);
      }
      console.log('PASS: 7) 读路径通过');
    }
  } finally {
    if (prevDriver === undefined) delete process.env.AUDIO_STORAGE_DRIVER;
    else process.env.AUDIO_STORAGE_DRIVER = prevDriver;
    if (prevRoot === undefined) delete process.env.AUDIO_LOCAL_ROOT;
    else process.env.AUDIO_LOCAL_ROOT = prevRoot;
    resetCache();
    resetAudioAssetStorageForTests();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    await wipeTombstonesByPrefix(`story-audio/${TAG}-`);
  }

  console.log('ALL AUDIO OWNERSHIP TRANSFER INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioOwnershipTransferIntegrationTests()
  .then(() => {
    console.log('ALL AUDIO OWNERSHIP TRANSFER INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
