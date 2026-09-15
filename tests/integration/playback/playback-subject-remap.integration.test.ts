import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import type { Subject } from '../../../lib/server/subject';
import {
  beginPlaybackSessionForSubject,
  getPlaybackAnchorForSubject,
  getWorkPlaybackProgressBatchForSubject,
  savePlaybackCheckpointForSubject,
} from '../../../lib/server/playbackSession';
import { createStoryWorkForSubject } from '../../../lib/server/storyWork';
import {
  migrateGuestCreativeRecordsToUser,
  migrateGuestPlaybackProgressToUser,
} from '../../../lib/server/unifiedMigration';
import { SEGMENTATION_VERSION, normalizeStoryText, segmentStoryText } from '../../../utils/segmentation';
import { makeGuestId } from '../../support/builders/auth-subject.builder';

/**
 * M5-08 Subject Migration：Guest→User Anchor/WorkProgress remap 集成测试（L2）。
 * 覆盖 spec §31 / §31.1 / §31.2 / §31.3 / §31.4 / §46（本项范围；§47 由
 * exec-login-existing-no-leak 覆盖登录不迁移，本文件另断言“不碰其它用户数据”）：
 * 1. §46：Guest Anchor work(35)+Progress work(35)，M2 map 35→481 后，
 *    User Anchor=work(481)+Progress=work(481)，无 work(35) dangling；
 *    sessionId 原样沿用（4a）；单事务 Anchor 先 Progress 后（4b/4c）；
 *    remap 后 getAnchor/Checkpoint/batch 一路正常（4f）；
 *    Guest 侧已迁移 Anchor 清除（4h），Guest Progress copy/remap 保留到 Guest GC
 *    （§31.4：storyWorkId/hash/version/paragraph/completedAt 不变，FK Cascade 清理）；
 *    同一 remap 重复调用幂等（User 不重复不倒退，Guest 仍不变）；
 * 2. §31.1：Draft Anchor messageId 原样迁移；
 * 3. §31.3：无映射 work Anchor → drop（false，用户侧无行，Guest 原样保留）；
 * 4. §31.4/4g：User 已有同 work 进度 → max(next) 合并，不覆盖（ahead 保持/behind 推进，
 *    completedAt 首完保留）；
 * 5. 无 guest 行 → false；他用户数据逐字节不受影响（4h no-leak 侧）。
 *    §47：Guest→新用户注册=remap 且 Guest Progress 保留；Guest 身份登录已有账号=
 *    不触发本函数（见 story-work-guest-registration §4 登录不迁移，本文件不直接调 login）。
 * 全程隔离库（runner 注入 DATABASE_URL），不碰 dev.db/app.db。
 */

const newSessionId = (): string => crypto.randomUUID();

/** 生成 N 个独立长段落（每段足够长避免合并，总段数恒为 N）。 */
const makeStoryText = (paras: number): string => {
  const parts: string[] = [];
  for (let i = 1; i <= paras; i += 1) {
    parts.push(
      `第${i}章：故事段落内容填充足够长度以避免前向合并策略将其合并到相邻段落之中保持独立成段${'内容'.repeat(30)}尾${i}`
    );
  }
  return parts.join('\n\n');
};

const STORY_TEXT = makeStoryText(6);
const expectedTotal = Math.max(1, segmentStoryText(normalizeStoryText(STORY_TEXT)).length);

async function runPlaybackSubjectRemapTests(): Promise<void> {
  console.log('=== M5-08: Subject Migration remap (Guest → User) ===');
  assert.strictEqual(expectedTotal, 6, '前置：测试正文恒为 6 段');

  // —— 1. §46 主路径：Anchor+Progress 同 map remap，无 dangling，guest 清除，用户侧一路正常 ——
  console.log('--- §46: work anchor + progress remap 35→481 shape ---');
  const guest: Subject = { type: 'guest', id: makeGuestId('m508_remap') };
  const w1 = await createStoryWorkForSubject(guest, {
    prompt: 'm508 remap 作品一',
    storyText: STORY_TEXT,
    voiceId: 'voice-r1',
  });
  const w2 = await createStoryWorkForSubject(guest, {
    prompt: 'm508 remap 作品二',
    storyText: STORY_TEXT,
    voiceId: 'voice-r2',
  });
  const sessionS = newSessionId();
  await beginPlaybackSessionForSubject(guest, {
    sessionId: sessionS,
    source: { kind: 'work', workId: w1.id },
    mode: 'resume',
    speed: 1.0,
  });
  const gSave = await savePlaybackCheckpointForSubject(guest, {
    sessionId: sessionS,
    contentHash: w1.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert.strictEqual(gSave.accepted, true, '前置：guest checkpoint 应接受');
  // W2 进度行直建（不断言 begin 切换语义，只需行存在）。
  await prisma.guestStoryPlaybackProgress.create({
    data: {
      storyWorkId: w2.id,
      contentHash: w2.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 0,
      nextParagraphIndex: 1,
      totalParagraphs: expectedTotal,
    },
  });

  // 他用户隔离基线（4h：remap 不得碰其它用户数据）。
  const otherUser = await prisma.user.create({
    data: { username: `m508_other_${Date.now()}`, password: 'Password123!' },
  });
  const otherWork = await createStoryWorkForSubject({ type: 'user', id: otherUser.id }, {
    prompt: 'm508 他用户作品',
    storyText: STORY_TEXT,
  });
  const otherSession = newSessionId();
  await beginPlaybackSessionForSubject({ type: 'user', id: otherUser.id }, {
    sessionId: otherSession,
    source: { kind: 'work', workId: otherWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  await savePlaybackCheckpointForSubject({ type: 'user', id: otherUser.id }, {
    sessionId: otherSession,
    contentHash: otherWork.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 2,
    nextParagraphIndex: 3,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  const otherAnchorBefore = await prisma.userPlaybackAnchor.findUnique({ where: { userId: otherUser.id } });
  const otherProgressBefore = await prisma.storyPlaybackProgress.findUnique({
    where: { storyWorkId: otherWork.id },
  });

  const freshUser = await prisma.user.create({
    data: { username: `m508_target_${Date.now()}`, password: 'Password123!' },
  });
  const creative = await migrateGuestCreativeRecordsToUser(guest.id, freshUser.id);
  const u1 = creative.storyWorkIdMap.get(w1.id);
  const u2 = creative.storyWorkIdMap.get(w2.id);
  assert(u1 !== undefined && u2 !== undefined, '前置：map 必须含两作品');
  const guestProgressesBefore = await prisma.guestStoryPlaybackProgress.findMany({
    where: { storyWorkId: { in: [w1.id, w2.id] } },
  });
  assert.strictEqual(guestProgressesBefore.length, 2, '前置：Guest Progress 两行存在');
  const remapped = await migrateGuestPlaybackProgressToUser(guest.id, freshUser.id, creative.storyWorkIdMap);
  assert.strictEqual(remapped, true, '§46：remap 应成功');

  const userSubject: Subject = { type: 'user', id: freshUser.id };
  const userAnchor = await prisma.userPlaybackAnchor.findUnique({ where: { userId: freshUser.id } });
  assert(userAnchor !== null, 'User Anchor 必须落库');
  assert.strictEqual(userAnchor.sourceKind, 'work');
  assert.strictEqual(userAnchor.sourceId, String(u1), 'Anchor 必须指 dst work(481 形)，经 map 定位');
  assert.strictEqual(userAnchor.sessionId, sessionS, '4a：sessionId 原样沿用');
  assert.strictEqual(userAnchor.nextParagraphIndex, 2, 'Anchor 位置保真');
  assert.strictEqual(userAnchor.title, w1.title);
  const userProgresses = await prisma.storyPlaybackProgress.findMany({
    where: { storyWorkId: { in: [u1, u2] } },
  });
  assert.strictEqual(userProgresses.length, 2, '两作品 Progress 必须成对 remap');
  assert.strictEqual(userProgresses.find((p) => p.storyWorkId === u1)?.nextParagraphIndex, 2);
  assert.strictEqual(userProgresses.find((p) => p.storyWorkId === u2)?.nextParagraphIndex, 1);
  // 无 dangling：User Progress 行键必须全部落在本次 map 的 dst 集合内。
  assert.deepStrictEqual(
    userProgresses.map((p) => p.storyWorkId).sort((a, b) => a - b),
    [u1, u2].sort((a, b) => (a as number) - (b as number)),
    'User Progress 键集合必须恰为 map dst，无悬空 guest 键'
  );
  // Guest 侧：Anchor 清除（4h）；Progress copy/remap 保留到 Guest GC（§31.4）。
  assert.strictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guest.id } }),
    null,
    '4h：Guest Anchor 必须清除'
  );
  // §31.4 copy 语义：Guest Progress rows still exist 且原 storyWorkId/hash/version/paragraph/completedAt 不变。
  const guestProgressesAfter = await prisma.guestStoryPlaybackProgress.findMany({
    where: { storyWorkId: { in: [w1.id, w2.id] } },
  });
  assert.strictEqual(
    guestProgressesAfter.length,
    2,
    '§31.4 copy：Guest Progress 必须保留（Guest GC 负责最终删除）'
  );
  const beforeByGuestWorkId = new Map(guestProgressesBefore.map((p) => [p.storyWorkId, p]));
  const afterByGuestWorkId = new Map(guestProgressesAfter.map((p) => [p.storyWorkId, p]));
  for (const gid of [w1.id, w2.id]) {
    const before = beforeByGuestWorkId.get(gid);
    const after = afterByGuestWorkId.get(gid);
    assert(before !== undefined && after !== undefined, `Guest Progress work(${gid}) 必须存在`);
    assert.strictEqual(after.storyWorkId, before.storyWorkId, 'storyWorkId 不变');
    assert.strictEqual(after.contentHash, before.contentHash, 'contentHash 不变');
    assert.strictEqual(after.segmentationVersion, before.segmentationVersion, 'segmentationVersion 不变');
    assert.strictEqual(
      after.lastCompletedParagraphIndex,
      before.lastCompletedParagraphIndex,
      'lastCompletedParagraphIndex 不变'
    );
    assert.strictEqual(after.nextParagraphIndex, before.nextParagraphIndex, 'nextParagraphIndex 不变');
    assert.strictEqual(after.totalParagraphs, before.totalParagraphs, 'totalParagraphs 不变');
    assert.strictEqual(
      after.completedAt?.toISOString() ?? null,
      before.completedAt?.toISOString() ?? null,
      'completedAt 不变'
    );
  }
  // §31.4 位置保真抽查：w1 next=2 / w2 next=1 与 remap 前一致。
  assert.strictEqual(afterByGuestWorkId.get(w1.id)?.nextParagraphIndex, 2, 'Guest w1 Progress 位置不变');
  assert.strictEqual(afterByGuestWorkId.get(w2.id)?.nextParagraphIndex, 1, 'Guest w2 Progress 位置不变');
  // 幂等回归：再次调用 remap → User Progress 不重复不倒退 + Guest Progress 仍不变
  //（mergeRemappedWorkProgress 完整 tuple winner + 保留 completedAt + 较晚 lastPlayedAt 天然幂等）。
  const userSnapshotBeforeSecond = await prisma.storyPlaybackProgress.findMany({
    where: { storyWorkId: { in: [u1, u2] } },
  });
  const normUserProgress = (p: {
    storyWorkId: number;
    contentHash: string | null;
    segmentationVersion: string | null;
    lastCompletedParagraphIndex: number;
    nextParagraphIndex: number;
    totalParagraphs: number;
    completedAt: Date | null;
    lastPlayedAt: Date | null;
  }) => ({
    storyWorkId: p.storyWorkId,
    contentHash: p.contentHash ?? '',
    segmentationVersion: p.segmentationVersion ?? 'v1',
    lastCompletedParagraphIndex: p.lastCompletedParagraphIndex,
    nextParagraphIndex: p.nextParagraphIndex,
    totalParagraphs: p.totalParagraphs,
    completedAt: p.completedAt?.toISOString() ?? null,
    lastPlayedAt: p.lastPlayedAt?.toISOString() ?? null,
  });
  assert.strictEqual(
    await migrateGuestPlaybackProgressToUser(guest.id, freshUser.id, creative.storyWorkIdMap),
    true,
    '幂等：重复 remap 仍返回 true（Guest Progress 保留故仍可迁移）'
  );
  const userProgressesAfterSecond = await prisma.storyPlaybackProgress.findMany({
    where: { storyWorkId: { in: [u1, u2] } },
  });
  assert.strictEqual(userProgressesAfterSecond.length, 2, '幂等：User Progress 不重复');
  assert.deepStrictEqual(
    userProgressesAfterSecond.map(normUserProgress).sort((a, b) => a.storyWorkId - b.storyWorkId),
    userSnapshotBeforeSecond.map(normUserProgress).sort((a, b) => a.storyWorkId - b.storyWorkId),
    '幂等：User Progress 不倒退（完整 tuple winner + completedAt 首完 + 较晚 lastPlayedAt 天然幂等）'
  );
  const guestProgressesAfterSecond = await prisma.guestStoryPlaybackProgress.findMany({
    where: { storyWorkId: { in: [w1.id, w2.id] } },
  });
  assert.strictEqual(guestProgressesAfterSecond.length, 2, '幂等：Guest Progress 仍保留');
  const normGuestProgress = (p: {
    storyWorkId: number;
    contentHash: string | null;
    segmentationVersion: string | null;
    lastCompletedParagraphIndex: number;
    nextParagraphIndex: number;
    totalParagraphs: number;
    completedAt: Date | null;
  }) => ({
    storyWorkId: p.storyWorkId,
    contentHash: p.contentHash,
    segmentationVersion: p.segmentationVersion,
    lastCompletedParagraphIndex: p.lastCompletedParagraphIndex,
    nextParagraphIndex: p.nextParagraphIndex,
    totalParagraphs: p.totalParagraphs,
    completedAt: p.completedAt?.toISOString() ?? null,
  });
  assert.deepStrictEqual(
    guestProgressesAfterSecond.map(normGuestProgress).sort((a, b) => a.storyWorkId - b.storyWorkId),
    guestProgressesAfter.map(normGuestProgress).sort((a, b) => a.storyWorkId - b.storyWorkId),
    '幂等：Guest Progress 仍不变'
  );
  // remap 后用户侧一路正常（4f：getAnchor/Checkpoint/batch，无 guest 残留查询）。
  const rehydrated = await getPlaybackAnchorForSubject(userSubject);
  assert(rehydrated !== null && rehydrated.sessionId === sessionS);
  assert.deepStrictEqual(rehydrated.source, { kind: 'work', workId: u1 });
  const batch = await getWorkPlaybackProgressBatchForSubject(userSubject, { workIds: [u1, u2] });
  assert.strictEqual(batch.items.length, 2);
  assert.strictEqual(batch.items[0].state, 'in_progress');
  assert.strictEqual(batch.items[0].nextParagraphIndex, 2);
  assert.strictEqual(batch.items[1].nextParagraphIndex, 1);
  const uWorkRow = await prisma.storyWork.findUnique({ where: { id: u1 } });
  assert(uWorkRow !== null);
  const uSave = await savePlaybackCheckpointForSubject(userSubject, {
    sessionId: sessionS,
    contentHash: uWorkRow.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 2,
    nextParagraphIndex: 3,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert.strictEqual(uSave.accepted, true, '4f：remap 后用户侧 checkpoint 必须正常');
  // 他用户逐字节不受影响。
  assert.deepStrictEqual(
    await prisma.userPlaybackAnchor.findUnique({ where: { userId: otherUser.id } }),
    otherAnchorBefore,
    '4h：他用户 Anchor 不得被碰'
  );
  assert.deepStrictEqual(
    await prisma.storyPlaybackProgress.findUnique({ where: { storyWorkId: otherWork.id } }),
    otherProgressBefore,
    '4h：他用户 Progress 不得被碰'
  );
  console.log('PASS: §46 remap + 4a/4f/4h verified');

  // —— 2. §31.1 Draft Anchor 原样迁移 ——
  console.log('--- §31.1: draft anchor messageId preserved ---');
  const guestDraftId = makeGuestId('m508_draft');
  const draftMsg = `m508_msg_${Date.now()}`;
  const draftSession = newSessionId();
  await prisma.guestPlaybackAnchor.create({
    data: {
      guestId: guestDraftId,
      sourceKind: 'chat',
      sourceId: draftMsg,
      sessionId: draftSession,
      title: 'm508 draft',
      contentHash: 'm508drafthash',
      nextParagraphIndex: 1,
      totalParagraphs: 4,
    },
  });
  const draftUser = await prisma.user.create({
    data: { username: `m508_draft_u_${Date.now()}`, password: 'Password123!' },
  });
  assert.strictEqual(await migrateGuestPlaybackProgressToUser(guestDraftId, draftUser.id), true);
  const draftUserAnchor = await prisma.userPlaybackAnchor.findUnique({ where: { userId: draftUser.id } });
  assert(draftUserAnchor !== null);
  assert.strictEqual(draftUserAnchor.sourceKind, 'draft');
  assert.strictEqual(draftUserAnchor.sourceId, draftMsg, 'draft messageId 原样迁移');
  assert.strictEqual(draftUserAnchor.sessionId, draftSession, 'sessionId 沿用');
  assert.strictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestDraftId } }),
    null,
    'draft Guest Anchor 亦清除'
  );
  console.log('PASS: §31.1 draft preserved');

  // —— 3. §31.3 无映射 work Anchor → drop ——
  console.log('--- §31.3: unmapped work anchor dropped ---');
  const guestLostId = makeGuestId('m508_lost');
  await prisma.guestPlaybackAnchor.create({
    data: { guestId: guestLostId, sourceKind: 'work', sourceId: '987654321', title: 'lost' },
  });
  const lostUser = await prisma.user.create({
    data: { username: `m508_lost_u_${Date.now()}`, password: 'Password123!' },
  });
  assert.strictEqual(await migrateGuestPlaybackProgressToUser(guestLostId, lostUser.id), false);
  assert.strictEqual(
    await prisma.userPlaybackAnchor.findUnique({ where: { userId: lostUser.id } }),
    null,
    '未映射不得创建 dangling User Anchor'
  );
  assert.notStrictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestLostId } }),
    null,
    'fail-closed 时 Guest 原行保留（不误删）'
  );
  console.log('PASS: §31.3 missing mapping dropped');

  // —— 4. §31.4/4g：User 已有同 work 进度 → max(next) 合并 ——
  console.log('--- §31.4/4g: existing user progress merged by max(next) ---');
  // 4a. User ahead（5 > guest 2）：保持 User。
  const guestAhead: Subject = { type: 'guest', id: makeGuestId('m508_ahead') };
  const wa = await createStoryWorkForSubject(guestAhead, { prompt: 'm508 ahead', storyText: STORY_TEXT });
  const sa = newSessionId();
  await beginPlaybackSessionForSubject(guestAhead, {
    sessionId: sa,
    source: { kind: 'work', workId: wa.id },
    mode: 'resume',
    speed: 1.0,
  });
  await savePlaybackCheckpointForSubject(guestAhead, {
    sessionId: sa,
    contentHash: wa.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  const userAhead = await prisma.user.create({
    data: { username: `m508_ahead_u_${Date.now()}`, password: 'Password123!' },
  });
  const creativeAhead = await migrateGuestCreativeRecordsToUser(guestAhead.id, userAhead.id);
  const uaWork = creativeAhead.storyWorkIdMap.get(wa.id);
  assert(uaWork !== undefined);
  const firstDone = new Date('2026-01-01T00:00:00.000Z');
  await prisma.storyPlaybackProgress.create({
    data: {
      storyWorkId: uaWork,
      contentHash: wa.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 4,
      nextParagraphIndex: 5,
      totalParagraphs: expectedTotal,
      completedAt: firstDone,
      lastPlayedAt: new Date('2026-02-01T00:00:00.000Z'),
    },
  });
  assert.strictEqual(
    await migrateGuestPlaybackProgressToUser(guestAhead.id, userAhead.id, creativeAhead.storyWorkIdMap),
    true
  );
  const mergedAhead = await prisma.storyPlaybackProgress.findUnique({ where: { storyWorkId: uaWork } });
  assert(mergedAhead !== null);
  assert.strictEqual(mergedAhead.nextParagraphIndex, 5, '4g：User 更完整时不被覆盖');
  assert.strictEqual(mergedAhead.lastCompletedParagraphIndex, 4);
  assert.strictEqual(mergedAhead.completedAt?.toISOString(), firstDone.toISOString(), '首完保留');
  // 4b. Guest ahead（4 > user 1）：推进到 guest，且带上 guest completedAt。
  const guestBehind: Subject = { type: 'guest', id: makeGuestId('m508_behind') };
  const wb = await createStoryWorkForSubject(guestBehind, { prompt: 'm508 behind', storyText: STORY_TEXT });
  const sb = newSessionId();
  await beginPlaybackSessionForSubject(guestBehind, {
    sessionId: sb,
    source: { kind: 'work', workId: wb.id },
    mode: 'resume',
    speed: 1.0,
  });
  await savePlaybackCheckpointForSubject(guestBehind, {
    sessionId: sb,
    contentHash: wb.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 3,
    nextParagraphIndex: 4,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  const guestDone = new Date('2026-03-01T00:00:00.000Z');
  await prisma.guestStoryPlaybackProgress.update({
    where: { storyWorkId: wb.id },
    data: { completedAt: guestDone },
  });
  const userBehind = await prisma.user.create({
    data: { username: `m508_behind_u_${Date.now()}`, password: 'Password123!' },
  });
  const creativeBehind = await migrateGuestCreativeRecordsToUser(guestBehind.id, userBehind.id);
  const ubWork = creativeBehind.storyWorkIdMap.get(wb.id);
  assert(ubWork !== undefined);
  await prisma.storyPlaybackProgress.create({
    data: {
      storyWorkId: ubWork,
      contentHash: wb.contentHash,
      segmentationVersion: SEGMENTATION_VERSION,
      lastCompletedParagraphIndex: 0,
      nextParagraphIndex: 1,
      totalParagraphs: expectedTotal,
      completedAt: null,
      lastPlayedAt: new Date('2026-01-15T00:00:00.000Z'),
    },
  });
  assert.strictEqual(
    await migrateGuestPlaybackProgressToUser(guestBehind.id, userBehind.id, creativeBehind.storyWorkIdMap),
    true
  );
  const mergedBehind = await prisma.storyPlaybackProgress.findUnique({ where: { storyWorkId: ubWork } });
  assert(mergedBehind !== null);
  assert.strictEqual(mergedBehind.nextParagraphIndex, 4, '4g：guest 更新时推进到 max(next)');
  assert.strictEqual(mergedBehind.completedAt?.toISOString(), guestDone.toISOString(), '首个非空 completedAt 保留');
  console.log('PASS: §31.4/4g max(next) merge verified');

  // —— 5. 无 guest 行 → false ——
  const emptyUser = await prisma.user.create({
    data: { username: `m508_empty_u_${Date.now()}`, password: 'Password123!' },
  });
  assert.strictEqual(await migrateGuestPlaybackProgressToUser(makeGuestId('m508_empty'), emptyUser.id), false);

  // 清理他用户与目标用户（级联清 anchor/progress/works/migrations）。
  await prisma.user.delete({ where: { id: otherUser.id } });
  await prisma.user.delete({ where: { id: freshUser.id } });
  await prisma.user.delete({ where: { id: draftUser.id } });
  await prisma.user.delete({ where: { id: lostUser.id } });
  await prisma.user.delete({ where: { id: userAhead.id } });
  await prisma.user.delete({ where: { id: userBehind.id } });
  await prisma.user.delete({ where: { id: emptyUser.id } });
  await prisma.guestPlaybackAnchor.deleteMany({ where: { guestId: guestLostId } });

  console.log('\nALL PLAYBACK SUBJECT REMAP TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runPlaybackSubjectRemapTests()
  .then(() => {
    console.log('ALL PLAYBACK SUBJECT REMAP TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
