import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import { TRPCError } from '@/lib/trpc/init';
import type { Subject } from '../../../lib/server/subject';
import {
  getPlaybackAnchorForSubject,
  beginPlaybackSessionForSubject,
} from '../../../lib/server/playbackSession';
import { createStoryWorkForSubject } from '../../../lib/server/storyWork';
import { isValidPlaybackSessionId } from '../../../lib/playback/session';
import {
  SEGMENTATION_VERSION,
  normalizeStoryText,
  segmentStoryText,
} from '../../../utils/segmentation';
import { makeGuestId, makeUsername, makeMessageId } from '../../support/builders/auth-subject.builder';

/**
 * M5-05 getAnchor / beginSession 真逻辑集成测试（L2）。
 * 覆盖 spec §15 / §16 / §33 / §36 强制验收：
 * 1. getAnchor 无 Anchor → null；
 * 2. sessionId null/invalid → repair 生成 UUID 并写回；
 * 3. legacy chat→draft / generation→work 归一（含写回）；
 * 4. Work begin：metadata 只取 M2（不信任 snapshot；Work 携 snapshot 即 BAD_REQUEST；
 *    trash/foreign 统一 NOT_FOUND；total 经 normalize/segment 计算）；
 * 5. Work resume 一致→继续；hash/version 漂移→reset 0 + 更新 Progress hash/version；
 * 6. Work restart：position→0、保留 completedAt、创建新 sessionId；
 * 7. Draft begin：messageId 须属于当前 Subject（跨主体 NOT_FOUND）；
 *    server 拒绝 replay-text-*（BAD_REQUEST，不落库）。
 * 全程隔离库（runner 注入 DATABASE_URL），不碰 dev.db/app.db。
 */

const newSessionId = (): string => crypto.randomUUID();
const INVALID_SESSION_IDS = [
  'not-a-uuid',
  'msg-legacy-id',
  '00000000-0000-0000-0000-000000000000',
  '6ec0bd7f-11c0-11d1-9100-00aa00b548e1',
  'f47ac10b-58cc-4372-c567-0e02b2c3d479',
];

const STORY_TEXT =
  '第一章：出发\n\n第二章：历险\n第三章：归来\n这是一个很长很长的尾声，充满了各种细节和波折，让切分结果稳定可断言。';

const expectedTotalFor = (text: string): number =>
  Math.max(1, segmentStoryText(normalizeStoryText(text)).length);

async function runPlaybackAnchorBeginSessionTests(): Promise<void> {
  console.log('=== M5-05: getAnchor / beginSession ===');

  // —— 1. getAnchor 无 Anchor → null ——
  console.log('--- getAnchor: no anchor → null ---');
  const guestEmpty: Subject = { type: 'guest', id: makeGuestId('m505_empty') };
  assert.strictEqual(await getPlaybackAnchorForSubject(guestEmpty), null);
  console.log('PASS: no anchor → null');

  // —— 2. sessionId null/invalid → repair 写回 ——
  console.log('--- getAnchor: sessionId null/invalid → repair ---');
  const guestRepair: Subject = { type: 'guest', id: makeGuestId('m505_repair') };
  const repairMsg = makeMessageId('repair_draft');
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestRepair.id,
      position: 0,
      messageId: repairMsg,
      role: 'assistant',
      content: 'repair seed',
      parts: null,
    },
  });
  // 先以 null 落库（§33 nullable schema 保留，repair 在 getAnchor）。
  await prisma.guestPlaybackAnchor.create({
    data: {
      guestId: guestRepair.id,
      sourceKind: 'draft',
      sourceId: repairMsg,
      sessionId: null,
      anchorState: 'ready',
      title: 'Repair Draft',
      contentHash: 'abc123',
      segmentationVersion: 'v1',
      lastCompletedParagraphIndex: -1,
      nextParagraphIndex: 0,
      totalParagraphs: 2,
      voiceId: '',
      speed: 1.0,
      remainingAllowedMs: null,
      totalAllowedMs: null,
      isOneShot: true,
    },
  });
  const repairedNull = await getPlaybackAnchorForSubject(guestRepair);
  assert(repairedNull !== null, 'null sessionId must repair to DTO');
  assert.strictEqual(isValidPlaybackSessionId(repairedNull.sessionId), true);
  const afterNull = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestRepair.id },
  });
  assert.strictEqual(afterNull?.sessionId, repairedNull.sessionId);
  assert.strictEqual(isValidPlaybackSessionId(afterNull?.sessionId), true);
  // invalid 逐值 repair：每次写回脏值，getAnchor 必须生成新 UUID 并持久化。
  for (const bad of INVALID_SESSION_IDS) {
    await prisma.guestPlaybackAnchor.update({
      where: { guestId: guestRepair.id },
      data: { sessionId: bad },
    });
    const beforeSession: string | null | undefined = (
      await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestRepair.id } })
    )?.sessionId;
    assert.strictEqual(beforeSession, bad);
    const dto = await getPlaybackAnchorForSubject(guestRepair);
    assert(dto !== null, `invalid ${bad} must repair`);
    assert.strictEqual(isValidPlaybackSessionId(dto.sessionId), true);
    assert.notStrictEqual(dto.sessionId, bad);
    const persistedSession: string | null | undefined = (
      await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestRepair.id } })
    )?.sessionId;
    assert.strictEqual(persistedSession, dto.sessionId);
  }
  // repair 后二次读取不再改写（幂等：sessionId 稳定）。
  const stableOnce = await getPlaybackAnchorForSubject(guestRepair);
  const stableTwice = await getPlaybackAnchorForSubject(guestRepair);
  assert(stableOnce !== null && stableTwice !== null);
  assert.strictEqual(stableOnce.sessionId, stableTwice.sessionId);
  console.log('PASS: sessionId repair verified');

  // —— 3. legacy chat/generation 归一 ——
  console.log('--- getAnchor: legacy kind normalization ---');
  const guestLegacy: Subject = { type: 'guest', id: makeGuestId('m505_legacy') };
  const legacyDraftMsg = makeMessageId('legacy_draft');
  await prisma.guestPlaybackAnchor.create({
    data: {
      guestId: guestLegacy.id,
      sourceKind: 'chat',
      sourceId: legacyDraftMsg,
      sessionId: newSessionId(),
      anchorState: 'ready',
      title: 'Legacy Chat',
      contentHash: 'h1',
      segmentationVersion: 'v1',
      lastCompletedParagraphIndex: -1,
      nextParagraphIndex: 0,
      totalParagraphs: 1,
      voiceId: '',
      speed: 1.0,
      remainingAllowedMs: null,
      totalAllowedMs: null,
      isOneShot: true,
    },
  });
  const legacyDto = await getPlaybackAnchorForSubject(guestLegacy);
  assert(legacyDto !== null);
  assert.deepStrictEqual(legacyDto.source, { kind: 'draft', messageId: legacyDraftMsg });
  const legacyRow = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestLegacy.id },
  });
  assert.strictEqual(legacyRow?.sourceKind, 'draft');
  console.log('PASS: legacy normalization verified');

  // —— 4. Work begin（M2 边界 + total 计算 + snapshot 门禁 + trash/foreign） ——
  console.log('--- beginSession: work begin via M2 ---');
  const guestWork: Subject = { type: 'guest', id: makeGuestId('m505_work') };
  const created = await createStoryWorkForSubject(guestWork, {
    prompt: 'm505 提示词',
    storyText: STORY_TEXT,
    voiceId: 'voice-m505',
  });
  const expectedTotal = expectedTotalFor(STORY_TEXT);
  const workSession = newSessionId();
  const workAnchor = await beginPlaybackSessionForSubject(guestWork, {
    sessionId: workSession,
    source: { kind: 'work', workId: created.id },
    mode: 'resume',
    speed: 1.25,
  });
  assert.strictEqual(workAnchor.sessionId, workSession);
  assert.deepStrictEqual(workAnchor.source, { kind: 'work', workId: created.id });
  assert.strictEqual(workAnchor.state, 'ready');
  assert.strictEqual(workAnchor.title, created.title);
  assert.strictEqual(workAnchor.contentHash, created.contentHash);
  assert.strictEqual(workAnchor.voiceId, created.voiceId);
  assert.strictEqual(workAnchor.segmentationVersion, SEGMENTATION_VERSION);
  assert.strictEqual(workAnchor.totalParagraphs, expectedTotal);
  assert.strictEqual(workAnchor.lastCompletedParagraphIndex, -1);
  assert.strictEqual(workAnchor.nextParagraphIndex, 0);
  assert.strictEqual(workAnchor.speed, 1.25);
  // getAnchor 回读一致。
  const workRehydrated = await getPlaybackAnchorForSubject(guestWork);
  assert.deepStrictEqual(workRehydrated, workAnchor);
  // Work 携 draftSnapshot 即 BAD_REQUEST（§16：snapshot 仅限 Draft）。
  await assert.rejects(
    () =>
      beginPlaybackSessionForSubject(guestWork, {
        sessionId: newSessionId(),
        source: { kind: 'work', workId: created.id },
        mode: 'resume',
        speed: 1.0,
        draftSnapshot: { title: '伪造', contentHash: 'fake', totalParagraphs: 9, voiceId: 'evil' },
      }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'work with draftSnapshot must BAD_REQUEST',
  );
  // trash 后 begin 统一 NOT_FOUND（经 M2 deletedAt 门禁原样透出）。
  const guestTrash: Subject = { type: 'guest', id: makeGuestId('m505_trash') };
  const trashWork = await createStoryWorkForSubject(guestTrash, {
    prompt: 'trash 提示词',
    storyText: STORY_TEXT,
  });
  await prisma.guestStoryWork.update({
    where: { id: trashWork.id },
    data: { deletedAt: new Date() },
  });
  await assert.rejects(
    () =>
      beginPlaybackSessionForSubject(guestTrash, {
        sessionId: newSessionId(),
        source: { kind: 'work', workId: trashWork.id },
        mode: 'resume',
        speed: 1.0,
      }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'NOT_FOUND');
      return true;
    },
    'trashed work begin must NOT_FOUND',
  );
  // 跨主体 work 统一 NOT_FOUND。
  const guestForeign: Subject = { type: 'guest', id: makeGuestId('m505_foreign') };
  await assert.rejects(
    () =>
      beginPlaybackSessionForSubject(guestForeign, {
        sessionId: newSessionId(),
        source: { kind: 'work', workId: created.id },
        mode: 'resume',
        speed: 1.0,
      }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'NOT_FOUND');
      return true;
    },
    'foreign work begin must NOT_FOUND',
  );
  console.log('PASS: work begin M2 boundary verified');

  // —— 5. resume 一致→继续；hash/version 漂移→reset 0 + 更新 Progress ——
  console.log('--- beginSession: resume drift ---');
  const guestResume: Subject = { type: 'guest', id: makeGuestId('m505_resume') };
  const resumeWork = await createStoryWorkForSubject(guestResume, {
    prompt: 'resume 提示词',
    storyText: STORY_TEXT,
  });
  const resumeTotal = expectedTotalFor(STORY_TEXT);
  // 先建立一致进度（next=1），resume 应继续。
  await prisma.guestStoryPlaybackProgress.create({
    data: {
      storyWorkId: resumeWork.id,
      contentHash: resumeWork.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 0,
      nextParagraphIndex: 1,
      totalParagraphs: resumeTotal,
      completedAt: null,
      lastPlayedAt: new Date(),
    },
  });
  const resumeKept = await beginPlaybackSessionForSubject(guestResume, {
    sessionId: newSessionId(),
    source: { kind: 'work', workId: resumeWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  assert.strictEqual(resumeKept.nextParagraphIndex, 1);
  assert.strictEqual(resumeKept.lastCompletedParagraphIndex, 0);
  // hash 漂移：篡改 Progress hash，resume 必须 reset 0 并回写 hash/version。
  await prisma.guestStoryPlaybackProgress.update({
    where: { storyWorkId: resumeWork.id },
    data: {
      contentHash: 'drifted-hash-0000',
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 2,
      nextParagraphIndex: 3,
      totalParagraphs: resumeTotal,
    },
  });
  const resumeReset = await beginPlaybackSessionForSubject(guestResume, {
    sessionId: newSessionId(),
    source: { kind: 'work', workId: resumeWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  assert.strictEqual(resumeReset.nextParagraphIndex, 0);
  assert.strictEqual(resumeReset.lastCompletedParagraphIndex, -1);
  const afterDrift = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: resumeWork.id },
  });
  assert.strictEqual(afterDrift?.contentHash, resumeWork.contentHash);
  assert.strictEqual(afterDrift?.segmentationVersion, SEGMENTATION_VERSION);
  assert.strictEqual(afterDrift?.nextParagraphIndex, 0);
  assert.strictEqual(afterDrift?.lastCompletedParagraphIndex, -1);
  // version 漂移同样 reset。
  await prisma.guestStoryPlaybackProgress.update({
    where: { storyWorkId: resumeWork.id },
    data: {
      contentHash: resumeWork.contentHash,
      segmentationVersion: 'v0-legacy',
      lastCompletedParagraphIndex: 1,
      nextParagraphIndex: 2,
    },
  });
  const versionReset = await beginPlaybackSessionForSubject(guestResume, {
    sessionId: newSessionId(),
    source: { kind: 'work', workId: resumeWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  assert.strictEqual(versionReset.nextParagraphIndex, 0);
  const afterVersion = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: resumeWork.id },
  });
  assert.strictEqual(afterVersion?.segmentationVersion, SEGMENTATION_VERSION);
  console.log('PASS: resume drift verified');

  // —— 6. restart：新 UUID + 保留 completedAt + position 0 ——
  console.log('--- beginSession: restart preserves completedAt ---');
  const guestRestart: Subject = { type: 'guest', id: makeGuestId('m505_restart') };
  const restartWork = await createStoryWorkForSubject(guestRestart, {
    prompt: 'restart 提示词',
    storyText: STORY_TEXT,
  });
  const completedAt = new Date('2026-09-01T00:00:00.000Z');
  await prisma.guestStoryPlaybackProgress.create({
    data: {
      storyWorkId: restartWork.id,
      contentHash: restartWork.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: resumeTotal - 1,
      nextParagraphIndex: resumeTotal,
      totalParagraphs: resumeTotal,
      completedAt,
      lastPlayedAt: new Date('2026-09-02T00:00:00.000Z'),
    },
  });
  const restartSession = newSessionId();
  const restartAnchor = await beginPlaybackSessionForSubject(guestRestart, {
    sessionId: restartSession,
    source: { kind: 'work', workId: restartWork.id },
    mode: 'restart',
    speed: 1.0,
  });
  assert.strictEqual(restartAnchor.sessionId, restartSession);
  assert.strictEqual(restartAnchor.nextParagraphIndex, 0);
  assert.strictEqual(restartAnchor.lastCompletedParagraphIndex, -1);
  const afterRestart = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: restartWork.id },
  });
  assert(afterRestart?.completedAt instanceof Date);
  assert.strictEqual(afterRestart?.completedAt?.toISOString(), completedAt.toISOString());
  assert.strictEqual(afterRestart?.nextParagraphIndex, 0);
  assert.strictEqual(afterRestart?.lastCompletedParagraphIndex, -1);
  console.log('PASS: restart verified');

  // —— 7. Draft begin：归属校验 + replay 拒绝 ——
  console.log('--- beginSession: draft ownership ---');
  const guestDraftOwner: Subject = { type: 'guest', id: makeGuestId('m505_draft_owner') };
  const guestDraftOther: Subject = { type: 'guest', id: makeGuestId('m505_draft_other') };
  const draftMsg = makeMessageId('draft_ok');
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestDraftOwner.id,
      position: 0,
      messageId: draftMsg,
      role: 'assistant',
      content: 'draft story',
      parts: null,
    },
  });
  const draftSession = newSessionId();
  const draftAnchor = await beginPlaybackSessionForSubject(guestDraftOwner, {
    sessionId: draftSession,
    source: { kind: 'draft', messageId: draftMsg },
    mode: 'resume',
    speed: 1.5,
    draftSnapshot: { title: 'Draft 标题', contentHash: 'draft-hash-1', totalParagraphs: 3, voiceId: 'v-d' },
  });
  assert.strictEqual(draftAnchor.sessionId, draftSession);
  assert.deepStrictEqual(draftAnchor.source, { kind: 'draft', messageId: draftMsg });
  assert.strictEqual(draftAnchor.title, 'Draft 标题');
  assert.strictEqual(draftAnchor.contentHash, 'draft-hash-1');
  assert.strictEqual(draftAnchor.totalParagraphs, 3);
  assert.strictEqual(draftAnchor.voiceId, 'v-d');
  assert.strictEqual(draftAnchor.nextParagraphIndex, 0);
  // 非当前 Subject 拒绝（NOT_FOUND，不泄露归属）。
  await assert.rejects(
    () =>
      beginPlaybackSessionForSubject(guestDraftOther, {
        sessionId: newSessionId(),
        source: { kind: 'draft', messageId: draftMsg },
        mode: 'resume',
        speed: 1.0,
        draftSnapshot: { title: 'T', contentHash: 'h', totalParagraphs: 1, voiceId: '' },
      }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'NOT_FOUND');
      return true;
    },
    'foreign draft must NOT_FOUND',
  );
  // replay-text-* server 拒绝（BAD_REQUEST，且不落库）。
  const replayId = `replay-text-${Date.now()}`;
  await assert.rejects(
    () =>
      beginPlaybackSessionForSubject(guestDraftOwner, {
        sessionId: newSessionId(),
        source: { kind: 'draft', messageId: replayId },
        mode: 'resume',
        speed: 1.0,
        draftSnapshot: { title: 'T', contentHash: 'h', totalParagraphs: 1, voiceId: '' },
      }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'replay-text-* must BAD_REQUEST',
  );
  const replayAnchorRow = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestDraftOwner.id },
  });
  assert.notStrictEqual(replayAnchorRow?.sourceId, replayId, 'replay id must never persist');
  console.log('PASS: draft ownership verified');

  // —— 8. User 对称路径（work + draft 各一） ——
  console.log('--- beginSession: user symmetry ---');
  const userTag = makeUsername('m505_user');
  const testUser = await prisma.user.create({
    data: { username: userTag, password: 'TestPassword123!', nickname: 'M505' },
  });
  const userSubject: Subject = { type: 'user', id: testUser.id };
  const userWork = await createStoryWorkForSubject(userSubject, {
    prompt: 'user 提示词',
    storyText: STORY_TEXT,
    voiceId: 'user-voice',
  });
  const userWorkAnchor = await beginPlaybackSessionForSubject(userSubject, {
    sessionId: newSessionId(),
    source: { kind: 'work', workId: userWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  assert.deepStrictEqual(userWorkAnchor.source, { kind: 'work', workId: userWork.id });
  assert.strictEqual(userWorkAnchor.title, userWork.title);
  const userMsg = makeMessageId('user_draft');
  await prisma.chatMessage.create({
    data: {
      userId: testUser.id,
      position: 0,
      messageId: userMsg,
      role: 'assistant',
      content: 'user draft',
      parts: null,
    },
  });
  const userDraftAnchor = await beginPlaybackSessionForSubject(userSubject, {
    sessionId: newSessionId(),
    source: { kind: 'draft', messageId: userMsg },
    mode: 'restart',
    speed: 1.0,
    draftSnapshot: { title: 'User Draft', contentHash: 'uh1', totalParagraphs: 2, voiceId: '' },
  });
  assert.deepStrictEqual(userDraftAnchor.source, { kind: 'draft', messageId: userMsg });
  // user 侧 repair：脏 sessionId 写回。
  await prisma.userPlaybackAnchor.update({
    where: { userId: testUser.id },
    data: { sessionId: 'bad-session' },
  });
  const userRepaired = await getPlaybackAnchorForSubject(userSubject);
  assert(userRepaired !== null);
  assert.strictEqual(isValidPlaybackSessionId(userRepaired.sessionId), true);
  console.log('PASS: user symmetry verified');

  console.log('\nALL PLAYBACK ANCHOR BEGIN SESSION TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runPlaybackAnchorBeginSessionTests()
  .then(() => {
    console.log('ALL PLAYBACK ANCHOR BEGIN SESSION TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
