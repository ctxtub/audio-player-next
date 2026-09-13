import assert from 'node:assert';
import {
  SEGMENTATION_VERSION as rootSegmentationVersion,
  computeStoryContentHash as rootComputeStoryContentHash,
  normalizeStoryText as rootNormalizeStoryText,
  segmentStoryText as rootSegmentStoryText,
} from '../../../utils/segmentation';
import {
  REPLAY_TEXT_PREFIX,
  createDraftSource,
  createWorkSource,
  equalPlaybackSource,
  isPlaybackSourceRef,
  isValidDraftMessageId,
  isValidWorkId,
  normalizePlaybackSourceRef,
  playbackSourceKey,
  serializePlaybackSource,
} from '../../../lib/playback/source';
import {
  STALE_SESSION,
  createPlaybackSessionId,
  decideCheckpointAcceptance,
  ensurePlaybackSessionId,
  isStaleSession,
  isValidPlaybackSessionId,
} from '../../../lib/playback/session';
import {
  SEGMENTATION_VERSION as domainSegmentationVersion,
  computeWorkProgressRatio,
  computeStoryContentHash as domainComputeStoryContentHash,
  continuationModeToLegacyIsOneShot,
  deriveWorkPlaybackState,
  normalizeStoryText as domainNormalizeStoryText,
  rehydratedContinuationMode,
  resolveContinuationMode,
  resolvePromotedNextParagraphIndex,
  segmentStoryText as domainSegmentStoryText,
  shouldPreserveDraftBreakpointOnPromote,
} from '../../../lib/playback/progress';
import {
  canonicalizeSourceKind,
  parseLegacyPlaybackSource,
  parseLegacyWorkId,
  tryParseLegacyPlaybackSource,
} from '../../../lib/playback/legacy';

/**
 * M5-01 Playback Identity Domain 纯领域契约单元测试（L1）。
 * 覆盖 spec §3 / §4 / §7 / §7.1 / §11 / §12 / §37 / §38 Unit 组：
 * Identity 4 组转换 + workId positive int + draft 禁 replay-text-*，
 * hash fixtures（CRLF/CR/行尾空格/中文/emoji/多段）逐字锁死，
 * progress 推导 / continuation / session stale guard / promotion 取舍。
 * 纯领域：无 DB / store / API / Prisma 依赖；不改任何既有播放行为。
 */

async function runPlaybackIdentityDomainTests(): Promise<void> {
  console.log('=== M5-01: Playback Identity Domain ===');

  // —— §3 / §38 Identity：4 组 legacy 转换 ——
  console.log('--- identity: legacy conversions ---');
  assert.deepStrictEqual(parseLegacyPlaybackSource('chat', 'msg-abc-123'), {
    kind: 'draft',
    messageId: 'msg-abc-123',
  });
  assert.deepStrictEqual(parseLegacyPlaybackSource('generation', '123'), {
    kind: 'work',
    workId: 123,
  });
  assert.deepStrictEqual(parseLegacyPlaybackSource('draft', 'msg-live-1'), {
    kind: 'draft',
    messageId: 'msg-live-1',
  });
  assert.deepStrictEqual(parseLegacyPlaybackSource('work', '481'), {
    kind: 'work',
    workId: 481,
  });
  assert.strictEqual(canonicalizeSourceKind('chat'), 'draft');
  assert.strictEqual(canonicalizeSourceKind('generation'), 'work');
  assert.strictEqual(canonicalizeSourceKind('draft'), 'draft');
  assert.strictEqual(canonicalizeSourceKind('work'), 'work');
  assert.throws(() => canonicalizeSourceKind('audio'), /unknown sourceType/);
  assert.throws(() => canonicalizeSourceKind('CHAT'), /unknown sourceType/);
  assert.throws(() => canonicalizeSourceKind(''), /unknown sourceType/);
  console.log('PASS: 4-group legacy conversion verified');

  // —— §3.3 / §38：workId 仅 positive int ——
  console.log('--- identity: workId positive int ---');
  assert.strictEqual(isValidWorkId(1), true);
  assert.strictEqual(isValidWorkId(481), true);
  assert.strictEqual(isValidWorkId(Number.MAX_SAFE_INTEGER), true);
  assert.deepStrictEqual(createWorkSource(481), { kind: 'work', workId: 481 });
  assert.strictEqual(parseLegacyWorkId('123'), 123);
  assert.strictEqual(parseLegacyWorkId('  481  '), 481);
  for (const bad of [0, -1, -481, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '123', null, undefined, {}, []]) {
    assert.strictEqual(isValidWorkId(bad), false, `workId must reject ${String(bad)}`);
  }
  assert.throws(() => createWorkSource(0), /invalid workId/);
  assert.throws(() => createWorkSource(-1), /invalid workId/);
  assert.throws(() => createWorkSource(1.5), /invalid workId/);
  assert.throws(() => createWorkSource(Number.NaN), /invalid workId/);
  for (const badId of ['', '   ', '0', '-1', '1.5', 'abc', '1e3', '0x10', '12a', '  ']) {
    assert.throws(() => parseLegacyWorkId(badId), /invalid work sourceId/, `legacy workId must reject ${JSON.stringify(badId)}`);
    assert.strictEqual(tryParseLegacyPlaybackSource('generation', badId), null);
    assert.strictEqual(tryParseLegacyPlaybackSource('work', badId), null);
  }
  assert.strictEqual(tryParseLegacyPlaybackSource('audio', '123'), null);
  assert.strictEqual(tryParseLegacyPlaybackSource('chat', 'replay-text-1'), null);
  console.log('PASS: workId positive-int gate verified');

  // —— §3.2 / §38：Draft 禁 replay-text-*（fail-closed） ——
  console.log('--- identity: draft bans replay-text-* ---');
  assert.strictEqual(REPLAY_TEXT_PREFIX, 'replay-text-');
  assert.strictEqual(isValidDraftMessageId('msg-abc-123'), true);
  assert.strictEqual(isValidDraftMessageId('replay-text-123'), false);
  assert.strictEqual(isValidDraftMessageId('replay-text-'), false);
  assert.strictEqual(isValidDraftMessageId(''), false);
  assert.strictEqual(isValidDraftMessageId('   '), false);
  assert.strictEqual(isValidDraftMessageId(null), false);
  assert.deepStrictEqual(createDraftSource('msg-ok'), { kind: 'draft', messageId: 'msg-ok' });
  assert.throws(() => createDraftSource('replay-text-123'), /invalid draft messageId/);
  assert.throws(() => createDraftSource(''), /invalid draft messageId/);
  assert.throws(() => parseLegacyPlaybackSource('chat', 'replay-text-999'), /invalid draft messageId/);
  assert.throws(() => parseLegacyPlaybackSource('draft', 'replay-text-999'), /invalid draft messageId/);
  assert.strictEqual(isPlaybackSourceRef({ kind: 'draft', messageId: 'replay-text-1' }), false);
  assert.strictEqual(isPlaybackSourceRef({ kind: 'draft', messageId: 'ok' }), true);
  assert.strictEqual(isPlaybackSourceRef({ kind: 'work', workId: 7 }), true);
  assert.strictEqual(isPlaybackSourceRef({ kind: 'work', workId: 0 }), false);
  assert.strictEqual(isPlaybackSourceRef({ kind: 'audio', sourceId: 'x' }), false);
  assert.strictEqual(isPlaybackSourceRef(null), false);
  console.log('PASS: draft replay-text-* fail-closed verified');

  // —— source 强类型 helpers ——
  console.log('--- source: helpers ---');
  assert.deepStrictEqual(normalizePlaybackSourceRef({ kind: 'work', workId: 5 }), { kind: 'work', workId: 5 });
  assert.strictEqual(equalPlaybackSource({ kind: 'work', workId: 5 }, { kind: 'work', workId: 5 }), true);
  assert.strictEqual(equalPlaybackSource({ kind: 'work', workId: 5 }, { kind: 'work', workId: 6 }), false);
  assert.strictEqual(equalPlaybackSource({ kind: 'draft', messageId: 'a' }, { kind: 'work', workId: 1 }), false);
  assert.strictEqual(equalPlaybackSource(null, { kind: 'work', workId: 1 }), false);
  assert.strictEqual(playbackSourceKey({ kind: 'draft', messageId: 'm1' }), 'draft:m1');
  assert.strictEqual(playbackSourceKey({ kind: 'work', workId: 42 }), 'work:42');
  assert.deepStrictEqual(serializePlaybackSource({ kind: 'draft', messageId: 'm1' }), { kind: 'draft', sourceId: 'm1' });
  assert.deepStrictEqual(serializePlaybackSource({ kind: 'work', workId: 42 }), { kind: 'work', sourceId: '42' });
  console.log('PASS: source helpers verified');

  // —— §37 hash SSOT：fixtures 逐字锁死 + 与既有算法一致 ——
  console.log('--- hash: SSOT fixtures ---');
  assert.strictEqual(rootSegmentationVersion, 'v1');
  assert.strictEqual(domainSegmentationVersion, 'v1');
  assert.strictEqual(domainSegmentationVersion, rootSegmentationVersion);

  const FIX_CRLF = '第一段故事。\r\n第二段故事。\r\n第三段故事。';
  const FIX_CR = '第一段故事。\r第二段故事。\r第三段故事。';
  const FIX_TRAILING = '第一段故事。   \n第二段故事。\t\n第三段故事。  ';
  const FIX_NORMALIZED = '第一段故事。\n第二段故事。\n第三段故事。';
  const FIX_CHINESE = '从前有座山，山里有座庙，庙里有个老和尚在讲故事。';
  const FIX_EMOJI = '小狐狸 🦊 穿过森林 🌲🌲，遇见了老乌龟 🐢。';
  const FIX_MULTI = '第一章：出发\n\n第二章：历险\n第三章：归来\n这是一个很长很长的尾声，充满了各种细节和波折。';
  const FIX_ABC = '故事正文内容ABC';

  // 归一化逐字向量
  assert.strictEqual(rootNormalizeStoryText(FIX_CRLF), FIX_NORMALIZED);
  assert.strictEqual(rootNormalizeStoryText(FIX_CR), FIX_NORMALIZED);
  assert.strictEqual(rootNormalizeStoryText(FIX_TRAILING), FIX_NORMALIZED);
  // hash 逐字回归向量（由既有算法生成，锁死）
  assert.strictEqual(rootComputeStoryContentHash(FIX_CRLF), '549c813b8b62');
  assert.strictEqual(rootComputeStoryContentHash(FIX_CR), '549c813b8b62');
  assert.strictEqual(rootComputeStoryContentHash(FIX_TRAILING), '549c813b8b62');
  assert.strictEqual(rootComputeStoryContentHash(FIX_CHINESE), '694f28f42ee5');
  assert.strictEqual(rootComputeStoryContentHash(FIX_EMOJI), '9a183bfc650d');
  assert.strictEqual(rootComputeStoryContentHash(FIX_MULTI), 'de3cfa2cf539');
  assert.strictEqual(rootComputeStoryContentHash(FIX_ABC), 'dcd35acfdfde');
  // 域层必须与 SSOT 逐字一致（无第二套算法）
  for (const fix of [FIX_CRLF, FIX_CR, FIX_TRAILING, FIX_CHINESE, FIX_EMOJI, FIX_MULTI, FIX_ABC]) {
    assert.strictEqual(domainNormalizeStoryText(fix), rootNormalizeStoryText(fix));
    assert.strictEqual(domainComputeStoryContentHash(fix), rootComputeStoryContentHash(fix));
    assert.deepStrictEqual(domainSegmentStoryText(fix), rootSegmentStoryText(fix));
  }
  // 切段逐字向量
  assert.deepStrictEqual(rootSegmentStoryText(FIX_CRLF), [FIX_NORMALIZED]);
  assert.deepStrictEqual(rootSegmentStoryText(FIX_MULTI), [
    '第一章：出发\n第二章：历险\n第三章：归来\n这是一个很长很长的尾声，充满了各种细节和波折。',
  ]);
  assert.deepStrictEqual(rootSegmentStoryText(''), []);
  console.log('PASS: hash SSOT fixtures verified');

  // —— §7 / §7.1 progress 推导 ——
  console.log('--- progress: derivation & ratio ---');
  assert.strictEqual(deriveWorkPlaybackState(null), 'not_started');
  assert.strictEqual(deriveWorkPlaybackState(undefined), 'not_started');
  assert.strictEqual(deriveWorkPlaybackState({ lastCompletedParagraphIndex: -1, nextParagraphIndex: 0, totalParagraphs: 3, completedAt: null }), 'in_progress');
  assert.strictEqual(deriveWorkPlaybackState({ lastCompletedParagraphIndex: 0, nextParagraphIndex: 1, totalParagraphs: 3, completedAt: null }), 'in_progress');
  assert.strictEqual(deriveWorkPlaybackState({ lastCompletedParagraphIndex: 2, nextParagraphIndex: 3, totalParagraphs: 3, completedAt: '2026-09-12T00:00:00.000Z' }), 'completed');
  // 再次播放语义（§8）：位置重置但 completedAt 保留 → 本次仍为 in_progress
  assert.strictEqual(
    deriveWorkPlaybackState({ lastCompletedParagraphIndex: -1, nextParagraphIndex: 0, totalParagraphs: 3, completedAt: '2026-09-12T00:00:00.000Z' }),
    'in_progress',
  );
  assert.strictEqual(computeWorkProgressRatio(null), 0);
  assert.strictEqual(computeWorkProgressRatio({ lastCompletedParagraphIndex: -1, nextParagraphIndex: 0, totalParagraphs: 3, completedAt: null }), 0);
  assert.strictEqual(computeWorkProgressRatio({ lastCompletedParagraphIndex: 0, nextParagraphIndex: 1, totalParagraphs: 3, completedAt: null }), 1 / 3);
  assert.strictEqual(computeWorkProgressRatio({ lastCompletedParagraphIndex: 2, nextParagraphIndex: 3, totalParagraphs: 3, completedAt: '2026-09-12T00:00:00.000Z' }), 1);
  // 越界钳制：不伪装超额精度
  assert.strictEqual(computeWorkProgressRatio({ lastCompletedParagraphIndex: 99, nextParagraphIndex: 99, totalParagraphs: 3, completedAt: null }), 1);
  console.log('PASS: progress derivation verified');

  // —— §11 / §12 continuation ——
  console.log('--- continuation ---');
  assert.strictEqual(resolveContinuationMode({ kind: 'work', rehydrated: false }), 'finite');
  assert.strictEqual(resolveContinuationMode({ kind: 'work', rehydrated: true }), 'finite');
  assert.strictEqual(resolveContinuationMode({ kind: 'work', rehydrated: false, liveExtendable: true }), 'finite');
  assert.strictEqual(resolveContinuationMode({ kind: 'draft', rehydrated: true }), 'finite');
  assert.strictEqual(resolveContinuationMode({ kind: 'draft', rehydrated: true, liveExtendable: true }), 'finite');
  assert.strictEqual(resolveContinuationMode({ kind: 'draft', rehydrated: false, liveExtendable: true }), 'extendable');
  assert.strictEqual(resolveContinuationMode({ kind: 'draft', rehydrated: false }), 'finite');
  assert.strictEqual(resolveContinuationMode({ kind: 'draft', rehydrated: false, liveExtendable: false }), 'finite');
  assert.strictEqual(rehydratedContinuationMode(), 'finite');
  assert.strictEqual(continuationModeToLegacyIsOneShot('finite'), true);
  assert.strictEqual(continuationModeToLegacyIsOneShot('extendable'), false);
  console.log('PASS: continuation verified');

  // —— §4 / §4.1 session ——
  console.log('--- session ---');
  const sidA = createPlaybackSessionId();
  const sidB = createPlaybackSessionId();
  assert.strictEqual(isValidPlaybackSessionId(sidA), true);
  assert.strictEqual(isValidPlaybackSessionId(sidB), true);
  assert.notStrictEqual(sidA, sidB);
  const seen = new Set<string>();
  for (let i = 0; i < 100; i += 1) seen.add(createPlaybackSessionId());
  assert.strictEqual(seen.size, 100);
  assert.strictEqual(isValidPlaybackSessionId(null), false);
  assert.strictEqual(isValidPlaybackSessionId(''), false);
  assert.strictEqual(isValidPlaybackSessionId('msg-abc-123'), false);
  assert.strictEqual(isValidPlaybackSessionId('not-a-uuid'), false);
  assert.strictEqual(ensurePlaybackSessionId(sidA), sidA);
  const repaired = ensurePlaybackSessionId(null);
  assert.strictEqual(isValidPlaybackSessionId(repaired), true);
  assert.strictEqual(isValidPlaybackSessionId(ensurePlaybackSessionId('bad')), true);
  // stale guard：同 session 接受，异 session 以 STALE_SESSION 拒绝
  assert.deepStrictEqual(decideCheckpointAcceptance(sidA, sidA), { accepted: true });
  assert.deepStrictEqual(decideCheckpointAcceptance(sidA, sidB), { accepted: false, reason: STALE_SESSION });
  assert.strictEqual(STALE_SESSION, 'STALE_SESSION');
  assert.strictEqual(isStaleSession(sidA, sidB), true);
  assert.strictEqual(isStaleSession(sidA, sidA), false);
  // legacy null anchor：接受走修复路径，而非 stale
  assert.deepStrictEqual(decideCheckpointAcceptance(sidA, null), { accepted: true });
  assert.strictEqual(isStaleSession('bad-checkpoint', sidA), true);
  console.log('PASS: session stale guard verified');

  // —— §3.4 promotion 取舍 ——
  console.log('--- promotion ---');
  assert.strictEqual(shouldPreserveDraftBreakpointOnPromote('abc123', 'abc123'), true);
  assert.strictEqual(shouldPreserveDraftBreakpointOnPromote('abc123', 'def456'), false);
  assert.strictEqual(shouldPreserveDraftBreakpointOnPromote('', 'abc123'), false);
  assert.strictEqual(shouldPreserveDraftBreakpointOnPromote('abc123', ''), false);
  assert.strictEqual(resolvePromotedNextParagraphIndex(2, 'h1', 'h1', 5), 2);
  assert.strictEqual(resolvePromotedNextParagraphIndex(2, 'h1', 'h2', 5), 0);
  assert.strictEqual(resolvePromotedNextParagraphIndex(9, 'h1', 'h1', 5), 5);
  console.log('PASS: promotion verified');

  console.log('\nALL PLAYBACK IDENTITY DOMAIN TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runPlaybackIdentityDomainTests()
  .then(() => {
    console.log('ALL PLAYBACK IDENTITY DOMAIN TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
