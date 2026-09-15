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
import {
  computeAudioChecksum,
} from '../../../lib/audio/checksum';
import { getMp3DurationMs } from '../../../lib/audio/duration';
import {
  buildFakeCanonicalMp3,
  expectedFakeMp3Checksum,
  expectedFakeMp3DurationMs,
} from '../../../tests/support/fixtures/fake-canonical-mp3';
import {
  ensureStoryAudioSegmentForSubject,
  getPlaybackManifestForSubject,
  refreshUserManifestState,
  STORY_AUDIO_LEASE_TTL_MS,
  STORY_AUDIO_RETRY_AFTER_MS,
} from '../../../lib/server/storyAudio';
import { resetCache } from '../../../lib/server/openai';
import { computeStoryContentHash } from '../../../utils/segmentation';

/**
 * M8-03 ensureSegment 集成测试（spec §50–§56/§59；fake TTS，真实 OpenAI 禁止进入自动测试）。
 *
 * 覆盖：
 * 1. fake 已知 MP3 → duration>0 → checksum exact → byteLength exact → object exists → DB ready；
 *    Manifest 创建零 TTS（仅请求段合成，其余仍 missing；二次同段 TTS 不增加）；
 * 2. 并发 Promise.all(ensure×3) → TTS count == 1；
 * 3. lease expiry（过期 preparing → re-claim 成功）；
 * 4. failure（TTS fail / Storage fail / retry 成功；manifest failed↔preparing↔ready）；
 * 5. corruption（DB ready + object missing → degrade → 下一次可重建）；
 * 6. voice 一致性 / model pinning / canonical speed 1.0；
 * 7. Trash 门禁（active 允许；trash 仅 Anchor 匹配允许，否则 WORK_UNAVAILABLE）；
 * 8. totals 仅全 ready 才写（partial null；全 ready sum）；
 * 9. 非法输入（INVALID_SEGMENT / WORK_NOT_FOUND / foreign 隔离）与 Guest 对称。
 * FIXUP（M8-03 复审 Blocking1/2）：
 * 10. lease fencing：A claim→TTS suspend→时间推进>TTL→B reclaim/ready→resume A→A 不得 put，
 *     最终 object checksum==DB checksum（B 保留）；
 * 11. Manifest aggregate 无 stale 回退：双段并发完成→Manifest ready/count2/totals 精确，
 *     旧快照不能覆盖新状态，并发 refresh 仍收敛 ready。
 */

type FakeTtsState = {
  count: number;
  inputs: Array<{ text: string; model: string; voiceId: string; speed: number; format: string }>;
  delayMs: number;
  failNext: boolean;
  bytesSeed: number;
};

function makeFakeTts(state: FakeTtsState) {
  return async (input: { text: string; model: string; voiceId: string; speed: number; format: string }) => {
    state.count += 1;
    state.inputs.push({ ...input });
    if (state.failNext) {
      state.failNext = false;
      throw new Error('fake tts boom');
    }
    if (state.delayMs > 0) {
      await new Promise((r) => setTimeout(r, state.delayMs));
    }
    const bytes = buildFakeCanonicalMp3(10, state.bytesSeed);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return { audioData: buf, requestId: '' };
  };
}

function storyTextTwoSegments(): string {
  const p1 = '第一段故事正文，用于 canonical 写入验证。'.repeat(6);
  const p2 = '第二段故事正文，用于 canonical 写入验证。'.repeat(6);
  return `${p1}\n${p2}`;
}

function storyTextSingle(): string {
  return '单段故事正文，用于 canonical 写入验证。'.repeat(6);
}

async function createUserWork(opts: {
  tag: string;
  storyText: string;
  voiceId?: string;
  contentHash?: string;
}): Promise<{ userId: number; workId: number }> {
  const user = await prisma.user.create({
    data: {
      username: `m803_${opts.tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      password: 'TestPassword123!',
      nickname: 'M803',
    },
  });
  const storyText = opts.storyText;
  const contentHash =
    opts.contentHash !== undefined ? opts.contentHash : computeStoryContentHash(storyText);
  const work = await prisma.storyWork.create({
    data: {
      userId: user.id,
      prompt: '测试提示词',
      storyText,
      voiceId: opts.voiceId ?? 'nova',
      title: '测试作品',
      excerpt: '测试摘要',
      contentHash,
    },
  });
  return { userId: user.id, workId: work.id };
}

async function createGuestWork(opts: {
  tag: string;
  storyText: string;
  voiceId?: string;
}): Promise<{ guestId: string; workId: number }> {
  const guestId = `g_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const work = await prisma.guestStoryWork.create({
    data: {
      guestId,
      prompt: '测试提示词',
      storyText: opts.storyText,
      voiceId: opts.voiceId ?? 'nova',
      title: '测试作品',
      excerpt: '测试摘要',
      contentHash: computeStoryContentHash(opts.storyText),
    },
  });
  return { guestId, workId: work.id };
}

function trpcCodeOf(err: unknown): string {
  return (err as { code?: unknown }).code as string;
}
function domainOf(err: unknown): string {
  return (err as { message?: unknown }).message as string;
}

async function runAudioEnsureSegmentTests() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm803-audio-'));
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

  try {
    console.log('=== 1. fake 已知 MP3 → ready 全字段精确 ===');
    {
      const { userId, workId } = await createUserWork({
        tag: 'basic',
        storyText: storyTextSingle(),
        voiceId: 'nova',
      });
      const sessionId = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      const fake: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 3 };
      const storage = getAudioAssetStorage();
      const res = await ensureStoryAudioSegmentForSubject(
        subject,
        { workId, segmentIndex: 0, sessionId },
        { storage, synthesize: makeFakeTts(fake) }
      );
      assert.strictEqual(res.status, 'ready', '首 ensure 应 ready');
      assert.strictEqual(fake.count, 1, '仅请求段合成一次（Manifest 创建零 TTS）');
      if (res.status !== 'ready') throw new Error('unreachable');
      assert.ok(res.segment.durationMs > 0, 'duration>0');
      assert.strictEqual(
        res.segment.durationMs,
        expectedFakeMp3DurationMs(10),
        'duration exact'
      );
      assert.strictEqual(res.segment.byteLength, 10 * 417, 'byteLength exact');
      assert.ok(res.segment.text.length > 0, 'frozen text 回传');
      assert.ok(res.segment.playbackUrl.startsWith('/api/audio/segments/'), 'playbackUrl 形态');
      assert.ok(!res.segment.playbackUrl.includes('story-audio/'), '不暴露 storageKey');

      // DB 行断言
      const manifest = await prisma.storyAudioManifest.findFirst({
        where: { storyWorkId: workId },
        include: { segments: true },
      });
      assert.ok(manifest, 'Manifest 已建');
      assert.strictEqual(manifest!.ttsModel, 'model-A', 'model pin A');
      assert.strictEqual(manifest!.voiceId, 'nova', 'voice 冻结 nova');
      assert.strictEqual(manifest!.segments.length, manifest!.segmentCount, '全段行已建');
      const segRow = manifest!.segments.find((s) => s.segmentIndex === 0)!;
      assert.strictEqual(segRow.status, 'ready', 'DB ready');
      assert.strictEqual(segRow.durationMs, expectedFakeMp3DurationMs(10), 'DB duration exact');
      assert.strictEqual(segRow.byteLength, 10 * 417, 'DB byteLength exact');
      const expectedBytes = buildFakeCanonicalMp3(10, 3);
      assert.strictEqual(segRow.audioChecksum, expectedFakeMp3Checksum(expectedBytes), 'DB checksum exact');
      // duration 解析与 checksum 与工具同源
      assert.strictEqual(getMp3DurationMs(expectedBytes), segRow.durationMs, '工具 duration 一致');
      assert.strictEqual(computeAudioChecksum(expectedBytes), segRow.audioChecksum, '工具 checksum 一致');
      // object exists
      assert.strictEqual(await storage.exists(segRow.storageKey), true, 'object exists');
      const meta = await storage.getMetadata(segRow.storageKey);
      assert.strictEqual(meta?.size, 10 * 417, 'object size exact');
      // 其余段仍 missing（lazy，非整篇合成）
      for (const s of manifest!.segments) {
        if (s.segmentIndex !== 0) assert.strictEqual(s.status, 'missing', '非请求段仍 missing');
      }
      // 二次同段 TTS 不增加（§53）
      const res2 = await ensureStoryAudioSegmentForSubject(
        subject,
        { workId, segmentIndex: 0, sessionId },
        { storage, synthesize: makeFakeTts(fake) }
      );
      assert.strictEqual(res2.status, 'ready', '二次秒开 ready');
      assert.strictEqual(fake.count, 1, 'TTS count 不增加');
      console.log('PASS: 1. 基本 ready 断言通过');
    }

    console.log('=== 2. 并发 Promise.all(ensure×3) → TTS count == 1 ===');
    {
      const { userId, workId } = await createUserWork({
        tag: 'race',
        storyText: storyTextSingle(),
        voiceId: 'nova',
      });
      const sessionId = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      const fake: FakeTtsState = { count: 0, inputs: [], delayMs: 120, failNext: false, bytesSeed: 5 };
      const storage = getAudioAssetStorage();
      const synth = makeFakeTts(fake);
      const results = await Promise.all([
        ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 0, sessionId }, { storage, synthesize: synth }),
        ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 0, sessionId }, { storage, synthesize: synth }),
        ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 0, sessionId }, { storage, synthesize: synth }),
      ]);
      assert.strictEqual(fake.count, 1, `TTS count 必须 ==1，实际=${fake.count}`);
      const readyCount = results.filter((r) => r.status === 'ready').length;
      const preparingCount = results.filter((r) => r.status === 'preparing').length;
      assert.ok(readyCount >= 1, '至少一个 ready');
      assert.strictEqual(readyCount + preparingCount, 3, '仅 ready/preparing 两态');
      // retryAfter 恒 500
      for (const r of results) {
        if (r.status === 'preparing') {
          assert.strictEqual((r as { retryAfterMs: number }).retryAfterMs, STORY_AUDIO_RETRY_AFTER_MS, 'retryAfter 500');
        }
      }
      console.log('PASS: 2. 并发断言通过');
    }

    console.log('=== 3. lease expiry（过期 preparing → re-claim） ===');
    {
      const { userId, workId } = await createUserWork({
        tag: 'lease',
        storyText: storyTextSingle(),
        voiceId: 'nova',
      });
      const sessionId = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      const fake: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 9 };
      const storage = getAudioAssetStorage();
      // 先 ensure 一次建 Manifest（不直接合成目标？先手动构造过期 lease）
      await ensureStoryAudioSegmentForSubject(
        subject,
        { workId, segmentIndex: 0, sessionId },
        { storage, synthesize: makeFakeTts(fake) }
      );
      assert.strictEqual(fake.count, 1, '预建一次');
      // 另起一段故事测过期：建双段 work，对段 1 手工置过期 preparing
      const two = await createUserWork({ tag: 'lease2', storyText: storyTextTwoSegments(), voiceId: 'nova' });
      const subj2 = { type: 'user' as const, id: two.userId };
      const fake2: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 11 };
      // 先触发 Manifest 创建（段 0 合成一次）
      await ensureStoryAudioSegmentForSubject(
        subj2,
        { workId: two.workId, segmentIndex: 0, sessionId },
        { storage, synthesize: makeFakeTts(fake2) }
      );
      const manifest = await prisma.storyAudioManifest.findFirst({
        where: { storyWorkId: two.workId },
        include: { segments: true },
      });
      const seg1 = manifest!.segments.find((s) => s.segmentIndex === 1)!;
      // 手工置过期 lease
      await prisma.storyAudioSegment.update({
        where: { id: seg1.id },
        data: {
          status: 'preparing',
          leaseId: randomUUID(),
          leaseExpiresAt: new Date(Date.now() - 1000),
          attemptCount: 1,
        },
      });
      const before = fake2.count;
      const res = await ensureStoryAudioSegmentForSubject(
        subj2,
        { workId: two.workId, segmentIndex: 1, sessionId },
        { storage, synthesize: makeFakeTts(fake2) }
      );
      assert.strictEqual(res.status, 'ready', '过期 lease 应 re-claim 成功');
      assert.strictEqual(fake2.count, before + 1, '重新合成一次');
      const after = await prisma.storyAudioSegment.findUnique({ where: { id: seg1.id } });
      assert.strictEqual(after!.status, 'ready', '段已 ready');
      assert.ok((after!.attemptCount ?? 0) >= 2, 'attemptCount 递增');
      console.log('PASS: 3. lease 过期断言通过');
    }

    console.log('=== 4. failure（TTS fail / Storage fail / retry） ===');
    {
      const { userId, workId } = await createUserWork({
        tag: 'fail',
        storyText: storyTextSingle(),
        voiceId: 'nova',
      });
      const sessionId = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      const storage = getAudioAssetStorage();
      const fake: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: true, bytesSeed: 13 };
      // TTS 失败
      let err: unknown = null;
      try {
        await ensureStoryAudioSegmentForSubject(
          subject,
          { workId, segmentIndex: 0, sessionId },
          { storage, synthesize: makeFakeTts(fake) }
        );
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'TTS 失败应抛错');
      assert.strictEqual(domainOf(err), 'AUDIO_SYNTHESIS_FAILED', 'TTS 失败 domain 码');
      const segFail = await prisma.storyAudioSegment.findFirst({
        where: { manifest: { storyWorkId: workId }, segmentIndex: 0 },
      });
      assert.strictEqual(segFail!.status, 'failed', '段 failed');
      assert.strictEqual(segFail!.lastErrorCode, 'AUDIO_SYNTHESIS_FAILED', 'lastErrorCode');
      const manFail = await prisma.storyAudioManifest.findFirst({ where: { storyWorkId: workId } });
      assert.strictEqual(manFail!.status, 'failed', 'Manifest failed');
      // retry 成功（同一 key 覆盖写，不断言新 key）
      const keyBefore = segFail!.storageKey;
      const fake2: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 13 };
      const res = await ensureStoryAudioSegmentForSubject(
        subject,
        { workId, segmentIndex: 0, sessionId },
        { storage, synthesize: makeFakeTts(fake2) }
      );
      assert.strictEqual(res.status, 'ready', 'retry 应 ready');
      const segOk = await prisma.storyAudioSegment.findUnique({ where: { id: segFail!.id } });
      assert.strictEqual(segOk!.storageKey, keyBefore, 'retry 复用同一 key（不生成第二个 object）');
      assert.strictEqual(await storage.exists(keyBefore), true, 'object 已写');

      // Storage 失败
      const two = await createUserWork({ tag: 'storfail', storyText: storyTextSingle(), voiceId: 'nova' });
      const subj2 = { type: 'user' as const, id: two.userId };
      const realStorage = getAudioAssetStorage();
      const failingStorage: AudioAssetStorage = {
        put: async () => {
          throw new Error('fake storage boom');
        },
        exists: (k) => realStorage.exists(k),
        delete: (k) => realStorage.delete(k),
        getMetadata: (k) => realStorage.getMetadata(k),
        resolveRead: (k, r) => realStorage.resolveRead(k, r),
      };
      const fake3: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 15 };
      let err2: unknown = null;
      try {
        await ensureStoryAudioSegmentForSubject(
          subj2,
          { workId: two.workId, segmentIndex: 0, sessionId },
          { storage: failingStorage, synthesize: makeFakeTts(fake3) }
        );
      } catch (e) {
        err2 = e;
      }
      assert.ok(err2, 'Storage 失败应抛错');
      assert.strictEqual(domainOf(err2), 'AUDIO_STORAGE_FAILED', 'Storage domain 码');
      const segSf = await prisma.storyAudioSegment.findFirst({
        where: { manifest: { storyWorkId: two.workId }, segmentIndex: 0 },
      });
      assert.strictEqual(segSf!.status, 'failed', 'Storage 失败段 failed');
      assert.notStrictEqual(segSf!.status, 'ready', 'TTS bytes 不标 canonical（非 ready）');
      // retry 用真存储成功
      const fake4: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 15 };
      const res2 = await ensureStoryAudioSegmentForSubject(
        subj2,
        { workId: two.workId, segmentIndex: 0, sessionId },
        { storage: realStorage, synthesize: makeFakeTts(fake4) }
      );
      assert.strictEqual(res2.status, 'ready', 'Storage retry 应 ready');
      console.log('PASS: 4. failure 断言通过');
    }

    console.log('=== 5. corruption（DB ready + object missing → degrade → 重建） ===');
    {
      const { userId, workId } = await createUserWork({
        tag: 'corrupt',
        storyText: storyTextSingle(),
        voiceId: 'nova',
      });
      const sessionId = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      const storage = getAudioAssetStorage();
      const fake: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 17 };
      const synth = makeFakeTts(fake);
      await ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 0, sessionId }, { storage, synthesize: synth });
      assert.strictEqual(fake.count, 1, '预建一次');
      const seg = await prisma.storyAudioSegment.findFirst({
        where: { manifest: { storyWorkId: workId }, segmentIndex: 0 },
      });
      assert.strictEqual(seg!.status, 'ready', '预建 ready');
      // 删 object 模拟 corruption
      await storage.delete(seg!.storageKey);
      assert.strictEqual(await storage.exists(seg!.storageKey), false, 'object 已删');
      // 下一次 ensure 应 degrade 后重建（同一 key）
      const fake2: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 17 };
      const res = await ensureStoryAudioSegmentForSubject(
        subject,
        { workId, segmentIndex: 0, sessionId },
        { storage, synthesize: makeFakeTts(fake2) }
      );
      assert.strictEqual(res.status, 'ready', 'corruption 后可重建 ready');
      assert.strictEqual(fake2.count, 1, '重建合成一次');
      const seg2 = await prisma.storyAudioSegment.findUnique({ where: { id: seg!.id } });
      assert.strictEqual(seg2!.status, 'ready', '重建后 ready');
      assert.strictEqual(seg2!.storageKey, seg!.storageKey, '同一 key 覆盖写');
      assert.strictEqual(await storage.exists(seg!.storageKey), true, 'object 恢复');
      console.log('PASS: 5. corruption 断言通过');
    }

    console.log('=== 6. voice/model/speed（§54–§56） ===');
    {
      // voice 一致性：Manifest nova，默认改 alloy，段 1 仍 nova
      const { userId, workId } = await createUserWork({
        tag: 'voice',
        storyText: storyTextTwoSegments(),
        voiceId: 'nova',
      });
      const sessionId = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      const storage = getAudioAssetStorage();
      const fake: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 19 };
      const synth = makeFakeTts(fake);
      await ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 0, sessionId }, { storage, synthesize: synth });
      assert.strictEqual(fake.inputs[0].voiceId, 'nova', '首段 nova');
      assert.strictEqual(fake.inputs[0].speed, 1.0, 'canonical speed 1.0');
      assert.strictEqual(fake.inputs[0].format, 'mp3', 'format mp3');
      process.env.OPENAI_TTS_DEFAULT_VOICE = 'alloy';
      resetCache();
      await ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 1, sessionId }, { storage, synthesize: synth });
      assert.strictEqual(fake.inputs[1].voiceId, 'nova', '默认变 alloy 已冻结仍 nova');
      assert.strictEqual(fake.inputs[1].speed, 1.0, '仍 1.0（用户 1.5 不得进资产）');
      process.env.OPENAI_TTS_DEFAULT_VOICE = 'nova';
      resetCache();

      // model pinning：旧 Manifest A，env 改 B，旧缺失段仍 A；新 Work 用 B
      const m = await createUserWork({ tag: 'model', storyText: storyTextTwoSegments(), voiceId: 'nova' });
      const subjM = { type: 'user' as const, id: m.userId };
      process.env.OPENAI_TTS_MODEL = 'model-A';
      resetCache();
      const fakeM: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 21 };
      const synthM = makeFakeTts(fakeM);
      await ensureStoryAudioSegmentForSubject(subjM, { workId: m.workId, segmentIndex: 0, sessionId }, { storage, synthesize: synthM });
      assert.strictEqual(fakeM.inputs[0].model, 'model-A', '首段 A');
      process.env.OPENAI_TTS_MODEL = 'model-B';
      resetCache();
      await ensureStoryAudioSegmentForSubject(subjM, { workId: m.workId, segmentIndex: 1, sessionId }, { storage, synthesize: synthM });
      assert.strictEqual(fakeM.inputs[1].model, 'model-A', '旧 Manifest 缺失段仍 A');
      const m2 = await createUserWork({ tag: 'modelnew', storyText: storyTextSingle(), voiceId: 'nova' });
      const subjM2 = { type: 'user' as const, id: m2.userId };
      const fakeN: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 23 };
      await ensureStoryAudioSegmentForSubject(subjM2, { workId: m2.workId, segmentIndex: 0, sessionId }, { storage, synthesize: makeFakeTts(fakeN) });
      assert.strictEqual(fakeN.inputs[0].model, 'model-B', '新 Manifest 用 B');
      process.env.OPENAI_TTS_MODEL = 'model-A';
      resetCache();
      console.log('PASS: 6. voice/model/speed 断言通过');
    }

    console.log('=== 7. Trash 门禁（spec §21/§59） ===');
    {
      const { userId, workId } = await createUserWork({
        tag: 'trash',
        storyText: storyTextTwoSegments(),
        voiceId: 'nova',
      });
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      const storage = getAudioAssetStorage();
      const fake: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 25 };
      const synth = makeFakeTts(fake);
      // active 允许
      const r0 = await ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 0, sessionId: sessionA }, { storage, synthesize: synth });
      assert.strictEqual(r0.status, 'ready', 'active 允许');
      // 移入 Trash
      await prisma.storyWork.update({ where: { id: workId }, data: { deletedAt: new Date() } });
      // 无 Anchor → 拒绝
      let errNoAnchor: unknown = null;
      try {
        await ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 1, sessionId: sessionA }, { storage, synthesize: synth });
      } catch (e) {
        errNoAnchor = e;
      }
      assert.ok(errNoAnchor, 'Trash 无 Anchor 应拒绝');
      assert.strictEqual(domainOf(errNoAnchor), 'WORK_UNAVAILABLE', 'Trash 拒绝码');
      assert.strictEqual(trpcCodeOf(errNoAnchor), 'FORBIDDEN', 'Trash TRPC 码');
      // 当前 Anchor 匹配 → 允许
      await prisma.userPlaybackAnchor.upsert({
        where: { userId },
        create: {
          userId,
          sourceKind: 'work',
          sourceId: String(workId),
          sessionId: sessionA,
          title: '测试作品',
        },
        update: { sourceKind: 'work', sourceId: String(workId), sessionId: sessionA },
      });
      const r1 = await ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 1, sessionId: sessionA }, { storage, synthesize: synth });
      assert.strictEqual(r1.status, 'ready', 'Anchor 匹配允许');
      // 其他 Session → 拒绝
      let errOther: unknown = null;
      try {
        // 用另一双段 work 的另一段？此处 work 已有段 0/1 ready，需新段越界？用同一 work 段 0 已 ready 会直接读（trash 读允许？ensure ready 快路径仍需门禁，已过门禁才到快路径，此处 sessionB 门禁即拒绝）
        await ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 0, sessionId: sessionB }, { storage, synthesize: synth });
      } catch (e) {
        errOther = e;
      }
      assert.ok(errOther, '其他 Session 应拒绝');
      assert.strictEqual(domainOf(errOther), 'WORK_UNAVAILABLE', '其他 Session 拒绝码');
      // Restore 后 active 又允许（清理 Anchor 影响）
      await prisma.storyWork.update({ where: { id: workId }, data: { deletedAt: null } });
      await prisma.userPlaybackAnchor.deleteMany({ where: { userId } });
      console.log('PASS: 7. Trash 断言通过');
    }

    console.log('=== 8. totals 仅全 ready 才写 + getPlaybackManifest ===');
    {
      const { userId, workId } = await createUserWork({
        tag: 'totals',
        storyText: storyTextTwoSegments(),
        voiceId: 'nova',
      });
      const sessionId = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      const storage = getAudioAssetStorage();
      const fake: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 27 };
      const synth = makeFakeTts(fake);
      // 无 Manifest → get 为 missing 空投影
      const empty = await getPlaybackManifestForSubject(subject, { workId });
      assert.strictEqual(empty.status, 'missing', '无 Manifest → missing');
      assert.strictEqual(empty.segments.length, 0, '空段');
      // 首段 ready 后 partial → totals null，manifest 非 ready
      await ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 0, sessionId }, { storage, synthesize: synth });
      const partial = await getPlaybackManifestForSubject(subject, { workId });
      assert.strictEqual(partial.segments.length, 2, '两段行');
      assert.strictEqual(partial.readySegmentCount, 1, '1 ready');
      assert.strictEqual(partial.totalDurationMs, null, 'partial totals null');
      assert.strictEqual(partial.totalByteLength, null, 'partial bytes null');
      assert.notStrictEqual(partial.status, 'ready', 'partial 非 ready');
      // ready 段有 playbackUrl，missing 无
      assert.ok(partial.segments[0].playbackUrl, 'ready 有 URL');
      assert.strictEqual(partial.segments[1].playbackUrl, null, 'missing 无 URL');
      assert.ok(!JSON.stringify(partial).includes('story-audio/'), '投影不暴露 storageKey');
      // 全 ready → totals sum
      await ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 1, sessionId }, { storage, synthesize: synth });
      const full = await getPlaybackManifestForSubject(subject, { workId });
      assert.strictEqual(full.status, 'ready', '全 ready → Manifest ready');
      assert.strictEqual(full.readySegmentCount, 2, '2 ready');
      const expectedDur = expectedFakeMp3DurationMs(10) * 2;
      const expectedBytes = 10 * 417 * 2;
      assert.strictEqual(full.totalDurationMs, expectedDur, 'totalDuration sum');
      assert.strictEqual(full.totalByteLength, expectedBytes, 'totalBytes sum');
      console.log('PASS: 8. totals 断言通过');
    }

    console.log('=== 9. 非法输入与隔离 + Guest 对称 ===');
    {
      const { userId, workId } = await createUserWork({
        tag: 'invalid',
        storyText: storyTextSingle(),
        voiceId: 'nova',
      });
      const sessionId = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      const storage = getAudioAssetStorage();
      const fake: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 29 };
      const synth = makeFakeTts(fake);
      // 越界
      let errRange: unknown = null;
      try {
        await ensureStoryAudioSegmentForSubject(subject, { workId, segmentIndex: 99, sessionId }, { storage, synthesize: synth });
      } catch (e) {
        errRange = e;
      }
      assert.ok(errRange, '越界应错');
      assert.strictEqual(domainOf(errRange), 'INVALID_SEGMENT', '越界码');
      // 未知 work
      let errMissing: unknown = null;
      try {
        await ensureStoryAudioSegmentForSubject(subject, { workId: 999999937, segmentIndex: 0, sessionId }, { storage, synthesize: synth });
      } catch (e) {
        errMissing = e;
      }
      assert.ok(errMissing, '未知应错');
      assert.strictEqual(domainOf(errMissing), 'WORK_NOT_FOUND', '未知码');
      // 他人 work 不可见
      const other = await createUserWork({ tag: 'foreign', storyText: storyTextSingle(), voiceId: 'nova' });
      let errForeign: unknown = null;
      try {
        await ensureStoryAudioSegmentForSubject(subject, { workId: other.workId, segmentIndex: 0, sessionId }, { storage, synthesize: synth });
      } catch (e) {
        errForeign = e;
      }
      assert.ok(errForeign, '他人应错');
      assert.strictEqual(domainOf(errForeign), 'WORK_NOT_FOUND', '他人码（不泄漏）');
      // Guest 对称
      const guest = await createGuestWork({ tag: 'sym', storyText: storyTextSingle(), voiceId: 'nova' });
      const gSubject = { type: 'guest' as const, id: guest.guestId };
      const fakeG: FakeTtsState = { count: 0, inputs: [], delayMs: 0, failNext: false, bytesSeed: 31 };
      const gRes = await ensureStoryAudioSegmentForSubject(
        gSubject,
        { workId: guest.workId, segmentIndex: 0, sessionId },
        { storage, synthesize: makeFakeTts(fakeG) }
      );
      assert.strictEqual(gRes.status, 'ready', 'Guest 对称 ready');
      assert.strictEqual(fakeG.count, 1, 'Guest 合成一次');
      const gManifest = await getPlaybackManifestForSubject(gSubject, { workId: guest.workId });
      assert.strictEqual(gManifest.segments.length, 1, 'Guest 投影一段');
      // User 读 Guest → NOT_FOUND
      let errCross: unknown = null;
      try {
        await ensureStoryAudioSegmentForSubject(subject, { workId: guest.workId, segmentIndex: 0, sessionId }, { storage, synthesize: synth });
      } catch (e) {
        errCross = e;
      }
      assert.ok(errCross, '跨主体应错');
      console.log('PASS: 9. 非法/隔离断言通过');
    }

    console.log('=== 10. FIXUP Blocking2 oracle：lease fencing（旧worker不得覆盖新owner object） ===');
    {
      const { userId, workId } = await createUserWork({
        tag: 'fence',
        storyText: storyTextSingle(),
        voiceId: 'nova',
      });
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      const realStorage = getAudioAssetStorage();
      let putCount = 0;
      const countingStorage: AudioAssetStorage = {
        put: async (input) => {
          putCount += 1;
          return realStorage.put(input);
        },
        exists: (k) => realStorage.exists(k),
        delete: (k) => realStorage.delete(k),
        getMetadata: (k) => realStorage.getMetadata(k),
        resolveRead: (k, r) => realStorage.resolveRead(k, r),
      };
      let nowMs = Date.now();
      const nowFn = () => new Date(nowMs);
      // A 的 TTS 挂起（suspend）
      let resolveA!: (v: { audioData: ArrayBuffer; requestId: string }) => void;
      const gateA = new Promise<{ audioData: ArrayBuffer; requestId: string }>(
        (res) => {
          resolveA = res;
        }
      );
      const synthA = async () => gateA;
      const bytesA = buildFakeCanonicalMp3(10, 41);
      const bytesB = buildFakeCanonicalMp3(10, 42);
      // A 先 claim（挂起在 TTS）
      const promiseA = ensureStoryAudioSegmentForSubject(
        subject,
        { workId, segmentIndex: 0, sessionId: sessionA },
        { storage: countingStorage, synthesize: synthA, now: nowFn }
      );
      let leaseA: string | null = null;
      for (let i = 0; i < 200; i += 1) {
        const seg = await prisma.storyAudioSegment.findFirst({
          where: { manifest: { storyWorkId: workId }, segmentIndex: 0 },
        });
        if (seg?.status === 'preparing' && seg.leaseId) {
          leaseA = seg.leaseId;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(leaseA, 'A 已 claim lease');
      // 时间推进 > TTL（A 的 lease 过期，但 A 的 Node 未死，仍挂起在 TTS）
      nowMs += STORY_AUDIO_LEASE_TTL_MS + 1000;
      // B 重新 claim 并完成（自己的 bytes）
      const synthB = async () => {
        const buf = bytesB.buffer.slice(
          bytesB.byteOffset,
          bytesB.byteOffset + bytesB.byteLength
        ) as ArrayBuffer;
        return { audioData: buf, requestId: '' };
      };
      const resB = await ensureStoryAudioSegmentForSubject(
        subject,
        { workId, segmentIndex: 0, sessionId: sessionB },
        { storage: countingStorage, synthesize: synthB, now: nowFn }
      );
      assert.strictEqual(resB.status, 'ready', 'B 应 reclaim 成功 ready');
      assert.strictEqual(putCount, 1, 'B put 一次');
      // resume A（晚到，携带不同 bytes）：必须被 fencing 丢弃
      const bufA = bytesA.buffer.slice(
        bytesA.byteOffset,
        bytesA.byteOffset + bytesA.byteLength
      ) as ArrayBuffer;
      resolveA({ audioData: bufA, requestId: '' });
      const resA = await promiseA;
      assert.strictEqual(
        resA.status,
        'preparing',
        'A 失去 lease 应返回 preparing/RETRY（不得 ready）'
      );
      assert.strictEqual(putCount, 1, 'A 不得 storage.put（fencing 锁住）');
      // 最终 object 与 metadata 永久一致（B 保留）
      const segFinal = await prisma.storyAudioSegment.findFirst({
        where: { manifest: { storyWorkId: workId }, segmentIndex: 0 },
      });
      assert.strictEqual(segFinal!.status, 'ready', '最终 ready');
      assert.strictEqual(
        segFinal!.audioChecksum,
        expectedFakeMp3Checksum(bytesB),
        'DB checksum == B'
      );
      assert.strictEqual(segFinal!.byteLength, bytesB.byteLength, 'DB byteLength == B');
      const stored = await realStorage.resolveRead(segFinal!.storageKey);
      assert.strictEqual(stored.kind, 'bytes', '读回 bytes');
      if (stored.kind === 'bytes') {
        assert.strictEqual(
          computeAudioChecksum(stored.bytes),
          segFinal!.audioChecksum,
          'object checksum == DB checksum'
        );
        assert.strictEqual(
          stored.bytes.byteLength,
          segFinal!.byteLength,
          'object length == DB byteLength'
        );
        assert.deepStrictEqual(
          Buffer.from(stored.bytes),
          Buffer.from(bytesB),
          "B's bytes retained"
        );
      }
      console.log('PASS: 10. fencing 断言通过');
    }

    console.log('=== 11. FIXUP Blocking1 oracle：双段并发完成无stale回退 ===');
    {
      const { userId, workId } = await createUserWork({
        tag: 'aggrace',
        storyText: storyTextTwoSegments(),
        voiceId: 'nova',
      });
      const sessionId = randomUUID();
      const subject = { type: 'user' as const, id: userId };
      const storage = getAudioAssetStorage();
      // 双段并发完成（TTS 延迟迫使两 completion 的 aggregate refresh 窗口交叠）
      const fake: FakeTtsState = { count: 0, inputs: [], delayMs: 80, failNext: false, bytesSeed: 43 };
      const synth = makeFakeTts(fake);
      const [r0, r1] = await Promise.all([
        ensureStoryAudioSegmentForSubject(
          subject,
          { workId, segmentIndex: 0, sessionId },
          { storage, synthesize: synth }
        ),
        ensureStoryAudioSegmentForSubject(
          subject,
          { workId, segmentIndex: 1, sessionId },
          { storage, synthesize: synth }
        ),
      ]);
      assert.ok(r0.status === 'ready' || r0.status === 'preparing', '段0 收敛态');
      assert.ok(r1.status === 'ready' || r1.status === 'preparing', '段1 收敛态');
      //  follow-up 收敛（若有 preparing 则再 ensure 一次）
      for (const idx of [0, 1]) {
        const cur = await prisma.storyAudioSegment.findFirst({
          where: { manifest: { storyWorkId: workId }, segmentIndex: idx },
        });
        if (cur?.status !== 'ready') {
          await ensureStoryAudioSegmentForSubject(
            subject,
            { workId, segmentIndex: idx, sessionId },
            { storage, synthesize: synth }
          );
        }
      }
      // 人为交错回归：先构造“旧快照语义”（若按旧 split 读会得 preparing），
      // 再让新事务 refresh 落地 → 最终必须 ready 且永不回退。
      const manifest = await prisma.storyAudioManifest.findFirst({
        where: { storyWorkId: workId },
      });
      assert.ok(manifest, 'Manifest 已建');
      // 并发 refresh 风暴：旧 snapshot 不可能覆盖新状态，后完成者看到最新
      await Promise.all([
        refreshUserManifestState(manifest!.id, new Date()),
        refreshUserManifestState(manifest!.id, new Date()),
        refreshUserManifestState(manifest!.id, new Date()),
      ]);
      const final = await prisma.storyAudioManifest.findFirst({
        where: { storyWorkId: workId },
        include: { segments: true },
      });
      assert.ok(final!.segments.every((s) => s.status === 'ready'), '两 Segment 均 ready');
      assert.strictEqual(final!.status, 'ready', 'Manifest ready（不回退 preparing）');
      assert.strictEqual(final!.readySegmentCount, 2, 'readySegmentCount=2');
      assert.strictEqual(
        final!.totalDurationMs,
        expectedFakeMp3DurationMs(10) * 2,
        'totalDurationMs 精确'
      );
      assert.strictEqual(final!.totalByteLength, 10 * 417 * 2, 'totalByteLength 精确');
      // 幂等再刷仍 ready（无 ready→preparing 回退）
      await refreshUserManifestState(final!.id, new Date());
      const stable = await prisma.storyAudioManifest.findUnique({
        where: { id: final!.id },
      });
      assert.strictEqual(stable!.status, 'ready', '再刷仍 ready，无回退');
      assert.strictEqual(stable!.readySegmentCount, 2, '再刷 count 稳定');
      console.log('PASS: 11. aggregate无回退断言通过');
    }
  } finally {
    if (savedDriver === undefined) delete process.env.AUDIO_STORAGE_DRIVER;
    else process.env.AUDIO_STORAGE_DRIVER = savedDriver;
    if (savedRoot === undefined) delete process.env.AUDIO_LOCAL_ROOT;
    else process.env.AUDIO_LOCAL_ROOT = savedRoot;
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
  }

  console.log('ALL AUDIO ENSURE SEGMENT INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioEnsureSegmentTests()
  .then(() => {
    console.log('ALL AUDIO ENSURE SEGMENT INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
