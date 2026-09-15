import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { computeStoryContentHash } from '../../../utils/segmentation';
import {
  buildManifestIdentity,
  buildFrozenSegmentInput,
  buildFrozenSegmentInputs,
  buildSegmentStorageKey,
  computeManifestIdentityKey,
  isOpaqueStorageKey,
  isSameManifestIdentity,
  isServerGeneratedSegmentId,
  MANIFEST_IDENTITY_FIELDS,
  type ManifestIdentity,
} from '../../../lib/audio/manifest';
import {
  CANONICAL_AUDIO_FORMAT,
  CANONICAL_SYNTHESIS_SPEED,
  DEFAULT_TTS_BACKEND_ID,
  FALLBACK_TTS_MODEL,
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
  createMissingAudioProjection,
  storyAudioProjectionSchema,
  storyWorkSummaryDtoSchema,
} from '../../../lib/trpc/schemas/library';

/**
 * M8-01：Manifest identity 与音频投影骨架单元测试。
 *
 * 覆盖（spec §5.2/§7–§9 + §6/§12 + §37）：
 * 1. 身份变化因子：改 contentHash/voice/model/backend/synthesisVersion/segmentationVersion → identity 变化；
 * 2. 身份无关因子：改 playbackRate/title/favorite → identity 不变（八元组外字段永不进入）；
 * 3. canonical speed 静态锁 1.0；
 * 4. TTS config identity 常量（TTS_BACKEND_ID / synthesisVersion）；
 * 5. Segment ID server-generated UUID；storageKey opaque（不编码 User/Guest/Work/title）；
 * 6. textHash 沿用既有 computeStoryContentHash，不另造正文 hash；text 为 frozen input；
 * 7. M2 投影骨架：无 Manifest → missing/null，且 audio:null 被 DTO 拒绝（消除双语义）。
 */

const BASE_IDENTITY: ManifestIdentity = {
  contentHash: 'aaaabbbbcccc',
  segmentationVersion: 'v1',
  voiceId: 'nova',
  ttsBackendId: 'openai',
  ttsModel: 'tts-1',
  synthesisVersion: SYNTHESIS_VERSION,
  audioFormat: 'mp3',
  synthesisSpeed: 1.0,
};

function withField(
  field: keyof ManifestIdentity,
  value: string | number
): ManifestIdentity {
  return { ...BASE_IDENTITY, [field]: value } as ManifestIdentity;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
}

async function runAudioManifestIdentityUnitTests() {
  console.log('=== 1. 身份变化因子：六字段任一变化 → identity 变化 ===');
  {
    const baseKey = computeManifestIdentityKey(BASE_IDENTITY);
    const mutations: Array<[keyof ManifestIdentity, string | number]> = [
      ['contentHash', 'ddddffff0000'],
      ['voiceId', 'alloy'],
      ['ttsModel', 'tts-1-hd'],
      ['ttsBackendId', 'company-proxy-v1'],
      ['synthesisVersion', 'canonical-mp3-v2'],
      ['segmentationVersion', 'v2'],
    ];
    assert.strictEqual(mutations.length, 6, '必须覆盖全部 6 个身份变化因子');
    for (const [field, value] of mutations) {
      const mutated = withField(field, value);
      assert.strictEqual(
        isSameManifestIdentity(BASE_IDENTITY, mutated),
        false,
        `字段 ${field} 变化必须被识别为不同 identity`
      );
      assert.notStrictEqual(
        computeManifestIdentityKey(mutated),
        baseKey,
        `字段 ${field} 变化后 identity key 必须变化`
      );
    }
    assert.strictEqual(
      isSameManifestIdentity(BASE_IDENTITY, { ...BASE_IDENTITY }),
      true,
      '全同身份必须判定相同'
    );
    console.log('PASS: 1. 六字段身份变化断言通过');
  }

  console.log('=== 2. 身份无关因子：playbackRate/title/favorite → identity 不变 ===');
  {
    // 八元组即全部身份：字段表冻结，title/favorite/用户倍速无位置可进入
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
      'Manifest 身份字段表必须冻结为八元组，不得增删'
    );
    assert.strictEqual(
      (MANIFEST_IDENTITY_FIELDS as readonly string[]).includes('title'),
      false,
      'title 不得进入 identity'
    );
    assert.strictEqual(
      (MANIFEST_IDENTITY_FIELDS as readonly string[]).includes('playbackRate'),
      false,
      '用户 playbackRate 不得进入 identity'
    );
    assert.ok(
      !(MANIFEST_IDENTITY_FIELDS as readonly string[]).some((f) =>
        /favorit/i.test(f)
      ),
      'favorite 不得进入 identity'
    );

    // 同一冻结输入在不同 ambient 下重建 → 同一 key（模拟改标题/收藏/倍速后重读）
    const storySnapshot = {
      contentHash: BASE_IDENTITY.contentHash,
      segmentationVersion: BASE_IDENTITY.segmentationVersion,
    };
    const profile = freezeCanonicalAudioProfile({
      voiceId: 'nova',
      ttsBackendId: 'openai',
      ttsModel: 'tts-1',
    });
    const rebuiltA = buildManifestIdentity(storySnapshot, profile);
    // ambient：title='新标题', favorite=true, playbackRate=1.5 —— 全部不在入参中
    const ambient = { title: '新标题', favorite: true, playbackRate: 1.5 };
    assert.ok(ambient.playbackRate !== 1.0 && ambient.favorite === true);
    const rebuiltB = buildManifestIdentity(storySnapshot, profile);
    assert.strictEqual(
      computeManifestIdentityKey(rebuiltA),
      computeManifestIdentityKey(rebuiltB),
      'ambient（title/favorite/playbackRate）变化不得改变 identity key'
    );
    assert.strictEqual(
      isSameManifestIdentity(rebuiltA, BASE_IDENTITY),
      true,
      '重建身份必须与基线一致'
    );
    console.log('PASS: 2. 身份无关因子断言通过');
  }

  console.log('=== 3. canonical speed 静态锁 1.0 ===');
  {
    assert.strictEqual(
      CANONICAL_SYNTHESIS_SPEED,
      1.0,
      'CANONICAL_SYNTHESIS_SPEED 必须恒为 1.0'
    );
    // 误传用户倍速亦被覆盖
    const polluted = freezeCanonicalAudioProfile({
      voiceId: 'nova',
      ttsBackendId: 'openai',
      ttsModel: 'tts-1',
      synthesisSpeed: 1.5,
    });
    assert.strictEqual(
      polluted.synthesisSpeed,
      1.0,
      'profile 冻结必须覆盖输入 speed，用户倍速不得污染身份'
    );
    assert.strictEqual(
      buildManifestIdentity(
        {
          contentHash: 'h',
          segmentationVersion: 'v1',
        },
        polluted
      ).synthesisSpeed,
      1.0,
      'Manifest 身份速度必须恒为 1.0'
    );
    // 源码静态守卫：audio 域代码（注释除外）不得出现 playbackRate
    for (const file of ['manifest.ts', 'profile.ts', 'checksum.ts']) {
      const source = stripComments(
        fs.readFileSync(path.join(process.cwd(), 'lib/audio', file), 'utf-8')
      );
      assert.strictEqual(
        /playbackRate/.test(source),
        false,
        `lib/audio/${file} 源码不得出现 playbackRate（用户倍速禁入领域层）`
      );
    }
    console.log('PASS: 3. canonical speed 锁定断言通过');
  }

  console.log('=== 4. TTS config identity 常量 ===');
  {
    assert.strictEqual(
      DEFAULT_TTS_BACKEND_ID,
      'openai',
      'TTS_BACKEND_ID 缺省必须为 openai（spec §5.3）'
    );
    assert.strictEqual(
      SYNTHESIS_VERSION,
      'canonical-mp3-v1',
      'synthesisVersion 冻结值必须为 canonical-mp3-v1（spec §5.4）'
    );
    assert.strictEqual(
      CANONICAL_AUDIO_FORMAT,
      'mp3',
      'canonical 音频格式必须为 mp3'
    );
    assert.strictEqual(
      resolveTtsBackendId(''),
      'openai',
      '空 backend 回落 openai'
    );
    assert.strictEqual(
      resolveTtsBackendId('  company-proxy-v1  '),
      'company-proxy-v1',
      '显式 backend 经 trim 后冻结'
    );
    assert.strictEqual(
      resolveTtsModel(''),
      FALLBACK_TTS_MODEL,
      '空 model 回落默认'
    );
    assert.strictEqual(
      resolveTtsModel('tts-1-hd'),
      'tts-1-hd',
      '显式 model 直通冻结（旧 Manifest pin 不跟随部署配置变化）'
    );
    console.log('PASS: 4. TTS config identity 断言通过');
  }

  console.log('=== 5. Segment ID 与 storageKey 不透明性 ===');
  {
    let counter = 0;
    const stubId = () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
    const segA = buildFrozenSegmentInput(0, '第一段正文', stubId);
    const segB = buildFrozenSegmentInput(1, '第二段正文', stubId);
    assert.strictEqual(
      isServerGeneratedSegmentId(segA.id),
      true,
      '注入 ID 须为 UUID 形态（service 显式生成语义）'
    );
    assert.notStrictEqual(segA.id, segB.id, '段 ID 必须唯一');
    assert.strictEqual(
      segA.storageKey,
      buildSegmentStorageKey(segA.id),
      'storageKey 必须由 segmentId 确定性派生'
    );
    assert.strictEqual(
      isOpaqueStorageKey(segA.storageKey),
      true,
      'storageKey 必须符合 story-audio/<uuid>.mp3 不透明格式'
    );

    // 默认生成器：随机但格式稳定
    const live = buildFrozenSegmentInput(0, '正文');
    assert.strictEqual(
      isServerGeneratedSegmentId(live.id),
      true,
      '默认 crypto.randomUUID 生成的 ID 必须为 server-generated UUID 形态'
    );
    assert.strictEqual(
      isOpaqueStorageKey(live.storageKey),
      true,
      '默认生成的 storageKey 必须不透明'
    );

    // 不编码业务身份（确定性证明 + 源码守卫，而非随机子串扫描）：
    // ① 给定同一 ID，多次派生恒等，且 key 仅由 ID 构成
    assert.strictEqual(
      buildSegmentStorageKey(segA.id),
      `story-audio/${segA.id}.mp3`,
      'storageKey 必须仅由 segmentId 派生，不混入任何业务字段'
    );
    assert.strictEqual(
      buildSegmentStorageKey(segA.id),
      segA.storageKey,
      '同 ID 重复派生必须幂等'
    );
    // ② 源码守卫：派生函数实现仅引用 segmentId，不得引用 user/guest/work/title
    const manifestSrc = stripComments(
      fs.readFileSync(path.join(process.cwd(), 'lib/audio/manifest.ts'), 'utf-8')
    );
    const builderSrc =
      manifestSrc.slice(manifestSrc.indexOf('export function buildSegmentStorageKey'));
    assert.ok(
      builderSrc.length > 0,
      '必须存在 buildSegmentStorageKey 实现'
    );
    const builderBody = builderSrc.slice(0, builderSrc.indexOf('}', builderSrc.indexOf('{')) + 1);
    for (const token of ['userId', 'guestId', 'workId', 'title']) {
      assert.strictEqual(
        new RegExp(`\\b${token}\\b`, 'i').test(builderBody),
        false,
        `storageKey 派生实现不得引用业务身份：${token}`
      );
    }
    assert.strictEqual(
      /^[ -~]+$/.test(live.storageKey),
      true,
      'storageKey 必须为纯 ASCII（中文标题永不进入）'
    );
    console.log('PASS: 5. Segment ID 与 storageKey 断言通过');
  }

  console.log('=== 6. text 冻结与 textHash 复用 ===');
  {
    const text = '很久以前，在月球的背面住着一只从未见过地球的小狐狸。';
    const seg = buildFrozenSegmentInput(2, text, () => '11111111-1111-4111-8111-111111111111');
    assert.strictEqual(seg.segmentIndex, 2, 'segmentIndex 必须原样冻结');
    assert.strictEqual(seg.text, text, 'text 必须原样冻结（frozen input）');
    assert.strictEqual(
      seg.textHash,
      computeStoryContentHash(text),
      'textHash 必须恒等于既有 computeStoryContentHash(text)，不另造正文 hash'
    );
    assert.strictEqual(seg.contentType, 'audio/mpeg', 'contentType 缺省 audio/mpeg');

    const batch = buildFrozenSegmentInputs(['甲', '乙', '丙'], (() => {
      let n = 0;
      return () => `22222222-2222-4222-8222-${String(n++).padStart(12, '0')}`;
    })());
    assert.strictEqual(batch.length, 3, '批量构建数量一致');
    assert.deepStrictEqual(
      batch.map((s) => s.segmentIndex),
      [0, 1, 2],
      '批量序号从 0 连续'
    );
    assert.deepStrictEqual(
      batch.map((s) => s.text),
      ['甲', '乙', '丙'],
      '批量文本顺序冻结'
    );

    // 静态守卫：冻结层代码（注释除外）永不依赖未来切段算法（不得 import segmentStoryText）
    const manifestSource = stripComments(
      fs.readFileSync(path.join(process.cwd(), 'lib/audio/manifest.ts'), 'utf-8')
    );
    assert.strictEqual(
      /segmentStoryText/.test(manifestSource),
      false,
      'lib/audio/manifest.ts 不得依赖 segmentStoryText（冻结文本不跟随算法升级重算）'
    );
    console.log('PASS: 6. text 冻结与 textHash 复用断言通过');
  }

  console.log('=== 7. M2 投影骨架：无 Manifest → missing/null（无双语义） ===');
  {
    assert.deepStrictEqual(
      createMissingAudioProjection(),
      { status: 'missing', durationMs: null },
      '无 Manifest 缺省投影必须为 missing/null'
    );
    const parsed = storyAudioProjectionSchema.parse(
      createMissingAudioProjection()
    );
    assert.strictEqual(parsed.status, 'missing');
    assert.strictEqual(parsed.durationMs, null);

    // audio:null 被 DTO 拒绝（消除 null vs missing 双语义）
    assert.throws(
      () =>
        storyWorkSummaryDtoSchema.parse({
          id: 1,
          title: 't',
          excerpt: 'e',
          voiceId: '',
          contentHash: 'abc',
          favoritedAt: null,
          deletedAt: null,
          createdAt: '2026-09-12T00:00:00.000Z',
          updatedAt: '2026-09-12T00:00:00.000Z',
          audio: null,
        }),
      /Expected object, received null|Expected type 'object', received 'null'|invalid/i,
      'Summary DTO audio 不得为 null'
    );
    console.log('PASS: 7. M2 投影骨架断言通过');
  }

  console.log('=== 8. checksum：SHA-256 blob 完整性（与正文身份区分） ===');
  {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sumA = computeAudioChecksum(bytes);
    const sumB = computeAudioChecksum(new Uint8Array([1, 2, 3, 4]));
    assert.strictEqual(sumA, sumB, '同字节 checksum 确定');
    assert.strictEqual(
      isValidAudioChecksum(sumA),
      true,
      'checksum 必须为 64 位小写十六进制'
    );
    assert.notStrictEqual(
      sumA,
      computeAudioChecksum(new Uint8Array([1, 2, 3, 5])),
      '字节变化 checksum 必须变化'
    );
    assert.strictEqual(
      isValidAudioChecksum(computeStoryContentHash('正文')),
      false,
      '正文 contentHash（短哈希）绝不能冒充 audioChecksum'
    );
    console.log('PASS: 8. checksum 断言通过');
  }

  console.log('=== 9. voice/model 绑定语义 ===');
  {
    assert.strictEqual(
      resolveManifestVoiceId('nova', 'alloy'),
      'nova',
      'Work.voiceId 优先冻结'
    );
    assert.strictEqual(
      resolveManifestVoiceId('', 'alloy'),
      'alloy',
      'legacy 空 voice resolve 默认 voice 后冻结'
    );
    assert.strictEqual(
      resolveManifestVoiceId('  ', 'alloy'),
      'alloy',
      '空白 voice 视同空串'
    );
    const pinned = freezeCanonicalAudioProfile({
      voiceId: 'nova',
      ttsBackendId: 'openai',
      ttsModel: 'model-A',
    });
    assert.strictEqual(
      pinned.ttsModel,
      'model-A',
      'Manifest model 一经冻结即为 authoritative pin'
    );
    assert.strictEqual(
      pinned.synthesisVersion,
      SYNTHESIS_VERSION,
      'synthesisVersion 缺省冻结当前管线版本'
    );
    console.log('PASS: 9. voice/model 绑定断言通过');
  }

  console.log('ALL AUDIO MANIFEST IDENTITY UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioManifestIdentityUnitTests()
  .then(() => {
    console.log('ALL AUDIO MANIFEST IDENTITY UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
