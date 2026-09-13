import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import type { Subject } from '../../../lib/server/subject';
import {
  getPlaybackAnchorForSubject,
  beginPlaybackSessionForSubject,
  savePlaybackCheckpointForSubject,
  conditionalUpdatePlaybackAnchorForSubject,
} from '../../../lib/server/playbackSession';
import { createStoryWorkForSubject } from '../../../lib/server/storyWork';
import {
  SEGMENTATION_VERSION,
  normalizeStoryText,
  segmentStoryText,
} from '../../../utils/segmentation';
import { makeGuestId, makeUsername, makeMessageId } from '../../support/builders/auth-subject.builder';

/**
 * M5-06 saveCheckpoint 真逻辑集成测试（L2）。
 * 覆盖 spec §17 / §17.1 / §17.2 / §18 / §39 强制验收：
 * 1. §39：begin A→save A→getAnchor 字段完全一致（含 Progress 同步）；
 * 2. §17.1：begin B 后 late save A → STALE_SESSION，Anchor remains B，
 *    B 不被 late A 污染（Anchor/Progress 均 unchanged，A Progress 亦不推进）；
 * 3. §17.2：同 Session incoming.next < existing.next → 不回退；
 *    forceReset 透传亦不得绕单调性（新 input 无此字段，server 忽略）；
 * 4. §18：source.kind==work 一事务同时 UPDATE Anchor + UPSERT Progress
 *    （两边同值，不许一边成功一边失败；User/Guest 对称）；
 * 5. Draft checkpoint 按 Anchor identity 只更新 Anchor，不做 Work progress；
 * 6. input 不收 source/title：透传亦忽略（Anchor source/title 不变）。
 * 全程隔离库（runner 注入 DATABASE_URL），不碰 dev.db/app.db。
 */

const newSessionId = (): string => crypto.randomUUID();

const STORY_TEXT =
  '第一章：出发\n\n第二章：历险\n第三章：归来\n这是一个很长很长的尾声，充满了各种细节和波折，让切分结果稳定可断言。';

const expectedTotalFor = (text: string): number =>
  Math.max(1, segmentStoryText(normalizeStoryText(text)).length);

async function runPlaybackCheckpointGuardsTests(): Promise<void> {
  console.log('=== M5-06: saveCheckpoint / Stale / Monotonic guards ===');
  const expectedTotal = expectedTotalFor(STORY_TEXT);

  // —— 1. §39：begin A→save A→getAnchor 字段完全一致（guest work） ——
  console.log('--- §39: begin A → save A → getAnchor identical ---');
  const guestA: Subject = { type: 'guest', id: makeGuestId('m506_guest_a') };
  const workA = await createStoryWorkForSubject(guestA, {
    prompt: 'm506 A 提示词',
    storyText: STORY_TEXT,
    voiceId: 'voice-a',
  });
  const sessionA = newSessionId();
  const anchorA0 = await beginPlaybackSessionForSubject(guestA, {
    sessionId: sessionA,
    source: { kind: 'work', workId: workA.id },
    mode: 'resume',
    speed: 1.0,
  });
  assert.strictEqual(anchorA0.sessionId, sessionA);
  assert.strictEqual(anchorA0.nextParagraphIndex, 0);
  const saveA1 = await savePlaybackCheckpointForSubject(guestA, {
    sessionId: sessionA,
    contentHash: workA.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: expectedTotal,
    speed: 1.25,
    remainingAllowedMs: 1500000,
    totalAllowedMs: 1800000,
  });
  assert.strictEqual(saveA1.accepted, true);
  assert(saveA1.accepted === true);
  const savedAnchorA1 = saveA1.anchor;
  assert.strictEqual(savedAnchorA1.sessionId, sessionA);
  assert.deepStrictEqual(savedAnchorA1.source, { kind: 'work', workId: workA.id });
  assert.strictEqual(savedAnchorA1.state, 'ready');
  assert.strictEqual(savedAnchorA1.title, workA.title);
  assert.strictEqual(savedAnchorA1.contentHash, workA.contentHash);
  assert.strictEqual(savedAnchorA1.segmentationVersion, SEGMENTATION_VERSION);
  assert.strictEqual(savedAnchorA1.lastCompletedParagraphIndex, 0);
  assert.strictEqual(savedAnchorA1.nextParagraphIndex, 1);
  assert.strictEqual(savedAnchorA1.totalParagraphs, expectedTotal);
  assert.strictEqual(savedAnchorA1.voiceId, workA.voiceId);
  assert.strictEqual(savedAnchorA1.speed, 1.25);
  assert.strictEqual(savedAnchorA1.remainingAllowedMs, 1500000);
  assert.strictEqual(savedAnchorA1.totalAllowedMs, 1800000);
  // pause 后 getAnchor 回读完全一致。
  const fetchedA1 = await getPlaybackAnchorForSubject(guestA);
  assert.deepStrictEqual(fetchedA1, savedAnchorA1);
  // §18：Progress 同步同值。
  const progressA1 = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: workA.id },
  });
  assert(progressA1 !== null, 'work checkpoint must UPSERT progress');
  assert.strictEqual(progressA1.contentHash, workA.contentHash);
  assert.strictEqual(progressA1.segmentationVersion, SEGMENTATION_VERSION);
  assert.strictEqual(progressA1.lastCompletedParagraphIndex, 0);
  assert.strictEqual(progressA1.nextParagraphIndex, 1);
  assert.strictEqual(progressA1.totalParagraphs, expectedTotal);
  assert.strictEqual(progressA1.completedAt, null);
  assert(progressA1.lastPlayedAt instanceof Date);
  console.log('PASS: §39 begin/save/getAnchor identical + progress synced');

  // —— 2. §39 + §17.1：begin B → late save A → STALE，Anchor remains B，B 不被污染 ——
  console.log('--- §17.1: begin B → late save A → STALE, Anchor remains B ---');
  const workB = await createStoryWorkForSubject(guestA, {
    prompt: 'm506 B 提示词',
    storyText: STORY_TEXT,
    voiceId: 'voice-b',
  });
  const sessionB = newSessionId();
  assert.notStrictEqual(sessionB, sessionA);
  const anchorB0 = await beginPlaybackSessionForSubject(guestA, {
    sessionId: sessionB,
    source: { kind: 'work', workId: workB.id },
    mode: 'resume',
    speed: 1.0,
  });
  assert.strictEqual(anchorB0.sessionId, sessionB);
  assert.deepStrictEqual(anchorB0.source, { kind: 'work', workId: workB.id });
  assert.strictEqual(anchorB0.nextParagraphIndex, 0);
  // B 刚 begin：尚无 Progress（begin 不预建，留给 checkpoint UPSERT）。
  assert.strictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: workB.id } }),
    null,
  );
  // 快照 B 的 Anchor 行（用于 unchanged 断言）。
  const anchorRowBBefore = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestA.id },
  });
  assert(anchorRowBBefore !== null);
  assert.strictEqual(anchorRowBBefore.sessionId, sessionB);
  assert.strictEqual(anchorRowBBefore.sourceId, String(workB.id));
  // late A：sessionA 已 stale，即使 next 前进亦必须拒绝。
  const lateA = await savePlaybackCheckpointForSubject(guestA, {
    sessionId: sessionA,
    contentHash: workA.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: expectedTotal,
    speed: 1.25,
  });
  assert.deepStrictEqual(lateA, { accepted: false, reason: 'STALE_SESSION' });
  // Anchor remains B（getAnchor + DB 行均 unchanged）。
  const fetchedAfterLate = await getPlaybackAnchorForSubject(guestA);
  assert.deepStrictEqual(fetchedAfterLate, anchorB0);
  assert.deepStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestA.id } }),
    anchorRowBBefore,
  );
  // B 不被 late A 污染：B Progress 仍 null（未被创建/覆盖）。
  assert.strictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: workB.id } }),
    null,
    'B progress must not be created by late A',
  );
  // A Progress 亦不被 late A 推进（仍为 1）。
  const progressAAfterLate = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: workA.id },
  });
  assert(progressAAfterLate !== null);
  assert.strictEqual(progressAAfterLate.nextParagraphIndex, 1);
  assert.strictEqual(progressAAfterLate.lastCompletedParagraphIndex, 0);
  console.log('PASS: stale late save rejected, Anchor remains B, B unpolluted');

  // —— 3. §17.2：同 Session 不可回退；forceReset 不得绕单调性；input 不收 source/title ——
  console.log('--- §17.2: monotonic guard, no forceReset bypass, no source/title ---');
  const guestM: Subject = { type: 'guest', id: makeGuestId('m506_mono') };
  const workM = await createStoryWorkForSubject(guestM, {
    prompt: 'm506 mono 提示词',
    storyText: STORY_TEXT,
  });
  const sessionM = newSessionId();
  await beginPlaybackSessionForSubject(guestM, {
    sessionId: sessionM,
    source: { kind: 'work', workId: workM.id },
    mode: 'resume',
    speed: 1.0,
  });
  const fwd = await savePlaybackCheckpointForSubject(guestM, {
    sessionId: sessionM,
    contentHash: workM.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert(fwd.accepted === true);
  assert.strictEqual(fwd.anchor.nextParagraphIndex, 2);
  const anchorRowFwd = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestM.id },
  });
  const progressRowFwd = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: workM.id },
  });
  assert(anchorRowFwd !== null && progressRowFwd !== null);
  // 回退 next=1 → 不允许：accepted:true + 现有 Anchor 原样，DB 不变。
  const regress = await savePlaybackCheckpointForSubject(guestM, {
    sessionId: sessionM,
    contentHash: workM.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert(regress.accepted === true);
  assert.strictEqual(regress.anchor.nextParagraphIndex, 2);
  assert.deepStrictEqual(regress.anchor, fwd.anchor);
  assert.deepStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestM.id } }),
    anchorRowFwd,
  );
  assert.deepStrictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: workM.id } }),
    progressRowFwd,
  );
  // forceReset 透传不得绕单调性：即使携带 forceReset:true + next=0，仍不回退。
  const forceBypass = await savePlaybackCheckpointForSubject(
    guestM,
    {
      sessionId: sessionM,
      contentHash: workM.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: -1,
      nextParagraphIndex: 0,
      totalParagraphs: expectedTotal,
      speed: 1.0,
      forceReset: true,
    } as unknown as Parameters<typeof savePlaybackCheckpointForSubject>[1],
  );
  assert(forceBypass.accepted === true);
  assert.strictEqual(
    forceBypass.accepted === true ? forceBypass.anchor.nextParagraphIndex : -999,
    2,
    'forceReset must not bypass monotonic guard',
  );
  assert.deepStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestM.id } }),
    anchorRowFwd,
  );
  assert.deepStrictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: workM.id } }),
    progressRowFwd,
  );
  // source/title 透传亦忽略：Anchor source/title 不变。
  const evilSource = await savePlaybackCheckpointForSubject(
    guestM,
    {
      sessionId: sessionM,
      contentHash: workM.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 1,
      nextParagraphIndex: 2,
      totalParagraphs: expectedTotal,
      speed: 1.0,
      source: { kind: 'work', workId: 999999 },
      title: '伪造标题',
    } as unknown as Parameters<typeof savePlaybackCheckpointForSubject>[1],
  );
  assert(evilSource.accepted === true);
  assert(evilSource.accepted === true);
  assert.deepStrictEqual(evilSource.anchor.source, { kind: 'work', workId: workM.id });
  assert.strictEqual(evilSource.anchor.title, workM.title);
  // 同值 next 允许更新附属字段（speed/timers）：单调 guard 仅拦回退。
  const sameNext = await savePlaybackCheckpointForSubject(guestM, {
    sessionId: sessionM,
    contentHash: workM.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: expectedTotal,
    speed: 1.5,
    remainingAllowedMs: 900000,
    totalAllowedMs: 1800000,
  });
  assert(sameNext.accepted === true);
  assert.strictEqual(sameNext.anchor.nextParagraphIndex, 2);
  assert.strictEqual(sameNext.anchor.speed, 1.5);
  assert.strictEqual(sameNext.anchor.remainingAllowedMs, 900000);
  console.log('PASS: monotonic + no forceReset bypass + no source/title verified');

  // —— 4. Draft checkpoint：按 Anchor identity，只更新 Anchor，不做 Work progress ——
  console.log('--- draft checkpoint: anchor only, no work progress ---');
  const guestD: Subject = { type: 'guest', id: makeGuestId('m506_draft') };
  const draftMsg = makeMessageId('m506_draft');
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestD.id,
      position: 0,
      messageId: draftMsg,
      role: 'assistant',
      content: 'draft story',
      parts: null,
    },
  });
  // 同主体另建一个 Work（用于证明 draft save 不碰 Work progress）。
  const draftSiblingWork = await createStoryWorkForSubject(guestD, {
    prompt: 'm506 draft sibling 提示词',
    storyText: STORY_TEXT,
  });
  const sessionD = newSessionId();
  const draftAnchor0 = await beginPlaybackSessionForSubject(guestD, {
    sessionId: sessionD,
    source: { kind: 'draft', messageId: draftMsg },
    mode: 'resume',
    speed: 1.0,
    draftSnapshot: { title: 'Draft 标题', contentHash: 'draft-hash-m506', totalParagraphs: 3, voiceId: 'v-d' },
  });
  assert.deepStrictEqual(draftAnchor0.source, { kind: 'draft', messageId: draftMsg });
  const draftSave = await savePlaybackCheckpointForSubject(guestD, {
    sessionId: sessionD,
    contentHash: 'draft-hash-m506',
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: 3,
    speed: 2.0,
  });
  assert(draftSave.accepted === true);
  assert.strictEqual(draftSave.anchor.nextParagraphIndex, 1);
  assert.strictEqual(draftSave.anchor.speed, 2.0);
  assert.deepStrictEqual(draftSave.anchor.source, { kind: 'draft', messageId: draftMsg });
  assert.strictEqual(draftSave.anchor.title, 'Draft 标题');
  assert.deepStrictEqual(await getPlaybackAnchorForSubject(guestD), draftSave.anchor);
  // draft 不做 Work progress：sibling Work 仍无进度。
  assert.strictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: draftSiblingWork.id } }),
    null,
    'draft checkpoint must not create work progress',
  );
  // draft 单调：回退亦不允许。
  const draftRegress = await savePlaybackCheckpointForSubject(guestD, {
    sessionId: sessionD,
    contentHash: 'draft-hash-m506',
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: -1,
    nextParagraphIndex: 0,
    totalParagraphs: 3,
    speed: 2.0,
  });
  assert(draftRegress.accepted === true);
  assert.strictEqual(draftRegress.anchor.nextParagraphIndex, 1);
  console.log('PASS: draft checkpoint verified');

  // —— 5. 无 Anchor → STALE（绝不凭空创建） ——
  console.log('--- no anchor → STALE ---');
  const guestEmpty: Subject = { type: 'guest', id: makeGuestId('m506_empty') };
  assert.strictEqual(await getPlaybackAnchorForSubject(guestEmpty), null);
  const noAnchorSave = await savePlaybackCheckpointForSubject(guestEmpty, {
    sessionId: newSessionId(),
    contentHash: 'abc12345',
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: 2,
    speed: 1.0,
  });
  assert.deepStrictEqual(noAnchorSave, { accepted: false, reason: 'STALE_SESSION' });
  assert.strictEqual(await getPlaybackAnchorForSubject(guestEmpty), null);
  assert.strictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestEmpty.id } }),
    null,
  );
  console.log('PASS: no anchor stale verified');

  // —— 6. User 对称：§39 + stale + monotonic + 事务 ——
  console.log('--- user symmetry: §39 + stale + monotonic + transaction ---');
  const userTag = makeUsername('m506_user');
  const testUser = await prisma.user.create({
    data: { username: userTag, password: 'TestPassword123!', nickname: 'M506' },
  });
  const userSubject: Subject = { type: 'user', id: testUser.id };
  const userWorkA = await createStoryWorkForSubject(userSubject, {
    prompt: 'm506 user A 提示词',
    storyText: STORY_TEXT,
    voiceId: 'user-voice-a',
  });
  const userSessionA = newSessionId();
  await beginPlaybackSessionForSubject(userSubject, {
    sessionId: userSessionA,
    source: { kind: 'work', workId: userWorkA.id },
    mode: 'resume',
    speed: 1.0,
  });
  const userSaveA = await savePlaybackCheckpointForSubject(userSubject, {
    sessionId: userSessionA,
    contentHash: userWorkA.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert(userSaveA.accepted === true);
  assert.deepStrictEqual(await getPlaybackAnchorForSubject(userSubject), userSaveA.anchor);
  const userProgressA = await prisma.storyPlaybackProgress.findUnique({
    where: { storyWorkId: userWorkA.id },
  });
  assert(userProgressA !== null);
  assert.strictEqual(userProgressA.nextParagraphIndex, 1);
  // begin B + late A → STALE，B 不变。
  const userWorkB = await createStoryWorkForSubject(userSubject, {
    prompt: 'm506 user B 提示词',
    storyText: STORY_TEXT,
  });
  const userSessionB = newSessionId();
  const userAnchorB = await beginPlaybackSessionForSubject(userSubject, {
    sessionId: userSessionB,
    source: { kind: 'work', workId: userWorkB.id },
    mode: 'resume',
    speed: 1.0,
  });
  const userLateA = await savePlaybackCheckpointForSubject(userSubject, {
    sessionId: userSessionA,
    contentHash: userWorkA.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert.deepStrictEqual(userLateA, { accepted: false, reason: 'STALE_SESSION' });
  assert.deepStrictEqual(await getPlaybackAnchorForSubject(userSubject), userAnchorB);
  assert.strictEqual(
    await prisma.storyPlaybackProgress.findUnique({ where: { storyWorkId: userWorkB.id } }),
    null,
    'user B progress must not be polluted by late A',
  );
  assert.strictEqual(
    (await prisma.storyPlaybackProgress.findUnique({ where: { storyWorkId: userWorkA.id } }))?.nextParagraphIndex,
    1,
  );
  // 同 Session 单调（user）：B 前进到 1 后回退到 0 → 保持 1。
  const userFwdB = await savePlaybackCheckpointForSubject(userSubject, {
    sessionId: userSessionB,
    contentHash: userWorkB.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert(userFwdB.accepted === true);
  const userBackB = await savePlaybackCheckpointForSubject(userSubject, {
    sessionId: userSessionB,
    contentHash: userWorkB.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: -1,
    nextParagraphIndex: 0,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert(userBackB.accepted === true);
  assert.strictEqual(userBackB.anchor.nextParagraphIndex, 1);
  // user draft 对称抽查。
  const userDraftMsg = makeMessageId('m506_user_draft');
  await prisma.chatMessage.create({
    data: {
      userId: testUser.id,
      position: 0,
      messageId: userDraftMsg,
      role: 'assistant',
      content: 'user draft',
      parts: null,
    },
  });
  const userDraftSession = newSessionId();
  await beginPlaybackSessionForSubject(userSubject, {
    sessionId: userDraftSession,
    source: { kind: 'draft', messageId: userDraftMsg },
    mode: 'resume',
    speed: 1.0,
    draftSnapshot: { title: 'User Draft', contentHash: 'uh-m506', totalParagraphs: 2, voiceId: '' },
  });
  const userDraftSave = await savePlaybackCheckpointForSubject(userSubject, {
    sessionId: userDraftSession,
    contentHash: 'uh-m506',
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: 2,
    speed: 1.0,
  });
  assert(userDraftSave.accepted === true);
  assert.deepStrictEqual(userDraftSave.anchor.source, { kind: 'draft', messageId: userDraftMsg });
  console.log('PASS: user symmetry verified');

  // —— 7. R1（评审 Blocking 1 回归）：Stale CAS 竞争 ——
  // 旧 S1 拿旧 snapshot 后 DB Anchor 切成 S2/B；S1 conditional write 必须 count=0，
  // B/S2 Anchor + B progress 不变（防 guard 后 write 前切换穿透）。
  console.log('--- R1: stale CAS race (S1 snapshot vs DB switched to S2/B) ---');
  const guestR1: Subject = { type: 'guest', id: makeGuestId('m506_r1_stale_cas') };
  const workR1A = await createStoryWorkForSubject(guestR1, {
    prompt: 'm506 R1 A 提示词',
    storyText: STORY_TEXT,
    voiceId: 'voice-r1a',
  });
  const workR1B = await createStoryWorkForSubject(guestR1, {
    prompt: 'm506 R1 B 提示词',
    storyText: STORY_TEXT,
    voiceId: 'voice-r1b',
  });
  const sessionR1A = newSessionId();
  await beginPlaybackSessionForSubject(guestR1, {
    sessionId: sessionR1A,
    source: { kind: 'work', workId: workR1A.id },
    mode: 'resume',
    speed: 1.0,
  });
  const r1aSave = await savePlaybackCheckpointForSubject(guestR1, {
    sessionId: sessionR1A,
    contentHash: workR1A.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert(r1aSave.accepted === true);
  // 旧 S1 快照：若只看快照，next=2 看似可写；随后 DB Anchor 切到 B/S2（模拟并发 begin）。
  const staleNextR1 = 2;
  const sessionR1B = newSessionId();
  const anchorR1B = await beginPlaybackSessionForSubject(guestR1, {
    sessionId: sessionR1B,
    source: { kind: 'work', workId: workR1B.id },
    mode: 'resume',
    speed: 1.0,
  });
  assert.strictEqual(anchorR1B.sessionId, sessionR1B);
  assert.deepStrictEqual(anchorR1B.source, { kind: 'work', workId: workR1B.id });
  const anchorRowR1BBefore = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestR1.id },
  });
  assert(anchorRowR1BBefore !== null);
  assert.strictEqual(anchorRowR1BBefore.sessionId, sessionR1B);
  // S1 conditional write 以 DB 当前值为准：session 已变 → count=0，绝不穿透覆盖 B。
  const r1count = await conditionalUpdatePlaybackAnchorForSubject(
    guestR1,
    sessionR1A,
    staleNextR1,
    {
      contentHash: workR1A.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 1,
      nextParagraphIndex: staleNextR1,
      totalParagraphs: expectedTotal,
      speed: 1.0,
      remainingAllowedMs: null,
      totalAllowedMs: null,
    },
  );
  assert.strictEqual(r1count, 0, 'stale conditional write must affect 0 rows');
  // B/S2 Anchor 不变，B progress 仍 null（未被创建/覆盖），A progress 仍为 1。
  assert.deepStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestR1.id } }),
    anchorRowR1BBefore,
  );
  assert.deepStrictEqual(await getPlaybackAnchorForSubject(guestR1), anchorR1B);
  assert.strictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: workR1B.id } }),
    null,
    'R1: B progress must stay null after stale CAS',
  );
  const progressR1A = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: workR1A.id },
  });
  assert(progressR1A !== null);
  assert.strictEqual(progressR1A.nextParagraphIndex, 1);
  assert.strictEqual(progressR1A.lastCompletedParagraphIndex, 0);
  // facade 层面 late S1 亦 STALE，且同样不污染 B（CAS 失败绝不碰 WorkProgress）。
  const r1late = await savePlaybackCheckpointForSubject(guestR1, {
    sessionId: sessionR1A,
    contentHash: workR1A.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: staleNextR1,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert.deepStrictEqual(r1late, { accepted: false, reason: 'STALE_SESSION' });
  assert.deepStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestR1.id } }),
    anchorRowR1BBefore,
  );
  assert.strictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: workR1B.id } }),
    null,
    'R1: B progress must stay null after facade late save',
  );
  console.log('PASS: R1 stale CAS race verified');

  // —— 8. R2（评审 Blocking 1 回归）：Monotonic CAS 竞争 ——
  // same session DB 已推进 next=4；旧 snapshot 发 next=3；conditional write 必须
  // count=0，最终仍为 4（防同 Session 两 checkpoint 竞争回写）。
  console.log('--- R2: monotonic CAS race (DB next=4 vs stale incoming next=3) ---');
  const guestR2: Subject = { type: 'guest', id: makeGuestId('m506_r2_mono_cas') };
  const workR2 = await createStoryWorkForSubject(guestR2, {
    prompt: 'm506 R2 提示词',
    storyText: STORY_TEXT,
  });
  const sessionR2 = newSessionId();
  await beginPlaybackSessionForSubject(guestR2, {
    sessionId: sessionR2,
    source: { kind: 'work', workId: workR2.id },
    mode: 'resume',
    speed: 1.0,
  });
  const r2fwd = await savePlaybackCheckpointForSubject(guestR2, {
    sessionId: sessionR2,
    contentHash: workR2.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 3,
    nextParagraphIndex: 4,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert(r2fwd.accepted === true);
  assert.strictEqual(r2fwd.anchor.nextParagraphIndex, 4);
  const anchorRowR2Fwd = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestR2.id },
  });
  const progressRowR2Fwd = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: workR2.id },
  });
  assert(anchorRowR2Fwd !== null && progressRowR2Fwd !== null);
  assert.strictEqual(anchorRowR2Fwd.nextParagraphIndex, 4);
  assert.strictEqual(progressRowR2Fwd.nextParagraphIndex, 4);
  // 旧 snapshot（incoming next=3）conditional write：DB next=4 > 3 → count=0。
  const r2count = await conditionalUpdatePlaybackAnchorForSubject(
    guestR2,
    sessionR2,
    3,
    {
      contentHash: workR2.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 2,
      nextParagraphIndex: 3,
      totalParagraphs: expectedTotal,
      speed: 1.0,
      remainingAllowedMs: null,
      totalAllowedMs: null,
    },
  );
  assert.strictEqual(r2count, 0, 'monotonic conditional write must affect 0 rows');
  // 最终仍为 4：Anchor 行 + Progress 行均 unchanged。
  assert.deepStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestR2.id } }),
    anchorRowR2Fwd,
  );
  assert.deepStrictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: workR2.id } }),
    progressRowR2Fwd,
  );
  assert.deepStrictEqual(await getPlaybackAnchorForSubject(guestR2), r2fwd.anchor);
  // facade 同值回退亦 monotonic no-op（accepted:true + 当前 Anchor），DB 不变。
  const r2back = await savePlaybackCheckpointForSubject(guestR2, {
    sessionId: sessionR2,
    contentHash: workR2.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 2,
    nextParagraphIndex: 3,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert(r2back.accepted === true);
  assert.strictEqual(r2back.anchor.nextParagraphIndex, 4);
  assert.deepStrictEqual(r2back.anchor, r2fwd.anchor);
  assert.deepStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestR2.id } }),
    anchorRowR2Fwd,
  );
  assert.deepStrictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: workR2.id } }),
    progressRowR2Fwd,
  );
  console.log('PASS: R2 monotonic CAS race verified');

  console.log('\nALL PLAYBACK CHECKPOINT GUARDS TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runPlaybackCheckpointGuardsTests()
  .then(() => {
    console.log('ALL PLAYBACK CHECKPOINT GUARDS TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
