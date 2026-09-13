import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  beginPlaybackSessionInputSchema,
  clearPlaybackAnchorInputSchema,
  completePlaybackSessionInputSchema,
  getWorkPlaybackProgressBatchInputSchema,
  playbackAnchorDTOSchema,
  playbackCanonicalSourceTypeSchema,
  playbackProgressDTOSchema,
  playbackSessionIdSchema,
  playbackSourceSchema,
  playbackSourceTypeSchema,
  promoteDraftPlaybackToWorkInputSchema,
  savePlaybackCheckpointInputSchema,
  savePlaybackCheckpointResultSchema,
  savePlaybackProgressInputSchema,
  workPlaybackProgressDTOSchema,
} from '../../../lib/trpc/schemas/playback';
import { isValidPlaybackSessionId } from '../../../lib/playback/session';
import {
  beginPlaybackSession,
  clearPlaybackAnchor,
  completePlaybackSession,
  getPlaybackAnchor,
  getWorkPlaybackProgressBatch,
  promoteDraftPlaybackToWork,
  savePlaybackCheckpoint,
} from '../../../lib/client/playbackSession';
import {
  beginPlaybackSessionForSubject,
  clearPlaybackAnchorForSubject,
  completePlaybackSessionForSubject,
  getPlaybackAnchorForSubject,
  getWorkPlaybackProgressBatchForSubject,
  promoteDraftPlaybackToWorkForSubject,
  savePlaybackCheckpointForSubject,
} from '../../../lib/server/playbackSession';

/**
 * M5-05 Playback API Contract 冻结单元测试（L1）。
 * 锁定 spec §13 / §14 / §34 surface：
 * Source discriminatedUnion（§13.1）+ Anchor DTO 14 字段（§13.2，
 * 绝不含 storyText/audioUrl/currentTime/isPlaying）+ WorkProgress DTO（§13.3）
 * + 7 新 procedures 输入输出 + 旧 API 保留 + 双层外观 7 方法 +
 * facade 分态：getAnchor / beginSession 真逻辑（M5-05，经 prisma + M2 边界），
 * 其余 5 procedures 保持 fail-closed skeleton（M5-06+）。
 * 纯契约：不触库、不调网络；router / server 侧经源码文本断言
 *（避免 unit 直连持久化层；getAnchor / beginSession 的 DB 语义由 L2 集成测试覆盖）。
 */

const VALID_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const buildValidAnchor = () => ({
  sessionId: VALID_UUID,
  source: { kind: 'draft', messageId: 'msg-abc-123' },
  state: 'ready',
  title: '月球上的小狐狸',
  contentHash: '549c813b8b62',
  segmentationVersion: 'v1',
  lastCompletedParagraphIndex: 0,
  nextParagraphIndex: 1,
  totalParagraphs: 4,
  voiceId: '',
  speed: 1.0,
  remainingAllowedMs: null as number | null,
  totalAllowedMs: null as number | null,
  updatedAt: '2026-09-13T00:00:00.000Z',
});

const readRepoText = (rel: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

async function runPlaybackSessionContractTests(): Promise<void> {
  console.log('=== M5-04: Playback Session Contract ===');

  // —— §13.1 Source schema：discriminatedUnion draft/work ——
  console.log('--- source schema (§13.1) ---');
  assert.deepStrictEqual(playbackSourceSchema.parse({ kind: 'draft', messageId: 'm1' }), {
    kind: 'draft',
    messageId: 'm1',
  });
  assert.deepStrictEqual(playbackSourceSchema.parse({ kind: 'work', workId: 42 }), {
    kind: 'work',
    workId: 42,
  });
  for (const bad of [
    { kind: 'chat', sourceId: 'm1' },
    { kind: 'generation', sourceId: '42' },
    { kind: 'audio', sourceId: 'x' },
    { kind: 'draft', messageId: '' },
    { kind: 'draft', messageId: 'x'.repeat(129) },
    { kind: 'work', workId: 0 },
    { kind: 'work', workId: -1 },
    { kind: 'work', workId: 1.5 },
    { kind: 'work', workId: '42' },
    { kind: 'draft' },
    { kind: 'work' },
    null,
  ]) {
    assert.throws(() => playbackSourceSchema.parse(bad), `source must reject ${JSON.stringify(bad)}`);
  }
  console.log('PASS: source discriminatedUnion verified');

  // —— §13.2 Anchor DTO：14 字段精确锁死 + 禁止字段 ——
  console.log('--- anchor DTO (§13.2) ---');
  const anchorKeys = Object.keys(playbackAnchorDTOSchema.shape).sort();
  assert.deepStrictEqual(anchorKeys, [
    'contentHash',
    'lastCompletedParagraphIndex',
    'nextParagraphIndex',
    'remainingAllowedMs',
    'segmentationVersion',
    'sessionId',
    'source',
    'speed',
    'state',
    'title',
    'totalAllowedMs',
    'totalParagraphs',
    'updatedAt',
    'voiceId',
  ]);
  for (const forbidden of ['storyText', 'audioUrl', 'currentTime', 'isPlaying']) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(playbackAnchorDTOSchema.shape, forbidden),
      false,
      `anchor must not contain ${forbidden}`,
    );
  }
  for (const legacy of ['sourceType', 'sourceId', 'isOneShot']) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(playbackAnchorDTOSchema.shape, legacy),
      false,
      `anchor must not contain legacy ${legacy}`,
    );
  }
  assert.deepStrictEqual(playbackAnchorDTOSchema.parse(buildValidAnchor()), buildValidAnchor());
  assert.deepStrictEqual(
    playbackAnchorDTOSchema.parse({ ...buildValidAnchor(), source: { kind: 'work', workId: 7 }, state: 'ended' }).state,
    'ended',
  );
  assert.throws(() => playbackAnchorDTOSchema.parse({ ...buildValidAnchor(), sessionId: 'not-a-uuid' }));
  assert.throws(() => playbackAnchorDTOSchema.parse({ ...buildValidAnchor(), state: 'playing' }));
  // 即使上游混入禁止字段，DTO 输出也不得携带（zod 默认 strip，未知键被丢弃）。
  const stripped = playbackAnchorDTOSchema.parse({
    ...buildValidAnchor(),
    storyText: '全文',
    audioUrl: 'https://x/y.mp3',
    currentTime: 12.5,
    isPlaying: true,
  } as unknown as Record<string, unknown>);
  for (const forbidden of ['storyText', 'audioUrl', 'currentTime', 'isPlaying']) {
    assert.strictEqual(forbidden in stripped, false, `parsed anchor must not carry ${forbidden}`);
  }
  console.log('PASS: anchor DTO verified');

  // —— §13.3 WorkPlaybackProgressDTO：8 字段 + 三态 + progress 钳制 ——
  console.log('--- work progress DTO (§13.3) ---');
  const progressKeys = Object.keys(workPlaybackProgressDTOSchema.shape).sort();
  assert.deepStrictEqual(progressKeys, [
    'completedAt',
    'lastCompletedParagraphIndex',
    'lastPlayedAt',
    'nextParagraphIndex',
    'progress',
    'state',
    'totalParagraphs',
    'workId',
  ]);
  const validProgress = {
    workId: 9,
    state: 'in_progress',
    progress: 1 / 3,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: 3,
    completedAt: null as string | null,
    lastPlayedAt: '2026-09-13T00:00:00.000Z' as string | null,
  };
  assert.deepStrictEqual(workPlaybackProgressDTOSchema.parse(validProgress), validProgress);
  for (const state of ['not_started', 'in_progress', 'completed']) {
    assert.strictEqual(workPlaybackProgressDTOSchema.parse({ ...validProgress, state }).state, state);
  }
  assert.throws(() => workPlaybackProgressDTOSchema.parse({ ...validProgress, progress: 1.5 }));
  assert.throws(() => workPlaybackProgressDTOSchema.parse({ ...validProgress, progress: -0.1 }));
  assert.throws(() => workPlaybackProgressDTOSchema.parse({ ...validProgress, workId: 0 }));
  assert.throws(() => workPlaybackProgressDTOSchema.parse({ ...validProgress, state: 'playing' }));
  console.log('PASS: work progress DTO verified');

  // —— legacy 四值 parser 保留（M5-03 兼容不破坏） ——
  console.log('--- legacy compatibility ---');
  for (const kind of ['chat', 'generation', 'draft', 'work']) {
    assert.strictEqual(playbackSourceTypeSchema.parse(kind), kind);
  }
  assert.strictEqual(playbackCanonicalSourceTypeSchema.parse('draft'), 'draft');
  assert.strictEqual(playbackCanonicalSourceTypeSchema.parse('work'), 'work');
  assert.throws(() => playbackCanonicalSourceTypeSchema.parse('chat'));
  // 旧 saveProgress 输入仍接受 chat|generation（兼容旧客户端）。
  assert.strictEqual(
    savePlaybackProgressInputSchema.parse({
      sourceType: 'chat',
      sourceId: 'msg-old',
      title: '旧标题',
      contentHash: 'abc123',
      lastCompletedParagraphIndex: -1,
      nextParagraphIndex: 0,
      totalParagraphs: 2,
    }).sourceType,
    'chat',
  );
  assert.strictEqual(
    savePlaybackProgressInputSchema.parse({
      sourceType: 'generation',
      sourceId: '123',
      title: '旧标题',
      contentHash: 'abc123',
      lastCompletedParagraphIndex: -1,
      nextParagraphIndex: 0,
      totalParagraphs: 2,
    }).sourceType,
    'generation',
  );
  // 旧 DTO 形态保留（含 sourceType/sourceId/isOneShot）。
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(playbackProgressDTOSchema.shape, 'isOneShot'),
    true,
  );
  console.log('PASS: legacy parser retained');

  // —— §14 inputs：7 procedures 输入边界 ——
  console.log('--- procedure inputs (§15–§24) ---');
  assert.deepStrictEqual(
    beginPlaybackSessionInputSchema.parse({
      sessionId: VALID_UUID,
      source: { kind: 'draft', messageId: 'm1' },
      mode: 'resume',
      speed: 1.0,
    }).mode,
    'resume',
  );
  beginPlaybackSessionInputSchema.parse({
    sessionId: VALID_UUID,
    source: { kind: 'work', workId: 3 },
    mode: 'restart',
    speed: 1.5,
    draftSnapshot: undefined,
  });
  beginPlaybackSessionInputSchema.parse({
    sessionId: VALID_UUID,
    source: { kind: 'draft', messageId: 'm1' },
    mode: 'resume',
    speed: 1.0,
    draftSnapshot: { title: 'T', contentHash: 'h1', totalParagraphs: 2, voiceId: '' },
  });
  assert.throws(() =>
    beginPlaybackSessionInputSchema.parse({
      sessionId: 'bad',
      source: { kind: 'draft', messageId: 'm1' },
      mode: 'resume',
      speed: 1.0,
    }),
  );
  assert.throws(() =>
    beginPlaybackSessionInputSchema.parse({
      sessionId: VALID_UUID,
      source: { kind: 'draft', messageId: 'm1' },
      mode: 'continue',
      speed: 1.0,
    }),
  );
  savePlaybackCheckpointInputSchema.parse({
    sessionId: VALID_UUID,
    contentHash: '549c813b8b62',
    segmentationVersion: 'v1',
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: 4,
    speed: 1.0,
  });
  assert.throws(() =>
    savePlaybackCheckpointInputSchema.parse({
      sessionId: VALID_UUID,
      contentHash: '',
      segmentationVersion: 'v1',
      lastCompletedParagraphIndex: 0,
      nextParagraphIndex: 1,
      totalParagraphs: 4,
      speed: 1.0,
    }),
  );
  completePlaybackSessionInputSchema.parse({ sessionId: VALID_UUID });
  assert.throws(() => completePlaybackSessionInputSchema.parse({ sessionId: 'bad' }));
  clearPlaybackAnchorInputSchema.parse({ sessionId: VALID_UUID });
  assert.throws(() => clearPlaybackAnchorInputSchema.parse({ sessionId: 'bad' }));
  promoteDraftPlaybackToWorkInputSchema.parse({ sessionId: VALID_UUID, workId: 11 });
  assert.throws(() => promoteDraftPlaybackToWorkInputSchema.parse({ sessionId: VALID_UUID, workId: 0 }));
  assert.deepStrictEqual(
    getWorkPlaybackProgressBatchInputSchema.parse({ workIds: [1, 2, 3] }).workIds,
    [1, 2, 3],
  );
  assert.throws(() => getWorkPlaybackProgressBatchInputSchema.parse({ workIds: [] }));
  assert.throws(() => getWorkPlaybackProgressBatchInputSchema.parse({ workIds: Array.from({ length: 51 }, (_, i) => i + 1) }));
  assert.throws(() => getWorkPlaybackProgressBatchInputSchema.parse({ workIds: [0] }));
  assert.throws(() => getWorkPlaybackProgressBatchInputSchema.parse({ workIds: [1.5] }));
  console.log('PASS: procedure inputs verified');

  // —— Session API UUID v4 contract 回归（评审 Blocking 1：继承 M5-01 identity invariant） ——
  // 六处 sessionId 入口必须共用同一 playbackSessionIdSchema（z.uuidv4），
  // v4（含 crypto.randomUUID）PASS；v1 / v7 / nil / 坏 variant 一律 REJECT。
  console.log('--- sessionId UUID v4 contract (M5-01 invariant) ---');
  const KNOWN_V4 = VALID_UUID;
  const RANDOM_V4 = crypto.randomUUID();
  const UUID_V1 = '6ec0bd7f-11c0-11d1-9100-00aa00b548e1';
  const UUID_V7 = '0196a1a0-9a2f-7f6c-b9e9-7a2b3c4d5e6f';
  const NIL_UUID = '00000000-0000-0000-0000-000000000000';
  const BAD_VARIANT = 'f47ac10b-58cc-4372-c567-0e02b2c3d479';
  // 六处入口的同值构造器：全部只替换 sessionId，其余字段保持合法。
  const sessionEntries: Array<{ name: string; build: (sessionId: string) => unknown; parse: (v: unknown) => unknown }> = [
    {
      name: 'PlaybackAnchorDTO.sessionId',
      build: (sessionId) => ({ ...buildValidAnchor(), sessionId }),
      parse: (v) => playbackAnchorDTOSchema.parse(v),
    },
    {
      name: 'beginSession.sessionId',
      build: (sessionId) => ({
        sessionId,
        source: { kind: 'draft', messageId: 'm1' },
        mode: 'resume',
        speed: 1.0,
      }),
      parse: (v) => beginPlaybackSessionInputSchema.parse(v),
    },
    {
      name: 'saveCheckpoint.sessionId',
      build: (sessionId) => ({
        sessionId,
        contentHash: '549c813b8b62',
        segmentationVersion: 'v1',
        lastCompletedParagraphIndex: 0,
        nextParagraphIndex: 1,
        totalParagraphs: 4,
        speed: 1.0,
      }),
      parse: (v) => savePlaybackCheckpointInputSchema.parse(v),
    },
    {
      name: 'completeSession.sessionId',
      build: (sessionId) => ({ sessionId }),
      parse: (v) => completePlaybackSessionInputSchema.parse(v),
    },
    {
      name: 'clearAnchor.sessionId',
      build: (sessionId) => ({ sessionId }),
      parse: (v) => clearPlaybackAnchorInputSchema.parse(v),
    },
    {
      name: 'promoteDraftToWork.sessionId',
      build: (sessionId) => ({ sessionId, workId: 11 }),
      parse: (v) => promoteDraftPlaybackToWorkInputSchema.parse(v),
    },
  ];
  assert.strictEqual(sessionEntries.length, 6, 'must lock all six sessionId entries');
  for (const entry of sessionEntries) {
    // v4 PASS：known v4 + crypto.randomUUID()
    entry.parse(entry.build(KNOWN_V4));
    entry.parse(entry.build(RANDOM_V4));
    // 非 v4 REJECT：v1 / v7 / nil / 坏 variant / 通用坏串
    for (const bad of [UUID_V1, UUID_V7, NIL_UUID, BAD_VARIANT, 'bad']) {
      assert.throws(
        () => entry.parse(entry.build(bad)),
        `${entry.name} must reject ${bad}`,
      );
    }
  }
  // 同一导出复用：六处 shape 必须为同一 playbackSessionIdSchema 引用（禁各自复制）。
  assert.strictEqual(playbackAnchorDTOSchema.shape.sessionId, playbackSessionIdSchema, 'anchor must reuse playbackSessionIdSchema');
  assert.strictEqual(beginPlaybackSessionInputSchema.shape.sessionId, playbackSessionIdSchema, 'beginSession must reuse playbackSessionIdSchema');
  assert.strictEqual(savePlaybackCheckpointInputSchema.shape.sessionId, playbackSessionIdSchema, 'saveCheckpoint must reuse playbackSessionIdSchema');
  assert.strictEqual(completePlaybackSessionInputSchema.shape.sessionId, playbackSessionIdSchema, 'completeSession must reuse playbackSessionIdSchema');
  assert.strictEqual(clearPlaybackAnchorInputSchema.shape.sessionId, playbackSessionIdSchema, 'clearAnchor must reuse playbackSessionIdSchema');
  assert.strictEqual(promoteDraftPlaybackToWorkInputSchema.shape.sessionId, playbackSessionIdSchema, 'promoteDraftToWork must reuse playbackSessionIdSchema');
  // 与 M5-01 领域判定逐向量一致（schema 继承 identity invariant 的活锁）。
  for (const v of [KNOWN_V4, RANDOM_V4, UUID_V1, UUID_V7, NIL_UUID, BAD_VARIANT, 'bad']) {
    assert.strictEqual(
      playbackSessionIdSchema.safeParse(v).success,
      isValidPlaybackSessionId(v),
      `schema/domain parity for ${v}`,
    );
  }
  console.log('PASS: sessionId UUID v4 contract verified');

  // —— saveCheckpoint 输出：accepted 判别联合（含 STALE_SESSION） ——
  console.log('--- checkpoint result (§17.1) ---');
  const anchor = buildValidAnchor();
  assert.deepStrictEqual(
    savePlaybackCheckpointResultSchema.parse({ accepted: true, anchor }),
    { accepted: true, anchor },
  );
  assert.deepStrictEqual(
    savePlaybackCheckpointResultSchema.parse({ accepted: false, reason: 'STALE_SESSION' }),
    { accepted: false, reason: 'STALE_SESSION' },
  );
  assert.throws(() => savePlaybackCheckpointResultSchema.parse({ accepted: false, reason: 'UNKNOWN' }));
  console.log('PASS: checkpoint result verified');

  // —— router surface：7 新 + 3 旧（源码文本断言，unit 不直连持久化层） ——
  console.log('--- router surface (§14) ---');
  const routerText = readRepoText('lib/trpc/routers/playback.ts');
  for (const name of [
    'getAnchor',
    'beginSession',
    'saveCheckpoint',
    'completeSession',
    'clearAnchor',
    'promoteDraftToWork',
    'getWorkProgressBatch',
  ]) {
    assert.match(routerText, new RegExp(`\\b${name}\\s*:`), `router must expose playback.${name}`);
  }
  for (const legacy of ['getProgress', 'saveProgress', 'clearProgress']) {
    assert.match(routerText, new RegExp(`\\b${legacy}\\s*:`), `router must retain legacy ${legacy}`);
  }
  assert.match(routerText, /lib\/server\/playbackSession/, 'router must route new API via server facade');
  assert.match(routerText, /enforceProcedureRateLimit\('playback:beginSession'/, 'beginSession must reuse rate limit');
  assert.match(routerText, /enforceProcedureRateLimit\('playback:saveCheckpoint'/, 'saveCheckpoint must reuse rate limit');
  assert.match(routerText, /resolveSubject\(ctx\)/, 'router must reuse Subject');
  console.log('PASS: router surface verified');

  // —— §34 client 外观：7 方法全部暴露 ——
  console.log('--- client facade (§34) ---');
  for (const fn of [
    getPlaybackAnchor,
    beginPlaybackSession,
    savePlaybackCheckpoint,
    completePlaybackSession,
    clearPlaybackAnchor,
    promoteDraftPlaybackToWork,
    getWorkPlaybackProgressBatch,
  ]) {
    assert.strictEqual(typeof fn, 'function');
  }
  const legacyClientText = readRepoText('lib/client/playbackProgress.ts');
  assert.match(legacyClientText, /getProgress/, 'legacy client adapter must be retained');
  assert.match(legacyClientText, /saveProgress/, 'legacy client adapter must be retained');
  assert.match(legacyClientText, /clearProgress/, 'legacy client adapter must be retained');
  console.log('PASS: client facade verified');

  // —— server facade：7 函数 + 分态（M5-05：getAnchor / beginSession 真逻辑，其余 5 fail-closed） ——
  console.log('--- server facade (M5-05 split) ---');
  for (const fn of [
    getPlaybackAnchorForSubject,
    beginPlaybackSessionForSubject,
    savePlaybackCheckpointForSubject,
    completePlaybackSessionForSubject,
    clearPlaybackAnchorForSubject,
    promoteDraftPlaybackToWorkForSubject,
    getWorkPlaybackProgressBatchForSubject,
  ]) {
    assert.strictEqual(typeof fn, 'function');
  }
  const serverText = readRepoText('lib/server/playbackSession.ts');
  // M5-05：getAnchor / beginSession 已落真逻辑，facade 必然触库（getAnchor repair + begin upsert）。
  assert.strictEqual(/prisma\./.test(serverText), true, 'M5-05 facade must touch prisma for getAnchor/beginSession');
  // M5-05 真逻辑锚点：Work 只经 M2 边界 + 分段 SSOT + Draft 门禁 + UUID repair（源码文本锁死§36/§16/§33）。
  assert.match(serverText, /getStoryWorkForSubject/, 'beginSession work must go via M2 getStoryWorkForSubject');
  assert.match(serverText, /normalizeStoryText/, 'work total must via normalizeStoryText');
  assert.match(serverText, /segmentStoryText/, 'work total must via segmentStoryText');
  assert.match(serverText, /SEGMENTATION_VERSION/, 'resume must validate segmentationVersion');
  assert.match(serverText, /isValidDraftMessageId|REPLAY_TEXT_PREFIX/, 'draft must gate replay-text-* on server');
  assert.match(serverText, /createPlaybackSessionId|isValidPlaybackSessionId/, 'getAnchor must repair sessionId');
  // §36 禁止面：不得直查 StoryWork 表 / legacy DTO、不得重算 Work title/hash
  //（源码执行面锁死；注释提及不计，只查 prisma 直查与派生函数导入）。
  assert.strictEqual(/prisma\.storyWork/.test(serverText), false, 'M5-05 must not query StoryWork directly');
  assert.strictEqual(/prisma\.guestStoryWork/.test(serverText), false, 'M5-05 must not query GuestStoryWork directly');
  assert.strictEqual(/from\s+['"]@\/lib\/storyWork\/metadata['"]/.test(serverText), false, 'M5-05 must not import work metadata derivators');
  assert.strictEqual(/computeStoryContentHash\s*\(/.test(serverText), false, 'M5-05 must not recompute work contentHash');
  assert.strictEqual(/resolveStoryTitle\s*\(/.test(serverText), false, 'M5-05 must not recompute work title');
  // 其余 5 procedures 保持 fail-closed skeleton（不提前做 M5-06+ 语义；unit 不触库，直接断言抛错）。
  const guest = { type: 'guest', id: 'g_contract_probe' } as const;
  await assert.rejects(() =>
    savePlaybackCheckpointForSubject({ ...guest }, {
      sessionId: VALID_UUID,
      contentHash: '549c813b8b62',
      segmentationVersion: 'v1',
      lastCompletedParagraphIndex: 0,
      nextParagraphIndex: 1,
      totalParagraphs: 4,
      speed: 1.0,
    }),
  );
  await assert.rejects(() => completePlaybackSessionForSubject({ ...guest }, { sessionId: VALID_UUID }));
  await assert.rejects(() => clearPlaybackAnchorForSubject({ ...guest }, { sessionId: VALID_UUID }));
  await assert.rejects(() =>
    promoteDraftPlaybackToWorkForSubject({ ...guest }, { sessionId: VALID_UUID, workId: 5 }),
  );
  await assert.rejects(() => getWorkPlaybackProgressBatchForSubject({ ...guest }, { workIds: [1] }));
  console.log('PASS: server facade M5-05 split verified');

  console.log('\nALL PLAYBACK SESSION CONTRACT TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runPlaybackSessionContractTests()
  .then(() => {
    console.log('ALL PLAYBACK SESSION CONTRACT TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
