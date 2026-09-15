import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import type { Subject } from '../../../lib/server/subject';
import {
  getPlaybackAnchorForSubject,
  beginPlaybackSessionForSubject,
  savePlaybackCheckpointForSubject,
  completePlaybackSessionForSubject,
  setSleepTimerForSubject,
  resolveAnchorSleepTimerRepair,
} from '../../../lib/server/playbackSession';
import { createStoryWorkForSubject } from '../../../lib/server/storyWork';
import { getOrCreateConfig, updateConfig } from '../../../lib/server/unifiedConfig';
import {
  SEGMENTATION_VERSION,
  normalizeStoryText,
  segmentStoryText,
} from '../../../utils/segmentation';
import { makeGuestId, makeMessageId, makeUsername } from '../../support/builders/auth-subject.builder';

/**
 * M7-03 Sleep Timer 全链集成测试（L2）。
 * 覆盖 spec §23/§23.1 + §24/§24.1 + §26 + §27 + §28 + §29/§29.2 + §30 + §62-67：
 * 1. §62 验收 1：legacy config（playDurationMinutes=30）→ enabled=true/minutes=30；
 *    新 Session mode=minutes/remaining=30min；
 * 2. begin 缺省 timer：remaining!=null→minutes，null→off（§23.1，不只依赖列 default）；
 * 3. setSleepTimer minutes/off：落库值 + Session Guard stale → STALE_SESSION（§24/§24.1）；
 * 4. story_end：Work 接受，Draft BAD_REQUEST；begin Draft story_end 拒绝（§22.1）；
 * 5. saveCheckpoint 携带/缺省 mode：显式更新 vs 保持现值（旧包不覆盖 Timer）；
 * 6. completeSession（Work/Draft）：Timer reset off + nulls（§27）；
 * 7. getAnchor repair：非法 mode/remaining==0 → off/null 写回（§23.1/§26）；
 * 8. Config DTO：新字段 + playDuration 兼容别名同值；legacy patch 收敛；冲突 BAD_REQUEST（§30）。
 * 全程隔离库（runner 注入 DATABASE_URL），不碰 dev.db/app.db。
 */

const newSessionId = (): string => crypto.randomUUID();

const STORY_TEXT =
  '第一章：出发\n\n第二章：历险\n第三章：归来\n这是一个很长很长的尾声，充满了各种细节和波折，让切分结果稳定可断言。';

const expectedTotalFor = (text: string): number =>
  Math.max(1, segmentStoryText(normalizeStoryText(text)).length);

async function runSleepTimerSessionTests(): Promise<void> {
  console.log('=== M7-03: Sleep Timer Session/API/Config ===');
  const expectedTotal = expectedTotalFor(STORY_TEXT);

  // —— 1. §62 验收 1：legacy config 迁移语义 + 新 Session 默认 ——
  console.log('--- §62(1): legacy config → enabled/minutes → new session minutes ---');
  const guestCfg: Subject = { type: 'guest', id: makeGuestId('m703_cfg') };
  const cfg0 = await getOrCreateConfig(guestCfg);
  assert.strictEqual(cfg0.defaultSleepTimerEnabled, true, '新主体默认 enabled=true（§29.2）');
  assert.strictEqual(cfg0.defaultSleepTimerMinutes, 30, '新主体默认 minutes=30');
  assert.strictEqual(cfg0.playDuration, 30, 'playDuration 兼容别名同值（§30）');
  // legacy patch（旧 Bundle 只发 playDuration）收敛为 defaultSleepTimerMinutes。
  const cfgLegacy = await updateConfig(guestCfg, { playDuration: 45 });
  assert.strictEqual(cfgLegacy.defaultSleepTimerMinutes, 45);
  assert.strictEqual(cfgLegacy.playDuration, 45, '别名同值');
  assert.strictEqual(cfgLegacy.defaultSleepTimerEnabled, true, '纯旧 patch 不碰 enabled');
  // 新字段 patch。
  const cfgNew = await updateConfig(guestCfg, { defaultSleepTimerEnabled: false, defaultSleepTimerMinutes: 60 });
  assert.strictEqual(cfgNew.defaultSleepTimerEnabled, false);
  assert.strictEqual(cfgNew.defaultSleepTimerMinutes, 60);
  // 新旧冲突 → BAD_REQUEST。
  await assert.rejects(
    updateConfig(guestCfg, { defaultSleepTimerMinutes: 20, playDuration: 40 }),
    /CONFLICTING_SLEEP_TIMER_FIELDS/,
    '新旧时长不同值必须 BAD_REQUEST',
  );
  // 同值共存 → 以新字段为准。
  const cfgSame = await updateConfig(guestCfg, { defaultSleepTimerMinutes: 20, playDuration: 20 });
  assert.strictEqual(cfgSame.defaultSleepTimerMinutes, 20);
  // Existing user：物理列 playDurationMinutes=30 的旧行 → enabled=true/minutes=30。
  const tag = Date.now();
  const userLegacy = await prisma.user.create({
    data: { username: makeUsername(`m703_legacy_${tag}`), password: 'TestPassword123!', nickname: 'M703' },
  });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "UserConfig" ("userId", "playDurationMinutes", "voiceId", "speed", "floatingPlayerEnabled", "themeMode", "updatedAt", "defaultSleepTimerEnabled") VALUES (${userLegacy.id}, 30, '', 1.0, 1, 'system', datetime('now'), 1)`
  );
  const legacyCfg = await getOrCreateConfig({ type: 'user', id: userLegacy.id });
  assert.strictEqual(legacyCfg.defaultSleepTimerEnabled, true);
  assert.strictEqual(legacyCfg.defaultSleepTimerMinutes, 30, '旧 playDurationMinutes=30 行为保持');
  console.log('PASS: legacy config migration');

  // —— 2. begin timer 派生（§23.1） ——
  console.log('--- §23.1: begin timer derivation ---');
  const guest: Subject = { type: 'guest', id: makeGuestId('m703_begin') };
  const work = await createStoryWorkForSubject(guest, {
    prompt: 'm703 提示词',
    storyText: STORY_TEXT,
    voiceId: 'voice-m703',
  });
  const sessionBudget = newSessionId();
  const anchorBudget = await beginPlaybackSessionForSubject(guest, {
    sessionId: sessionBudget,
    source: { kind: 'work', workId: work.id },
    mode: 'resume',
    speed: 1.0,
    remainingAllowedMs: 1800000,
    totalAllowedMs: 1800000,
  });
  assert.strictEqual(anchorBudget.sleepTimerMode, 'minutes', 'remaining!=null 缺省→minutes');
  const sessionNull = newSessionId();
  const anchorNull = await beginPlaybackSessionForSubject(guest, {
    sessionId: sessionNull,
    source: { kind: 'work', workId: work.id },
    mode: 'restart',
    speed: 1.0,
  });
  assert.strictEqual(anchorNull.sleepTimerMode, 'off', 'remaining null 缺省→off');
  assert.strictEqual(anchorNull.remainingAllowedMs, null);
  // 显式 off。
  const anchorOff = await beginPlaybackSessionForSubject(guest, {
    sessionId: newSessionId(),
    source: { kind: 'work', workId: work.id },
    mode: 'restart',
    speed: 1.0,
    remainingAllowedMs: 1800000,
    totalAllowedMs: 1800000,
    sleepTimerMode: 'off',
  });
  assert.strictEqual(anchorOff.sleepTimerMode, 'off', '显式 off 优先于派生');
  console.log('PASS: begin timer derivation');

  // —— 3. setSleepTimer minutes/off + stale（§24/§24.1） ——
  console.log('--- §24/§24.1: setSleepTimer + stale guard ---');
  const setMinutes = await setSleepTimerForSubject(guest, {
    sessionId: anchorOff.sessionId,
    mode: 'minutes',
    minutes: 10,
  });
  assert.strictEqual(setMinutes.accepted, true);
  assert(setMinutes.accepted === true);
  assert.strictEqual(setMinutes.anchor.sleepTimerMode, 'minutes');
  assert.strictEqual(setMinutes.anchor.remainingAllowedMs, 600000);
  assert.strictEqual(setMinutes.anchor.totalAllowedMs, 600000);
  const setOff = await setSleepTimerForSubject(guest, {
    sessionId: anchorOff.sessionId,
    mode: 'off',
  });
  assert.strictEqual(setOff.accepted, true);
  assert(setOff.accepted === true);
  assert.strictEqual(setOff.anchor.sleepTimerMode, 'off');
  assert.strictEqual(setOff.anchor.remainingAllowedMs, null);
  assert.strictEqual(setOff.anchor.totalAllowedMs, null);
  // off 刷新后仍 off（持久化验收 §62(2)）。
  const refetched = await getPlaybackAnchorForSubject(guest);
  assert.strictEqual(refetched?.sleepTimerMode, 'off');
  assert.strictEqual(refetched?.remainingAllowedMs, null);
  // stale：切到新 Session 后旧 sessionId 设置 → STALE_SESSION，不覆盖新 timer。
  const sessionB = newSessionId();
  await beginPlaybackSessionForSubject(guest, {
    sessionId: sessionB,
    source: { kind: 'work', workId: work.id },
    mode: 'restart',
    speed: 1.0,
    remainingAllowedMs: 1800000,
    totalAllowedMs: 1800000,
    sleepTimerMode: 'minutes',
  });
  const staleRes = await setSleepTimerForSubject(guest, {
    sessionId: anchorOff.sessionId,
    mode: 'off',
  });
  assert.strictEqual(staleRes.accepted, false);
  assert(staleRes.accepted === false);
  assert.strictEqual(staleRes.reason, 'STALE_SESSION');
  const anchorB = await getPlaybackAnchorForSubject(guest);
  assert.strictEqual(anchorB?.sessionId, sessionB);
  assert.strictEqual(anchorB?.sleepTimerMode, 'minutes', 'stale 写不得污染新 Session timer');
  assert.strictEqual(anchorB?.remainingAllowedMs, 1800000);
  console.log('PASS: setSleepTimer + stale guard');

  // —— 4. story_end：Work 接受 / Draft 拒绝（§22.1） ——
  console.log('--- §22.1: story_end work-only ---');
  const setStoryEnd = await setSleepTimerForSubject(guest, { sessionId: sessionB, mode: 'story_end' });
  assert.strictEqual(setStoryEnd.accepted, true);
  assert(setStoryEnd.accepted === true);
  assert.strictEqual(setStoryEnd.anchor.sleepTimerMode, 'story_end');
  assert.strictEqual(setStoryEnd.anchor.remainingAllowedMs, null);
  const guestDraft: Subject = { type: 'guest', id: makeGuestId('m703_draft') };
  const draftMsg = makeMessageId('m703_draft');
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestDraft.id,
      position: 0,
      messageId: draftMsg,
      role: 'assistant',
      content: 'm703 草稿定时故事正文',
      parts: null,
    },
  });
  const draftSession = newSessionId();
  await beginPlaybackSessionForSubject(guestDraft, {
    sessionId: draftSession,
    source: { kind: 'draft', messageId: draftMsg },
    mode: 'resume',
    speed: 1.0,
    draftSnapshot: {
      title: '草稿定时',
      contentHash: 'm703-draft-hash',
      totalParagraphs: expectedTotal,
      voiceId: '',
    },
  });
  await assert.rejects(
    setSleepTimerForSubject(guestDraft, { sessionId: draftSession, mode: 'story_end' }),
    /story_end/,
    'Draft story_end 必须 BAD_REQUEST',
  );
  const draftMsg2 = makeMessageId('m703_draft2');
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestDraft.id,
      position: 1,
      messageId: draftMsg2,
      role: 'assistant',
      content: 'm703 草稿定时故事正文2',
      parts: null,
    },
  });
  await assert.rejects(
    beginPlaybackSessionForSubject(guestDraft, {
      sessionId: newSessionId(),
      source: { kind: 'draft', messageId: draftMsg2 },
      mode: 'resume',
      speed: 1.0,
      sleepTimerMode: 'story_end',
      draftSnapshot: {
        title: '草稿定时2',
        contentHash: 'm703-draft-hash-2',
        totalParagraphs: expectedTotal,
        voiceId: '',
      },
    }),
    /story_end/,
    'Draft begin story_end 必须拒绝',
  );
  // minutes 缺 minutes → zod 拒绝（fail-closed）。
  const { setSleepTimerInputSchema } = await import('../../../lib/trpc/schemas/playback');
  assert.throws(
    () => setSleepTimerInputSchema.parse({ sessionId: sessionB, mode: 'minutes' }),
    /SLEEP_TIMER_MINUTES_REQUIRED/,
  );
  console.log('PASS: story_end work-only');

  // —— 5. saveCheckpoint mode 携带/缺省（Timer 独立持久化 + 旧包不覆盖） ——
  console.log('--- checkpoint timer carry ---');
  const guestCk: Subject = { type: 'guest', id: makeGuestId('m703_ckpt') };
  const workCk = await createStoryWorkForSubject(guestCk, {
    prompt: 'm703 ck 提示词',
    storyText: STORY_TEXT,
    voiceId: 'voice-ck',
  });
  const sessionCk = newSessionId();
  await beginPlaybackSessionForSubject(guestCk, {
    sessionId: sessionCk,
    source: { kind: 'work', workId: workCk.id },
    mode: 'resume',
    speed: 1.0,
    remainingAllowedMs: 1800000,
    totalAllowedMs: 1800000,
    sleepTimerMode: 'minutes',
  });
  // 显式携带 off → Timer 更新。
  const ckOff = await savePlaybackCheckpointForSubject(guestCk, {
    sessionId: sessionCk,
    contentHash: workCk.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: expectedTotal,
    speed: 1.0,
    remainingAllowedMs: null,
    totalAllowedMs: null,
    sleepTimerMode: 'off',
  });
  assert.strictEqual(ckOff.accepted, true);
  assert(ckOff.accepted === true);
  assert.strictEqual(ckOff.anchor.sleepTimerMode, 'off');
  // 缺省 mode → 保持现值 off（旧包不覆盖 Timer）。
  const ckKeep = await savePlaybackCheckpointForSubject(guestCk, {
    sessionId: sessionCk,
    contentHash: workCk.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert.strictEqual(ckKeep.accepted, true);
  assert(ckKeep.accepted === true);
  assert.strictEqual(ckKeep.anchor.sleepTimerMode, 'off', '缺省 mode 必须保持现值');
  console.log('PASS: checkpoint timer carry');

  // —— 6. completeSession Timer reset off（§27；Work/Draft 对称） ——
  console.log('--- §27: complete resets timer off ---');
  const guestDone: Subject = { type: 'guest', id: makeGuestId('m703_done') };
  const workDone = await createStoryWorkForSubject(guestDone, {
    prompt: 'm703 done 提示词',
    storyText: STORY_TEXT,
    voiceId: 'voice-done',
  });
  const sessionDone = newSessionId();
  await beginPlaybackSessionForSubject(guestDone, {
    sessionId: sessionDone,
    source: { kind: 'work', workId: workDone.id },
    mode: 'resume',
    speed: 1.0,
    remainingAllowedMs: 600000,
    totalAllowedMs: 1800000,
    sleepTimerMode: 'minutes',
  });
  await completePlaybackSessionForSubject(guestDone, { sessionId: sessionDone });
  const doneAnchor = await getPlaybackAnchorForSubject(guestDone);
  assert.strictEqual(doneAnchor?.sleepTimerMode, 'off', 'Work 完播 Timer reset off');
  assert.strictEqual(doneAnchor?.remainingAllowedMs, null);
  assert.strictEqual(doneAnchor?.totalAllowedMs, null);
  // Draft 完播同样 reset。
  await completePlaybackSessionForSubject(guestDraft, { sessionId: draftSession });
  const draftDone = await getPlaybackAnchorForSubject(guestDraft);
  assert.strictEqual(draftDone?.sleepTimerMode, 'off');
  console.log('PASS: complete resets timer');

  // —— 7. getAnchor repair：非法 mode/remaining==0 → off/null 写回（§23.1/§26） ——
  console.log('--- §23.1/§26: anchor timer repair ---');
  assert.deepStrictEqual(
    resolveAnchorSleepTimerRepair({ sleepTimerMode: 'minutes', remainingAllowedMs: 100, totalAllowedMs: 200 }),
    null,
    '一致行无需 repair',
  );
  assert.deepStrictEqual(
    resolveAnchorSleepTimerRepair({ sleepTimerMode: 'bogus', remainingAllowedMs: 100, totalAllowedMs: 200 }),
    { sleepTimerMode: 'minutes', remainingAllowedMs: 100, totalAllowedMs: 200 },
  );
  assert.deepStrictEqual(
    resolveAnchorSleepTimerRepair({ sleepTimerMode: 'minutes', remainingAllowedMs: null, totalAllowedMs: null }),
    { sleepTimerMode: 'off', remainingAllowedMs: null, totalAllowedMs: null },
  );
  assert.deepStrictEqual(
    resolveAnchorSleepTimerRepair({ sleepTimerMode: 'minutes', remainingAllowedMs: 0, totalAllowedMs: 1800000 }),
    { sleepTimerMode: 'off', remainingAllowedMs: null, totalAllowedMs: null },
    'remaining==0 过期残留归一 null/off',
  );
  assert.deepStrictEqual(
    resolveAnchorSleepTimerRepair({ sleepTimerMode: 'off', remainingAllowedMs: 1800000, totalAllowedMs: 1800000 }),
    { sleepTimerMode: 'off', remainingAllowedMs: null, totalAllowedMs: null },
    'off+预算违反不变式→预算清零（mode 保持显式 off）',
  );
  const guestRepair: Subject = { type: 'guest', id: makeGuestId('m703_repair') };
  const workRepair = await createStoryWorkForSubject(guestRepair, {
    prompt: 'm703 repair 提示词',
    storyText: STORY_TEXT,
    voiceId: 'voice-repair',
  });
  const sessionRepair = newSessionId();
  await beginPlaybackSessionForSubject(guestRepair, {
    sessionId: sessionRepair,
    source: { kind: 'work', workId: workRepair.id },
    mode: 'resume',
    speed: 1.0,
    remainingAllowedMs: 900000,
    totalAllowedMs: 1800000,
    sleepTimerMode: 'minutes',
  });
  // 模拟 legacy 残留：非法 mode + 0 预算（绕过 facade 直写）。
  await prisma.guestPlaybackAnchor.update({
    where: { guestId: guestRepair.id },
    data: { sleepTimerMode: 'bogus', remainingAllowedMs: 0 },
  });
  const repaired = await getPlaybackAnchorForSubject(guestRepair);
  assert.strictEqual(repaired?.sleepTimerMode, 'off');
  assert.strictEqual(repaired?.remainingAllowedMs, null);
  assert.strictEqual(repaired?.totalAllowedMs, null);
  const repairedRow = await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestRepair.id } });
  assert.strictEqual(repairedRow?.sleepTimerMode, 'off', 'repair 必须写回 DB');
  assert.strictEqual(repairedRow?.remainingAllowedMs, null);
  console.log('PASS: anchor timer repair');

  console.log('\nALL M7-03 SLEEP TIMER SESSION INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runSleepTimerSessionTests()
  .then(() => {
    console.log('ALL M7-03 SLEEP TIMER SESSION INTEGRATION TESTS PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
