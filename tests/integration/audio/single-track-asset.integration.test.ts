/**
 * T3 L1/L2 行为级 oracle：StoryAudio 单轨资产（一 Work 一 timeline）与 30 天滑动缓存。
 *
 * 在基线（未实现单轨）上，`SINGLE_TRACK_AUDIO_ENABLED=1` 被忽略：
 * ensure 只物化 segment 0、投影仍暴露 N 个 segment、无 TTL/重组。
 * 本套件进入真实 server service（真实 Prisma + 真实 storage + fake TTS），
 * 逐条断言单轨契约，因此旧行为成立时必然失败（行为级 RED）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../../lib/db';
import {
  getAudioAssetStorage,
  resetAudioAssetStorageForTests,
} from '../../../lib/audio/storage/index';
import { getMp3DurationMs } from '../../../lib/audio/duration';
import { computeAudioChecksum } from '../../../lib/audio/checksum';
import {
  buildFakeCanonicalMp3,
  expectedFakeMp3DurationMs,
} from '../../../tests/support/fixtures/fake-canonical-mp3';
import {
  ensureStoryAudioSegmentForSubject,
  getPlaybackManifestForSubject,
} from '../../../lib/server/storyAudio';
import {
  __resetStoryAudioAssetTestHooks,
  ensureStoryAudioAssetForSubject,
  getStoryAudioAssetProjectionForSubject,
  saveStoryAudioProgressForSubject,
} from '../../../lib/server/storyAudioAsset';
import { resetCache } from '../../../lib/server/openai';
import { computeStoryContentHash } from '../../../utils/segmentation';

const DAY_MS = 24 * 60 * 60 * 1000;

type FakeTtsState = {
  count: number;
  texts: string[];
  failOnCall: number | null;
};

function makeFakeTts(state: FakeTtsState) {
  return async (input: {
    text: string;
    model: string;
    voiceId: string;
    speed: number;
    format: string;
  }) => {
    state.count += 1;
    state.texts.push(input.text);
    if (state.failOnCall !== null && state.count === state.failOnCall) {
      state.failOnCall = null;
      throw new Error('fake tts boom');
    }
    const bytes = buildFakeCanonicalMp3(10, state.count);
    return {
      audioData: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      requestId: '',
    };
  };
}

function longStoryText(): string {
  return (
    '很久很久以前，山谷里住着一位会讲故事的老人，他的每一句话都能变成一段旋律。'.repeat(12)
  );
}

async function createUserWork(storyText: string): Promise<{ userId: number; workId: number }> {
  const user = await prisma.user.create({
    data: {
      username: `t3_single_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      password: 'TestPassword123!',
      nickname: 'T3',
    },
  });
  const work = await prisma.storyWork.create({
    data: {
      userId: user.id,
      prompt: '测试提示词',
      storyText,
      voiceId: 'nova',
      title: '单轨测试作品',
      excerpt: '摘要',
      contentHash: computeStoryContentHash(storyText),
    },
  });
  return { userId: user.id, workId: work.id };
}

const failures: string[] = [];
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS: ${name}`);
  } else {
    console.log(`RED : ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

async function main(): Promise<void> {
  const savedEnv = {
    single: process.env.SINGLE_TRACK_AUDIO_ENABLED,
    publicSingle: process.env.NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED,
    driver: process.env.AUDIO_STORAGE_DRIVER,
    root: process.env.AUDIO_LOCAL_ROOT,
    voiceList: process.env.OPENAI_TTS_VOICE_LIST,
    defaultVoice: process.env.OPENAI_TTS_DEFAULT_VOICE,
    model: process.env.OPENAI_TTS_MODEL,
    backend: process.env.TTS_BACKEND_ID,
  };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't3-single-track-'));
  process.env.SINGLE_TRACK_AUDIO_ENABLED = '1';
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
    const storage = getAudioAssetStorage();
    const sessionId = randomUUID();
    const storyText = longStoryText();
    const { userId, workId } = await createUserWork(storyText);
    const subject = { type: 'user' as const, id: userId };

    // ---- 1. 单资产发布：ensure 一次只发布一个 Asset，内部 chunk 数 >= 2 ----
    const tts1: FakeTtsState = { count: 0, texts: [], failOnCall: null };
    const ensured = await ensureStoryAudioAssetForSubject(
      subject,
      { workId, sessionId },
      { storage, synthesize: makeFakeTts(tts1) },
    );
    const ensuredAsset = (ensured as unknown as { asset?: Record<string, unknown> }).asset;
    check('1a ensure 暴露单轨 asset 投影', ensuredAsset !== undefined);
    check(
      '1b 单轨 ensure 不再返回逐 segment manifest（一个 asset 单元）',
      (ensured as unknown as { manifest?: unknown }).manifest === undefined,
      `manifest=${JSON.stringify((ensured as unknown as { manifest?: unknown }).manifest)}`,
    );
    const chunkCount = Number(ensuredAsset?.chunkCount ?? -1);
    check('1c 长文被内部拆为多个 chunk 后合并为一个 asset', chunkCount >= 2, `chunkCount=${chunkCount}`);
    check(
      '1d 合成次数等于内部 chunk 数（整篇一次物化，非仅首段）',
      tts1.count === chunkCount && chunkCount >= 2,
      `tts=${tts1.count} chunks=${chunkCount}`,
    );
    const assetId = String(ensuredAsset?.assetId ?? '');
    const publishedKey = `story-audio/${assetId}.mp3`;
    check('1e 只发布一个 canonical 对象', assetId.length > 0 && (await storage.exists(publishedKey)));
    let published: Uint8Array<ArrayBufferLike> = new Uint8Array();
    if (assetId.length > 0 && (await storage.exists(publishedKey))) {
      const read = await storage.resolveRead(publishedKey);
      if (read.kind === 'bytes') published = read.bytes;
    }
    let publishedDuration = -1;
    try {
      publishedDuration = published.length > 0 ? getMp3DurationMs(published) : -1;
    } catch {
      publishedDuration = -1;
    }
    const expectedDuration = expectedFakeMp3DurationMs(10) * chunkCount;
    check(
      '1f 总时长等于拼接后整轨时长',
      publishedDuration > 0 &&
        publishedDuration === Number(ensuredAsset?.durationMs) &&
        Math.abs(publishedDuration - expectedDuration) <= chunkCount,
      `actual=${publishedDuration} asset=${ensuredAsset?.durationMs} chunkSum=${expectedDuration}`,
    );
    check(
      '1g 单对象 checksum 覆盖拼接后字节',
      published.length > 0 && computeAudioChecksum(published) === String(ensuredAsset?.checksum ?? ''),
    );

    // ---- 2. 一个 Work 一 timeline：投影只暴露一个授权 URL ----
    const manifest = await getPlaybackManifestForSubject(subject, { workId });
    const single = (manifest as unknown as { singleTrack?: Record<string, unknown> }).singleTrack;
    check('2a 投影暴露 singleTrack', single !== undefined);
    check('2b 投影不再暴露多 segment 播放项', manifest.segments.length === 0, `segments=${manifest.segments.length}`);
    const authorizedUrls = [
      ...(single ? [String(single.playbackUrl ?? '')] : []),
      ...manifest.segments.map((s) => s.playbackUrl ?? ''),
    ].filter((u) => u.length > 0);
    check('2c 任意正文只暴露一个授权 Asset URL', authorizedUrls.length === 1, `urls=${authorizedUrls.length}`);
    check(
      '2d 授权 URL 指向单资产读取路由',
      authorizedUrls[0] === `/api/audio/assets/${assetId}`,
      authorizedUrls[0],
    );
    check(
      '2e 投影总时长与单资产一致',
      manifest.totalDurationMs === publishedDuration && publishedDuration > 0,
      `actual=${manifest.totalDurationMs} published=${publishedDuration}`,
    );
    check('2f 进度默认从 0 开始（positionMs 投影）', Number(single?.positionMs ?? -1) >= 0);

    // ---- 3. 暂停恢复/重播不重复 TTS（30 天内复用） ----
    const tts2: FakeTtsState = { count: 0, texts: [], failOnCall: null };
    const t29 = new Date(Date.now() + 29 * DAY_MS);
    const reused = await ensureStoryAudioAssetForSubject(
      subject,
      { workId, sessionId },
      { storage, synthesize: makeFakeTts(tts2), now: () => t29 },
    );
    check('3a 29 天内命中同一 Asset（不重建）', (reused as unknown as { asset?: { assetId?: string } }).asset?.assetId === assetId);
    check('3b 命中复用不产生新 TTS', tts2.count === 0, `tts=${tts2.count}`);

    // ---- 4. 30 天滑动 TTL：29 天访问已把锚点滑到 D29，故 D31 仍复用、D60 才重建 ----
    const ttsSlide: FakeTtsState = { count: 0, texts: [], failOnCall: null };
    const t31 = new Date(Date.now() + 31 * DAY_MS);
    await ensureStoryAudioAssetForSubject(
      subject,
      { workId, sessionId },
      { storage, synthesize: makeFakeTts(ttsSlide), now: () => t31 },
    );
    check('4a 距上次访问不足 30 天不重建（滑动 TTL）', ttsSlide.count === 0, `tts=${ttsSlide.count}`);
    const tts3: FakeTtsState = { count: 0, texts: [], failOnCall: null };
    const t60 = new Date(t31.getTime() + 31 * DAY_MS);
    const rebuilt = await ensureStoryAudioAssetForSubject(
      subject,
      { workId, sessionId },
      { storage, synthesize: makeFakeTts(tts3), now: () => t60 },
    );
    const rebuiltAsset = (rebuilt as unknown as { asset?: { assetId?: string; chunkCount?: number } }).asset;
    check('4b 超过 30 天必须重建（重新 TTS 整篇）', tts3.count === chunkCount && chunkCount >= 2, `tts=${tts3.count}`);
    check('4c 重建后仍是单轨 asset', rebuiltAsset?.chunkCount === chunkCount);

    // ---- 5. chunk 失败 → 整个 Asset failed + 临时对象清理 ----
    const { userId: userId2, workId: workId2 } = await createUserWork(storyText);
    const subject2 = { type: 'user' as const, id: userId2 };
    const ttsFail: FakeTtsState = { count: 0, texts: [], failOnCall: 2 };
    let failedStatus = '';
    try {
      await ensureStoryAudioAssetForSubject(
        subject2,
        { workId: workId2, sessionId },
        { storage, synthesize: makeFakeTts(ttsFail) },
      );
      failedStatus = 'ready';
    } catch {
      failedStatus = 'failed';
    }
    check('5a chunk 失败使整个 Asset 失败', failedStatus === 'failed');
    const orphanChunkKeys = (await listChunkKeys(storage)).filter((k) => k.includes('/chunks/'));
    check('5b 失败后不留临时 chunk 对象', orphanChunkKeys.length === 0, `orphans=${orphanChunkKeys.length}`);

    // ---- 6. 并发 single-flight：整篇只被合成一次 ----
    const { userId: userId3, workId: workId3 } = await createUserWork(storyText);
    const subject3 = { type: 'user' as const, id: userId3 };
    const ttsRace: FakeTtsState = { count: 0, texts: [], failOnCall: null };
    const raceResults = await Promise.all(
      [0, 1, 2].map(() =>
        ensureStoryAudioAssetForSubject(
          subject3,
          { workId: workId3, sessionId },
          { storage, synthesize: makeFakeTts(ttsRace) },
        ),
      ),
    );
    check('6a 并发 ensure 只合成整篇一次', ttsRace.count === chunkCount && chunkCount >= 2, `tts=${ttsRace.count}`);
    const raceAssetIds = new Set(
      raceResults.map((r) => (r as unknown as { asset?: { assetId?: string } }).asset?.assetId),
    );
    check('6b 并发只发布一个 Asset identity', raceAssetIds.size === 1 && !raceAssetIds.has(undefined));

    // ---- 7. 开关回退：关闭时旧 Segment 路径原样保留（旧 Segment 不物理删除） ----
    process.env.SINGLE_TRACK_AUDIO_ENABLED = '0';
    const { userId: userIdOff, workId: workIdOff } = await createUserWork(storyText);
    const subjectOff = { type: 'user' as const, id: userIdOff };
    const ttsOff: FakeTtsState = { count: 0, texts: [], failOnCall: null };
    const legacy = await ensureStoryAudioSegmentForSubject(
      subjectOff,
      { workId: workIdOff, segmentIndex: 0, sessionId },
      { storage, synthesize: makeFakeTts(ttsOff) },
    );
    check(
      '7a 开关关闭时 ensure 不暴露单轨 asset',
      (legacy as unknown as { asset?: unknown }).asset === undefined,
    );
    check(
      '7b 开关关闭时仍走旧逐段路径（仅首段 TTS）',
      (legacy as unknown as { manifest?: { segmentCount?: number } }).manifest?.segmentCount !== 1 &&
        ttsOff.count === 1,
      `segmentCount=${(legacy as unknown as { manifest?: { segmentCount?: number } }).manifest?.segmentCount} tts=${ttsOff.count}`,
    );
    const legacyManifest = await getPlaybackManifestForSubject(subjectOff, { workId: workIdOff });
    check('7c 开关关闭时投影无 singleTrack', (legacyManifest as unknown as { singleTrack?: unknown }).singleTrack === undefined);
    check('7d 开关关闭时旧 Segment 投影仍可读', legacyManifest.segments.length > 0, `segments=${legacyManifest.segments.length}`);
    process.env.SINGLE_TRACK_AUDIO_ENABLED = '1';

    // ---- 8. 内部 chunk 不可通过资产读取服务授权 ----
    const readModule = await import('../../../lib/server/audioAssetRead');
    let chunkReadStatus = 0;
    try {
      await readModule.resolveReadableAudioAssetForSubject(
        subject,
        `story-audio/chunks/${assetId}/0.mp3`,
      );
    } catch (err) {
      chunkReadStatus = (err as { httpStatus?: number }).httpStatus ?? 0;
    }
    check('8a 内部 chunk key 作为 assetId 一律 404', chunkReadStatus === 404, `status=${chunkReadStatus}`);
    const readable = await readModule.resolveReadableAudioAssetForSubject(subject, assetId);
    check('8b 授权 assetId 可解析到存储对象', readable.storageKey === publishedKey);
    let crossUserStatus = 0;
    try {
      await readModule.resolveReadableAudioAssetForSubject({ type: 'user', id: userIdOff }, assetId);
    } catch (err) {
      crossUserStatus = (err as { httpStatus?: number }).httpStatus ?? 0;
    }
    check('8c 跨主体读取被拒（403）', crossUserStatus === 403, `status=${crossUserStatus}`);

    // ---- 9. 服务端 flag 门禁：关闭即拒绝单轨写/读/进度（不产生单轨流量） ----
    process.env.SINGLE_TRACK_AUDIO_ENABLED = '0';
    const { userId: userIdDisabled, workId: workIdDisabled } = await createUserWork(storyText);
    const subjectDisabled = { type: 'user' as const, id: userIdDisabled };
    let disabledEnsureMessage = '';
    try {
      await ensureStoryAudioAssetForSubject(
        subjectDisabled,
        { workId: workIdDisabled, sessionId },
        { storage, synthesize: makeFakeTts({ count: 0, texts: [], failOnCall: null }) },
      );
      disabledEnsureMessage = 'no-throw';
    } catch (err) {
      disabledEnsureMessage = err instanceof Error ? err.message : String(err);
    }
    check(
      '9a flag 关闭时 ensure 被拒（不产生单轨流量）',
      disabledEnsureMessage === 'SINGLE_TRACK_AUDIO_DISABLED',
      disabledEnsureMessage,
    );
    const disabledRows = await prisma.storyAudioAsset.count({
      where: { storyWorkId: workIdDisabled },
    });
    check('9b flag 关闭时 ensure 不落任何资产行', disabledRows === 0, `rows=${disabledRows}`);
    let disabledProjectionMessage = '';
    try {
      await getStoryAudioAssetProjectionForSubject(subjectDisabled, { workId: workIdDisabled });
      disabledProjectionMessage = 'no-throw';
    } catch (err) {
      disabledProjectionMessage = err instanceof Error ? err.message : String(err);
    }
    check(
      '9c flag 关闭时投影读取被拒',
      disabledProjectionMessage === 'SINGLE_TRACK_AUDIO_DISABLED',
      disabledProjectionMessage,
    );
    let disabledProgressMessage = '';
    try {
      await saveStoryAudioProgressForSubject(subjectDisabled, {
        workId: workIdDisabled,
        sessionId,
        positionMs: 1000,
        durationMs: 5000,
        force: true,
      });
      disabledProgressMessage = 'no-throw';
    } catch (err) {
      disabledProgressMessage = err instanceof Error ? err.message : String(err);
    }
    check(
      '9d flag 关闭时进度写入被拒',
      disabledProgressMessage === 'SINGLE_TRACK_AUDIO_DISABLED',
      disabledProgressMessage,
    );
    let disabledReadStatus = 0;
    try {
      await readModule.resolveReadableAudioAssetForSubject(subject, assetId);
    } catch (err) {
      disabledReadStatus = (err as { httpStatus?: number }).httpStatus ?? 0;
    }
    check('9e flag 关闭时资产读取路由 404（无单轨流量）', disabledReadStatus === 404, `status=${disabledReadStatus}`);

    // ---- 9f: 仅公开变量（NEXT_PUBLIC_*=1）不得开启服务端单轨路径 ----
    // 服务端授权只认运行时 SINGLE_TRACK_AUDIO_ENABLED；公开变量可被构建期内联/
    // 客户端可见，不能充当服务端授权依据。此处删除运行时变量、只置公开变量。
    delete process.env.SINGLE_TRACK_AUDIO_ENABLED;
    process.env.NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED = '1';
    try {
      let publicEnsureMessage = '';
      try {
        await ensureStoryAudioAssetForSubject(
          subjectDisabled,
          { workId: workIdDisabled, sessionId },
          { storage, synthesize: makeFakeTts({ count: 0, texts: [], failOnCall: null }) },
        );
        publicEnsureMessage = 'no-throw';
      } catch (err) {
        publicEnsureMessage = err instanceof Error ? err.message : String(err);
      }
      check(
        '9f 仅公开变量时 ensure 仍被拒（服务端只认运行时 flag）',
        publicEnsureMessage === 'SINGLE_TRACK_AUDIO_DISABLED',
        publicEnsureMessage,
      );
      let publicProjectionMessage = '';
      try {
        await getStoryAudioAssetProjectionForSubject(subjectDisabled, { workId: workIdDisabled });
        publicProjectionMessage = 'no-throw';
      } catch (err) {
        publicProjectionMessage = err instanceof Error ? err.message : String(err);
      }
      check(
        '9g 仅公开变量时投影读取仍被拒',
        publicProjectionMessage === 'SINGLE_TRACK_AUDIO_DISABLED',
        publicProjectionMessage,
      );
      let publicProgressMessage = '';
      try {
        await saveStoryAudioProgressForSubject(subjectDisabled, {
          workId: workIdDisabled,
          sessionId,
          positionMs: 1000,
          durationMs: 5000,
          force: true,
        });
        publicProgressMessage = 'no-throw';
      } catch (err) {
        publicProgressMessage = err instanceof Error ? err.message : String(err);
      }
      check(
        '9h 仅公开变量时进度写入仍被拒',
        publicProgressMessage === 'SINGLE_TRACK_AUDIO_DISABLED',
        publicProgressMessage,
      );
      let publicReadStatus = 0;
      try {
        await readModule.resolveReadableAudioAssetForSubject(subject, assetId);
      } catch (err) {
        publicReadStatus = (err as { httpStatus?: number }).httpStatus ?? 0;
      }
      check('9i 仅公开变量时资产读取路由仍 404', publicReadStatus === 404, `status=${publicReadStatus}`);
      const publicRows = await prisma.storyAudioAsset.count({
        where: { storyWorkId: workIdDisabled },
      });
      check('9j 仅公开变量时不落任何资产行', publicRows === 0, `rows=${publicRows}`);
    } finally {
      delete process.env.NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED;
    }
    process.env.SINGLE_TRACK_AUDIO_ENABLED = '1';

    // ---- 10. ensureSegment 不再是单轨入口（旧多段路径不被单轨 flag 劫持） ----
    const { userId: userIdSeg, workId: workIdSeg } = await createUserWork(storyText);
    const subjectSeg = { type: 'user' as const, id: userIdSeg };
    const ttsSeg: FakeTtsState = { count: 0, texts: [], failOnCall: null };
    const segResult = await ensureStoryAudioSegmentForSubject(
      subjectSeg,
      { workId: workIdSeg, segmentIndex: 0, sessionId },
      { storage, synthesize: makeFakeTts(ttsSeg) },
    );
    check(
      '10a flag 开启时 ensureSegment 仍走旧多段路径（不暴露单轨 asset）',
      (segResult as unknown as { asset?: unknown }).asset === undefined,
    );

    // ---- 11. 生产 GC 触发器 + 「正在播放」守卫（30 天滑动） ----
    const { userId: userIdIdle, workId: workIdIdle } = await createUserWork(storyText);
    const { userId: userIdPlaying, workId: workIdPlaying } = await createUserWork(storyText);
    const subjectIdle = { type: 'user' as const, id: userIdIdle };
    const subjectPlaying = { type: 'user' as const, id: userIdPlaying };
    const past = new Date(Date.now() - 40 * DAY_MS);
    const idleAsset = (
      (await ensureStoryAudioAssetForSubject(
        subjectIdle,
        { workId: workIdIdle, sessionId },
        { storage, synthesize: makeFakeTts({ count: 0, texts: [], failOnCall: null }), now: () => past },
      )) as unknown as { asset?: { assetId?: string } }
    ).asset;
    const playingAsset = (
      (await ensureStoryAudioAssetForSubject(
        subjectPlaying,
        { workId: workIdPlaying, sessionId },
        { storage, synthesize: makeFakeTts({ count: 0, texts: [], failOnCall: null }), now: () => past },
      )) as unknown as { asset?: { assetId?: string } }
    ).asset;
    const idleKey = `story-audio/${String(idleAsset?.assetId ?? '')}.mp3`;
    const playingKey = `story-audio/${String(playingAsset?.assetId ?? '')}.mp3`;
    await saveStoryAudioProgressForSubject(subjectPlaying, {
      workId: workIdPlaying,
      sessionId,
      positionMs: 1200,
      durationMs: 5000,
      force: true,
    });
    const { userId: userIdTrigger, workId: workIdTrigger } = await createUserWork(storyText);
    __resetStoryAudioAssetTestHooks();
    await ensureStoryAudioAssetForSubject(
      { type: 'user' as const, id: userIdTrigger },
      { workId: workIdTrigger, sessionId },
      { storage, synthesize: makeFakeTts({ count: 0, texts: [], failOnCall: null }) },
    );
    check(
      '11a ensure 机会式触发：过期且空闲的资产对象被清理',
      !(await storage.exists(idleKey)),
    );
    check(
      '11b 正在播放（近期进度）的过期资产被跳过保留',
      await storage.exists(playingKey),
    );

  } finally {
    if (savedEnv.single === undefined) delete process.env.SINGLE_TRACK_AUDIO_ENABLED;
    else process.env.SINGLE_TRACK_AUDIO_ENABLED = savedEnv.single;
    if (savedEnv.publicSingle === undefined) delete process.env.NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED;
    else process.env.NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED = savedEnv.publicSingle;
    if (savedEnv.driver === undefined) delete process.env.AUDIO_STORAGE_DRIVER;
    else process.env.AUDIO_STORAGE_DRIVER = savedEnv.driver;
    if (savedEnv.root === undefined) delete process.env.AUDIO_LOCAL_ROOT;
    else process.env.AUDIO_LOCAL_ROOT = savedEnv.root;
    if (savedEnv.voiceList === undefined) delete process.env.OPENAI_TTS_VOICE_LIST;
    else process.env.OPENAI_TTS_VOICE_LIST = savedEnv.voiceList;
    if (savedEnv.defaultVoice === undefined) delete process.env.OPENAI_TTS_DEFAULT_VOICE;
    else process.env.OPENAI_TTS_DEFAULT_VOICE = savedEnv.defaultVoice;
    if (savedEnv.model === undefined) delete process.env.OPENAI_TTS_MODEL;
    else process.env.OPENAI_TTS_MODEL = savedEnv.model;
    if (savedEnv.backend === undefined) delete process.env.TTS_BACKEND_ID;
    else process.env.TTS_BACKEND_ID = savedEnv.backend;
    resetCache();
    resetAudioAssetStorageForTests();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`T3_SINGLE_TRACK_SUMMARY failures=${failures.length} [${failures.join(' | ')}]`);
  if (failures.length > 0) {
    process.exitCode = 1;
  } else {
    console.log('ALL T3 SINGLE TRACK TESTS PASSED SUCCESSFULLY');
  }
}

/** 列出本地存储根下所有对象 key（仅测试用；local driver 目录结构 = key 路径）。 */
async function listChunkKeys(storage: ReturnType<typeof getAudioAssetStorage>): Promise<string[]> {
  const root = process.env.AUDIO_LOCAL_ROOT ?? '';
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  void storage;
  await walk(root);
  return out;
}

const testPromise = main().catch((err) => {
  console.error('T3 single track test crashed:', err);
  process.exit(1);
});

export default testPromise;
