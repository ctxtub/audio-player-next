import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import type { Subject } from '../../../lib/server/subject';
import {
  beginPlaybackSessionForSubject,
  getPlaybackAnchorForSubject,
  promoteDraftPlaybackToWorkForSubject,
  savePlaybackCheckpointForSubject,
} from '../../../lib/server/playbackSession';
import { createStoryWorkForSubject } from '../../../lib/server/storyWork';
import {
  SEGMENTATION_VERSION,
  normalizeStoryText,
  segmentStoryText,
} from '../../../utils/segmentation';
import { makeGuestId, makeMessageId } from '../../support/builders/auth-subject.builder';

/**
 * M5-07 FIXUP checkpoint CAS 绑定 content identity 回归（L2，评审 Blocking 1）。
 *
 * 裁决场景：Draft D/session S/hash draftHash/next=4 → promote → Work W/session S/
 * hash workHash（≠draftHash）→ Anchor + WorkProgress reset 0。此时 promotion 前
 * 已发出的旧 saveCheckpoint(S, draftHash, next=4) 晚到：M5-06 CAS 只看
 * sessionId + monotonic → 双 PASS → 旧 checkpoint 复活（hash 被拉回 draftHash、
 * next 0→4），推翻 §24.1。seamless promotion 是唯一 source identity 改变而
 * sessionId 不变的 transition，故 CAS 必须补 content identity 维度。
 *
 * 确定性顺序（不做并发 barrier，顺序 await 即模拟“晚到”）：
 * P1. begin Draft D/S/hashA，checkpoint next=4；
 * P2. promote → Work W/hashB(≠hashA)，assert Anchor next=0 + WorkProgress next=0；
 * P3. 迟到 checkpoint saveCheckpoint(S, hashA, next=4)：assert Anchor
 *     source=work(W)/hash=hashB/next=0（accepted:true 安全 no-op，不伪装 STALE），
 *     WorkProgress hash=hashB/next=0 不变；
 * P4. 真正 Work checkpoint saveCheckpoint(S, hashB, next=1) → 正常成功；
 * P5. segmentationVersion mismatch 同类 case（只 segVersion 不同、hash 相同，
 *     且 next 前进）→ 旧包 no-op，Anchor/Progress 不变；
 * P6. content-hash 恰好相同 + version 相同的长草 seamless case → 旧包仍被吸收
 *    （同 next 改 speed 落库成功，证明是写成功而非 no-op）。
 * 全程隔离库（runner 注入 DATABASE_URL），不碰 dev.db/app.db。
 */

const newSessionId = (): string => crypto.randomUUID();

/** 生成 N 个独立长段落（每段 >80 且 <350，避免合并/拆分，总段数恒为 N）。 */
const makeStoryText = (paras: number): string => {
  const parts: string[] = [];
  for (let i = 1; i <= paras; i += 1) {
    parts.push(
      `第${i}章：故事段落内容填充足够长度以避免前向合并策略将其合并到相邻段落之中保持独立成段${'内容'.repeat(30)}尾${i}`,
    );
  }
  return parts.join('\n');
};

const expectedTotalFor = (text: string): number =>
  Math.max(1, segmentStoryText(normalizeStoryText(text)).length);

async function runCheckpointContentIdentityTests(): Promise<void> {
  console.log('=== M5-07 FIXUP: checkpoint CAS binds content identity ===');
  const text12 = makeStoryText(12);
  assert.strictEqual(expectedTotalFor(text12), 12);

  // —— P1. begin Draft D/S/hashA，checkpoint next=4 ——
  console.log('--- P1: begin draft D/S/hashA, checkpoint next=4 ---');
  const guest: Subject = { type: 'guest', id: makeGuestId('m507_fixup_identity') };
  const draftMsg = makeMessageId('m507_fixup_identity_draft');
  await prisma.guestChatMessage.create({
    data: {
      guestId: guest.id,
      position: 0,
      messageId: draftMsg,
      role: 'assistant',
      content: 'fixup identity draft story',
      parts: null,
    },
  });
  // 先创建 Work 取权威 hashB，再以与之不同的 hashA begin draft（§24.1 drift 前提）。
  const work = await createStoryWorkForSubject(guest, {
    prompt: 'm507 fixup identity 提示词',
    storyText: text12,
    voiceId: 'voice-fixup',
    sourceMessageId: draftMsg,
  });
  const hashB = work.contentHash;
  const hashA = 'fixup-old-draft-hash-0000';
  assert.notStrictEqual(hashB, hashA);
  const sessionS = newSessionId();
  await beginPlaybackSessionForSubject(guest, {
    sessionId: sessionS,
    source: { kind: 'draft', messageId: draftMsg },
    mode: 'resume',
    speed: 1.0,
    draftSnapshot: { title: 'Fixup Draft', contentHash: hashA, totalParagraphs: 12, voiceId: '' },
  });
  const draftSave = await savePlaybackCheckpointForSubject(guest, {
    sessionId: sessionS,
    contentHash: hashA,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 3,
    nextParagraphIndex: 4,
    totalParagraphs: 12,
    speed: 1.0,
  });
  assert(draftSave.accepted === true);
  assert.strictEqual(draftSave.anchor.nextParagraphIndex, 4);
  assert.strictEqual(draftSave.anchor.contentHash, hashA);
  console.log('PASS: P1 draft checkpoint next=4');

  // —— P2. promote → Work W/hashB，Anchor next=0 + WorkProgress next=0 ——
  console.log('--- P2: promote → work/hashB resets to 0 ---');
  const promoted = await promoteDraftPlaybackToWorkForSubject(guest, {
    sessionId: sessionS,
    workId: work.id,
  });
  assert.strictEqual(promoted.sessionId, sessionS, 'promotion must keep sessionId');
  assert.deepStrictEqual(promoted.source, { kind: 'work', workId: work.id });
  assert.strictEqual(promoted.contentHash, hashB);
  assert.strictEqual(promoted.nextParagraphIndex, 0, 'hash drift must reset 0 (§24.1)');
  assert.strictEqual(promoted.lastCompletedParagraphIndex, -1);
  const progressAfterPromote = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: work.id },
  });
  assert(progressAfterPromote !== null, 'promotion must create work progress');
  assert.strictEqual(progressAfterPromote.contentHash, hashB);
  assert.strictEqual(progressAfterPromote.nextParagraphIndex, 0);
  assert.strictEqual(progressAfterPromote.lastCompletedParagraphIndex, -1);
  console.log('PASS: P2 promotion reset verified');

  // —— P3. 迟到 checkpoint(S, hashA, next=4)：no-op，不复活 ——
  console.log('--- P3: late checkpoint(S, hashA, next=4) must no-op, never resurrect ---');
  const anchorRowBeforeLate = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guest.id },
  });
  assert(anchorRowBeforeLate !== null);
  const late = await savePlaybackCheckpointForSubject(guest, {
    sessionId: sessionS,
    contentHash: hashA,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 3,
    nextParagraphIndex: 4,
    totalParagraphs: 12,
    speed: 1.0,
  });
  // 关键契约：identity 失配是安全 no-op（accepted:true + 当前 Anchor），绝不伪装成 STALE。
  assert.strictEqual(late.accepted, true, 'identity-mismatch late packet must be accepted:true no-op, not STALE');
  assert(late.accepted === true);
  assert.deepStrictEqual(late.anchor.source, { kind: 'work', workId: work.id });
  assert.strictEqual(late.anchor.sessionId, sessionS);
  assert.strictEqual(late.anchor.contentHash, hashB, 'anchor hash must stay work hash');
  assert.strictEqual(late.anchor.nextParagraphIndex, 0, 'anchor next must stay 0 (§24.1 holds)');
  assert.strictEqual(late.anchor.lastCompletedParagraphIndex, -1);
  // DB 行级 unchanged：Anchor 整行 + WorkProgress 整行均不被旧包污染。
  assert.deepStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guest.id } }),
    anchorRowBeforeLate,
  );
  const progressAfterLate = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: work.id },
  });
  assert(progressAfterLate !== null);
  assert.strictEqual(progressAfterLate.contentHash, hashB);
  assert.strictEqual(progressAfterLate.segmentationVersion, SEGMENTATION_VERSION);
  assert.strictEqual(progressAfterLate.nextParagraphIndex, 0);
  assert.strictEqual(progressAfterLate.lastCompletedParagraphIndex, -1);
  assert.deepStrictEqual(await getPlaybackAnchorForSubject(guest), late.anchor);
  console.log('PASS: P3 late packet no-op, §24.1 holds');

  // —— P4. 真正 Work checkpoint(S, hashB, next=1) → 正常成功 ——
  console.log('--- P4: genuine work checkpoint(S, hashB, next=1) succeeds ---');
  const genuine = await savePlaybackCheckpointForSubject(guest, {
    sessionId: sessionS,
    contentHash: hashB,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: 12,
    speed: 1.0,
  });
  assert(genuine.accepted === true);
  assert(genuine.accepted === true);
  assert.deepStrictEqual(genuine.anchor.source, { kind: 'work', workId: work.id });
  assert.strictEqual(genuine.anchor.contentHash, hashB);
  assert.strictEqual(genuine.anchor.nextParagraphIndex, 1);
  const progressAfterGenuine = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: work.id },
  });
  assert(progressAfterGenuine !== null);
  assert.strictEqual(progressAfterGenuine.contentHash, hashB);
  assert.strictEqual(progressAfterGenuine.nextParagraphIndex, 1);
  assert.strictEqual(progressAfterGenuine.lastCompletedParagraphIndex, 0);
  console.log('PASS: P4 genuine work checkpoint advances');

  // —— P5. segmentationVersion mismatch（hash 相同、next 前进）→ 旧包 no-op ——
  console.log('--- P5: segVersion mismatch (same hash, forward next) must no-op ---');
  const anchorRowBeforeSeg = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guest.id },
  });
  const progressRowBeforeSeg = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: work.id },
  });
  assert(anchorRowBeforeSeg !== null && progressRowBeforeSeg !== null);
  // 若无 identity 绑定，next=2 前进包本会成功并把 version 写成旧值；现必须 no-op。
  const staleSeg = await savePlaybackCheckpointForSubject(guest, {
    sessionId: sessionS,
    contentHash: hashB,
    segmentationVersion: 'v0-legacy-seg',
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: 12,
    speed: 1.0,
  });
  assert.strictEqual(staleSeg.accepted, true, 'segVersion-mismatch packet must be accepted:true no-op');
  assert(staleSeg.accepted === true);
  assert.strictEqual(staleSeg.anchor.nextParagraphIndex, 1);
  assert.strictEqual(staleSeg.anchor.segmentationVersion, SEGMENTATION_VERSION);
  assert.deepStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guest.id } }),
    anchorRowBeforeSeg,
  );
  assert.deepStrictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: work.id } }),
    progressRowBeforeSeg,
  );
  console.log('PASS: P5 segVersion mismatch no-op');

  // —— P6. hash 相同 + version 相同的 seamless case → 旧包仍被吸收 ——
  console.log('--- P6: seamless same-hash/version old packet still absorbed ---');
  const guestSeamless: Subject = { type: 'guest', id: makeGuestId('m507_fixup_seamless') };
  const seamlessMsg = makeMessageId('m507_fixup_seamless_draft');
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestSeamless.id,
      position: 0,
      messageId: seamlessMsg,
      role: 'assistant',
      content: 'seamless draft story',
      parts: null,
    },
  });
  const seamlessWork = await createStoryWorkForSubject(guestSeamless, {
    prompt: 'm507 fixup seamless 提示词',
    storyText: text12,
    sourceMessageId: seamlessMsg,
  });
  const seamlessHash = seamlessWork.contentHash;
  const seamlessSession = newSessionId();
  await beginPlaybackSessionForSubject(guestSeamless, {
    sessionId: seamlessSession,
    source: { kind: 'draft', messageId: seamlessMsg },
    mode: 'resume',
    speed: 1.0,
    draftSnapshot: {
      title: 'Seamless Draft',
      contentHash: seamlessHash,
      totalParagraphs: 12,
      voiceId: '',
    },
  });
  const seamlessDraftSave = await savePlaybackCheckpointForSubject(guestSeamless, {
    sessionId: seamlessSession,
    contentHash: seamlessHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 3,
    nextParagraphIndex: 4,
    totalParagraphs: 12,
    speed: 1.0,
  });
  assert(seamlessDraftSave.accepted === true);
  // hash 一致 → promote 沿用段落 4（seamless 语义）。
  const seamlessPromoted = await promoteDraftPlaybackToWorkForSubject(guestSeamless, {
    sessionId: seamlessSession,
    workId: seamlessWork.id,
  });
  assert.strictEqual(seamlessPromoted.nextParagraphIndex, 4);
  assert.strictEqual(seamlessPromoted.contentHash, seamlessHash);
  // promotion 前发出的旧包（同 hash/version、同 next=4、仅 speed 不同）晚到：
  // CAS 命中 → 被吸收（speed 落库），而非 no-op。
  const seamlessLate = await savePlaybackCheckpointForSubject(guestSeamless, {
    sessionId: seamlessSession,
    contentHash: seamlessHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 3,
    nextParagraphIndex: 4,
    totalParagraphs: 12,
    speed: 2.5,
  });
  assert(seamlessLate.accepted === true);
  assert(seamlessLate.accepted === true);
  assert.deepStrictEqual(seamlessLate.anchor.source, { kind: 'work', workId: seamlessWork.id });
  assert.strictEqual(seamlessLate.anchor.contentHash, seamlessHash);
  assert.strictEqual(seamlessLate.anchor.nextParagraphIndex, 4);
  assert.strictEqual(seamlessLate.anchor.speed, 2.5, 'seamless old packet must be absorbed (speed written)');
  const seamlessAnchorRow = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestSeamless.id },
  });
  assert(seamlessAnchorRow !== null);
  assert.strictEqual(seamlessAnchorRow.speed, 2.5);
  assert.strictEqual(seamlessAnchorRow.nextParagraphIndex, 4);
  console.log('PASS: P6 seamless old packet absorbed');

  console.log('\nALL CHECKPOINT CONTENT IDENTITY TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runCheckpointContentIdentityTests()
  .then(() => {
    console.log('ALL CHECKPOINT CONTENT IDENTITY TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
