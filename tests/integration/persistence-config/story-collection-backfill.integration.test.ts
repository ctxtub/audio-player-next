/**
 * StoryCollection 可重复 backfill 与迁移守恒集成测试（change-id 2026-09-15-story-collection-continuous-creation T1）。
 *
 * 覆盖：
 * 1. 旧 Chat 快照 → legacy Conversation（确定性 id）+ 消息会话内 position 重排；
 * 2. 旧 Work 默认一 Work 一 Collection（无证据绝不按时间合并）；
 * 3. 仅凭可靠证据（sourceMessageId 命中已归属会话的 ChatMessage）合并；
 * 4. 重跑幂等（第二次为空操作，计数与作品总数守恒）；
 * 5. 回填后无孤儿、无 position 缺失；
 * 6. Guest 对称；
 * 7. 注册迁移归属重映射（conversationId / collectionId / position）且可重复。
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../../lib/db';
import type { Subject } from '../../../lib/server/subject';
import {
  backfillStoryCollectionsForSubject,
  measureStoryCollectionMigrationState,
  runStoryCollectionBackfill,
} from '../../../lib/server/storyCollectionBackfill';
import { migrateGuestCreativeRecordsToUser } from '../../../lib/server/unifiedMigration';
import { deriveDeterministicId } from '../../../lib/storyCollection/identity';

async function createUser(tag: number, suffix: string) {
  return prisma.user.create({
    data: {
      username: `sc_backfill_${suffix}_${tag}`,
      password: 'TestPassword123!',
      nickname: `BF ${suffix}`,
    },
  });
}

async function createLegacyWork(userId: number, prompt: string, storyText: string, sourceMessageId?: string) {
  return prisma.storyWork.create({
    data: {
      userId,
      prompt,
      storyText,
      voiceId: '',
      title: '',
      excerpt: '',
      contentHash: '',
      sourceMessageId: sourceMessageId ?? null,
    },
  });
}

async function runStoryCollectionBackfillTests() {
  const tag = Date.now();
  const user = await createUser(tag, 'main');
  const subject: Subject = { type: 'user', id: user.id };

  console.log('=== 1. 旧 Chat 快照 → legacy Conversation + 一 Work 一 Collection ===');
  await prisma.chatMessage.createMany({
    data: [
      { userId: user.id, position: 0, messageId: `legacy_m1_${tag}`, role: 'user', content: '旧消息一', parts: null, agentType: null, createdAt: new Date().toISOString() },
      { userId: user.id, position: 1, messageId: `legacy_m2_${tag}`, role: 'assistant', content: '旧消息二', parts: null, agentType: null, createdAt: new Date().toISOString() },
    ],
  });
  const legacyWorkA = await createLegacyWork(user.id, '旧作品甲提示词', '# 旧作品甲\n正文甲');
  const legacyWorkB = await createLegacyWork(user.id, '旧作品乙提示词', '正文乙没有标题格式');
  // 时间上相邻，但无 sourceMessageId 证据 → 绝不允许合并
  await prisma.storyWork.update({ where: { id: legacyWorkB.id }, data: { createdAt: new Date() } });

  const counts1 = await backfillStoryCollectionsForSubject(subject);
  assert.strictEqual(counts1.conversationsCreated, 3, 'chat 快照 1 个 legacy 会话 + 每个无证据作品 1 个合成会话');
  assert.strictEqual(counts1.chatMessagesAssigned, 2);
  assert.strictEqual(counts1.collectionsCreated, 2, '无证据旧作品必须各自成集');
  assert.strictEqual(counts1.worksAttached, 2);
  assert.strictEqual(counts1.worksGroupedByChat, 0);
  assert.strictEqual(counts1.worksIndividual, 2);

  const legacyConversation = await prisma.conversation.findUnique({
    where: { id: deriveDeterministicId('legacy-conversation', `user:${user.id}`) },
  });
  assert.ok(legacyConversation, 'legacy 会话必须使用确定性 id');
  const assignedMessages = await prisma.chatMessage.findMany({
    where: { userId: user.id },
    orderBy: { position: 'asc' },
  });
  assert.ok(assignedMessages.every((m) => m.conversationId === legacyConversation!.id));
  assert.deepStrictEqual(assignedMessages.map((m) => m.position), [0, 1]);

  const refreshedA = await prisma.storyWork.findUnique({ where: { id: legacyWorkA.id } });
  const refreshedB = await prisma.storyWork.findUnique({ where: { id: legacyWorkB.id } });
  assert.ok(refreshedA!.collectionId && refreshedB!.collectionId);
  assert.notStrictEqual(refreshedA!.collectionId, refreshedB!.collectionId, '无证据旧作品不得按时间合并');
  assert.strictEqual(refreshedA!.position, 0);
  assert.strictEqual(refreshedB!.position, 0);
  const legacyCollectionA = await prisma.storyCollection.findUnique({ where: { id: refreshedA!.collectionId! } });
  assert.strictEqual(legacyCollectionA!.title, '旧作品甲', '集合标题回退严格正文标题');
  assert.strictEqual(legacyCollectionA!.titleSource, 'fallback');
  console.log('PASS: 1');

  console.log('=== 2. 仅凭可靠证据合并进会话集合 ===');
  const evidenceConversationId = randomUUID();
  await prisma.conversation.create({
    data: { id: evidenceConversationId, userId: user.id, state: 'active' },
  });
  await prisma.chatMessage.create({
    data: {
      userId: user.id,
      conversationId: evidenceConversationId,
      position: 0,
      messageId: `ev_msg_${tag}`,
      role: 'assistant',
      content: '证据消息',
      parts: null,
      agentType: null,
      createdAt: new Date().toISOString(),
    },
  });
  const evidenceWork = await createLegacyWork(user.id, '证据作品提示词', '# 证据作品\n正文', `ev_msg_${tag}`);
  const noEvidenceWork = await createLegacyWork(user.id, '无消息证据提示词', '无证据正文', `no_chat_${tag}`);

  const counts2 = await backfillStoryCollectionsForSubject(subject);
  assert.strictEqual(counts2.worksGroupedByChat, 1, '有证据作品须合并进会话集合');
  assert.strictEqual(counts2.worksIndividual, 1, 'sourceMessageId 无匹配消息仍各自成集');
  const evidenceCollection = await prisma.storyCollection.findUnique({
    where: { conversationId: evidenceConversationId },
  });
  assert.ok(evidenceCollection, '证据会话必须拥有唯一集合');
  assert.strictEqual(
    (await prisma.storyWork.findUnique({ where: { id: evidenceWork.id } }))!.collectionId,
    evidenceCollection!.id,
  );
  const noEvidenceRefreshed = await prisma.storyWork.findUnique({ where: { id: noEvidenceWork.id } });
  assert.notStrictEqual(noEvidenceRefreshed!.collectionId, evidenceCollection!.id, '无证据作品不得并入');
  console.log('PASS: 2');

  console.log('=== 3. 重跑幂等且守恒 ===');
  const totalWorksBeforeRerun = await prisma.storyWork.count({ where: { userId: user.id } });
  const collectionsBeforeRerun = await prisma.storyCollection.count({ where: { userId: user.id } });
  const conversationsBeforeRerun = await prisma.conversation.count({ where: { userId: user.id } });
  const counts3 = await backfillStoryCollectionsForSubject(subject);
  assert.deepStrictEqual(counts3, {
    conversationsCreated: 0,
    collectionsCreated: 0,
    worksAttached: 0,
    worksGroupedByChat: 0,
    worksIndividual: 0,
    chatMessagesAssigned: 0,
    conflictsReused: 0,
  }, '第二次回填必须为空操作');
  assert.strictEqual(await prisma.storyWork.count({ where: { userId: user.id } }), totalWorksBeforeRerun);
  assert.strictEqual(await prisma.storyCollection.count({ where: { userId: user.id } }), collectionsBeforeRerun);
  assert.strictEqual(await prisma.conversation.count({ where: { userId: user.id } }), conversationsBeforeRerun);
  console.log('PASS: 3');

  console.log('=== 4. 回填后无孤儿、无 position 缺失、作品总数守恒 ===');
  const after = await measureStoryCollectionMigrationState();
  assert.strictEqual(after.userWorksTotal, 4, '作品总数守恒（2 旧 + 2 证据用例，回填不增删）');
  assert.strictEqual(after.userWorksAttached, 4, '回填后全部作品必须已归属集合');
  assert.strictEqual(after.userWorksOrphaned, 0);
  assert.strictEqual(after.userWorksPositionless, 0);
  assert.strictEqual(after.guestWorksOrphaned, 0);
  assert.strictEqual(after.guestWorksPositionless, 0);
  console.log('PASS: 4');

  console.log('=== 5. Guest 对称回填 ===');
  const guestId = `guest_bf_${tag}`;
  const guestSubject: Subject = { type: 'guest', id: guestId };
  await prisma.guestChatMessage.create({
    data: {
      guestId,
      position: 0,
      messageId: `g_legacy_${tag}`,
      role: 'user',
      content: '访客旧消息',
      parts: null,
      agentType: null,
    },
  });
  const guestWork = await prisma.guestStoryWork.create({
    data: { guestId, prompt: '访客旧作品', storyText: '# 访客旧作\n正文', voiceId: '', title: '', excerpt: '', contentHash: '' },
  });
  const guestCounts = await backfillStoryCollectionsForSubject(guestSubject);
  assert.strictEqual(guestCounts.conversationsCreated, 2, '访客 chat 会话 + 合成作品会话');
  assert.strictEqual(guestCounts.collectionsCreated, 1);
  assert.strictEqual(guestCounts.worksAttached, 1);
  const guestCollection = await prisma.guestStoryCollection.findFirst({ where: { guestId } });
  assert.ok(guestCollection);
  assert.strictEqual(
    (await prisma.guestStoryWork.findUnique({ where: { id: guestWork.id } }))!.collectionId,
    guestCollection!.id,
  );
  const guestRerun = await backfillStoryCollectionsForSubject(guestSubject);
  assert.strictEqual(guestRerun.collectionsCreated, 0, 'Guest 重跑必须幂等');
  console.log('PASS: 5');

  console.log('=== 6. 全局回填入口幂等 ===');
  const globalCounts = await runStoryCollectionBackfill();
  assert.strictEqual(globalCounts.collectionsCreated, 0, '全局回填在全量已补后应为空操作');
  console.log('PASS: 6');

  console.log('=== 7. 注册迁移归属重映射且可重复 ===');
  const registeredUser = await createUser(tag, 'registered');
  await migrateGuestCreativeRecordsToUser(guestId, registeredUser.id);
  const migratedConversations = await prisma.conversation.findMany({ where: { userId: registeredUser.id } });
  assert.strictEqual(migratedConversations.length, 2, 'Guest 会话（chat + 合成作品）须迁移为 User 会话');
  const migratedConversationIds = new Set(migratedConversations.map((c) => c.id));
  const migratedCollections = await prisma.storyCollection.findMany({ where: { userId: registeredUser.id } });
  assert.strictEqual(migratedCollections.length, 1, 'Guest 集合须迁移为 User 集合');
  assert.ok(migratedConversationIds.has(migratedCollections[0]!.conversationId), '集合 conversationId 须映射到迁移会话');
  const migratedWorks = await prisma.storyWork.findMany({ where: { userId: registeredUser.id } });
  assert.strictEqual(migratedWorks.length, 1);
  assert.strictEqual(migratedWorks[0]!.collectionId, migratedCollections[0]!.id, 'position/归属须重映射');
  assert.strictEqual(migratedWorks[0]!.position, 0);
  const migratedMessages = await prisma.chatMessage.findMany({ where: { userId: registeredUser.id } });
  assert.strictEqual(migratedMessages.length, 1);
  assert.ok(
    migratedMessages[0]!.conversationId !== null &&
      migratedConversationIds.has(migratedMessages[0]!.conversationId),
    'conversationId 须重映射到迁移会话',
  );
  // 二次迁移幂等
  await migrateGuestCreativeRecordsToUser(guestId, registeredUser.id);
  assert.strictEqual(await prisma.storyCollection.count({ where: { userId: registeredUser.id } }), 1);
  assert.strictEqual(await prisma.conversation.count({ where: { userId: registeredUser.id } }), 2);
  assert.strictEqual(await prisma.storyWork.count({ where: { userId: registeredUser.id } }), 1);
  console.log('PASS: 7');

  console.log('ALL STORY COLLECTION BACKFILL INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runStoryCollectionBackfillTests()
  .then(() => {
    console.log('ALL STORY COLLECTION BACKFILL INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
