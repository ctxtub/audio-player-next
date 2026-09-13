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
  // 用 same-session resume（保持 session）直达 snapshot 门禁，避免被 resume guard 误拦。
  await assert.rejects(
    () =>
      beginPlaybackSessionForSubject(guestWork, {
        sessionId: workSession,
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
  // same-source resume 必须保持 session（resume guard）：drift 系列全程复用同一 sessionId。
  const resumeSession = newSessionId();
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
    sessionId: resumeSession,
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
    sessionId: resumeSession,
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
    sessionId: resumeSession,
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

  // —— 9. begin identity guard（评审 Blocking 1：restart / source-switch 必须新会话） ——
  // guard 发生在 restart Progress reset 之前：前两条须断言 Anchor/Progress DB unchanged。
  console.log('--- beginSession: identity guard (restart / source-switch new-session) ---');
  // 9.1 Work A/S → restart A/S → BAD_REQUEST，Anchor/Progress unchanged。
  const guestGuardRestart: Subject = { type: 'guest', id: makeGuestId('m505_guard_restart') };
  const guardRestartWork = await createStoryWorkForSubject(guestGuardRestart, {
    prompt: 'guard restart 提示词',
    storyText: STORY_TEXT,
  });
  const guardRestartSession = newSessionId();
  await beginPlaybackSessionForSubject(guestGuardRestart, {
    sessionId: guardRestartSession,
    source: { kind: 'work', workId: guardRestartWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  // 构造非零进度，使“若 guard 在 reset 之后”必可观测到脏写；快照后复用同 session restart 必须拒绝。
  await prisma.guestStoryPlaybackProgress.upsert({
    where: { storyWorkId: guardRestartWork.id },
    create: {
      storyWorkId: guardRestartWork.id,
      contentHash: guardRestartWork.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 0,
      nextParagraphIndex: 1,
      totalParagraphs: expectedTotalFor(STORY_TEXT),
      completedAt: null,
      lastPlayedAt: new Date('2026-09-10T00:00:00.000Z'),
    },
    update: {
      contentHash: guardRestartWork.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 0,
      nextParagraphIndex: 1,
      totalParagraphs: expectedTotalFor(STORY_TEXT),
      completedAt: null,
    },
  });
  const guardRestartAnchorBefore = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestGuardRestart.id },
  });
  const guardRestartProgressBefore = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: guardRestartWork.id },
  });
  assert(guardRestartAnchorBefore !== null && guardRestartProgressBefore !== null);
  assert.strictEqual(guardRestartAnchorBefore.sessionId, guardRestartSession);
  await assert.rejects(
    () =>
      beginPlaybackSessionForSubject(guestGuardRestart, {
        sessionId: guardRestartSession,
        source: { kind: 'work', workId: guardRestartWork.id },
        mode: 'restart',
        speed: 1.0,
      }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'restart with reused sessionId must BAD_REQUEST',
  );
  const guardRestartAnchorAfter = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestGuardRestart.id },
  });
  const guardRestartProgressAfter = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: guardRestartWork.id },
  });
  assert.deepStrictEqual(guardRestartAnchorAfter, guardRestartAnchorBefore);
  assert.deepStrictEqual(guardRestartProgressAfter, guardRestartProgressBefore);
  console.log('PASS: restart reuse rejected, Anchor/Progress unchanged');

  // 9.2 Work A/S → Work B/S → BAD_REQUEST，Anchor 仍 A，B progress 不产生/不修改。
  const guestGuardSwitch: Subject = { type: 'guest', id: makeGuestId('m505_guard_switch') };
  const guardWorkA = await createStoryWorkForSubject(guestGuardSwitch, {
    prompt: 'guard switch A 提示词',
    storyText: STORY_TEXT,
  });
  const guardWorkB = await createStoryWorkForSubject(guestGuardSwitch, {
    prompt: 'guard switch B 提示词',
    storyText: STORY_TEXT,
  });
  const guardSwitchSession = newSessionId();
  await beginPlaybackSessionForSubject(guestGuardSwitch, {
    sessionId: guardSwitchSession,
    source: { kind: 'work', workId: guardWorkA.id },
    mode: 'resume',
    speed: 1.0,
  });
  // B 尚无进度：切换必须拒绝且不产生 B 进度。
  assert.strictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: guardWorkB.id } }),
    null,
  );
  const guardSwitchAnchorBefore = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestGuardSwitch.id },
  });
  assert(guardSwitchAnchorBefore !== null);
  assert.strictEqual(guardSwitchAnchorBefore.sessionId, guardSwitchSession);
  assert.strictEqual(guardSwitchAnchorBefore.sourceId, String(guardWorkA.id));
  await assert.rejects(
    () =>
      beginPlaybackSessionForSubject(guestGuardSwitch, {
        sessionId: guardSwitchSession,
        source: { kind: 'work', workId: guardWorkB.id },
        mode: 'resume',
        speed: 1.0,
      }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'source-switch with reused sessionId must BAD_REQUEST',
  );
  const guardSwitchAnchorAfterNoCreate = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestGuardSwitch.id },
  });
  assert.deepStrictEqual(guardSwitchAnchorAfterNoCreate, guardSwitchAnchorBefore);
  assert.strictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: guardWorkB.id } }),
    null,
    'B progress must not be created on rejected switch',
  );
  // B 已有进度：切换必须拒绝且不修改 B 进度。
  await prisma.guestStoryPlaybackProgress.create({
    data: {
      storyWorkId: guardWorkB.id,
      contentHash: guardWorkB.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 0,
      nextParagraphIndex: 1,
      totalParagraphs: expectedTotalFor(STORY_TEXT),
      completedAt: null,
      lastPlayedAt: new Date('2026-09-10T00:00:00.000Z'),
    },
  });
  const guardWorkBProgressBefore = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: guardWorkB.id },
  });
  assert(guardWorkBProgressBefore !== null);
  await assert.rejects(
    () =>
      beginPlaybackSessionForSubject(guestGuardSwitch, {
        sessionId: guardSwitchSession,
        source: { kind: 'work', workId: guardWorkB.id },
        mode: 'resume',
        speed: 1.0,
      }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'source-switch with reused sessionId must BAD_REQUEST (existing B progress)',
  );
  assert.deepStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestGuardSwitch.id } }),
    guardSwitchAnchorBefore,
  );
  assert.deepStrictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: guardWorkB.id } }),
    guardWorkBProgressBefore,
  );
  console.log('PASS: source-switch reuse rejected, Anchor kept A, B progress untouched');

  // 9.3 Work A/S → resume A/S → allowed（continue 保持 session）。
  const guestGuardResume: Subject = { type: 'guest', id: makeGuestId('m505_guard_resume') };
  const guardResumeWork = await createStoryWorkForSubject(guestGuardResume, {
    prompt: 'guard resume 提示词',
    storyText: STORY_TEXT,
  });
  await prisma.guestStoryPlaybackProgress.create({
    data: {
      storyWorkId: guardResumeWork.id,
      contentHash: guardResumeWork.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 0,
      nextParagraphIndex: 1,
      totalParagraphs: expectedTotalFor(STORY_TEXT),
      completedAt: null,
      lastPlayedAt: new Date('2026-09-10T00:00:00.000Z'),
    },
  });
  const guardResumeSession = newSessionId();
  const guardResumeFirst = await beginPlaybackSessionForSubject(guestGuardResume, {
    sessionId: guardResumeSession,
    source: { kind: 'work', workId: guardResumeWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  assert.strictEqual(guardResumeFirst.sessionId, guardResumeSession);
  assert.strictEqual(guardResumeFirst.nextParagraphIndex, 1);
  const guardResumeSecond = await beginPlaybackSessionForSubject(guestGuardResume, {
    sessionId: guardResumeSession,
    source: { kind: 'work', workId: guardResumeWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  assert.strictEqual(guardResumeSecond.sessionId, guardResumeSession);
  assert.strictEqual(guardResumeSecond.nextParagraphIndex, 1);
  assert.strictEqual(guardResumeSecond.lastCompletedParagraphIndex, 0);
  console.log('PASS: same-source resume keeps session allowed');

  // 9.4 Work A/S → restart A/S2 → allowed，position 0，completedAt 保留。
  const guestGuardRestartNew: Subject = { type: 'guest', id: makeGuestId('m505_guard_new') };
  const guardNewWork = await createStoryWorkForSubject(guestGuardRestartNew, {
    prompt: 'guard new session 提示词',
    storyText: STORY_TEXT,
  });
  const guardNewTotal = expectedTotalFor(STORY_TEXT);
  const guardCompletedAt = new Date('2026-09-01T00:00:00.000Z');
  await prisma.guestStoryPlaybackProgress.create({
    data: {
      storyWorkId: guardNewWork.id,
      contentHash: guardNewWork.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: guardNewTotal - 1,
      nextParagraphIndex: guardNewTotal,
      totalParagraphs: guardNewTotal,
      completedAt: guardCompletedAt,
      lastPlayedAt: new Date('2026-09-02T00:00:00.000Z'),
    },
  });
  const guardNewSession = newSessionId();
  const guardNewSession2 = newSessionId();
  assert.notStrictEqual(guardNewSession2, guardNewSession);
  await beginPlaybackSessionForSubject(guestGuardRestartNew, {
    sessionId: guardNewSession,
    source: { kind: 'work', workId: guardNewWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  const guardNewRestart = await beginPlaybackSessionForSubject(guestGuardRestartNew, {
    sessionId: guardNewSession2,
    source: { kind: 'work', workId: guardNewWork.id },
    mode: 'restart',
    speed: 1.0,
  });
  assert.strictEqual(guardNewRestart.sessionId, guardNewSession2);
  assert.strictEqual(guardNewRestart.nextParagraphIndex, 0);
  assert.strictEqual(guardNewRestart.lastCompletedParagraphIndex, -1);
  const guardNewProgressAfter = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: guardNewWork.id },
  });
  assert(guardNewProgressAfter?.completedAt instanceof Date);
  assert.strictEqual(guardNewProgressAfter?.completedAt?.toISOString(), guardCompletedAt.toISOString());
  assert.strictEqual(guardNewProgressAfter?.nextParagraphIndex, 0);
  assert.strictEqual(guardNewProgressAfter?.lastCompletedParagraphIndex, -1);
  console.log('PASS: restart with new session allowed, position 0, completedAt kept');

  // 9.5 Work A/S1 → resume Work A/S2 → BAD_REQUEST，Anchor/Progress unchanged
  //（评审复审：resume 换 UUID 破坏 sessionId stale ownership 安全边界，必须拦截）。
  const guestGuardResumeNew: Subject = { type: 'guest', id: makeGuestId('m505_guard_resume_new') };
  const guardResumeNewWork = await createStoryWorkForSubject(guestGuardResumeNew, {
    prompt: 'guard resume new 提示词',
    storyText: STORY_TEXT,
  });
  const guardResumeNewSession = newSessionId();
  const guardResumeNewSession2 = newSessionId();
  assert.notStrictEqual(guardResumeNewSession2, guardResumeNewSession);
  await beginPlaybackSessionForSubject(guestGuardResumeNew, {
    sessionId: guardResumeNewSession,
    source: { kind: 'work', workId: guardResumeNewWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  await prisma.guestStoryPlaybackProgress.upsert({
    where: { storyWorkId: guardResumeNewWork.id },
    create: {
      storyWorkId: guardResumeNewWork.id,
      contentHash: guardResumeNewWork.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 0,
      nextParagraphIndex: 1,
      totalParagraphs: expectedTotalFor(STORY_TEXT),
      completedAt: null,
      lastPlayedAt: new Date('2026-09-10T00:00:00.000Z'),
    },
    update: {
      contentHash: guardResumeNewWork.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 0,
      nextParagraphIndex: 1,
      totalParagraphs: expectedTotalFor(STORY_TEXT),
      completedAt: null,
    },
  });
  const guardResumeNewAnchorBefore = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestGuardResumeNew.id },
  });
  const guardResumeNewProgressBefore = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: guardResumeNewWork.id },
  });
  assert(guardResumeNewAnchorBefore !== null && guardResumeNewProgressBefore !== null);
  assert.strictEqual(guardResumeNewAnchorBefore.sessionId, guardResumeNewSession);
  await assert.rejects(
    () =>
      beginPlaybackSessionForSubject(guestGuardResumeNew, {
        sessionId: guardResumeNewSession2,
        source: { kind: 'work', workId: guardResumeNewWork.id },
        mode: 'resume',
        speed: 1.0,
      }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'same-source resume with new sessionId must BAD_REQUEST',
  );
  assert.deepStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestGuardResumeNew.id } }),
    guardResumeNewAnchorBefore,
  );
  assert.deepStrictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({
      where: { storyWorkId: guardResumeNewWork.id },
    }),
    guardResumeNewProgressBefore,
  );
  console.log('PASS: same-source resume with new session rejected, Anchor/Progress unchanged');

  // 9.6 无 current Anchor → begin Work A/S1 → allowed（首次播放不被 resume guard 误伤）。
  const guestGuardFirst: Subject = { type: 'guest', id: makeGuestId('m505_guard_first') };
  const guardFirstWork = await createStoryWorkForSubject(guestGuardFirst, {
    prompt: 'guard first 提示词',
    storyText: STORY_TEXT,
  });
  assert.strictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestGuardFirst.id } }),
    null,
  );
  const guardFirstSession = newSessionId();
  const guardFirstAnchor = await beginPlaybackSessionForSubject(guestGuardFirst, {
    sessionId: guardFirstSession,
    source: { kind: 'work', workId: guardFirstWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  assert.strictEqual(guardFirstAnchor.sessionId, guardFirstSession);
  assert.deepStrictEqual(guardFirstAnchor.source, { kind: 'work', workId: guardFirstWork.id });
  assert.strictEqual(guardFirstAnchor.nextParagraphIndex, 0);
  console.log('PASS: first begin without anchor allowed');

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
