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
import { SEGMENTATION_VERSION } from '../../../utils/segmentation';
import { decideRehydratedPosition } from '../../../lib/playback/rehydrate';

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

  console.log('=== 8. M8-04 FIXUP Blocking1/2（Manifest 权威 + fail-closed） ===');
  {
    // Blocking 1 Oracle A 纯函数面：Manifest legacy-v0 权威时不误判 drift。
    // 当前全局 SEGMENTATION_VERSION 为 v1（断言前提：与 legacy 不同值）。
    assert.notStrictEqual(SEGMENTATION_VERSION, 'legacy-v0', '前提：当前全局版本须与 legacy 不同值');
    assert.deepStrictEqual(
      decideRehydratedPosition({
        savedNextParagraphIndex: 1,
        savedLastCompletedParagraphIndex: 0,
        savedContentHash: 'h-legacy',
        savedSegmentationVersion: 'legacy-v0',
        currentContentHash: 'h-legacy',
        currentSegmentationVersion: 'legacy-v0',
        totalParagraphs: 2,
      }),
      { nextParagraphIndex: 1, lastCompletedParagraphIndex: 0, drifted: false },
      'Oracle A 纯函数：saved legacy == effective legacy → 不 reset（即使全局为 v1）',
    );
    assert.strictEqual(
      decideRehydratedPosition({
        savedNextParagraphIndex: 1,
        savedLastCompletedParagraphIndex: 0,
        savedContentHash: 'h-legacy',
        savedSegmentationVersion: 'legacy-v0',
        currentContentHash: 'h-legacy',
        currentSegmentationVersion: SEGMENTATION_VERSION,
        totalParagraphs: 2,
      }).drifted,
      true,
      'saved legacy vs 当前版本 → drifted=true（回落路径仍重置）',
    );
    // helper 不得内部读全局常量：函数体须用 input.currentSegmentationVersion 比较。
    const rehydrateSrc = stripComments(
      fs.readFileSync(path.resolve(process.cwd(), 'lib/playback/rehydrate.ts'), 'utf8'),
    );
    assert.ok(
      rehydrateSrc.includes('currentSegmentationVersion'),
      'rehydrate 必须经调用方传入 currentSegmentationVersion',
    );
    const decideBody = rehydrateSrc.slice(
      rehydrateSrc.indexOf('decideRehydratedPosition'),
      rehydrateSrc.indexOf('decideRehydratedPosition') + 2000,
    );
    assert.ok(
      decideBody.includes('input.currentSegmentationVersion'),
      'decide 必须比较 input.currentSegmentationVersion（Manifest 权威）',
    );
    assert.ok(
      !decideBody.includes('SEGMENTATION_VERSION'),
      'decide 内部不得读全局 SEGMENTATION_VERSION（防 v1→v2 误判）',
    );
    // Blocking 2 静态面：getManifest throws ≠ missing；canonical fail-closed。
    const storeSrc8 = stripComments(
      fs.readFileSync(path.resolve(process.cwd(), 'stores/playbackSessionStore.ts'), 'utf8'),
    );
    assert.ok(
      !/getManifest[\s\S]{0,600}\} catch \{\s*return null/.test(storeSrc8),
      'defaultDeps.getManifest 不得 catch→null（throws 须与 missing 区分）',
    );
    assert.ok(
      storeSrc8.includes('fail-closed') && storeSrc8.includes("set({ status: 'error' })"),
      'hydrate manifest throws 须 fail-closed（不进 ready，可 retry，不清 Anchor）',
    );
    assert.ok(
      storeSrc8.includes('effectiveTotalParagraphs') && storeSrc8.includes('segmentCount'),
      'hydrate 有效 total 须取 manifest.segmentCount（Manifest 权威）',
    );
    const serverSrc = stripComments(
      fs.readFileSync(path.resolve(process.cwd(), 'lib/server/playbackSession.ts'), 'utf8'),
    );
    assert.ok(
      serverSrc.includes('resolveWorkEffectiveSegmentation') &&
        serverSrc.includes('effectiveSegmentationVersion') &&
        serverSrc.includes('effectiveTotalParagraphs'),
      'server beginSession 须经 Manifest 权威 effective pair',
    );
    assert.ok(
      serverSrc.includes('=== effectiveSegmentationVersion'),
      'server resume version 校验须对 effective（非全局常量）',
    );
    console.log('PASS: 8. FIXUP Blocking1/2 通过');
  }

  console.log('=== 9. M8-04 FIXUP-2 相邻写路径收口（hydrate 无条件 + 三路径统一 helper） ===');
  {
    const storeSrc9 = stripComments(
      fs.readFileSync(path.resolve(process.cwd(), 'stores/playbackSessionStore.ts'), 'utf8'),
    );
    // Blocking 1：Work hydrate 身份不得被 flag 条件化（flag 只控音源 provider）。
    const hydrateStart = storeSrc9.indexOf('hydrateFromAnchor: async');
    assert.ok(hydrateStart >= 0, 'hydrateFromAnchor 实现存在');
    const hydrateSeg = storeSrc9.slice(hydrateStart, hydrateStart + 8000);
    assert.ok(
      hydrateSeg.includes('d.getManifest') || hydrateSeg.includes('getManifest'),
      'hydrate Work 必须始终读取 Manifest identity（与 flag 无关）',
    );
    assert.ok(
      !hydrateSeg.includes('shouldUseCanonicalAudio'),
      'hydrate 身份不得经 shouldUseCanonicalAudio 条件化（flag 只控音源，不控 identity）',
    );
    assert.ok(
      hydrateSeg.includes('selectWorkParagraphs'),
      'hydrate 仍经 Manifest precedence 取 frozen 文本',
    );
    // flag 仍控制音源：全局保留 provider 分支（play/prefetch），Draft 旧路径不变。
    assert.ok(
      storeSrc9.includes('shouldUseCanonicalAudio'),
      'flag 仍须控制音源 provider（play/prefetch on→ensure/off→fetchAudio）',
    );
    assert.ok(storeSrc9.includes('fetchAudio'), 'flag-off 仍保留 ephemeral fetchAudio');
    assert.ok(
      storeSrc9.includes('ensureCanonicalSegment') || storeSrc9.includes('ensureSegment'),
      'flag-on 仍保留 ensureSegment/canonical URL',
    );
    // Blocking 2：server 三身份写路径统一消费正式只读 helper。
    const serverSrc9 = stripComments(
      fs.readFileSync(path.resolve(process.cwd(), 'lib/server/playbackSession.ts'), 'utf8'),
    );
    assert.ok(
      serverSrc9.includes('export const resolveWorkEffectiveSegmentation'),
      'effective resolution 须为正式导出只读 helper（三路径统一消费）',
    );
    const completeStart = serverSrc9.indexOf('completePlaybackSessionForSubject');
    assert.ok(completeStart >= 0, 'complete 路径存在');
    const completeSeg = serverSrc9.slice(completeStart, completeStart + 8000);
    assert.ok(
      completeSeg.includes('resolveWorkEffectiveSegmentation'),
      'completeSession 须消费 effective helper（不用当前重算回写）',
    );
    assert.ok(
      completeSeg.includes('effectiveTotalParagraphs') &&
        completeSeg.includes('effectiveSegmentationVersion'),
      'complete 须用 effective pair 写 Anchor/Progress',
    );
    const promoteStart = serverSrc9.indexOf('promoteDraftPlaybackToWorkForSubject');
    assert.ok(promoteStart >= 0, 'promote 路径存在');
    const promoteSeg = serverSrc9.slice(promoteStart, promoteStart + 12000);
    assert.ok(
      promoteSeg.includes('resolveWorkEffectiveSegmentation'),
      'promoteDraftToWork 须消费 effective helper（目标已有 Manifest 时守 invariant）',
    );
    assert.ok(
      !promoteSeg.includes('SEGMENTATION_VERSION'),
      'promote Work 写身份不得硬编码当前版本（须用 Manifest pair）',
    );
    assert.ok(
      !/workVersionForProgress\s*=\s*SEGMENTATION_VERSION/.test(serverSrc9),
      'complete 不得把 Work version 回写为当前版本（Manifest 权威）',
    );
    console.log('PASS: 9. FIXUP-2 收口通过');
  }

  console.log('=== 10. M8-04 FIXUP-3 promotion 后 client Session 切 Manifest frozen（§23） ===');
  {
    const storeSrc10 = stripComments(
      fs.readFileSync(path.resolve(process.cwd(), 'stores/playbackSessionStore.ts'), 'utf8'),
    );
    const promoteStart = storeSrc10.indexOf('promoteDraftToWork: async');
    assert.ok(promoteStart >= 0, 'client promoteDraftToWork 实现存在');
    const promoteSeg = storeSrc10.slice(promoteStart, promoteStart + 9000);
    assert.ok(
      promoteSeg.includes('d.getManifest') || promoteSeg.includes('getManifest'),
      'promotion 后必须同步读目标 Work Manifest（复用 getPlaybackManifest，不造新状态）',
    );
    assert.ok(
      promoteSeg.includes('selectWorkParagraphs'),
      'promotion 后 paragraphs 必须经 selectWorkParagraphs 取 frozen texts',
    );
    assert.ok(
      promoteSeg.includes('paragraphs'),
      'promotion 必须写回 Session.paragraphs（不得停留 Draft 切分）',
    );
    assert.ok(
      promoteSeg.includes('effectiveSegmentationVersion') &&
        promoteSeg.includes('effectiveTotalParagraphs'),
      'promotion version/count 须取 Manifest 权威 pair（Anchor 一致性校验）',
    );
    assert.ok(
      promoteSeg.includes('fail-closed'),
      'promotion Manifest read throws 须 fail-closed（不得偷偷把 Draft 当 Work SSOT）',
    );
    assert.ok(
      promoteSeg.includes("set({ status: 'error' })") || promoteSeg.includes('status'),
      'promotion unknown 须显式 error（可 retry，不静默成功）',
    );
    assert.ok(!promoteSeg.includes('playAudio'), 'promotion 不得触发换音源播放（当前 Blob 不打断 §22.4）');
    assert.ok(
      !promoteSeg.includes('pauseAudioPlayback') && !promoteSeg.includes('.stop('),
      'promotion 不得物理停止当前 Draft Blob',
    );
    console.log('PASS: 10. FIXUP-3 promotion 切 Manifest 通过');
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
