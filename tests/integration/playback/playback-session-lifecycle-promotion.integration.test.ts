import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import { TRPCError } from '@/lib/trpc/init';
import type { Subject } from '../../../lib/server/subject';
import {
  beginPlaybackSessionForSubject,
  clearPlaybackAnchorForSubject,
  completePlaybackSessionForSubject,
  getPlaybackAnchorForSubject,
  getWorkPlaybackProgressBatchForSubject,
  promoteDraftPlaybackToWorkForSubject,
  savePlaybackCheckpointForSubject,
} from '../../../lib/server/playbackSession';
import { createStoryWorkForSubject } from '../../../lib/server/storyWork';
import {
  SEGMENTATION_VERSION,
  normalizeStoryText,
  segmentStoryText,
} from '../../../utils/segmentation';
import { makeGuestId, makeUsername, makeMessageId } from '../../support/builders/auth-subject.builder';

/**
 * M5-07 Session Lifecycle & Draft→Work Promotion 真逻辑集成测试（L2）。
 * 覆盖 spec §40 / §41 / §42 / §45（本项范围；§43/44/46/47/48 属 M5-08/09）：
 * 1. §40：Work A=40%(in_progress)/B=completed/C=not_started 精确三分；
 *    播放 D 不得覆盖 A/B 长期 Progress；
 * 2. §41：last paragraph ended → Progress next=total+completedAt!=null +
 *    Anchor state=ended（不删 completion history）；重复 complete 幂等保留首完；
 * 3. §42：已完成 restart → new sessionId+position 0+completedAt 保留；
 *    播到一半 state=in_progress 但 completedAt 仍保留；
 * 4. §45：draft(message-1) paragraph 4/12 → promote work(51) 后 sessionId 不变+
 *    paragraph 4 + Work Progress 创建；hash 不一致 → reset 0；
 * 5. clearAnchor：无 Anchor/不匹配 no-op(cleared:false)；匹配清除；
 *    已 trash/missing Work 的 Anchor 照清；已 ended 照清；
 * 6. complete/promote 三校验 fail-closed（session 不匹配/非 draft/
 *    sourceMessageId 不一致一律抛错且不写库）；
 * 7. User/Guest 对称抽查。
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

async function runPlaybackSessionLifecyclePromotionTests(): Promise<void> {
  console.log('=== M5-07: Session Lifecycle & Draft→Work Promotion ===');

  // —— §40：A=40% / B=completed / C=not_started 精确三分（guest） ——
  console.log('--- §40: batch triple A(in_progress)/B(completed)/C(not_started) ---');
  const guest40: Subject = { type: 'guest', id: makeGuestId('m507_batch') };
  const text5 = makeStoryText(5);
  assert.strictEqual(expectedTotalFor(text5), 5);
  const workA = await createStoryWorkForSubject(guest40, {
    prompt: 'm507 A 提示词',
    storyText: text5,
    voiceId: 'voice-a',
  });
  const workB = await createStoryWorkForSubject(guest40, {
    prompt: 'm507 B 提示词',
    storyText: text5,
    voiceId: 'voice-b',
  });
  const workC = await createStoryWorkForSubject(guest40, {
    prompt: 'm507 C 提示词',
    storyText: text5,
  });
  // A：begin + save 到 40%（last=1/next=2/total=5）。
  const sessionA = newSessionId();
  await beginPlaybackSessionForSubject(guest40, {
    sessionId: sessionA,
    source: { kind: 'work', workId: workA.id },
    mode: 'resume',
    speed: 1.0,
  });
  const saveA = await savePlaybackCheckpointForSubject(guest40, {
    sessionId: sessionA,
    contentHash: workA.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: 5,
    speed: 1.0,
  });
  assert(saveA.accepted === true);
  // B：begin + complete → completed。
  const sessionB = newSessionId();
  await beginPlaybackSessionForSubject(guest40, {
    sessionId: sessionB,
    source: { kind: 'work', workId: workB.id },
    mode: 'resume',
    speed: 1.0,
  });
  const completedB = await completePlaybackSessionForSubject(guest40, { sessionId: sessionB });
  assert(completedB !== null);
  assert.strictEqual(completedB.state, 'ended');
  // C：不建进度，保持 not_started。
  const batchABC = await getWorkPlaybackProgressBatchForSubject(guest40, {
    workIds: [workA.id, workB.id, workC.id],
  });
  assert.strictEqual(batchABC.items.length, 3);
  assert.strictEqual(batchABC.items[0].workId, workA.id);
  assert.strictEqual(batchABC.items[1].workId, workB.id);
  assert.strictEqual(batchABC.items[2].workId, workC.id);
  // A 精确 40% in_progress。
  assert.strictEqual(batchABC.items[0].state, 'in_progress');
  assert.strictEqual(batchABC.items[0].progress, 2 / 5);
  assert.strictEqual(batchABC.items[0].lastCompletedParagraphIndex, 1);
  assert.strictEqual(batchABC.items[0].nextParagraphIndex, 2);
  assert.strictEqual(batchABC.items[0].totalParagraphs, 5);
  assert.strictEqual(batchABC.items[0].completedAt, null);
  assert(batchABC.items[0].lastPlayedAt !== null);
  // B 精确 completed。
  assert.strictEqual(batchABC.items[1].state, 'completed');
  assert.strictEqual(batchABC.items[1].progress, 1);
  assert.strictEqual(batchABC.items[1].lastCompletedParagraphIndex, 4);
  assert.strictEqual(batchABC.items[1].nextParagraphIndex, 5);
  assert.strictEqual(batchABC.items[1].totalParagraphs, 5);
  assert(batchABC.items[1].completedAt !== null);
  assert(batchABC.items[1].lastPlayedAt !== null);
  // C 精确 not_started 默认行。
  assert.strictEqual(batchABC.items[2].state, 'not_started');
  assert.strictEqual(batchABC.items[2].progress, 0);
  assert.strictEqual(batchABC.items[2].lastCompletedParagraphIndex, -1);
  assert.strictEqual(batchABC.items[2].nextParagraphIndex, 0);
  assert.strictEqual(batchABC.items[2].totalParagraphs, 1);
  assert.strictEqual(batchABC.items[2].completedAt, null);
  assert.strictEqual(batchABC.items[2].lastPlayedAt, null);
  console.log('PASS: §40 triple verified');

  // —— §40 后半：播放 D 不得覆盖 A/B ——
  console.log('--- §40: play D must not overwrite A/B ---');
  const workD = await createStoryWorkForSubject(guest40, {
    prompt: 'm507 D 提示词',
    storyText: text5,
  });
  const sessionD = newSessionId();
  await beginPlaybackSessionForSubject(guest40, {
    sessionId: sessionD,
    source: { kind: 'work', workId: workD.id },
    mode: 'resume',
    speed: 1.0,
  });
  const saveD = await savePlaybackCheckpointForSubject(guest40, {
    sessionId: sessionD,
    contentHash: workD.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: 5,
    speed: 1.0,
  });
  assert(saveD.accepted === true);
  // A/B 进度行逐字段 unchanged。
  const progressAAfterD = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: workA.id },
  });
  assert(progressAAfterD !== null);
  assert.strictEqual(progressAAfterD.lastCompletedParagraphIndex, 1);
  assert.strictEqual(progressAAfterD.nextParagraphIndex, 2);
  assert.strictEqual(progressAAfterD.totalParagraphs, 5);
  const progressBAfterD = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: workB.id },
  });
  assert(progressBAfterD !== null);
  assert.strictEqual(progressBAfterD.nextParagraphIndex, 5);
  assert.strictEqual(progressBAfterD.lastCompletedParagraphIndex, 4);
  assert(progressBAfterD.completedAt instanceof Date);
  const batchAfterD = await getWorkPlaybackProgressBatchForSubject(guest40, {
    workIds: [workA.id, workB.id],
  });
  assert.strictEqual(batchAfterD.items[0].progress, 2 / 5);
  assert.strictEqual(batchAfterD.items[0].state, 'in_progress');
  assert.strictEqual(batchAfterD.items[1].state, 'completed');
  assert.strictEqual(batchAfterD.items[1].progress, 1);
  // D 自身进度独立。
  const batchD = await getWorkPlaybackProgressBatchForSubject(guest40, { workIds: [workD.id] });
  assert.strictEqual(batchD.items[0].state, 'in_progress');
  assert.strictEqual(batchD.items[0].nextParagraphIndex, 1);
  console.log('PASS: §40 D isolation verified');

  // —— batch 跨主体隔离：foreign workId → not_started，不泄漏 ——
  console.log('--- batch: foreign workId fail-closed not_started ---');
  const guestForeign: Subject = { type: 'guest', id: makeGuestId('m507_foreign') };
  const foreignBatch = await getWorkPlaybackProgressBatchForSubject(guestForeign, {
    workIds: [workA.id],
  });
  assert.strictEqual(foreignBatch.items.length, 1);
  assert.strictEqual(foreignBatch.items[0].workId, workA.id);
  assert.strictEqual(foreignBatch.items[0].state, 'not_started');
  assert.strictEqual(foreignBatch.items[0].progress, 0);
  console.log('PASS: batch foreign isolation verified');

  // —— §41：Completion（guest work） ——
  console.log('--- §41: completion ended + progress retained ---');
  const guest41: Subject = { type: 'guest', id: makeGuestId('m507_complete') };
  const text4 = makeStoryText(4);
  assert.strictEqual(expectedTotalFor(text4), 4);
  const work41 = await createStoryWorkForSubject(guest41, {
    prompt: 'm507 completion 提示词',
    storyText: text4,
  });
  const session41 = newSessionId();
  await beginPlaybackSessionForSubject(guest41, {
    sessionId: session41,
    source: { kind: 'work', workId: work41.id },
    mode: 'resume',
    speed: 1.0,
  });
  // 推到 last paragraph 前一位置，再 complete。
  const preComplete = await savePlaybackCheckpointForSubject(guest41, {
    sessionId: session41,
    contentHash: work41.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 2,
    nextParagraphIndex: 3,
    totalParagraphs: 4,
    speed: 1.0,
  });
  assert(preComplete.accepted === true);
  const ended41 = await completePlaybackSessionForSubject(guest41, { sessionId: session41 });
  assert(ended41 !== null);
  assert.strictEqual(ended41.sessionId, session41);
  assert.deepStrictEqual(ended41.source, { kind: 'work', workId: work41.id });
  assert.strictEqual(ended41.state, 'ended');
  assert.strictEqual(ended41.nextParagraphIndex, 4);
  assert.strictEqual(ended41.lastCompletedParagraphIndex, 3);
  assert.strictEqual(ended41.totalParagraphs, 4);
  // Progress：next=total + completedAt!=null（不删 history）。
  const progress41 = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: work41.id },
  });
  assert(progress41 !== null, 'completion must retain progress history');
  assert.strictEqual(progress41.nextParagraphIndex, 4);
  assert.strictEqual(progress41.lastCompletedParagraphIndex, 3);
  assert.strictEqual(progress41.totalParagraphs, 4);
  assert(progress41.completedAt instanceof Date);
  assert(progress41.lastPlayedAt instanceof Date);
  const firstCompletedAt = progress41.completedAt?.toISOString();
  assert(firstCompletedAt !== undefined);
  // 幂等：重复 complete 不破坏（completedAt 保留首完，位置仍 total）。
  const ended41Again = await completePlaybackSessionForSubject(guest41, { sessionId: session41 });
  assert(ended41Again !== null);
  assert.strictEqual(ended41Again.state, 'ended');
  assert.strictEqual(ended41Again.nextParagraphIndex, 4);
  const progress41Again = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: work41.id },
  });
  assert(progress41Again !== null);
  assert.strictEqual(progress41Again.completedAt?.toISOString(), firstCompletedAt);
  assert.strictEqual(progress41Again.nextParagraphIndex, 4);
  // batch 视角 completed。
  const batch41 = await getWorkPlaybackProgressBatchForSubject(guest41, { workIds: [work41.id] });
  assert.strictEqual(batch41.items[0].state, 'completed');
  assert.strictEqual(batch41.items[0].progress, 1);
  assert.strictEqual(batch41.items[0].completedAt, firstCompletedAt);
  console.log('PASS: §41 completion verified');

  // —— complete fail-closed：无 Anchor → null；session 不匹配 → BAD_REQUEST 不覆盖 ——
  console.log('--- complete: fail-closed (no anchor / stale) ---');
  const guestNoAnchor: Subject = { type: 'guest', id: makeGuestId('m507_noanchor') };
  assert.strictEqual(await getPlaybackAnchorForSubject(guestNoAnchor), null);
  assert.strictEqual(
    await completePlaybackSessionForSubject(guestNoAnchor, { sessionId: newSessionId() }),
    null,
  );
  // stale：切到 B 后用 A session complete → BAD_REQUEST，B 不变。
  const guestStale: Subject = { type: 'guest', id: makeGuestId('m507_stale') };
  const staleWorkA = await createStoryWorkForSubject(guestStale, {
    prompt: 'm507 stale A 提示词',
    storyText: text5,
  });
  const staleWorkB = await createStoryWorkForSubject(guestStale, {
    prompt: 'm507 stale B 提示词',
    storyText: text5,
  });
  const staleSessionA = newSessionId();
  await beginPlaybackSessionForSubject(guestStale, {
    sessionId: staleSessionA,
    source: { kind: 'work', workId: staleWorkA.id },
    mode: 'resume',
    speed: 1.0,
  });
  const staleSessionB = newSessionId();
  const anchorStaleB = await beginPlaybackSessionForSubject(guestStale, {
    sessionId: staleSessionB,
    source: { kind: 'work', workId: staleWorkB.id },
    mode: 'resume',
    speed: 1.0,
  });
  await assert.rejects(
    () => completePlaybackSessionForSubject(guestStale, { sessionId: staleSessionA }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'stale complete must BAD_REQUEST',
  );
  assert.deepStrictEqual(await getPlaybackAnchorForSubject(guestStale), anchorStaleB);
  console.log('PASS: complete fail-closed verified');

  // —— draft complete：仅 ended，不建 Work progress ——
  console.log('--- complete: draft ended without work progress ---');
  const guestDraftDone: Subject = { type: 'guest', id: makeGuestId('m507_draft_done') };
  const draftDoneMsg = makeMessageId('m507_draft_done');
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestDraftDone.id,
      position: 0,
      messageId: draftDoneMsg,
      role: 'assistant',
      content: 'draft done story',
      parts: null,
    },
  });
  const siblingWork = await createStoryWorkForSubject(guestDraftDone, {
    prompt: 'm507 draft sibling 提示词',
    storyText: text5,
  });
  const draftDoneSession = newSessionId();
  await beginPlaybackSessionForSubject(guestDraftDone, {
    sessionId: draftDoneSession,
    source: { kind: 'draft', messageId: draftDoneMsg },
    mode: 'resume',
    speed: 1.0,
    draftSnapshot: { title: 'Draft 标题', contentHash: 'draft-hash-done', totalParagraphs: 3, voiceId: '' },
  });
  const draftEnded = await completePlaybackSessionForSubject(guestDraftDone, {
    sessionId: draftDoneSession,
  });
  assert(draftEnded !== null);
  assert.strictEqual(draftEnded.state, 'ended');
  assert.deepStrictEqual(draftEnded.source, { kind: 'draft', messageId: draftDoneMsg });
  assert.strictEqual(
    await prisma.guestStoryPlaybackProgress.findUnique({ where: { storyWorkId: siblingWork.id } }),
    null,
    'draft complete must not create work progress',
  );
  console.log('PASS: draft complete verified');

  // —— §42：Restart（已完成 → new session + 0 + completedAt 保留） ——
  console.log('--- §42: restart after completed preserves completedAt ---');
  // 复用 guest41 的已完成 work（completedAt=T1）。
  const restartSession = newSessionId();
  assert.notStrictEqual(restartSession, session41);
  const restartAnchor = await beginPlaybackSessionForSubject(guest41, {
    sessionId: restartSession,
    source: { kind: 'work', workId: work41.id },
    mode: 'restart',
    speed: 1.0,
  });
  assert.strictEqual(restartAnchor.sessionId, restartSession);
  assert.strictEqual(restartAnchor.nextParagraphIndex, 0);
  assert.strictEqual(restartAnchor.lastCompletedParagraphIndex, -1);
  assert.strictEqual(restartAnchor.state, 'ready');
  const progressAfterRestart = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: work41.id },
  });
  assert(progressAfterRestart !== null);
  assert.strictEqual(progressAfterRestart.completedAt?.toISOString(), firstCompletedAt);
  assert.strictEqual(progressAfterRestart.nextParagraphIndex, 0);
  // 播到一半：save next=1 → batch in_progress 但 completedAt 仍 T1。
  const halfSave = await savePlaybackCheckpointForSubject(guest41, {
    sessionId: restartSession,
    contentHash: work41.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: 4,
    speed: 1.0,
  });
  assert(halfSave.accepted === true);
  const batchHalf = await getWorkPlaybackProgressBatchForSubject(guest41, { workIds: [work41.id] });
  assert.strictEqual(batchHalf.items[0].state, 'in_progress');
  assert.strictEqual(batchHalf.items[0].completedAt, firstCompletedAt);
  assert.strictEqual(batchHalf.items[0].nextParagraphIndex, 1);
  console.log('PASS: §42 restart verified');

  // —— clearAnchor：no-op / 清除 / trash 照清 / ended 照清 ——
  console.log('--- clearAnchor: no-op vs clear vs trash ---');
  const guestClear: Subject = { type: 'guest', id: makeGuestId('m507_clear') };
  // 无 Anchor → cleared:false。
  assert.strictEqual(await getPlaybackAnchorForSubject(guestClear), null);
  assert.deepStrictEqual(
    await clearPlaybackAnchorForSubject(guestClear, { sessionId: newSessionId() }),
    { success: true, cleared: false },
  );
  // begin 后不匹配 → no-op，Anchor 不变。
  const clearWork = await createStoryWorkForSubject(guestClear, {
    prompt: 'm507 clear 提示词',
    storyText: text5,
  });
  const clearSession = newSessionId();
  const clearAnchor0 = await beginPlaybackSessionForSubject(guestClear, {
    sessionId: clearSession,
    source: { kind: 'work', workId: clearWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  assert.deepStrictEqual(
    await clearPlaybackAnchorForSubject(guestClear, { sessionId: newSessionId() }),
    { success: true, cleared: false },
  );
  assert.deepStrictEqual(await getPlaybackAnchorForSubject(guestClear), clearAnchor0);
  // 匹配 → cleared:true，Anchor 消失。
  assert.deepStrictEqual(await clearPlaybackAnchorForSubject(guestClear, { sessionId: clearSession }), {
    success: true,
    cleared: true,
  });
  assert.strictEqual(await getPlaybackAnchorForSubject(guestClear), null);
  // 重复清 → cleared:false（幂等 no-op）。
  assert.deepStrictEqual(await clearPlaybackAnchorForSubject(guestClear, { sessionId: clearSession }), {
    success: true,
    cleared: false,
  });
  // 已 trash Work 的 Anchor 照清：重建 Anchor 后 trash work，仍可按 session 清除。
  const clearSession2 = newSessionId();
  await beginPlaybackSessionForSubject(guestClear, {
    sessionId: clearSession2,
    source: { kind: 'work', workId: clearWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  await prisma.guestStoryWork.update({
    where: { id: clearWork.id },
    data: { deletedAt: new Date() },
  });
  assert.deepStrictEqual(
    await clearPlaybackAnchorForSubject(guestClear, { sessionId: clearSession2 }),
    { success: true, cleared: true },
  );
  assert.strictEqual(await getPlaybackAnchorForSubject(guestClear), null);
  // 已 ended 的 Anchor 照清。
  const guestClearEnded: Subject = { type: 'guest', id: makeGuestId('m507_clear_ended') };
  const clearEndedWork = await createStoryWorkForSubject(guestClearEnded, {
    prompt: 'm507 clear ended 提示词',
    storyText: text5,
  });
  const clearEndedSession = newSessionId();
  await beginPlaybackSessionForSubject(guestClearEnded, {
    sessionId: clearEndedSession,
    source: { kind: 'work', workId: clearEndedWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  const clearEndedAnchor = await completePlaybackSessionForSubject(guestClearEnded, {
    sessionId: clearEndedSession,
  });
  assert(clearEndedAnchor !== null && clearEndedAnchor.state === 'ended');
  assert.deepStrictEqual(
    await clearPlaybackAnchorForSubject(guestClearEnded, { sessionId: clearEndedSession }),
    { success: true, cleared: true },
  );
  assert.strictEqual(await getPlaybackAnchorForSubject(guestClearEnded), null);
  console.log('PASS: clearAnchor verified');

  // —— §45：Draft→Work Promotion（hash 一致保留段落） ——
  console.log('--- §45: draft(4/12) → work promotion keeps session + paragraph ---');
  const guest45: Subject = { type: 'guest', id: makeGuestId('m507_promote') };
  const text12 = makeStoryText(12);
  assert.strictEqual(expectedTotalFor(text12), 12);
  const draftMsg45 = makeMessageId('m507_promote_draft');
  await prisma.guestChatMessage.create({
    data: {
      guestId: guest45.id,
      position: 0,
      messageId: draftMsg45,
      role: 'assistant',
      content: 'draft 45 story',
      parts: null,
    },
  });
  // 先创建 Work（取权威 hash/voice/title），再以同 hash begin draft 到 4/12。
  const work45 = await createStoryWorkForSubject(guest45, {
    prompt: 'm507 promote 提示词',
    storyText: text12,
    voiceId: 'voice-45',
    sourceMessageId: draftMsg45,
  });
  assert.strictEqual(work45.sourceMessageId, draftMsg45);
  assert.strictEqual(expectedTotalFor(text12), 12);
  const draftSession45 = newSessionId();
  const draftAnchor45 = await beginPlaybackSessionForSubject(guest45, {
    sessionId: draftSession45,
    source: { kind: 'draft', messageId: draftMsg45 },
    mode: 'resume',
    speed: 1.5,
    draftSnapshot: {
      title: 'Draft 旧标题',
      contentHash: work45.contentHash,
      totalParagraphs: 12,
      voiceId: 'draft-voice',
    },
  });
  assert.strictEqual(draftAnchor45.nextParagraphIndex, 0);
  const draftSave45 = await savePlaybackCheckpointForSubject(guest45, {
    sessionId: draftSession45,
    contentHash: work45.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 3,
    nextParagraphIndex: 4,
    totalParagraphs: 12,
    speed: 1.5,
  });
  assert(draftSave45.accepted === true);
  assert.strictEqual(draftSave45.anchor.nextParagraphIndex, 4);
  // promotion：session 不变 + paragraph 4 + 取 Work 元数据 + 创建 Progress。
  const promoted45 = await promoteDraftPlaybackToWorkForSubject(guest45, {
    sessionId: draftSession45,
    workId: work45.id,
  });
  assert.strictEqual(promoted45.sessionId, draftSession45, 'promotion must keep sessionId');
  assert.deepStrictEqual(promoted45.source, { kind: 'work', workId: work45.id });
  assert.strictEqual(promoted45.title, work45.title);
  assert.strictEqual(promoted45.contentHash, work45.contentHash);
  assert.strictEqual(promoted45.voiceId, work45.voiceId);
  assert.strictEqual(promoted45.nextParagraphIndex, 4);
  assert.strictEqual(promoted45.lastCompletedParagraphIndex, 3);
  assert.strictEqual(promoted45.totalParagraphs, 12);
  assert.strictEqual(promoted45.speed, 1.5, 'promotion must preserve speed/timer context');
  // Work Progress 已创建且同值。
  const progress45 = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: work45.id },
  });
  assert(progress45 !== null, 'promotion must create work progress');
  assert.strictEqual(progress45.nextParagraphIndex, 4);
  assert.strictEqual(progress45.lastCompletedParagraphIndex, 3);
  assert.strictEqual(progress45.totalParagraphs, 12);
  assert.strictEqual(progress45.contentHash, work45.contentHash);
  // batch 视角 in_progress。
  const batch45 = await getWorkPlaybackProgressBatchForSubject(guest45, { workIds: [work45.id] });
  assert.strictEqual(batch45.items[0].state, 'in_progress');
  assert.strictEqual(batch45.items[0].nextParagraphIndex, 4);
  console.log('PASS: §45 promotion preserved verified');

  // —— §24.1：hash 不一致 → promotion 成功但 reset 0 ——
  console.log('--- §24.1: hash drift promotion resets to 0 ---');
  const guestDrift: Subject = { type: 'guest', id: makeGuestId('m507_drift') };
  const driftMsg = makeMessageId('m507_drift_draft');
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestDrift.id,
      position: 0,
      messageId: driftMsg,
      role: 'assistant',
      content: 'drift draft story',
      parts: null,
    },
  });
  const driftWork = await createStoryWorkForSubject(guestDrift, {
    prompt: 'm507 drift 提示词',
    storyText: text12,
    sourceMessageId: driftMsg,
  });
  assert.notStrictEqual(driftWork.contentHash, 'drift-old-hash-0000');
  const driftSession = newSessionId();
  await beginPlaybackSessionForSubject(guestDrift, {
    sessionId: driftSession,
    source: { kind: 'draft', messageId: driftMsg },
    mode: 'resume',
    speed: 1.0,
    draftSnapshot: {
      title: 'Drift Draft',
      contentHash: 'drift-old-hash-0000',
      totalParagraphs: 12,
      voiceId: '',
    },
  });
  const driftSave = await savePlaybackCheckpointForSubject(guestDrift, {
    sessionId: driftSession,
    contentHash: 'drift-old-hash-0000',
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 3,
    nextParagraphIndex: 4,
    totalParagraphs: 12,
    speed: 1.0,
  });
  assert(driftSave.accepted === true);
  const driftPromoted = await promoteDraftPlaybackToWorkForSubject(guestDrift, {
    sessionId: driftSession,
    workId: driftWork.id,
  });
  assert.strictEqual(driftPromoted.sessionId, driftSession);
  assert.deepStrictEqual(driftPromoted.source, { kind: 'work', workId: driftWork.id });
  assert.strictEqual(driftPromoted.contentHash, driftWork.contentHash);
  assert.strictEqual(driftPromoted.nextParagraphIndex, 0, 'hash drift must reset 0');
  assert.strictEqual(driftPromoted.lastCompletedParagraphIndex, -1);
  const driftProgress = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: driftWork.id },
  });
  assert(driftProgress !== null);
  assert.strictEqual(driftProgress.nextParagraphIndex, 0);
  assert.strictEqual(driftProgress.lastCompletedParagraphIndex, -1);
  console.log('PASS: §24.1 hash drift verified');

  // —— promote 三校验 fail-closed：session/非 draft/sourceMessageId ——
  console.log('--- promote: triple-guard fail-closed ---');
  const guestGuard: Subject = { type: 'guest', id: makeGuestId('m507_guard') };
  const guardMsg = makeMessageId('m507_guard_draft');
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestGuard.id,
      position: 0,
      messageId: guardMsg,
      role: 'assistant',
      content: 'guard draft',
      parts: null,
    },
  });
  const guardWork = await createStoryWorkForSubject(guestGuard, {
    prompt: 'm507 guard 提示词',
    storyText: text5,
    sourceMessageId: guardMsg,
  });
  const otherWork = await createStoryWorkForSubject(guestGuard, {
    prompt: 'm507 guard other 提示词',
    storyText: text5,
  });
  const guardSession = newSessionId();
  await beginPlaybackSessionForSubject(guestGuard, {
    sessionId: guardSession,
    source: { kind: 'draft', messageId: guardMsg },
    mode: 'resume',
    speed: 1.0,
    draftSnapshot: { title: 'G', contentHash: guardWork.contentHash, totalParagraphs: 5, voiceId: '' },
  });
  const guardAnchorBefore = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guestGuard.id },
  });
  assert(guardAnchorBefore !== null);
  // ① session 不匹配。
  await assert.rejects(
    () =>
      promoteDraftPlaybackToWorkForSubject(guestGuard, {
        sessionId: newSessionId(),
        workId: guardWork.id,
      }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'promote session mismatch must BAD_REQUEST',
  );
  // ② sourceMessageId 不一致（otherWork 未绑定 guardMsg）。
  await assert.rejects(
    () => promoteDraftPlaybackToWorkForSubject(guestGuard, { sessionId: guardSession, workId: otherWork.id }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'promote sourceMessageId mismatch must BAD_REQUEST',
  );
  // ③ 当前非 draft（先成功 promote 一次，再对 work anchor 二次 promote）。
  const guardPromoted = await promoteDraftPlaybackToWorkForSubject(guestGuard, {
    sessionId: guardSession,
    workId: guardWork.id,
  });
  assert.deepStrictEqual(guardPromoted.source, { kind: 'work', workId: guardWork.id });
  await assert.rejects(
    () => promoteDraftPlaybackToWorkForSubject(guestGuard, { sessionId: guardSession, workId: guardWork.id }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'promote on work source must BAD_REQUEST',
  );
  // fail-closed 的两次拒绝均未污染：Anchor 仍为首次 promote 结果（验证不回退）。
  const guardAnchorAfterReject = await getPlaybackAnchorForSubject(guestGuard);
  assert.deepStrictEqual(guardAnchorAfterReject, guardPromoted);
  console.log('PASS: promote triple-guard verified');

  // —— User 对称：batch triple + complete + clear + promote 各一 ——
  console.log('--- user symmetry: batch/complete/clear/promote ---');
  const userTag = makeUsername('m507_user');
  const testUser = await prisma.user.create({
    data: { username: userTag, password: 'TestPassword123!', nickname: 'M507' },
  });
  const userSubject: Subject = { type: 'user', id: testUser.id };
  const uWorkA = await createStoryWorkForSubject(userSubject, {
    prompt: 'm507 user A 提示词',
    storyText: text5,
  });
  const uWorkB = await createStoryWorkForSubject(userSubject, {
    prompt: 'm507 user B 提示词',
    storyText: text5,
  });
  const uWorkC = await createStoryWorkForSubject(userSubject, {
    prompt: 'm507 user C 提示词',
    storyText: text5,
  });
  const uSessionA = newSessionId();
  await beginPlaybackSessionForSubject(userSubject, {
    sessionId: uSessionA,
    source: { kind: 'work', workId: uWorkA.id },
    mode: 'resume',
    speed: 1.0,
  });
  await savePlaybackCheckpointForSubject(userSubject, {
    sessionId: uSessionA,
    contentHash: uWorkA.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: 5,
    speed: 1.0,
  });
  const uSessionB = newSessionId();
  await beginPlaybackSessionForSubject(userSubject, {
    sessionId: uSessionB,
    source: { kind: 'work', workId: uWorkB.id },
    mode: 'resume',
    speed: 1.0,
  });
  const uEndedB = await completePlaybackSessionForSubject(userSubject, { sessionId: uSessionB });
  assert(uEndedB !== null && uEndedB.state === 'ended');
  const uBatch = await getWorkPlaybackProgressBatchForSubject(userSubject, {
    workIds: [uWorkA.id, uWorkB.id, uWorkC.id],
  });
  assert.strictEqual(uBatch.items[0].state, 'in_progress');
  assert.strictEqual(uBatch.items[0].progress, 2 / 5);
  assert.strictEqual(uBatch.items[1].state, 'completed');
  assert.strictEqual(uBatch.items[2].state, 'not_started');
  // user clear：不匹配 no-op，匹配清除。
  assert.deepStrictEqual(
    await clearPlaybackAnchorForSubject(userSubject, { sessionId: newSessionId() }),
    { success: true, cleared: false },
  );
  assert.deepStrictEqual(await clearPlaybackAnchorForSubject(userSubject, { sessionId: uSessionB }), {
    success: true,
    cleared: true,
  });
  assert.strictEqual(await getPlaybackAnchorForSubject(userSubject), null);
  // user promote happy path。
  const uDraftMsg = makeMessageId('m507_user_draft');
  await prisma.chatMessage.create({
    data: {
      userId: testUser.id,
      position: 0,
      messageId: uDraftMsg,
      role: 'assistant',
      content: 'user draft',
      parts: null,
    },
  });
  const uWork = await createStoryWorkForSubject(userSubject, {
    prompt: 'm507 user promote 提示词',
    storyText: text5,
    sourceMessageId: uDraftMsg,
  });
  const uDraftSession = newSessionId();
  await beginPlaybackSessionForSubject(userSubject, {
    sessionId: uDraftSession,
    source: { kind: 'draft', messageId: uDraftMsg },
    mode: 'resume',
    speed: 1.0,
    draftSnapshot: { title: 'UD', contentHash: uWork.contentHash, totalParagraphs: 5, voiceId: '' },
  });
  await savePlaybackCheckpointForSubject(userSubject, {
    sessionId: uDraftSession,
    contentHash: uWork.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: 5,
    speed: 1.0,
  });
  const uPromoted = await promoteDraftPlaybackToWorkForSubject(userSubject, {
    sessionId: uDraftSession,
    workId: uWork.id,
  });
  assert.strictEqual(uPromoted.sessionId, uDraftSession);
  assert.deepStrictEqual(uPromoted.source, { kind: 'work', workId: uWork.id });
  assert.strictEqual(uPromoted.nextParagraphIndex, 2);
  const uProgress = await prisma.storyPlaybackProgress.findUnique({
    where: { storyWorkId: uWork.id },
  });
  assert(uProgress !== null && uProgress.nextParagraphIndex === 2);
  console.log('PASS: user symmetry verified');

  console.log('\nALL PLAYBACK SESSION LIFECYCLE PROMOTION TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runPlaybackSessionLifecyclePromotionTests()
  .then(() => {
    console.log('ALL PLAYBACK SESSION LIFECYCLE PROMOTION TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
