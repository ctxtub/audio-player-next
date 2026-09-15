/**
 * M9-C1 T3 单轨资产纯领域单测（L1）：identity / chunk 计划 / 校验 / 拼接 /
 * 30 天滑动 TTL / positionMs clamp 与节流 / feature flag。
 * 纯函数，无 DB、无 TTS、无 storage；不导入 lib/db（unit 层硬约束）。
 */
import assert from 'node:assert';
import {
  buildAssetChunkStorageKey,
  buildAssetStorageKey,
  buildAssetPlaybackUrl,
  clampPositionMs,
  computeAssetIdentityKey,
  computeTtsProfileHash,
  concatAudioChunks,
  isInternalChunkStorageKey,
  isSameAssetIdentity,
  isSingleTrackAssetExpired,
  isValidChunkPlan,
  planAssetTextChunks,
  shouldPersistPosition,
  shouldRefreshLastAccess,
  validateChunkAudio,
} from '../../../lib/audio/asset';
import { buildAssetIdentity } from '../../../lib/audio/asset';
import {
  isSingleTrackAudioEnabled,
  isSingleTrackServerEnabled,
} from '../../../lib/audio/singleTrackFlag';
import { getMp3DurationMs } from '../../../lib/audio/duration';
import {
  buildFakeCanonicalMp3,
  expectedFakeMp3DurationMs,
} from '../../support/fixtures/fake-canonical-mp3';
import type { CanonicalAudioProfile } from '../../../lib/audio/profile';

const DAY_MS = 24 * 60 * 60 * 1000;

const PROFILE: CanonicalAudioProfile = {
  voiceId: 'nova',
  ttsBackendId: 'openai',
  ttsModel: 'model-A',
  synthesisVersion: 'canonical-mp3-v1',
  synthesisSpeed: 1.0,
  audioFormat: 'mp3',
};

function runStoryAudioAssetDomainUnitTests(): void {
  console.log('=== 1. identity 稳定/顺序/相等 ===');
  {
    const a = buildAssetIdentity({ contentHash: 'h1' }, PROFILE);
    const b = buildAssetIdentity({ contentHash: 'h1' }, PROFILE);
    assert.strictEqual(computeAssetIdentityKey(a), computeAssetIdentityKey(b), '同输入 key 稳定');
    assert.ok(isSameAssetIdentity(a, b), '同输入 identity 相等');
    const changed = buildAssetIdentity({ contentHash: 'h2' }, PROFILE);
    assert.ok(!isSameAssetIdentity(a, changed), 'contentHash 变化 → 不相等');
    const changedVoice = buildAssetIdentity({ contentHash: 'h1' }, { ...PROFILE, voiceId: 'alloy' });
    assert.ok(!isSameAssetIdentity(a, changedVoice), 'voice 变化 → 不相等');
    assert.strictEqual(computeTtsProfileHash(PROFILE), computeTtsProfileHash({ ...PROFILE }), 'profile hash 稳定');
    console.log('PASS: identity');
  }

  console.log('=== 2. chunk 计划：守恒 + 多 chunk + 硬切 ===');
  {
    const text = '第一句话。第二句话！第三句话？第四句话。'.repeat(12);
    const chunks = planAssetTextChunks(text);
    assert.ok(chunks.length >= 2, '长文切成多 chunk');
    assert.ok(isValidChunkPlan(text, chunks), 'join 守恒');
    assert.ok(chunks.every((c) => c.length <= 180), 'chunk 不超上限');
    const hard = '甲'.repeat(500);
    const hardChunks = planAssetTextChunks(hard, 100);
    assert.strictEqual(hardChunks.length, 5, '超长单句按上限硬切');
    assert.strictEqual(hardChunks.join(''), hard, '硬切仍守恒');
    assert.deepStrictEqual(planAssetTextChunks(''), [], '空正文 → 空计划');
    assert.ok(!isValidChunkPlan(text, []), '空计划非法');
    console.log('PASS: chunk plan');
  }

  console.log('=== 3. chunk 音频校验 ===');
  {
    const ok = validateChunkAudio(buildFakeCanonicalMp3(10, 1));
    assert.ok(ok.ok && ok.durationMs === expectedFakeMp3DurationMs(10), '合法 mp3 校验通过');
    assert.ok(!validateChunkAudio(new Uint8Array()).ok, '空字节非法');
    assert.ok(!validateChunkAudio(new Uint8Array([1, 2, 3, 4, 5])).ok, '垃圾字节非法');
    console.log('PASS: chunk validation');
  }

  console.log('=== 4. 拼接 ===');
  {
    const parts = [buildFakeCanonicalMp3(10, 1), buildFakeCanonicalMp3(10, 2), buildFakeCanonicalMp3(10, 3)];
    const merged = concatAudioChunks(parts);
    assert.strictEqual(merged.length, 30 * 417, '拼接字节数守恒（fake 帧大小 417）');
    const mergedDuration = getMp3DurationMs(merged);
    const sum = parts.reduce((acc, p) => acc + getMp3DurationMs(p), 0);
    assert.ok(Math.abs(mergedDuration - sum) <= 3, `拼接时长≈逐段和 actual=${mergedDuration} sum=${sum}`);
    assert.throws(() => concatAudioChunks([]), '空拼接抛错');
    console.log('PASS: concat');
  }

  console.log('=== 5. 30 天滑动 TTL ===');
  {
    const base = new Date('2026-01-01T00:00:00.000Z');
    assert.ok(
      !isSingleTrackAssetExpired({ readyAt: base, lastAccessedAt: null, now: new Date(base.getTime() + 29 * DAY_MS) }),
      '29 天未过期',
    );
    assert.ok(
      isSingleTrackAssetExpired({ readyAt: base, lastAccessedAt: null, now: new Date(base.getTime() + 31 * DAY_MS) }),
      '31 天过期',
    );
    assert.ok(
      !isSingleTrackAssetExpired({
        readyAt: base,
        lastAccessedAt: new Date(base.getTime() + 29 * DAY_MS),
        now: new Date(base.getTime() + 40 * DAY_MS),
      }),
      '访问后锚点滑动 → 40 天仍复用',
    );
    assert.ok(shouldRefreshLastAccess(null, base), '首次读取刷新');
    assert.ok(!shouldRefreshLastAccess(new Date(base.getTime() - 1000), base), '限频内不刷新');
    assert.ok(shouldRefreshLastAccess(new Date(base.getTime() - 2 * 60 * 60 * 1000), base), '超限频刷新');
    console.log('PASS: ttl');
  }

  console.log('=== 6. positionMs clamp 与节流/单调 ===');
  {
    assert.strictEqual(clampPositionMs(-5, 1000), 0, '负值归零');
    assert.strictEqual(clampPositionMs(5000, 1000), 1000, '超时长 clamp');
    assert.strictEqual(clampPositionMs(123.9, 1000), 123, '取整');
    assert.strictEqual(clampPositionMs(Number.NaN, 1000), 0, 'NaN 归零');
    const now = new Date('2026-01-01T00:00:10.000Z');
    assert.ok(
      !shouldPersistPosition({ positionMs: 500, previousPositionMs: 800, lastWriteAt: null, now }),
      '单调守卫拒绝回退',
    );
    assert.ok(
      shouldPersistPosition({ positionMs: 900, previousPositionMs: 800, lastWriteAt: null, now }),
      '无 lastWriteAt 应写',
    );
    assert.ok(
      !shouldPersistPosition({
        positionMs: 900,
        previousPositionMs: 800,
        lastWriteAt: new Date(now.getTime() - 5000),
        now,
      }),
      '节流内不写',
    );
    assert.ok(
      shouldPersistPosition({
        positionMs: 900,
        previousPositionMs: 800,
        lastWriteAt: new Date(now.getTime() - 5000),
        now,
        force: true,
      }),
      'force 突破节流',
    );
    console.log('PASS: progress');
  }

  console.log('=== 7. key/url 与内部 chunk 判定 ===');
  {
    assert.strictEqual(buildAssetStorageKey('abc'), 'story-audio/abc.mp3');
    assert.strictEqual(buildAssetChunkStorageKey('abc', 2), 'story-audio/chunks/abc/2.mp3');
    assert.strictEqual(buildAssetPlaybackUrl('abc'), '/api/audio/assets/abc');
    assert.ok(isInternalChunkStorageKey(buildAssetChunkStorageKey('abc', 0)), 'chunk key 判定为内部');
    assert.ok(!isInternalChunkStorageKey(buildAssetStorageKey('abc')), '发布 key 非内部');
    console.log('PASS: keys');
  }

  console.log('=== 8. feature flag（T3-r2 真去耦：server/client 各认一侧）===');
  {
    // 客户端 provider：只认公开变量（构建期内联）。
    assert.ok(
      isSingleTrackAudioEnabled({ NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED: '1' }),
      'client：公开变量 1 → on',
    );
    assert.ok(
      !isSingleTrackAudioEnabled({ SINGLE_TRACK_AUDIO_ENABLED: '1' } as Record<string, string>),
      'client：运行时变量不得开启 client provider',
    );
    assert.ok(
      !isSingleTrackAudioEnabled({ NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED: 'true' }),
      'client：非严格 1 → off',
    );
    assert.ok(!isSingleTrackAudioEnabled({}), 'client：缺席 → off');
    // 服务端授权：只认运行时变量，公开变量不得授权。
    assert.ok(
      isSingleTrackServerEnabled({ SINGLE_TRACK_AUDIO_ENABLED: '1' }),
      'server：运行时变量 1 → on',
    );
    assert.ok(
      !isSingleTrackServerEnabled({ NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED: '1' } as Record<string, string>),
      'server：仅公开变量 → off（不得授权服务端单轨）',
    );
    assert.ok(
      !isSingleTrackServerEnabled({ SINGLE_TRACK_AUDIO_ENABLED: 'true' }),
      'server：非严格 1 → off',
    );
    assert.ok(!isSingleTrackServerEnabled({}), 'server：缺席 → off');
    console.log('PASS: flag');
  }
}

const testPromise = Promise.resolve()
  .then(() => {
    runStoryAudioAssetDomainUnitTests();
    console.log('ALL STORY AUDIO ASSET DOMAIN UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
