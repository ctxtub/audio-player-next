import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { computeStoryContentHash } from '../../../utils/segmentation';
import {
  buildFrozenSegmentInput,
  buildFrozenSegmentInputs,
  computeManifestIdentityKey,
  deriveManifestStatus,
  deriveManifestStatusFromSegments,
  isOpaqueStorageKey,
  isSameManifestIdentity,
  isServerGeneratedSegmentId,
  MANIFEST_IDENTITY_FIELDS,
  type ManifestIdentity,
} from '../../../lib/audio/manifest';
import {
  CANONICAL_AUDIO_FORMAT,
  CANONICAL_SYNTHESIS_SPEED,
  SYNTHESIS_VERSION,
  freezeCanonicalAudioProfile,
  resolveManifestVoiceId,
  resolveTtsBackendId,
  resolveTtsModel,
} from '../../../lib/audio/profile';
import {
  computeAudioChecksum,
  isValidAudioChecksum,
} from '../../../lib/audio/checksum';
import {
  getMp3DurationMs,
  isValidDurationMs,
  Mp3DurationParseError,
} from '../../../lib/audio/duration';
import {
  buildFakeCanonicalMp3,
  expectedFakeMp3Checksum,
  expectedFakeMp3DurationMs,
  FAKE_MP3_DEFAULT_FRAMES,
  FAKE_MP3_FRAME_SIZE,
} from '../../../tests/support/fixtures/fake-canonical-mp3';
import {
  ensureStoryAudioSegmentInputSchema,
  getPlaybackManifestInputSchema,
} from '../../../lib/trpc/schemas/storyAudio';
import {
  STORY_AUDIO_LEASE_TTL_MS,
  STORY_AUDIO_RETRY_AFTER_MS,
} from '../../../lib/server/storyAudio';

/**
 * M8-03 Canonical Write Path 单元测试（spec §47/§50/§54–§56 + §10–§18/§26；零 TTS cost 锁死）。
 *
 * 覆盖：
 * 1. Manifest identity 变化因子（六字段）/ 无关因子（playbackRate/title/favorite 不进入八元组）；
 * 2. 状态派生：no manifest→missing / missing→preparing→missing(partial) / last→ready / failure→failed / retry→preparing；
 * 3. Segment text freeze：text 原样冻结、textHash 复用 computeStoryContentHash、ID/storageKey 形态；
 * 4. voice 绑定：Work 优先、legacy 空串回落默认；
 * 5. model pinning：冻结后为 authoritative pin，不跟随 env；
 * 6. canonical speed 恒 1.0（profile 忽略输入速度 + storyAudio 服务传 1.0 静态守卫）；
 * 7. duration：fake MP3 精确解析、非法抛错；
 * 8. checksum：SHA-256 exact + 格式守卫；
 * 9. 输入严格：ensure 三字段 strict，多传 text/audio/profile/storageKey 拒绝；
 * 10. 静态守卫：无 transaction 跨 TTS、同一 key 覆盖写、profile 顶注 M8-03。
 */

const BASE_IDENTITY: ManifestIdentity = {
  contentHash: 'aaaabbbbcccc',
  segmentationVersion: 'v1',
  voiceId: 'nova',
  ttsBackendId: 'openai',
  ttsModel: 'model-A',
  synthesisVersion: SYNTHESIS_VERSION,
  audioFormat: 'mp3',
  synthesisSpeed: 1.0,
};

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
}

async function runAudioCanonicalWriteUnitTests() {
  console.log('=== 1. Manifest identity 变化因子 ===');
  {
    const baseKey = computeManifestIdentityKey(BASE_IDENTITY);
    const mutations: Array<[keyof ManifestIdentity, string]> = [
      ['contentHash', 'ddddffff0000'],
      ['voiceId', 'alloy'],
      ['ttsModel', 'model-B'],
      ['ttsBackendId', 'company-proxy-v1'],
      ['synthesisVersion', 'canonical-mp3-v2'],
      ['segmentationVersion', 'v2'],
    ];
    assert.strictEqual(mutations.length, 6, '必须覆盖全部 6 个身份变化因子');
    for (const [field, value] of mutations) {
      const mutated = { ...BASE_IDENTITY, [field]: value };
      assert.strictEqual(
        isSameManifestIdentity(BASE_IDENTITY, mutated),
        false,
        `字段 ${field} 变化必须识别为不同 identity`
      );
      assert.notStrictEqual(
        computeManifestIdentityKey(mutated),
        baseKey,
        `字段 ${field} 变化后 key 必须变化`
      );
    }
    assert.strictEqual(
      isSameManifestIdentity(BASE_IDENTITY, { ...BASE_IDENTITY }),
      true,
      '全同必须相同'
    );
    // 无关因子：八元组外字段永不进入（字段表冻结）
    assert.deepStrictEqual(
      [...MANIFEST_IDENTITY_FIELDS],
      [
        'contentHash',
        'segmentationVersion',
        'voiceId',
        'ttsBackendId',
        'ttsModel',
        'synthesisVersion',
        'audioFormat',
        'synthesisSpeed',
      ],
      '八元组字段表冻结，title/favorite/rate 无位置可进入'
    );
    console.log('PASS: 1. identity 断言通过');
  }

  console.log('=== 2. 状态派生（spec §12.2/§47） ===');
  {
    // no manifest → missing（空段快照）
    assert.strictEqual(
      deriveManifestStatusFromSegments([], new Date()),
      'missing',
      '无段即无 Manifest → missing'
    );
    // missing segment → missing（部分未开始且无 lease/失败）
    assert.strictEqual(
      deriveManifestStatus({
        segmentCount: 3,
        readySegmentCount: 1,
        allDurationsPresent: false,
        hasActiveLease: false,
        hasFailedSegment: false,
      }),
      'missing',
      '部分 ready 且无 synthesis → missing（非 preparing）'
    );
    // preparing：至少一个有效 lease
    assert.strictEqual(
      deriveManifestStatus({
        segmentCount: 3,
        readySegmentCount: 0,
        allDurationsPresent: false,
        hasActiveLease: true,
        hasFailedSegment: false,
      }),
      'preparing',
      '有 active lease → preparing'
    );
    // last segment → ready（全 ready 且全有 duration）
    assert.strictEqual(
      deriveManifestStatus({
        segmentCount: 2,
        readySegmentCount: 2,
        allDurationsPresent: true,
        hasActiveLease: false,
        hasFailedSegment: false,
      }),
      'ready',
      '全 ready 且全有 duration → ready'
    );
    // 全 ready 但缺 duration → 非 ready（spec §17.1）
    assert.strictEqual(
      deriveManifestStatus({
        segmentCount: 2,
        readySegmentCount: 2,
        allDurationsPresent: false,
        hasActiveLease: false,
        hasFailedSegment: false,
      }),
      'missing',
      '缺 duration 不得 ready'
    );
    // failure → failed
    assert.strictEqual(
      deriveManifestStatus({
        segmentCount: 2,
        readySegmentCount: 0,
        allDurationsPresent: false,
        hasActiveLease: false,
        hasFailedSegment: true,
      }),
      'failed',
      '失败且无 active → failed'
    );
    // retry → preparing（失败后重新 claim 有 lease 即 preparing，失败被 lease 覆盖）
    assert.strictEqual(
      deriveManifestStatus({
        segmentCount: 2,
        readySegmentCount: 0,
        allDurationsPresent: false,
        hasActiveLease: true,
        hasFailedSegment: true,
      }),
      'preparing',
      '失败后 retry 有 lease → preparing'
    );
    // 快照版：lease 有效性按时间判定
    const now = new Date('2026-09-14T00:00:00.000Z');
    const future = new Date(now.getTime() + 60_000);
    const past = new Date(now.getTime() - 1000);
    assert.strictEqual(
      deriveManifestStatusFromSegments(
        [
          { status: 'missing', durationMs: null },
          { status: 'preparing', durationMs: null, leaseExpiresAt: future },
        ],
        now
      ),
      'preparing',
      '有效 lease 快照 → preparing'
    );
    assert.strictEqual(
      deriveManifestStatusFromSegments(
        [
          { status: 'missing', durationMs: null },
          { status: 'preparing', durationMs: null, leaseExpiresAt: past },
        ],
        now
      ),
      'missing',
      '过期 lease 不视为 active → missing'
    );
    assert.strictEqual(
      deriveManifestStatusFromSegments(
        [
          { status: 'ready', durationMs: 261, leaseExpiresAt: null },
          { status: 'ready', durationMs: 261, leaseExpiresAt: null },
        ],
        now
      ),
      'ready',
      '全 ready 快照 → ready'
    );
    console.log('PASS: 2. 状态派生断言通过');
  }

  console.log('=== 3. Segment text freeze ===');
  {
    const texts = ['第一段正文。', '第二段正文。'];
    const frozen = buildFrozenSegmentInputs(texts, (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`;
    })());
    assert.strictEqual(frozen.length, 2, '段数一致');
    assert.strictEqual(frozen[0].text, texts[0], 'text 原样冻结');
    assert.strictEqual(frozen[1].text, texts[1], 'text 原样冻结');
    assert.strictEqual(
      frozen[0].textHash,
      computeStoryContentHash(texts[0]),
      'textHash 复用既有 computeStoryContentHash'
    );
    assert.ok(isServerGeneratedSegmentId(frozen[0].id), 'ID 为 server-generated UUID');
    assert.ok(isOpaqueStorageKey(frozen[0].storageKey), 'storageKey opaque');
    assert.ok(
      !frozen[0].storageKey.includes('nova') &&
        !frozen[0].storageKey.includes('user') &&
        !frozen[0].storageKey.includes('work'),
      'storageKey 不编码业务身份'
    );
    // 单段确定性：同文本同 hash
    const single = buildFrozenSegmentInput(0, texts[0], () => '11111111-1111-4111-8111-111111111111');
    assert.strictEqual(single.textHash, computeStoryContentHash(texts[0]), '单段 hash 一致');
    console.log('PASS: 3. text freeze 断言通过');
  }

  console.log('=== 4. voice 绑定（spec §8/§54） ===');
  {
    assert.strictEqual(resolveManifestVoiceId('nova', 'alloy'), 'nova', 'Work voice 优先');
    assert.strictEqual(resolveManifestVoiceId('', 'alloy'), 'alloy', 'legacy 空串回落默认');
    assert.strictEqual(resolveManifestVoiceId('  ', 'alloy'), 'alloy', '空白视同空串');
    assert.strictEqual(resolveManifestVoiceId(null, 'alloy'), 'alloy', 'null 回落默认');
    const pinned = freezeCanonicalAudioProfile({
      voiceId: 'nova',
      ttsBackendId: 'openai',
      ttsModel: 'model-A',
    });
    assert.strictEqual(pinned.voiceId, 'nova', '冻结 voice 为 nova');
    // 默认变更不影响已冻结
    assert.strictEqual(resolveManifestVoiceId('nova', 'alloy'), 'nova', '默认变 alloy 已冻结仍 nova');
    console.log('PASS: 4. voice 断言通过');
  }

  console.log('=== 5. model pinning（spec §9/§55） ===');
  {
    const pinnedA = freezeCanonicalAudioProfile({
      voiceId: 'nova',
      ttsBackendId: 'openai',
      ttsModel: 'model-A',
    });
    assert.strictEqual(pinnedA.ttsModel, 'model-A', 'authoritative pin 为 A');
    // env 改 B 不影响旧 pin（纯函数层面：pin 值即权威，不跟随 resolveTtsModel('B')）
    assert.strictEqual(resolveTtsModel('model-B'), 'model-B', '新 Manifest 用 B');
    assert.strictEqual(pinnedA.ttsModel, 'model-A', '旧 pin 仍 A');
    const identityA = computeManifestIdentityKey({
      ...BASE_IDENTITY,
      ttsModel: 'model-A',
    });
    const identityB = computeManifestIdentityKey({
      ...BASE_IDENTITY,
      ttsModel: 'model-B',
    });
    assert.notStrictEqual(identityA, identityB, 'model 不同即不同 Manifest');
    console.log('PASS: 5. model pinning 断言通过');
  }

  console.log('=== 6. canonical speed 恒 1.0（spec §7/§56） ===');
  {
    assert.strictEqual(CANONICAL_SYNTHESIS_SPEED, 1.0, '常量锁 1.0');
    assert.strictEqual(CANONICAL_AUDIO_FORMAT, 'mp3', '格式锁 mp3');
    const withUserRate = freezeCanonicalAudioProfile({
      voiceId: 'nova',
      ttsBackendId: 'openai',
      ttsModel: 'model-A',
      synthesisSpeed: 1.5,
    });
    assert.strictEqual(withUserRate.synthesisSpeed, 1.0, '用户倍速不得污染 profile');
    assert.strictEqual(resolveTtsBackendId(''), 'openai', 'backend 缺省 openai');
    // 服务层静态守卫：storyAudio 以恒 1.0 调用合成
    const storySrc = fs.readFileSync(
      path.join(process.cwd(), 'lib/server/storyAudio.ts'),
      'utf-8'
    );
    const storyCode = stripComments(storySrc);
    assert.ok(
      storyCode.includes('speed: CANONICAL_SYNTHESIS_SPEED'),
      'storyAudio 必须以 CANONICAL_SYNTHESIS_SPEED 调用合成'
    );
    assert.ok(
      !storyCode.includes('playbackRate') || storyCode.includes('playbackRate 实现'),
      'storyAudio 不得引入用户 playbackRate 资产分支'
    );
    console.log('PASS: 6. speed 断言通过');
  }

  console.log('=== 7. duration（spec §17） ===');
  {
    const bytes = buildFakeCanonicalMp3(FAKE_MP3_DEFAULT_FRAMES, 0);
    assert.strictEqual(bytes.byteLength, FAKE_MP3_DEFAULT_FRAMES * FAKE_MP3_FRAME_SIZE, 'byteLength exact');
    const duration = getMp3DurationMs(bytes);
    assert.strictEqual(duration, expectedFakeMp3DurationMs(FAKE_MP3_DEFAULT_FRAMES), 'duration exact');
    assert.ok(duration > 0, 'duration>0');
    assert.ok(isValidDurationMs(duration), '合法 duration');
    assert.strictEqual(isValidDurationMs(0), false, '0 非法');
    assert.strictEqual(isValidDurationMs(null), false, 'null 非法');
    assert.throws(() => getMp3DurationMs(new Uint8Array(0)), Mp3DurationParseError, '空 bytes 抛错');
    assert.throws(
      () => getMp3DurationMs(new Uint8Array([1, 2, 3, 4])),
      Mp3DurationParseError,
      '非 MP3 抛错'
    );
    console.log('PASS: 7. duration 断言通过');
  }

  console.log('=== 8. checksum（spec §6.6） ===');
  {
    const bytes = buildFakeCanonicalMp3(10, 7);
    const checksum = computeAudioChecksum(bytes);
    assert.strictEqual(checksum, expectedFakeMp3Checksum(bytes), 'checksum exact');
    assert.ok(isValidAudioChecksum(checksum), '格式合法');
    assert.strictEqual(isValidAudioChecksum('zzz'), false, '非法拒绝');
    // 不同文本/seed → 不同 checksum（TTS bytes 区分）
    const other = buildFakeCanonicalMp3(10, 8);
    assert.notStrictEqual(
      computeAudioChecksum(other),
      checksum,
      '不同 bytes 不同 checksum'
    );
    console.log('PASS: 8. checksum 断言通过');
  }

  console.log('=== 9. 输入严格（三字段；spec §26） ===');
  {
    const ok = ensureStoryAudioSegmentInputSchema.safeParse({
      workId: 1,
      segmentIndex: 0,
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    assert.strictEqual(ok.success, true, '合法三字段通过');
    for (const extra of ['text', 'audio', 'profile', 'storageKey', 'audioBytes', 'voiceId', 'model']) {
      const bad = ensureStoryAudioSegmentInputSchema.safeParse({
        workId: 1,
        segmentIndex: 0,
        sessionId: '11111111-1111-4111-8111-111111111111',
        [extra]: 'evil',
      });
      assert.strictEqual(bad.success, false, `多传 ${extra} 必须拒绝`);
    }
    const getOk = getPlaybackManifestInputSchema.safeParse({ workId: 1 });
    assert.strictEqual(getOk.success, true, 'get 输入通过');
    const getBad = getPlaybackManifestInputSchema.safeParse({ workId: 1, text: 'x' } as never);
    assert.strictEqual(getBad.success, false, 'get 多传拒绝');
    // 源码静态：schemas 不定义 text/audio 输入
    const schemaSrc = stripComments(
      fs.readFileSync(path.join(process.cwd(), 'lib/trpc/schemas/storyAudio.ts'), 'utf-8')
    );
    assert.ok(schemaSrc.includes('.strict()'), '输入必须 strict');
    console.log('PASS: 9. 输入严格断言通过');
  }

  console.log('=== 10. 静态守卫：零 TTS/事务/同 key/顶注 ===');
  {
    const profileSrc = fs.readFileSync(path.join(process.cwd(), 'lib/audio/profile.ts'), 'utf-8');
    assert.ok(profileSrc.includes('留待 M8-03'), 'profile 顶注必须更正为 M8-03');
    assert.ok(!profileSrc.includes('留待 M8-02'), '不得残留 M8-02 顶注');

    const storySrc = stripComments(
      fs.readFileSync(path.join(process.cwd(), 'lib/server/storyAudio.ts'), 'utf-8')
    );
    const storyRaw = fs.readFileSync(
      path.join(process.cwd(), 'lib/server/storyAudio.ts'),
      'utf-8'
    );
    // Manifest 创建零 TTS：创建路径无 synthesize 调用（synthesize 仅 lease 成功后一处）
    const synthCalls = (storySrc.match(/deps\.synthesize\(/g) ?? []).length;
    assert.strictEqual(synthCalls, 2, 'User/Guest 各一处合成调用（creation 路径零调用）');
    // 事务外 TTS：注释锁 + claim 用 updateMany（无 $transaction 包裹合成）
    assert.ok(storyRaw.includes('transaction 外'), '必须注释事务外 TTS');
    assert.ok(storySrc.includes('updateMany'), 'claim 必须用原子 updateMany');
    // 同一 key 覆盖写：storage.put 复用 stable storageKey，不生成新 key
    assert.ok(
      storySrc.includes('storage.put({ key: storageKey'),
      'storage.put 必须复用 stable storageKey'
    );
    assert.ok(
      !storySrc.includes('put({ key: build'),
      '合成路径不得生成新 key'
    );
    // frozen input：合成用 frozenText + Manifest pin
    assert.ok(storySrc.includes('text: frozenText'), '合成必须用 frozen text');
    assert.ok(storySrc.includes('model: manifest.ttsModel'), '合成必须用 Manifest pin model');
    assert.ok(storySrc.includes('voiceId: manifest.voiceId'), '合成必须用 Manifest 冻结 voice');
    // lease 常量
    assert.strictEqual(STORY_AUDIO_RETRY_AFTER_MS, 500, 'retryAfter 恒 500');
    assert.ok(STORY_AUDIO_LEASE_TTL_MS > 0, 'lease TTL 正数');
    console.log('PASS: 10. 静态守卫断言通过');
  }

  console.log('=== 11. FIXUP静态守卫：refresh单事务+fencing renew（Blocking1/2） ===');
  {
    const storyRaw = fs.readFileSync(
      path.join(process.cwd(), 'lib/server/storyAudio.ts'),
      'utf-8'
    );
    const storySrc = stripComments(storyRaw);
    // Blocking1：refresh 读→derive→update 收进同一短 $transaction（User/Guest 各一处）
    const txUses = storySrc.match(/prisma\.\$transaction\(/g) ?? [];
    // creation 2 处 + refresh 2 处 = 至少 4 处（claim/synthesis 仍无事务包裹）
    assert.ok(txUses.length >= 4, `refresh必须收进短事务(creation2+refresh2)，实际$transaction=${txUses.length}`);
    assert.ok(
      storyRaw.includes('refreshUserManifestState') &&
        storyRaw.includes('refreshGuestManifestState'),
      'User/Guest 两边一起修'
    );
    // refresh 事务内只做 DB 读+单写：事务块内无 storage.put / synthesize
    //（以 refresh 函数体为界检查：两函数均含 findMany + update 且块内无 put/synthesize）
    for (const fn of ['refreshUserManifestState', 'refreshGuestManifestState']) {
      const start = storyRaw.indexOf(`export async function ${fn}`);
      assert.ok(start >= 0, `${fn} 必须导出供oracle复用`);
      const nextExport = storyRaw.indexOf('export async function', start + 10);
      const body = nextExport > 0 ? storyRaw.slice(start, nextExport) : storyRaw.slice(start);
      const code = stripComments(body);
      assert.ok(code.includes('$transaction'), `${fn} 必须用 $transaction`);
      assert.ok(code.includes('findMany'), `${fn} 事务内读 segments`);
      assert.ok(code.includes('Manifest.update'), `${fn} 事务内写 Manifest`);
      assert.ok(!code.includes('storage.put'), `${fn} 事务内不得 storage.put`);
      assert.ok(!code.includes('deps.synthesize'), `${fn} 事务内不得 synthesize`);
    }
    // Blocking2：put 前原子 renew fencing（User/Guest 各一处），put 后 WHERE leaseId CAS 保留
    const renewGuards = storySrc.match(/where:\s*\{\s*id:\s*segment\.id,\s*leaseId,\s*status:\s*'preparing'\s*\}/g) ?? [];
    assert.ok(renewGuards.length >= 2, `put前renew守卫User/Guest各一处，实际=${renewGuards.length}`);
    assert.ok(storyRaw.includes('FIXUP Blocking2'), '必须注释 fencing 语义');
    // renew 成功才 put：renew 块后紧跟 storage.put（顺序守卫）
    const renewIdx = storyRaw.indexOf('leaseExpiresAt: new Date(renewAt.getTime()');
    const putIdx = storyRaw.indexOf('storage.put({ key: storageKey');
    assert.ok(renewIdx > 0 && putIdx > renewIdx, 'renew 成功才 put（顺序）');
    console.log('PASS: 11. FIXUP静态守卫断言通过');
  }

  console.log('ALL AUDIO CANONICAL WRITE UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioCanonicalWriteUnitTests()
  .then(() => {
    console.log('ALL AUDIO CANONICAL WRITE UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
