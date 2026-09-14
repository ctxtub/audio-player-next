import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { isCanonicalAudioEnabled } from '../../../lib/audio/canonicalFlag';
import {
  isCanonicalPlaybackUrl,
  selectWorkParagraphs,
  shouldUseCanonicalAudio,
} from '../../../lib/client/storyAudio';
import { toAudioProjectionFromManifest } from '../../../lib/server/storyWork';

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
}

/**
 * M8-04 Work 播放读路径单元测试（spec §22–§23/§39；M5 冻结边界不动）。
 *
 * 覆盖：
 * 1. flag：production 默认 false；显式 '1' 开启（双变量任一）；其余值 fail closed；
 * 2. provider 选择：Work+开→true；Draft 恒 false；关闭/Null 恒 false；
 * 3. manifest precedence：有 Manifest → frozen texts（排序）；空/null → 本地；
 * 4. canonical URL 形态：/api/audio/segments/* true，blob 其他 false；
 * 5. 投影：missing/preparing/ready/failed/unknown 映射；
 * 6. 静态守卫：store 仅替换 provider（M5 identity/Anchor/Progress/restart/stale 全保留；
 *    speed 不进 ensure；lookahead exactly 1；blob-only revoke；promotion 不打断当前 Blob）。
 */
async function runWorkPlaybackReadUnitTests() {
  console.log('=== 1. flag 默认关闭 + 显式开启 ===');
  {
    assert.strictEqual(isCanonicalAudioEnabled({}), false, '空 env 默认关闭（production 默认 false）');
    assert.strictEqual(
      isCanonicalAudioEnabled({ CANONICAL_AUDIO_ENABLED: '1' }),
      true,
      'server 变量显式 1 开启',
    );
    assert.strictEqual(
      isCanonicalAudioEnabled({ NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED: '1' }),
      true,
      'client 变量显式 1 开启',
    );
    assert.strictEqual(
      isCanonicalAudioEnabled({ CANONICAL_AUDIO_ENABLED: 'true' }),
      false,
      "'true' 非法值 fail closed（仅严格 '1' 合法）",
    );
    assert.strictEqual(
      isCanonicalAudioEnabled({ CANONICAL_AUDIO_ENABLED: '0' }),
      false,
      "'0' 关闭",
    );
    // ambient production 默认（双变量缺席）→ false；不污染全局 env，仅断言当前值非 '1' 时为 false
    const ambientEnabled =
      process.env.CANONICAL_AUDIO_ENABLED === '1' ||
      process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED === '1';
    if (!ambientEnabled) {
      assert.strictEqual(isCanonicalAudioEnabled(), false, 'ambient 缺席默认关闭');
    }
    console.log('PASS: 1. flag 通过');
  }

  console.log('=== 2. provider 选择（只替换 Work Segment provider） ===');
  {
    const savedServer = process.env.CANONICAL_AUDIO_ENABLED;
    const savedPublic = process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED;
    try {
      process.env.CANONICAL_AUDIO_ENABLED = '1';
      assert.strictEqual(
        shouldUseCanonicalAudio({ kind: 'work', workId: 1 }),
        true,
        'Work+开 → canonical',
      );
      assert.strictEqual(
        shouldUseCanonicalAudio({ kind: 'draft', messageId: 'm1' }),
        false,
        'Draft 恒旧路径（不受开关影响）',
      );
      assert.strictEqual(shouldUseCanonicalAudio(null), false, 'null → false');
      delete process.env.CANONICAL_AUDIO_ENABLED;
      delete process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED;
      assert.strictEqual(
        shouldUseCanonicalAudio({ kind: 'work', workId: 1 }),
        false,
        'Work+关 → legacy（production 默认）',
      );
    } finally {
      if (savedServer === undefined) delete process.env.CANONICAL_AUDIO_ENABLED;
      else process.env.CANONICAL_AUDIO_ENABLED = savedServer;
      if (savedPublic === undefined) delete process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED;
      else process.env.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED = savedPublic;
    }
    console.log('PASS: 2. provider 选择通过');
  }

  console.log('=== 3. manifest segmentation precedence（SSOT 防漂移） ===');
  {
    const local = ['本地A', '本地B'];
    const manifest = {
      segments: [
        { index: 1, text: '冻B' },
        { index: 0, text: '冻A' },
      ],
    };
    assert.deepStrictEqual(
      selectWorkParagraphs(local, manifest),
      ['冻A', '冻B'],
      '有 Manifest → frozen texts（按 index 排序，不跑未来切分）',
    );
    assert.deepStrictEqual(selectWorkParagraphs(local, null), local, '无 Manifest → 本地回落');
    assert.deepStrictEqual(
      selectWorkParagraphs(local, { segments: [] }),
      local,
      '空 Manifest → 本地回落（lazy 建由 ensure 侧完成）',
    );
    console.log('PASS: 3. precedence 通过');
  }

  console.log('=== 4. canonical URL 形态（stale 仅 blob 才 revoke） ===');
  {
    assert.strictEqual(
      isCanonicalPlaybackUrl('/api/audio/segments/11111111-1111-4111-8111-111111111111'),
      true,
      'canonical 形态识别',
    );
    assert.strictEqual(isCanonicalPlaybackUrl('blob:mock-1'), false, 'blob 非 canonical');
    assert.strictEqual(isCanonicalPlaybackUrl('https://x/y.mp3'), false, '其他非 canonical');
    console.log('PASS: 4. URL 形态通过');
  }

  console.log('=== 5. Library audio 投影映射（§12.4） ===');
  {
    assert.deepStrictEqual(toAudioProjectionFromManifest(null), {
      status: 'missing',
      durationMs: null,
    });
    assert.deepStrictEqual(
      toAudioProjectionFromManifest({ status: 'preparing', totalDurationMs: 123 }),
      { status: 'preparing', durationMs: null },
      'preparing 不暴露 duration',
    );
    assert.deepStrictEqual(
      toAudioProjectionFromManifest({ status: 'ready', totalDurationMs: 456 }),
      { status: 'ready', durationMs: 456 },
      'ready 才暴露 duration',
    );
    assert.deepStrictEqual(
      toAudioProjectionFromManifest({ status: 'ready', totalDurationMs: null }),
      { status: 'ready', durationMs: null },
      'ready 无 duration 仍 null（partial 不提前写）',
    );
    assert.deepStrictEqual(
      toAudioProjectionFromManifest({ status: 'failed', totalDurationMs: 999 }),
      { status: 'failed', durationMs: null },
    );
    assert.deepStrictEqual(
      toAudioProjectionFromManifest({ status: 'weird', totalDurationMs: 10 }),
      { status: 'missing', durationMs: null },
      '未知 status 回落 missing',
    );
    console.log('PASS: 5. 投影通过');
  }

  console.log('=== 6. store 静态守卫（M5 冻结边界 + lazy=1 + speed 不进资产） ===');
  {
    const storeSrc = stripComments(
      fs.readFileSync(path.resolve(process.cwd(), 'stores/playbackSessionStore.ts'), 'utf8'),
    );
    // 只替换 provider：保留 M5 identity 面
    assert.ok(
      storeSrc.includes('shouldUseCanonicalAudio'),
      'store 必须经 provider 选择分支（只替换 provider）',
    );
    assert.ok(
      storeSrc.includes('ensureCanonicalSegment') || storeSrc.includes('ensureSegment'),
      'Work 路径必须经 ensureSegment',
    );
    assert.ok(storeSrc.includes('fetchAudio'), 'Draft/关闭路径保留旧 fetchAudio');
    assert.ok(
      storeSrc.includes('selectWorkParagraphs'),
      'hydrate 必须经 Manifest precedence 选择段落文本',
    );
    assert.ok(
      storeSrc.includes('originatingSessionId'),
      'stale 保护必须保留 originatingSessionId 校验',
    );
    // stale 仅 blob 才 revoke（canonical 永不 revoke）
    assert.ok(
      storeSrc.includes('revokeAudioUrlIfBlob') || storeSrc.includes('isCanonicalPlaybackUrl'),
      'stale 丢弃必须区分 blob/canonical（canonical 永不 revoke）',
    );
    // lookahead exactly 1：prefetch 仅 next+1
    assert.ok(
      /prefetchNextParagraph[\s\S]{0,800}nextParagraphIndex \+ 1/.test(storeSrc),
      'prefetch 必须守卫 next+1（lookahead exactly 1）',
    );
    // 首播绝不全篇：无循环 ensure 全段
    assert.ok(
      !/for\s*\([^)]*totalParagraphs[^)]*\)\s*\{[^}]*ensureCanonicalSegment/.test(storeSrc),
      '绝不能首播一次性 ensure 全篇',
    );
    // speed 不进 asset：ensure 输入仅三字段（workId/segmentIndex/sessionId）
    assert.ok(
      /ensureCanonicalSegment\(\{\s*workId,\s*segmentIndex,\s*sessionId/.test(storeSrc),
      'ensure 输入必须严格三字段（speed 不得进入资产身份）',
    );
    assert.ok(
      !/ensureCanonicalSegment\([^)]*speed/.test(storeSrc),
      'ensure 调用不得携带 speed',
    );
    // Draft promotion 不打断当前 Blob：promote 不碰 transport play/stop
    const promoteSeg = storeSrc.slice(
      storeSrc.indexOf('promoteDraftToWork'),
      storeSrc.indexOf('promoteDraftToWork') + 4000,
    );
    assert.ok(!promoteSeg.includes('playAudio'), 'promotion 不得触发换音源播放');
    assert.ok(
      !promoteSeg.includes('pauseAudioPlayback') && !promoteSeg.includes('.stop('),
      'promotion 不得物理停止当前 Draft Blob',
    );
    console.log('PASS: 6. store 静态守卫通过');
  }

  console.log('=== 7. flag/production 门（spec §39） ===');
  {
    const flagSrc = stripComments(
      fs.readFileSync(path.resolve(process.cwd(), 'lib/audio/canonicalFlag.ts'), 'utf8'),
    );
    assert.ok(
      flagSrc.includes("=== '1'") || flagSrc.includes('=== "1"') || flagSrc.includes('ENABLED_VALUE'),
      'flag 必须严格 1 才开启（fail closed）',
    );
    const storeSrc = stripComments(
      fs.readFileSync(path.resolve(process.cwd(), 'stores/playbackSessionStore.ts'), 'utf8'),
    );
    assert.ok(
      !/process\.env\.CANONICAL_AUDIO_ENABLED\s*=\s*['"]1['"]/.test(storeSrc),
      'store 不得写 env（只读 flag）',
    );
    console.log('PASS: 7. production 门通过');
  }

  console.log('\nALL AUDIO WORK PLAYBACK READ UNIT TESTS PASSED!');
}

const testPromise = runWorkPlaybackReadUnitTests()
  .then(() => {
    console.log('ALL AUDIO WORK PLAYBACK READ UNIT TESTS PASSED!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
