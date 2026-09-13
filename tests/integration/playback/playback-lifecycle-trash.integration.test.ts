import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import { TRPCError } from '@/lib/trpc/init';
import type { Subject } from '../../../lib/server/subject';
import {
  beginPlaybackSessionForSubject,
  completePlaybackSessionForSubject,
  getPlaybackAnchorForSubject,
  invalidatePlaybackReferencesForWork,
  savePlaybackCheckpointForSubject,
} from '../../../lib/server/playbackSession';
import {
  createStoryWorkForSubject,
  permanentlyDeleteStoryWorkForSubject,
  trashStoryWorkForSubject,
} from '../../../lib/server/storyWork';
import { SEGMENTATION_VERSION, normalizeStoryText, segmentStoryText } from '../../../utils/segmentation';
import { makeGuestId } from '../../support/builders/auth-subject.builder';

/**
 * M5-08 Playback Lifecycle：Trash / Permanent Delete 播放边界集成测试（L2）。
 * 覆盖 spec §29 / §29.1 / §29.2（M5-P03）/ §29.3（本项范围）：
 * 1. §29.1：在播 Work moveToTrash → 内存 Session 不被打断：同一 Session 的
 *    checkpoint 仍 accepted（server 侧不切断），completion 仍可收尾；
 * 2. §29.2：刷新（getAnchor）→ 发现 Work 已 trash → 删除 Anchor 行 → null，
 *    不 rehydrate；此后同 Session checkpoint → STALE（不复活）；
 *    再次 beginSession(trash work) → NOT_FOUND（WORK_UNAVAILABLE 的 wire 形，
 *    与 M2 trash/foreign/missing 统一不可区分面一致）；
 * 3. §29.3：永久删除后 Anchor 视为 dangling：getAnchor → null（行删）；
 *    Progress 经 Work FK CASCADE；invalidatePlaybackReferencesForWork 供清理
 *    （draft 不动、非法 workId no-op；M5 半径内仅提供路径，不自动接入删除流程）；
 * 4. Draft Anchor 不受 Work trash 影响（只处理 work Anchor 层）。
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

const STORY_TEXT = makeStoryText(4);

const expectedTotalFor = (text: string): number =>
  Math.max(1, segmentStoryText(normalizeStoryText(text)).length);

async function runPlaybackLifecycleTrashTests(): Promise<void> {
  console.log('=== M5-08: Playback Lifecycle Trash / Permanent Delete ===');
  const expectedTotal = expectedTotalFor(STORY_TEXT);
  assert(expectedTotal >= 3, '前置：测试正文至少 3 段');

  // —— 1. §29.1：在播 Work trash 后，同一 Session checkpoint/completion 仍被允许 ——
  console.log('--- §29.1: trashed in-session checkpoint + completion still honored ---');
  const guest: Subject = { type: 'guest', id: makeGuestId('m508_trash') };
  const work = await createStoryWorkForSubject(guest, {
    prompt: 'm508 trash 提示词',
    storyText: STORY_TEXT,
    voiceId: 'voice-t',
  });
  const session = newSessionId();
  await beginPlaybackSessionForSubject(guest, {
    sessionId: session,
    source: { kind: 'work', workId: work.id },
    mode: 'resume',
    speed: 1.0,
  });
  const save1 = await savePlaybackCheckpointForSubject(guest, {
    sessionId: session,
    contentHash: work.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert.strictEqual(save1.accepted, true, '前置：trash 前 checkpoint 应接受');

  await trashStoryWorkForSubject(guest, work.id);
  // 内存播放不被打断的 server 侧对应：同一 Session checkpoint 仍 accepted。
  const save2 = await savePlaybackCheckpointForSubject(guest, {
    sessionId: session,
    contentHash: work.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert.strictEqual(save2.accepted, true, '§29.1：trash 后在播 Session checkpoint 仍须接受');
  assert(save2.accepted === true);
  assert.strictEqual(save2.anchor.nextParagraphIndex, 2, 'trash 后 checkpoint 位置照常推进');
  const progressAfterTrash = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: work.id },
  });
  assert(progressAfterTrash !== null, 'trash 后 checkpoint 仍同步 Progress（同一 CAS 面）');
  assert.strictEqual(progressAfterTrash.nextParagraphIndex, 2);
  // completion 同样允许。
  const completed = await completePlaybackSessionForSubject(guest, { sessionId: session });
  assert(completed !== null, '§29.1：trash 后在播 Session completion 仍须收尾');
  assert.strictEqual(completed.state, 'ended');
  assert.strictEqual(completed.nextParagraphIndex, expectedTotal);
  console.log('PASS: §29.1 in-session checkpoint + completion honored after trash');

  // —— 2. §29.2：刷新 getAnchor → null（行删，不 rehydrate）；后续 checkpoint STALE；重 begin NOT_FOUND ——
  console.log('--- §29.2: refresh getAnchor → null, late checkpoint STALE, re-begin NOT_FOUND ---');
  const refreshed = await getPlaybackAnchorForSubject(guest);
  assert.strictEqual(refreshed, null, '§29.2：trash Work 刷新后 getAnchor 必须 null');
  const anchorRowAfterRefresh = await prisma.guestPlaybackAnchor.findUnique({
    where: { guestId: guest.id },
  });
  assert.strictEqual(anchorRowAfterRefresh, null, '§29.2：trash Anchor 行必须被清除');
  const lateSave = await savePlaybackCheckpointForSubject(guest, {
    sessionId: session,
    contentHash: work.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  assert.strictEqual(lateSave.accepted, false, 'Anchor 已 null 后 checkpoint 必须 fail-closed');
  assert(lateSave.accepted === false);
  assert.strictEqual(lateSave.reason, 'STALE_SESSION');
  const stillGone = await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guest.id } });
  assert.strictEqual(stillGone, null, 'STALE checkpoint 不得复活 Anchor');
  await assert.rejects(
    () =>
      beginPlaybackSessionForSubject(guest, {
        sessionId: newSessionId(),
        source: { kind: 'work', workId: work.id },
        mode: 'resume',
        speed: 1.0,
      }),
    (err: unknown) => {
      assert(err instanceof TRPCError);
      // WORK_UNAVAILABLE 的 wire 形：经 M2 统一 NOT_FOUND（trash/foreign/missing 不可区分）。
      assert.strictEqual(err.code, 'NOT_FOUND');
      return true;
    },
    'trash Work 再次 begin 必须不可用（NOT_FOUND）'
  );
  console.log('PASS: §29.2 refresh-null + STALE + re-begin NOT_FOUND');

  // —— 3. §29.3：永久删除 → dangling Anchor getAnchor null；Progress FK 级联；hook 路径 ——
  console.log('--- §29.3: permanent delete dangling + FK cascade + invalidate hook ---');
  const guestGone: Subject = { type: 'guest', id: makeGuestId('m508_gone') };
  const doomed = await createStoryWorkForSubject(guestGone, {
    prompt: 'm508 永久删除提示词',
    storyText: STORY_TEXT,
  });
  const doomedSession = newSessionId();
  await beginPlaybackSessionForSubject(guestGone, {
    sessionId: doomedSession,
    source: { kind: 'work', workId: doomed.id },
    mode: 'resume',
    speed: 1.0,
  });
  await savePlaybackCheckpointForSubject(guestGone, {
    sessionId: doomedSession,
    contentHash: doomed.contentHash,
    segmentationVersion: SEGMENTATION_VERSION,
    lastCompletedParagraphIndex: 0,
    nextParagraphIndex: 1,
    totalParagraphs: expectedTotal,
    speed: 1.0,
  });
  await trashStoryWorkForSubject(guestGone, doomed.id);
  await permanentlyDeleteStoryWorkForSubject(guestGone, doomed.id);
  // Progress 随 Work FK CASCADE。
  const cascaded = await prisma.guestStoryPlaybackProgress.findUnique({
    where: { storyWorkId: doomed.id },
  });
  assert.strictEqual(cascaded, null, '§29.3：Work 物理删除必须级联删除 Progress');
  // Anchor 视为 dangling：getAnchor 静默 null + 行删（不抛错、不做大规模删除）。
  const goneAnchor = await getPlaybackAnchorForSubject(guestGone);
  assert.strictEqual(goneAnchor, null, '§29.3：已删 Work 的 Anchor 必须视为 dangling null');
  assert.strictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestGone.id } }),
    null,
    'dangling Anchor 行必须被清除'
  );
  // hook 在已清理后为 no-op。
  const hookNoop = await invalidatePlaybackReferencesForWork(guestGone, doomed.id);
  assert.strictEqual(hookNoop.cleared, false, '已无引用时 hook 应 no-op');
  // hook 正向：指向 Work 的 Anchor 被清除，draft 不动，Progress 不碰。
  const guestHook: Subject = { type: 'guest', id: makeGuestId('m508_hook') };
  const hookWork = await createStoryWorkForSubject(guestHook, {
    prompt: 'm508 hook 提示词',
    storyText: STORY_TEXT,
  });
  const hookSession = newSessionId();
  await beginPlaybackSessionForSubject(guestHook, {
    sessionId: hookSession,
    source: { kind: 'work', workId: hookWork.id },
    mode: 'resume',
    speed: 1.0,
  });
  const hookHit = await invalidatePlaybackReferencesForWork(guestHook, hookWork.id);
  assert.strictEqual(hookHit.cleared, true, 'hook 应清除指向该 Work 的 Anchor');
  assert.strictEqual(
    await prisma.guestPlaybackAnchor.findUnique({ where: { guestId: guestHook.id } }),
    null,
    'hook 后 Anchor 行必须消失'
  );
  // 非法 workId no-op。
  assert.deepStrictEqual(await invalidatePlaybackReferencesForWork(guestHook, -7), { cleared: false });
  assert.deepStrictEqual(await invalidatePlaybackReferencesForWork(guestHook, 0), { cleared: false });
  console.log('PASS: §29.3 permanent-delete dangling + cascade + hook');

  // —— 4. Draft Anchor 不受 Work trash 影响 ——
  console.log('--- draft anchor unaffected by work trash ---');
  const guestDraft: Subject = { type: 'guest', id: makeGuestId('m508_draft') };
  const draftMessageId = `m508_draft_${Date.now()}`;
  await prisma.guestChatMessage.create({
    data: { guestId: guestDraft.id, position: 0, messageId: draftMessageId, role: 'user', content: 'm508' },
  });
  const draftSession = newSessionId();
  await beginPlaybackSessionForSubject(guestDraft, {
    sessionId: draftSession,
    source: { kind: 'draft', messageId: draftMessageId },
    mode: 'resume',
    speed: 1.0,
    draftSnapshot: { title: 'm508 草稿', contentHash: 'm508hash', totalParagraphs: 2, voiceId: '' },
  });
  const unrelatedWork = await createStoryWorkForSubject(guestDraft, {
    prompt: 'm508 无关作品',
    storyText: STORY_TEXT,
  });
  await trashStoryWorkForSubject(guestDraft, unrelatedWork.id);
  const draftAnchor = await getPlaybackAnchorForSubject(guestDraft);
  assert(draftAnchor !== null, 'Work trash 不得影响 Draft Anchor');
  assert.deepStrictEqual(draftAnchor.source, { kind: 'draft', messageId: draftMessageId });
  console.log('PASS: draft anchor unaffected');

  // —— 5. User/Guest 对称：user 侧 trash 刷新同样 null ——
  console.log('--- user symmetry: trashed work getAnchor → null ---');
  const createdUser = await prisma.user.create({
    data: { username: `m508_user_${Date.now()}`, password: 'Password123!' },
  });
  const user: Subject = { type: 'user', id: createdUser.id };
  try {
    const uWork = await createStoryWorkForSubject(user, {
      prompt: 'm508 user 作品',
      storyText: STORY_TEXT,
    });
    await beginPlaybackSessionForSubject(user, {
      sessionId: newSessionId(),
      source: { kind: 'work', workId: uWork.id },
      mode: 'resume',
      speed: 1.0,
    });
    await trashStoryWorkForSubject(user, uWork.id);
    assert.strictEqual(await getPlaybackAnchorForSubject(user), null, 'user 侧 trash 后 getAnchor 亦 null');
    assert.strictEqual(
      await prisma.userPlaybackAnchor.findUnique({ where: { userId: user.id } }),
      null,
      'user 侧 trash Anchor 行亦清除'
    );
    console.log('PASS: user symmetry verified');
  } finally {
    await prisma.user.delete({ where: { id: createdUser.id } });
  }

  console.log('\nALL PLAYBACK LIFECYCLE TRASH TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runPlaybackLifecycleTrashTests()
  .then(() => {
    console.log('ALL PLAYBACK LIFECYCLE TRASH TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
