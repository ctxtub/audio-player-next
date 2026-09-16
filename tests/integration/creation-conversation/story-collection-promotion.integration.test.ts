/**
 * StoryCollection Promotion 与生命周期集成测试（change-id 2026-09-15-story-collection-continuous-creation T1）。
 *
 * 覆盖：
 * 1. 首作建集 + AI 标题注入 + 标题回退；
 * 2. 同会话连续追加、集合内 position、用户改名后自动流程不覆盖；
 * 3. sourceMessageId 幂等（同 hash 返回既有 Work）与冲突（异 hash CONFLICT 不覆盖）；
 * 4. 会话归属/状态（NOT_FOUND / CONFLICT）、已软删集合拒绝追加；
 * 5. 跨会话、跨用户、跨访客严格隔离；
 * 6. 并发首作只产生一个集合且 position 互异；
 * 7. 标题生成超时不阻断入库（含确定性回退标题）；
 * 8. list 视图、keyset 游标、搜索按 Collection 去重；
 * 9. rename / setFavorite / softDelete / restore / deleteForever 生命周期与成员级联。
 */

import assert from 'node:assert';
import { TRPCError } from '@trpc/server';
import { prisma } from '../../../lib/db';
import type { Subject } from '../../../lib/server/subject';
import {
  createNewConversationForSubject,
  closeConversationForSubject,
} from '../../../lib/server/conversation';
import {
  promoteArtifactForSubject,
  getCollectionForSubject,
  listCollectionsForSubject,
  renameCollectionForSubject,
  setCollectionFavoriteForSubject,
  softDeleteCollectionForSubject,
  restoreCollectionForSubject,
  deleteForeverCollectionForSubject,
} from '../../../lib/server/storyCollection';
import { restoreStoryWorkForSubject } from '../../../lib/server/storyWork';

const isTrpcErrorWithCode = (error: unknown, code: string): boolean =>
  error instanceof TRPCError && error.code === code;

async function createUser(tag: number, suffix: string) {
  return prisma.user.create({
    data: {
      username: `sc_promote_${suffix}_${tag}`,
      password: 'TestPassword123!',
      nickname: `SC ${suffix}`,
    },
  });
}

async function runStoryCollectionPromotionTests() {
  const tag = Date.now();
  const userA = await createUser(tag, 'a');
  const userB = await createUser(tag, 'b');
  const subjectA: Subject = { type: 'user', id: userA.id };
  const subjectB: Subject = { type: 'user', id: userB.id };

  console.log('=== 1. 首作建集 + AI 标题注入 ===');
  const conv1 = await createNewConversationForSubject(subjectA);
  let titleCalls = 0;
  const work1 = await promoteArtifactForSubject(
    subjectA,
    {
      conversationId: conv1.id,
      sourceMessageId: `m1_${tag}`,
      prompt: '写一个关于秋天的睡前故事',
      storyText: '# 秋日私语\n落叶铺满了小路。',
    },
    { generateTitle: async () => { titleCalls += 1; return '秋日私语集'; } },
  );
  assert.strictEqual(titleCalls, 1, '首作建集须调用一次标题生成');
  const collection1 = await prisma.storyCollection.findUnique({
    where: { conversationId: conv1.id },
  });
  assert.ok(collection1, '首作必须创建集合');
  assert.strictEqual(collection1!.title, '秋日私语集');
  assert.strictEqual(collection1!.titleSource, 'ai');
  assert.strictEqual(collection1!.userId, userA.id);
  const work1Row = await prisma.storyWork.findUnique({ where: { id: work1.id } });
  assert.strictEqual(work1Row!.collectionId, collection1!.id);
  assert.strictEqual(work1Row!.position, 0, '首作 position 必须为 0');
  assert.strictEqual(await prisma.storyCollection.count({ where: { userId: userA.id } }), 1);
  console.log('PASS: 1');

  console.log('=== 2. 同会话追加 + 用户改名后自动流程不覆盖 ===');
  await renameCollectionForSubject(subjectA, collection1!.id, '我的秋天');
  let calledAfterRename = false;
  const work2 = await promoteArtifactForSubject(
    subjectA,
    {
      conversationId: conv1.id,
      sourceMessageId: `m2_${tag}`,
      prompt: '再写一段秋天的故事',
      storyText: '# 秋雨\n雨点敲打窗户。',
    },
    { generateTitle: async () => { calledAfterRename = true; return '不应出现'; } },
  );
  assert.strictEqual(calledAfterRename, false, '集合已存在时不得再生成标题');
  const collection1b = await prisma.storyCollection.findUnique({ where: { id: collection1!.id } });
  assert.strictEqual(collection1b!.title, '我的秋天');
  assert.strictEqual(collection1b!.titleSource, 'user');
  assert.strictEqual(await prisma.storyCollection.count({ where: { userId: userA.id } }), 1, '追加不得新建集合');
  const work2Row = await prisma.storyWork.findUnique({ where: { id: work2.id } });
  assert.strictEqual(work2Row!.collectionId, collection1!.id);
  assert.strictEqual(work2Row!.position, 1, '第二个作品 position 必须为 1');
  console.log('PASS: 2');

  console.log('=== 3. sourceMessageId 幂等（同 hash 返回既有 Work）===');
  const work2Again = await promoteArtifactForSubject(
    subjectA,
    {
      conversationId: conv1.id,
      sourceMessageId: `m2_${tag}`,
      prompt: '再写一段秋天的故事',
      storyText: '# 秋雨\n雨点敲打窗户。',
    },
    { generateTitle: async () => { throw new Error('幂等路径不得生成标题'); } },
  );
  assert.strictEqual(work2Again.id, work2.id, '同源同 hash 必须返回既有 Work id');
  assert.strictEqual(await prisma.storyWork.count({ where: { userId: userA.id } }), 2, '幂等不得新增行');
  assert.strictEqual(await prisma.storyCollection.count({ where: { userId: userA.id } }), 1);
  console.log('PASS: 3');

  console.log('=== 4. sourceMessageId 冲突（异 hash CONFLICT 且不覆盖）===');
  await assert.rejects(
    promoteArtifactForSubject(subjectA, {
      conversationId: conv1.id,
      sourceMessageId: `m2_${tag}`,
      prompt: '再写一段秋天的故事',
      storyText: '# 完全不同的正文\n内容漂移。',
    }),
    (error: unknown) => isTrpcErrorWithCode(error, 'CONFLICT'),
    '同源异 hash 必须 CONFLICT',
  );
  const untouched = await prisma.storyWork.findUnique({ where: { id: work2.id } });
  assert.strictEqual(untouched!.storyText, '# 秋雨\n雨点敲打窗户。', '冲突不得覆盖既有正文');
  assert.strictEqual(await prisma.storyWork.count({ where: { userId: userA.id } }), 2);
  console.log('PASS: 4');

  console.log('=== 5. 会话归属与状态守卫 ===');
  const conv2 = await createNewConversationForSubject(subjectA); // 关闭 conv1
  assert.strictEqual((await prisma.conversation.findUnique({ where: { id: conv1.id } }))!.state, 'closed');
  await assert.rejects(
    promoteArtifactForSubject(subjectA, {
      conversationId: conv1.id,
      sourceMessageId: `m_closed_${tag}`,
      prompt: 'p',
      storyText: '已结束会话的正文',
    }),
    (error: unknown) => isTrpcErrorWithCode(error, 'CONFLICT'),
  );
  await assert.rejects(
    promoteArtifactForSubject(subjectA, {
      conversationId: '00000000-0000-4000-8000-000000000000',
      sourceMessageId: `m_missing_${tag}`,
      prompt: 'p',
      storyText: '不存在会话的正文',
    }),
    (error: unknown) => isTrpcErrorWithCode(error, 'NOT_FOUND'),
  );
  console.log('PASS: 5');

  console.log('=== 6. 跨会话隔离：新会话独立成集 ===');
  const work3 = await promoteArtifactForSubject(
    subjectA,
    {
      conversationId: conv2.id,
      sourceMessageId: `m3_${tag}`,
      prompt: '第二个会话的提示词',
      storyText: '# 冬雪\n雪花落下。',
    },
    { generateTitle: async () => null },
  );
  const collection2 = await prisma.storyCollection.findUnique({
    where: { conversationId: conv2.id },
  });
  assert.ok(collection2);
  assert.notStrictEqual(collection2!.id, collection1!.id, '不同会话必须各自成集');
  assert.strictEqual(collection2!.title, '冬雪', 'AI 为空时回退严格正文标题');
  assert.strictEqual(collection2!.titleSource, 'fallback');
  assert.strictEqual(await prisma.storyWork.count({ where: { collectionId: collection1!.id } }), 2, 'A 会话集合不受影响');
  assert.strictEqual(await prisma.storyWork.count({ where: { collectionId: collection2!.id } }), 1);
  console.log('PASS: 6');

  console.log('=== 7. 已软删集合拒绝继续追加 ===');
  await softDeleteCollectionForSubject(subjectA, collection2!.id);
  await assert.rejects(
    promoteArtifactForSubject(subjectA, {
      conversationId: conv2.id,
      sourceMessageId: `m_trashed_${tag}`,
      prompt: 'p',
      storyText: '追加到回收站集合的正文',
    }),
    (error: unknown) => isTrpcErrorWithCode(error, 'CONFLICT'),
  );
  await restoreCollectionForSubject(subjectA, collection2!.id);
  console.log('PASS: 7');

  console.log('=== 8. 标题生成超时不阻断入库（确定性回退）===');
  const conv3 = await createNewConversationForSubject(subjectA); // 关闭 conv2
  const startedAt = Date.now();
  const work4 = await promoteArtifactForSubject(
    subjectA,
    {
      conversationId: conv3.id,
      sourceMessageId: `m4_${tag}`,
      prompt: '超时回退提示词',
      storyText: '这段正文没有严格标题格式。',
    },
    { generateTitle: () => new Promise<string>(() => {}), titleTimeoutMs: 25 },
  );
  assert.ok(Date.now() - startedAt >= 20, '超时路径须等待至少配置时长');
  const collection3 = await prisma.storyCollection.findUnique({
    where: { conversationId: conv3.id },
  });
  assert.ok(collection3, '超时后集合仍须创建');
  assert.strictEqual(collection3!.title, '超时回退提示词');
  assert.strictEqual(collection3!.titleSource, 'fallback');
  assert.ok((await prisma.storyWork.findUnique({ where: { id: work4.id } }))!.collectionId === collection3!.id);
  console.log('PASS: 8');

  console.log('=== 9. 并发首作：单集合且 position 互异 ===');
  const conv4 = await createNewConversationForSubject(subjectA); // 关闭 conv3
  const [concurrentA, concurrentB] = await Promise.all([
    promoteArtifactForSubject(
      subjectA,
      { conversationId: conv4.id, sourceMessageId: `mc1_${tag}`, prompt: 'p', storyText: '# 并发甲\n甲正文' },
      { generateTitle: async () => null },
    ),
    promoteArtifactForSubject(
      subjectA,
      { conversationId: conv4.id, sourceMessageId: `mc2_${tag}`, prompt: 'p', storyText: '# 并发乙\n乙正文' },
      { generateTitle: async () => null },
    ),
  ]);
  const conv4Collections = await prisma.storyCollection.findMany({
    where: { conversationId: conv4.id },
  });
  assert.strictEqual(conv4Collections.length, 1, '并发首作只允许一个集合');
  const conv4Works = await prisma.storyWork.findMany({
    where: { collectionId: conv4Collections[0]!.id },
    orderBy: { position: 'asc' },
  });
  assert.strictEqual(conv4Works.length, 2);
  assert.deepStrictEqual(
    conv4Works.map((w) => w.position).sort(),
    [0, 1],
    '并发首作 position 必须互异',
  );
  assert.ok([concurrentA.id, concurrentB.id].every((id) => conv4Works.some((w) => w.id === id)));
  console.log('PASS: 9');

  console.log('=== 10. 跨用户隔离 ===');
  const convB = await createNewConversationForSubject(subjectB);
  await promoteArtifactForSubject(
    subjectB,
    {
      conversationId: convB.id,
      sourceMessageId: `m1_${tag}`,
      prompt: 'B 的提示词',
      storyText: '# B 的作品\nB 正文',
    },
    { generateTitle: async () => null },
  ); // 与 A 同 sourceMessageId，不得冲突
  const collectionB = await prisma.storyCollection.findUnique({
    where: { conversationId: convB.id },
  });
  assert.ok(collectionB);
  assert.notStrictEqual(collectionB!.id, collection1!.id);
  await assert.rejects(
    getCollectionForSubject(subjectA, collectionB!.id),
    (error: unknown) => isTrpcErrorWithCode(error, 'NOT_FOUND'),
    '跨用户读取必须 NOT_FOUND',
  );
  await assert.rejects(
    renameCollectionForSubject(subjectB, collection1!.id, '越权改名'),
    (error: unknown) => isTrpcErrorWithCode(error, 'NOT_FOUND'),
  );
  assert.strictEqual(
    (await prisma.storyCollection.findUnique({ where: { id: collection1!.id } }))!.title,
    '我的秋天',
    '跨用户改名不得生效',
  );
  console.log('PASS: 10');

  console.log('=== 11. Guest 主体对称与跨主体隔离 ===');
  const guestSubject: Subject = { type: 'guest', id: `guest_sc_${tag}` };
  const guestConv = await createNewConversationForSubject(guestSubject);
  const guestWork = await promoteArtifactForSubject(
    guestSubject,
    {
      conversationId: guestConv.id,
      sourceMessageId: `gm1_${tag}`,
      prompt: '访客提示词',
      storyText: '# 访客作品\n访客正文',
    },
    { generateTitle: async () => '访客作品集' },
  );
  const guestCollection = await prisma.guestStoryCollection.findUnique({
    where: { conversationId: guestConv.id },
  });
  assert.ok(guestCollection);
  assert.strictEqual(guestCollection!.title, '访客作品集');
  assert.strictEqual(
    (await prisma.guestStoryWork.findUnique({ where: { id: guestWork.id } }))!.collectionId,
    guestCollection!.id,
  );
  await assert.rejects(
    getCollectionForSubject(subjectA, guestCollection!.id),
    (error: unknown) => isTrpcErrorWithCode(error, 'NOT_FOUND'),
    'User 不得读取 Guest 集合',
  );
  await assert.rejects(
    getCollectionForSubject(guestSubject, collection1!.id),
    (error: unknown) => isTrpcErrorWithCode(error, 'NOT_FOUND'),
    'Guest 不得读取 User 集合',
  );
  console.log('PASS: 11');

  console.log('=== 12. list 视图、游标与搜索去重 ===');
  const activeList = await listCollectionsForSubject(subjectA, { view: 'active', limit: 50 });
  assert.ok(activeList.items.length >= 3, 'active 视图应包含全部未删除集合');
  assert.ok(activeList.items.every((c) => c.deletedAt === null));
  assert.strictEqual(activeList.hasMore, false);
  assert.strictEqual(activeList.nextCursor, null);
  const activeIds = activeList.items.map((c) => c.id);
  assert.strictEqual(new Set(activeIds).size, activeIds.length, '列表不得出现重复集合');

  await setCollectionFavoriteForSubject(subjectA, collection1!.id, true);
  const favoriteList = await listCollectionsForSubject(subjectA, { view: 'favorites', limit: 50 });
  assert.ok(favoriteList.items.some((c) => c.id === collection1!.id));
  assert.ok(favoriteList.items.every((c) => c.favoritedAt !== null && c.deletedAt === null));

  // 搜索命中集合内多个成员时按 Collection 去重（collection1 的两篇正文都含「秋」）
  const searchList = await listCollectionsForSubject(subjectA, { view: 'active', query: '秋', limit: 50 });
  const searchIds = searchList.items.map((c) => c.id);
  assert.strictEqual(new Set(searchIds).size, searchIds.length, '搜索结果必须按 Collection 去重');
  assert.strictEqual(searchIds.filter((id) => id === collection1!.id).length, 1);

  // 分页 keyset：limit=1 时 nextCursor 非空且不重复
  const page1 = await listCollectionsForSubject(subjectA, { view: 'active', limit: 1 });
  assert.strictEqual(page1.items.length, 1);
  assert.ok(page1.hasMore === (page1.nextCursor !== null));
  if (page1.nextCursor) {
    const page2 = await listCollectionsForSubject(subjectA, {
      view: 'active',
      limit: 1,
      cursor: page1.nextCursor,
    });
    assert.notStrictEqual(page2.items[0]!.id, page1.items[0]!.id, '分页不得重复');
  }
  await assert.rejects(
    listCollectionsForSubject(subjectA, { view: 'active', limit: 1, cursor: 'not-a-cursor' }),
    (error: unknown) => isTrpcErrorWithCode(error, 'BAD_REQUEST'),
  );
  console.log('PASS: 12');

  console.log('=== 13. 生命周期：软删级联、恢复、永久删除 ===');
  const detailBefore = await getCollectionForSubject(subjectA, collection2!.id);
  assert.strictEqual(detailBefore.works.length, 1);
  assert.strictEqual(detailBefore.works[0]!.position, 0);
  assert.strictEqual(detailBefore.works[0]!.audio.status, 'missing');

  await softDeleteCollectionForSubject(subjectA, collection2!.id);
  assert.strictEqual(
    await prisma.storyWork.count({ where: { collectionId: collection2!.id, deletedAt: { not: null } } }),
    1,
    '软删集合必须级联成员 Work',
  );
  await assert.rejects(
    getCollectionForSubject(subjectA, collection2!.id),
    (error: unknown) => isTrpcErrorWithCode(error, 'NOT_FOUND'),
  );
  const trashList = await listCollectionsForSubject(subjectA, { view: 'trash', limit: 50 });
  assert.ok(trashList.items.some((c) => c.id === collection2!.id));

  await restoreCollectionForSubject(subjectA, collection2!.id);
  assert.strictEqual(
    await prisma.storyWork.count({ where: { collectionId: collection2!.id, deletedAt: null } }),
    1,
    '恢复必须清空成员 deletedAt',
  );
  await assert.rejects(
    deleteForeverCollectionForSubject(subjectA, collection2!.id),
    (error: unknown) => isTrpcErrorWithCode(error, 'CONFLICT'),
    'active 集合不得永久删除',
  );

  await assert.rejects(
    renameCollectionForSubject(subjectA, collection1!.id, '   '),
    (error: unknown) => isTrpcErrorWithCode(error, 'BAD_REQUEST'),
  );

  await softDeleteCollectionForSubject(subjectA, collection2!.id);
  const deletedResult = await deleteForeverCollectionForSubject(subjectA, collection2!.id);
  assert.strictEqual(deletedResult.success, true);
  assert.strictEqual(await prisma.storyCollection.count({ where: { id: collection2!.id } }), 0);
  assert.strictEqual(await prisma.storyWork.count({ where: { collectionId: collection2!.id } }), 0);
  assert.strictEqual(await prisma.storyWork.count({ where: { id: work3.id } }), 0);
  console.log('PASS: 13');

  console.log('=== 14. closeConversation 幂等 ===');
  const closedAgain = await closeConversationForSubject(guestSubject, guestConv.id);
  assert.strictEqual(closedAgain.state, 'closed');
  const closedAgain2 = await closeConversationForSubject(guestSubject, guestConv.id);
  assert.strictEqual(closedAgain2.state, 'closed');
  console.log('PASS: 14');

  console.log('=== 15. restore-vs-deleteForever 竞态：成员恢复后永久删除必须 fail closed ===');
  for (const side of ['user', 'guest'] as const) {
    const raceMessageId = `race_${side}_${tag}`;
    const subject: Subject =
      side === 'user'
        ? { type: 'user', id: (await createUser(tag, `race_${side}`)).id }
        : { type: 'guest', id: `sc_race_guest_${tag}` };
    const raceConv = await createNewConversationForSubject(subject);
    const raceWork = await promoteArtifactForSubject(
      subject,
      {
        conversationId: raceConv.id,
        sourceMessageId: raceMessageId,
        prompt: '竞态作品',
        storyText: '# 竞态\n正文',
      },
      { generateTitle: async () => null },
    );
    const raceCollectionId =
      side === 'user'
        ? (await prisma.storyCollection.findUnique({ where: { conversationId: raceConv.id } }))!.id
        : (await prisma.guestStoryCollection.findUnique({ where: { conversationId: raceConv.id } }))!.id;

    // 集合软删 → 成员进入回收站
    await softDeleteCollectionForSubject(subject, raceCollectionId);
    // 模拟 restore 竞态窗口末态：deleteForever 已捕获成员后，单个成员被恢复为 active
    await restoreStoryWorkForSubject(subject, raceWork.id);

    // 竞态下永久删除必须 fail closed（禁止依赖 FK cascade 静默删除恢复后的 Work）
    await assert.rejects(
      deleteForeverCollectionForSubject(subject, raceCollectionId),
      (error: unknown) => isTrpcErrorWithCode(error, 'CONFLICT'),
      `${side}: 存在已恢复成员时永久删除必须 CONFLICT`,
    );

    if (side === 'user') {
      const survivor = await prisma.storyWork.findUnique({ where: { id: raceWork.id } });
      assert.ok(survivor && survivor.deletedAt === null, `${side}: 恢复后的 Work 不得被 FK cascade 删除`);
      assert.ok(
        await prisma.storyCollection.findUnique({ where: { id: raceCollectionId } }),
        `${side}: fail closed 后集合必须保留`,
      );
    } else {
      const survivor = await prisma.guestStoryWork.findUnique({ where: { id: raceWork.id } });
      assert.ok(survivor && survivor.deletedAt === null, `${side}: 恢复后的 Work 不得被 FK cascade 删除`);
      assert.ok(
        await prisma.guestStoryCollection.findUnique({ where: { id: raceCollectionId } }),
        `${side}: fail closed 后集合必须保留`,
      );
    }
  }
  console.log('PASS: 15');

  console.log('ALL STORY COLLECTION PROMOTION INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runStoryCollectionPromotionTests()
  .then(() => {
    console.log('ALL STORY COLLECTION PROMOTION INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
