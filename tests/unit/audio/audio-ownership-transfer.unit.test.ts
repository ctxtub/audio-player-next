import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { isTransferEquivalent } from '../../../lib/server/audioOwnershipTransfer';

/**
 * M8-05-03 Guest → User Canonical Audio Ownership Transfer 单元测试（无真库）。
 *
 * 锁定（与任务验收对应，静态 + 纯函数口径）：
 * 1. 窄 helper 存在且仅允许 transaction client：transferGuestAudioOwnershipTx(tx, guestWorkId, userWorkId)，
 *    文件内永不 import 全局 prisma / storage / TTS / tombstone；
 * 2. 全程不变量（静态）：storage.put/delete/copy、TTS、tombstone 零触达；不新建 storageKey；
 * 3. 挂载点：creative migration 同一 $transaction 内逐 Work 调用 transfer（复用/同源/新建三分支）；
 * 4. 幂等/冲突语义纯函数门：等价→true；identity/segments/storageKeys 任一冲突→false；
 *    瞬态（lease/attempt/opaque id/墙钟）差异→仍 true；禁止「User 已有就直接删 Guest」（先等价后删）；
 * 5. fail-closed：冲突抛 CONFLICT，throw 前对该 Manifest 零写。
 */

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
}

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
}

type TestManifest = {
  version: number;
  status: string;
  contentHash: string;
  segmentationVersion: string;
  voiceId: string;
  ttsBackendId: string;
  ttsModel: string;
  synthesisVersion: string;
  synthesisSpeed: number;
  audioFormat: string;
  segmentCount: number;
  readySegmentCount: number;
  totalDurationMs: number | null;
  totalByteLength: number | null;
  lastErrorCode: string | null;
  supersededAt: null;
  segments: Array<{
    segmentIndex: number;
    text: string;
    textHash: string;
    status: string;
    storageKey: string;
    contentType: string;
    byteLength: number | null;
    durationMs: number | null;
    audioChecksum: string | null;
    lastErrorCode: string | null;
  }>;
};

function baseManifest(): TestManifest {
  return {
    version: 1,
    status: 'ready',
    contentHash: 'hash_35_481',
    segmentationVersion: 'v1',
    voiceId: 'nova',
    ttsBackendId: 'openai',
    ttsModel: 'tts-1',
    synthesisVersion: 'canonical-mp3-v1',
    synthesisSpeed: 1.0,
    audioFormat: 'mp3',
    segmentCount: 2,
    readySegmentCount: 2,
    totalDurationMs: 522,
    totalByteLength: 8340,
    lastErrorCode: null,
    supersededAt: null,
    segments: [
      {
        segmentIndex: 0,
        text: 'seg0 frozen',
        textHash: 'th0',
        status: 'ready',
        storageKey: 'story-audio/key-X-0.mp3',
        contentType: 'audio/mpeg',
        byteLength: 4170,
        durationMs: 261,
        audioChecksum: 'ck0',
        lastErrorCode: null,
      },
      {
        segmentIndex: 1,
        text: 'seg1 frozen',
        textHash: 'th1',
        status: 'ready',
        storageKey: 'story-audio/key-X-1.mp3',
        contentType: 'audio/mpeg',
        byteLength: 4170,
        durationMs: 261,
        audioChecksum: 'ck1',
        lastErrorCode: null,
      },
    ],
  };
}

async function runAudioOwnershipTransferUnitTests() {
  console.log('=== 1. 窄 helper 形态：仅 tx 入参 + 零全局/存储/TTS/tombstone 引用 ===');
  {
    const src = readRepoFile('lib/server/audioOwnershipTransfer.ts');
    const code = stripComments(src);
    assert.ok(/export async function transferGuestAudioOwnershipTx/.test(code), 'helper 必须导出');
    assert.ok(
      /transferGuestAudioOwnershipTx\(\s*tx:\s*AudioOwnershipTransferTx,\s*guestWorkId:\s*number,\s*userWorkId:\s*number/.test(code),
      '签名必须为 (tx, guestWorkId, userWorkId) 窄形态',
    );
    assert.ok(/export type AudioOwnershipTransferTx/.test(code), 'tx 窄面类型必须导出');
    assert.ok(/export function isTransferEquivalent/.test(code), '等价门必须为可测纯函数');
    for (const pat of [
      /from\s+['"][^'"]*lib\/db['"]/,
      /@\/lib\/db/,
      /getAudioAssetStorage/,
      /AudioAssetStorage/,
      /synthesizeSpeechWithProfile/,
      /synthesize/,
      /audioStorageDeletion/i,
      /AudioStorageDeletion/,
      /enqueueAudioDeletionTombstones/,
      /cleanupAudioStorage/,
      /prisma\s*\./,
    ]) {
      assert.strictEqual(pat.test(code), false, `helper 不得触达 ${String(pat)}（只允许 tx 窄面）`);
    }
    console.log('PASS: 1. 窄 helper 形态通过');
  }

  console.log('=== 2. 全程不变量：零 storage/TTS/object-lifecycle 写 + 不新建 key ===');
  {
    const src = readRepoFile('lib/server/audioOwnershipTransfer.ts');
    const code = stripComments(src);
    for (const pat of [
      /\.put\s*\(/,
      /\.delete\s*\(\s*\{?\s*key/,
      /storage\.delete/,
      /storage\.put/,
      /copy\s*\(/,
      /buildSegmentStorageKey/,
      /buildFrozenSegmentInput/,
      /randomUUID/,
      /crypto/,
      /tts/i,
    ]) {
      // 注意：注释已剥离；代码区出现上述任一即违反「不复制 object、不重新 TTS、不 rename key」。
      // 例外：函数名/类型名中的 transfer 含意不计；此处仅拦 storage/TTS/key 生成原语。
      if (pat.source === 'tts') {
        assert.strictEqual(/synthesize|getTtsConfig|ttsBackend/i.test(code) && /synthesizeSpeech/.test(code), false, '不得调用 TTS');
        continue;
      }
      assert.strictEqual(pat.test(code), false, `helper 不得出现 ${pat.source}`);
    }
    // 允许的写仅四类：User Manifest/Segment create + Guest Segment deleteMany + Guest Manifest delete
    assert.ok(/storyAudioManifest\s*\.\s*create/.test(code), '允许 User Manifest create');
    assert.ok(/storyAudioSegment\s*\.\s*create/.test(code), '允许 User Segment create');
    assert.ok(/guestStoryAudioSegment\s*\.\s*deleteMany/.test(code), '允许 Guest Segment deleteMany');
    assert.ok(/guestStoryAudioManifest\s*\.\s*delete\b/.test(code), '允许 Guest Manifest delete');
    assert.strictEqual(/storyAudioManifest\s*\.\s*delete/.test(code), false, '绝不删除 User Manifest');
    assert.strictEqual(/storyAudioSegment\s*\.\s*delete/.test(code), false, '绝不删除 User Segment');
    assert.strictEqual(/\.update\s*\(/.test(code), false, 'transfer/idempotent 路径不得 update 任何行（只 create + delete Guest）');
    console.log('PASS: 2. 不变量通过');
  }

  console.log('=== 3. 挂载点：creative migration 同一 transaction 内逐 Work 调用 ===');
  {
    const src = readRepoFile('lib/server/unifiedMigration.ts');
    const code = stripComments(src);
    assert.ok(/from\s+['"]@\/lib\/server\/audioOwnershipTransfer['"]/.test(code), '必须 import 窄 helper');
    const callSites = code.match(/await transferGuestAudioOwnershipTx\(tx,\s*g\.id,/g) ?? [];
    assert.ok(callSites.length >= 3, `三分支（复用/同源/新建）均须同事务调用，实际 ${callSites.length}`);
    const txStart = code.indexOf('await prisma.$transaction(async (tx)');
    assert.ok(txStart >= 0, 'creative migration 事务可定位');
    const txBlock = code.slice(txStart, txStart + 12000);
    assert.ok(/transferGuestAudioOwnershipTx\(tx,/.test(txBlock), '调用必须在同一 $transaction 闭包内（传 tx）');
    assert.strictEqual(/getAudioAssetStorage|synthesize|storage\.put|storage\.delete|AudioStorageDeletion/.test(txBlock), false, '事务内不得新增 storage/TTS/tombstone 调用');
    // Guest StoryWork 文本仍保留：migration 不得删 Guest Work（M2 retention 语义保持）
    assert.strictEqual(/guestStoryWork\s*\.\s*delete/.test(code), false, 'migration 不得删除 Guest StoryWork 文本行');
    console.log('PASS: 3. 挂载点通过');
  }

  console.log('=== 4. 等价门：等价→true；identity/segments/keys 冲突→false ===');
  {
    const g = baseManifest();
    const u = baseManifest();
    assert.strictEqual(isTransferEquivalent(g, u), true, '完全等价必须 true（幂等可清 Guest）');

    // identity 任一变化即冲突
    const identityCases: Array<[string, (m: TestManifest) => void]> = [
      ['contentHash', (m) => { m.contentHash = 'other'; }],
      ['segmentationVersion', (m) => { m.segmentationVersion = 'v2'; }],
      ['voiceId', (m) => { m.voiceId = 'alloy'; }],
      ['ttsBackendId', (m) => { m.ttsBackendId = 'proxy'; }],
      ['ttsModel', (m) => { m.ttsModel = 'tts-2'; }],
      ['synthesisVersion', (m) => { m.synthesisVersion = 'canonical-mp3-v2'; }],
      ['synthesisSpeed', (m) => { m.synthesisSpeed = 1.25; }],
      ['audioFormat', (m) => { m.audioFormat = 'wav'; }],
      ['segmentCount', (m) => { m.segmentCount = 3; }],
      ['status', (m) => { m.status = 'preparing'; }],
      ['readySegmentCount', (m) => { m.readySegmentCount = 1; }],
      ['totalDurationMs', (m) => { m.totalDurationMs = 261; }],
      ['lastErrorCode', (m) => { m.lastErrorCode = 'AUDIO_SYNTHESIS_FAILED'; }],
    ];
    for (const [label, mutate] of identityCases) {
      const other = baseManifest();
      mutate(other);
      assert.strictEqual(isTransferEquivalent(g, other), false, `identity 冲突必须 false：${label}`);
    }

    // segment asset 任一变化即冲突
    const segmentCases: Array<[string, (m: TestManifest) => void]> = [
      ['storageKey', (m) => { m.segments[1].storageKey = 'story-audio/other.mp3'; }],
      ['text', (m) => { m.segments[0].text = 'tampered'; }],
      ['textHash', (m) => { m.segments[0].textHash = 'other'; }],
      ['segment status', (m) => { m.segments[0].status = 'failed'; }],
      ['byteLength', (m) => { m.segments[0].byteLength = 1; }],
      ['durationMs', (m) => { m.segments[0].durationMs = 1; }],
      ['audioChecksum', (m) => { m.segments[0].audioChecksum = 'other'; }],
      ['segment lastErrorCode', (m) => { m.segments[0].lastErrorCode = 'X'; }],
      ['segment count', (m) => { m.segments.pop(); }],
    ];
    for (const [label, mutate] of segmentCases) {
      const other = baseManifest();
      mutate(other);
      assert.strictEqual(isTransferEquivalent(g, other), false, `segment 冲突必须 false：${label}`);
    }
    console.log('PASS: 4. 冲突语义通过');
  }

  console.log('=== 5. 瞬态豁免：lease/attempt/opaque id/墙钟差异仍等价 ===');
  {
    // 纯函数面只收语义字段；此处锁死「helper 文件头声明的排除集」不被偷改收紧。
    const src = readRepoFile('lib/server/audioOwnershipTransfer.ts');
    const code = stripComments(src);
    assert.ok(/leaseId/.test(code) && /leaseExpiresAt/.test(code), 'copy 面保留 lease 字段搬运（原样 transfer）');
    // 等价门实现必须不比对 lease/attempt/id/readyAt：静态锁定排除注释 + 实现无这些键比对
    const gateStart = code.indexOf('export function isTransferEquivalent');
    assert.ok(gateStart >= 0, '等价门可定位');
    const gate = code.slice(gateStart, gateStart + 4000);
    assert.strictEqual(/leaseId/.test(gate), false, '等价门不得比对 leaseId（瞬态豁免）');
    assert.strictEqual(/attemptCount/.test(gate), false, '等价门不得比对 attemptCount（运维计数豁免）');
    assert.strictEqual(/readyAt/.test(gate), false, '等价门不得比对 readyAt（墙钟豁免）');
    // 乱序 segments 仍等价（按 index 排序后比对）
    const g = baseManifest();
    const u = baseManifest();
    u.segments = [u.segments[1], u.segments[0]];
    assert.strictEqual(isTransferEquivalent(g, u), true, '乱序 segments 必须仍等价');
    console.log('PASS: 5. 瞬态豁免通过');
  }

  console.log('=== 6. fail-closed：先等价后删 + 冲突 CONFLICT 零写 ===');
  {
    const src = readRepoFile('lib/server/audioOwnershipTransfer.ts');
    const code = stripComments(src);
    assert.ok(/code:\s*['"]CONFLICT['"]/.test(code), '冲突必须抛 CONFLICT');
    const helperStart = code.indexOf('export async function transferGuestAudioOwnershipTx');
    assert.ok(helperStart >= 0, 'helper 可定位');
    const body = code.slice(helperStart, helperStart + 12000);
    const equivIdx = body.indexOf('isTransferEquivalent(');
    assert.ok(equivIdx >= 0, '等价门调用可定位');
    // User 已存在分支：等价判定必须出现在幂等删除之前（禁止「User 已有就直接删 Guest」）。
    // 源码顺序：transfer 分支（User 缺席→先 create 后删 Guest）在前，
    // User 已存在分支（等价门→throw/删）在后；注释已被剥离，故以代码位置断言。
    const firstDelete = body.indexOf('guestStoryAudioSegment');
    assert.ok(firstDelete >= 0 && firstDelete < equivIdx, 'transfer 分支先建 User 行后删 Guest 行');
    const transferCreate = body.indexOf('storyAudioManifest.create');
    assert.ok(transferCreate >= 0 && transferCreate < firstDelete, 'transfer 分支 create 在 delete 之前');
    const branchDelete = body.indexOf('guestStoryAudioSegment', equivIdx);
    assert.ok(branchDelete > equivIdx, '必须先等价判定、后删 Guest（禁止直接删）');
    const branchThrow = body.indexOf('throwConflict', equivIdx);
    assert.ok(branchThrow > equivIdx && branchThrow < branchDelete, '冲突 throw 必须在等价判定后、删除前（throw 前零写）');
    assert.ok(/throwConflict/.test(body), '冲突经 throwConflict 抛错（throw 前零写）');
    // throwConflict 定义内只有 throw，无 DB 写
    const throwStart = code.indexOf('function throwConflict');
    const throwBlock = code.slice(throwStart, throwStart + 600);
    assert.strictEqual(/deleteMany|delete\b|\.create\(/.test(throwBlock), false, 'conflict 路径不得含任何 DB 写');
    console.log('PASS: 6. fail-closed 通过');
  }

  console.log('ALL AUDIO OWNERSHIP TRANSFER UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioOwnershipTransferUnitTests()
  .then(() => {
    console.log('ALL AUDIO OWNERSHIP TRANSFER UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
