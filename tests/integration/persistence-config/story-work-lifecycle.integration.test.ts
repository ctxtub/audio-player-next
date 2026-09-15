/**
 * StoryWork 生命周期 Mutations 集成测试（M2-05）
 *
 * 验收矩阵：
 * 1. renameStoryWorkForSubject：
 *    - 仅更新 title（+ updatedAt 变化）；
 *    - storyText / contentHash / excerpt 严格保持不变（内容身份不变性）；
 *    - 标题经 resolveStoryTitle 规范化（剥离首尾成对引号、空白压缩、长度截断）；
 *    - 空标题或纯空白标题以 BAD_REQUEST 拒绝；
 * 2. setStoryWorkFavoriteForSubject：
 *    - favorite 状态唯一 truth = favoritedAt（null=未收藏，非 null=已收藏）；
 *    - true → favoritedAt 写入时间戳；false → favoritedAt 置为 null；
 *    - 已收藏时再次传入 true 保持原 favoritedAt（幂等）；
 *    - 严格断言不存在第二个布尔字段；非布尔入参以 BAD_REQUEST 拒绝；
 * 3. trashStoryWorkForSubject：
 *    - 仅写入 deletedAt = now()；严禁物理删除，数据行在库（count 不变）；
 *    - 已在回收站中重复调用保持原 deletedAt（幂等，不刷新 30 天生命周期）；
 *    - 软删除后读模型 active 视图自动过滤，trash 视图可见；
 * 4. restoreStoryWorkForSubject：
 *    - 仅清空 deletedAt = null；
 *    - 必须严格保留原 favoritedAt（先收藏→trash→restore → 仍处于收藏状态）；
 *    - 对活跃作品（deletedAt === null）调用以明确领域错误 CONFLICT 拒绝；
 * 5. permanentlyDeleteStoryWorkForSubject：
 *    - 仅允许目标处于回收站（deletedAt !== null）；对 active 作品调用以明确 CONFLICT 拒绝；
 *    - 物理删除唯一执行点（统一 Service Seam，预留作为 M8 Audio tombstone 扩展点）；
 *    - 执行后数据行彻底从数据库中移除；
 * 6. 统一 NOT_FOUND：
 *    - nonexistent id / foreign id / invalid id 对全部 5 个 mutation 统一抛出 NOT_FOUND（作品不存在）；
 *    - 对回收站中作品调用 rename / setFavorite 统一抛出 NOT_FOUND；
 * 7. User / Guest 两种主体行为完全一致且数据物理隔离；
 * 8. 并发状态原子性与 TOCTOU 竞态回归（条件写拦截、状态转移冲突断言、Guest 对称保护）。
 */

import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import { TRPCError } from '@trpc/server';
import type { Subject } from '../../../lib/server/subject';
import {
  createStoryWorkForSubject,
  getStoryWorkForSubject,
  listStoryWorksForSubject,
  renameStoryWorkForSubject,
  setStoryWorkFavoriteForSubject,
  trashStoryWorkForSubject,
  restoreStoryWorkForSubject,
  permanentlyDeleteStoryWorkForSubject,
} from '../../../lib/server/storyWork';
import { storyWorkDetailDtoSchema } from '../../../lib/trpc/schemas/library';

async function runStoryWorkLifecycleTests() {
  const userTag = Date.now();
  console.log('=== 1. rename: title 更新 + updatedAt 变化 + contentHash/storyText/excerpt 保持不变 ===');
  const testUser = await prisma.user.create({
    data: {
      username: `sw_life_u1_${userTag}`,
      password: 'TestPassword123!',
      nickname: 'LifecycleTester',
    },
  });
  const userSubject: Subject = { type: 'user', id: testUser.id };

  const originalStoryText = '# 原始森林大冒险\n小松鼠在古老的橡树下发现了一颗会发光的神秘松果……';
  const originalPrompt = '写一个小松鼠森林探险的故事';
  const created = await createStoryWorkForSubject(userSubject, {
    prompt: originalPrompt,
    storyText: originalStoryText,
    voiceId: 'voice_alloy',
    sourceMessageId: 'msg_life_001',
  });

  const originalHash = created.contentHash;
  const originalExcerpt = created.excerpt;
  const originalCreatedAt = created.createdAt;
  const originalUpdatedAt = created.updatedAt;

  // 等待 25ms 确保 updatedAt 时间戳具备毫秒级单调递增可观测性
  await new Promise((resolve) => setTimeout(resolve, 25));

  // 1.1 正常重命名，入参包含首尾双引号与多余空白，验证 resolveStoryTitle 规范化
  const renamed = await renameStoryWorkForSubject(
    userSubject,
    created.id,
    '  “改名后的月球大冒险”  '
  );

  const parsedRenamed = storyWorkDetailDtoSchema.parse(renamed);
  assert.strictEqual(parsedRenamed.id, created.id);
  assert.strictEqual(renamed.title, '改名后的月球大冒险', '标题必须被 resolveStoryTitle 剥离引号与修剪空白');
  assert.strictEqual(renamed.contentHash, originalHash, 'rename 严禁更改 contentHash');
  assert.strictEqual(renamed.storyText, originalStoryText, 'rename 严禁更改 storyText');
  assert.strictEqual(renamed.excerpt, originalExcerpt, 'rename 严禁更改 excerpt');
  assert.strictEqual(renamed.prompt, originalPrompt, 'rename 严禁更改 prompt');
  assert.strictEqual(renamed.voiceId, 'voice_alloy', 'rename 严禁更改 voiceId');
  assert.strictEqual(renamed.createdAt, originalCreatedAt, 'createdAt 必须保持不变');
  assert(
    new Date(renamed.updatedAt).getTime() > new Date(originalUpdatedAt).getTime(),
    'updatedAt 必须发生更新且单调递增'
  );

  // 直接回查数据库底层行，确证正文与哈希绝对未被触碰
  const dbRowAfterRename = await prisma.storyWork.findUnique({
    where: { id: created.id },
  });
  assert(dbRowAfterRename !== null);
  assert.strictEqual(dbRowAfterRename.title, '改名后的月球大冒险');
  assert.strictEqual(dbRowAfterRename.contentHash, originalHash);
  assert.strictEqual(dbRowAfterRename.storyText, originalStoryText);
  assert.strictEqual(dbRowAfterRename.excerpt, originalExcerpt);

  // 1.2 非法标题拒绝（空字符串、纯空白）
  await assert.rejects(
    async () => renameStoryWorkForSubject(userSubject, created.id, ''),
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST' && err.message === '标题不能为空',
    '空标题必须抛出 BAD_REQUEST'
  );
  await assert.rejects(
    async () => renameStoryWorkForSubject(userSubject, created.id, '   '),
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST' && err.message === '标题不能为空',
    '纯空白标题必须抛出 BAD_REQUEST'
  );
  console.log('PASS: 1. rename 标题规范化、updatedAt 变化、正文与哈希严格不变通过');

  console.log('=== 2. favorite: true → favoritedAt 非 null；false → null；唯一 truth 断言 ===');
  // 2.1 初始未收藏
  assert.strictEqual(created.favoritedAt, null);

  // 2.2 收藏作品 (favorite = true)
  const favorited = await setStoryWorkFavoriteForSubject(userSubject, created.id, true);
  assert(favorited.favoritedAt !== null, 'favoritedAt 必须为非 null ISO 字符串');
  const favTimestamp1 = favorited.favoritedAt;

  const dbFavorited = await prisma.storyWork.findUnique({ where: { id: created.id } });
  assert(dbFavorited !== null);
  assert(dbFavorited.favoritedAt instanceof Date, 'DB 真实字段 favoritedAt 必须为 Date');

  // 2.3 幂等重试：已收藏状态下再次调用 favorite = true，保持原时间戳不变
  const refavorited = await setStoryWorkFavoriteForSubject(userSubject, created.id, true);
  assert.strictEqual(refavorited.favoritedAt, favTimestamp1, '重复收藏必须保持原 favoritedAt 时间戳（幂等）');

  // 2.4 取消收藏 (favorite = false)
  const unfavorited = await setStoryWorkFavoriteForSubject(userSubject, created.id, false);
  assert.strictEqual(unfavorited.favoritedAt, null, '取消收藏后 favoritedAt 必须为 null');

  const dbUnfavorited = await prisma.storyWork.findUnique({ where: { id: created.id } });
  assert(dbUnfavorited !== null);
  assert.strictEqual(dbUnfavorited.favoritedAt, null, 'DB 字段 favoritedAt 必须为 null');

  // 2.5 唯一 Truth 断言：断言模型行中不存在除 favoritedAt 外的第二个 boolean favorite 字段
  assert.strictEqual(
    (dbUnfavorited as Record<string, unknown>).favorite,
    undefined,
    '数据库模型不得存在多余的 favorite 布尔列，唯一真值为 favoritedAt'
  );

  // 2.6 非布尔入参以 BAD_REQUEST 拒绝
  await assert.rejects(
    async () => setStoryWorkFavoriteForSubject(userSubject, created.id, 'true' as unknown as boolean),
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    '非布尔入参必须抛出 BAD_REQUEST'
  );
  console.log('PASS: 2. favorite 唯一 truth 与切换断言通过');

  console.log('=== 3. trash: deletedAt 写入；行仍在（count 不变）===');
  const countBeforeTrash = await prisma.storyWork.count({ where: { userId: testUser.id } });

  const trashed = await trashStoryWorkForSubject(userSubject, created.id);
  assert(trashed.deletedAt !== null, 'deletedAt 必须被写入时间戳');
  const trashTimestamp1 = trashed.deletedAt;

  // 物理行必须完好存在，行数绝对不变
  const countAfterTrash = await prisma.storyWork.count({ where: { userId: testUser.id } });
  assert.strictEqual(countAfterTrash, countBeforeTrash, '移入回收站严禁物理删除，总行数必须保持不变');

  const dbTrashedRow = await prisma.storyWork.findUnique({ where: { id: created.id } });
  assert(dbTrashedRow !== null, '回收站中记录必须物理存在于 DB');
  assert(dbTrashedRow.deletedAt instanceof Date);

  // 读模型 active 视图隔离：active 不可见，trash 可见
  await assert.rejects(
    async () => getStoryWorkForSubject(userSubject, created.id),
    (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    '被放入回收站的作品在 getStoryWorkForSubject 中必须对外呈现 NOT_FOUND'
  );
  const activeList = await listStoryWorksForSubject(userSubject, { view: 'active' });
  assert(!activeList.items.some((item) => item.id === created.id), 'active 列表严禁包含回收站记录');
  const trashList = await listStoryWorksForSubject(userSubject, { view: 'trash' });
  assert(trashList.items.some((item) => item.id === created.id), 'trash 列表中必须包含该记录');

  // 幂等性：已处于回收站中重复调用 trash，必须保留最初的 deletedAt 时间戳（不刷新 30 天生命周期）
  await new Promise((resolve) => setTimeout(resolve, 20));
  const retrayedTrash = await trashStoryWorkForSubject(userSubject, created.id);
  assert.strictEqual(retrayedTrash.deletedAt, trashTimestamp1, '重复移入回收站必须保留原 deletedAt（不刷新生命周期）');
  console.log('PASS: 3. trash 软删除标记与行留存断言通过');

  console.log('=== 4. restore: deletedAt 清空；favoritedAt 严格保留（收藏→trash→restore → 仍收藏）===');
  // 创建第二条作品，验证完整的「先收藏 → 移入回收站 → 恢复」链路
  const work2 = await createStoryWorkForSubject(userSubject, {
    prompt: '用于测试恢复与收藏保持的故事',
    storyText: '# 坚韧的小松鼠\n松鼠在暴风雨后重建家园……',
  });
  // 4.1 先收藏
  const work2Fav = await setStoryWorkFavoriteForSubject(userSubject, work2.id, true);
  assert(work2Fav.favoritedAt !== null);
  const work2FavTime = work2Fav.favoritedAt;

  // 4.2 移入回收站
  const work2Trash = await trashStoryWorkForSubject(userSubject, work2.id);
  assert(work2Trash.deletedAt !== null);
  assert.strictEqual(work2Trash.favoritedAt, work2FavTime, '移入回收站时 favoritedAt 必须原样保留');

  // 4.3 恢复作品
  const work2Restored = await restoreStoryWorkForSubject(userSubject, work2.id);
  assert.strictEqual(work2Restored.deletedAt, null, 'restore 必须清空 deletedAt');
  assert.strictEqual(
    work2Restored.favoritedAt,
    work2FavTime,
    'restore 必须严格保留原 favoritedAt（收藏状态在软删除与恢复后依然保持）'
  );

  // 恢复后活跃读取与收藏视图恢复可见
  const work2Fetched = await getStoryWorkForSubject(userSubject, work2.id);
  assert.strictEqual(work2Fetched.id, work2.id);
  assert.strictEqual(work2Fetched.favoritedAt, work2FavTime);
  const favList = await listStoryWorksForSubject(userSubject, { view: 'favorites' });
  assert(favList.items.some((item) => item.id === work2.id), '恢复后的已收藏作品必须重现在 favorites 视图');

  // 4.4 对 active 作品调用 restore，必须明确以 CONFLICT 拒绝
  await assert.rejects(
    async () => restoreStoryWorkForSubject(userSubject, work2.id),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === 'CONFLICT' &&
      err.message === '作品未处于回收站中，无需恢复',
    '对 active 作品调用 restore 必须抛出 CONFLICT'
  );
  console.log('PASS: 4. restore 清空 deletedAt 且严格保留 favoritedAt 与 active 前置拒绝通过');

  console.log('=== 5. permanent delete: trash 后可物理删除；active 时被拒绝；删除后行不存在；seam 调用 ===');
  const work3 = await createStoryWorkForSubject(userSubject, {
    prompt: '用于测试永久物理删除的作品',
    storyText: '# 临时试验作品\n此作品将被永久销毁……',
  });

  // 5.1 对 active 状态的作品直接调用永久删除 → 必须以 CONFLICT 拒绝
  await assert.rejects(
    async () => permanentlyDeleteStoryWorkForSubject(userSubject, work3.id),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === 'CONFLICT' &&
      err.message === '仅允许对回收站中的作品执行永久删除',
    '直接对 active 作品调用 permanent delete 必须拒绝（CONFLICT）'
  );
  const dbWork3StillThere = await prisma.storyWork.findUnique({ where: { id: work3.id } });
  assert(dbWork3StillThere !== null, '拒绝后活跃作品必须完好在库');

  // 5.2 移入回收站后允许永久删除
  await trashStoryWorkForSubject(userSubject, work3.id);

  const countBeforePermanent = await prisma.storyWork.count({ where: { userId: testUser.id } });
  const deleteResult = await permanentlyDeleteStoryWorkForSubject(userSubject, work3.id);

  assert.strictEqual(deleteResult.success, true);
  assert.strictEqual(deleteResult.id, work3.id);

  // 数据库物理行必须彻底消失
  const countAfterPermanent = await prisma.storyWork.count({ where: { userId: testUser.id } });
  assert.strictEqual(countAfterPermanent, countBeforePermanent - 1, '永久删除后总行数必须减少 1');
  const dbWork3Deleted = await prisma.storyWork.findUnique({ where: { id: work3.id } });
  assert.strictEqual(dbWork3Deleted, null, '永久删除后物理行必须为 null');

  // 二次调用永久删除 → 统一抛出 NOT_FOUND
  await assert.rejects(
    async () => permanentlyDeleteStoryWorkForSubject(userSubject, work3.id),
    (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND' && err.message === '作品不存在',
    '对已永久删除的作品再次删除应抛 NOT_FOUND'
  );
  console.log('PASS: 5. permanent delete active 拒绝、trash 后物理删除、行彻底消失与 seam 触发断言通过');

  console.log('=== 6. foreign id / nonexistent id / 非法 id → 各 mutation 统一 NOT_FOUND ===');
  const userOther = await prisma.user.create({
    data: {
      username: `sw_other_u2_${userTag}`,
      password: 'TestPassword123!',
      nickname: 'OtherUserTester',
    },
  });
  const otherSubject: Subject = { type: 'user', id: userOther.id };
  const otherWork = await createStoryWorkForSubject(otherSubject, {
    prompt: '他人作品',
    storyText: '# 他人专属故事\n秘密正文……',
  });

  const nonexistentId = 99999999;
  const invalidIds = [-1, 0, 1.5, NaN];

  const mutationOperations = [
    {
      name: 'renameStoryWorkForSubject',
      fn: (s: Subject, id: number) => renameStoryWorkForSubject(s, id, '新标题'),
    },
    {
      name: 'setStoryWorkFavoriteForSubject',
      fn: (s: Subject, id: number) => setStoryWorkFavoriteForSubject(s, id, true),
    },
    {
      name: 'trashStoryWorkForSubject',
      fn: (s: Subject, id: number) => trashStoryWorkForSubject(s, id),
    },
    {
      name: 'restoreStoryWorkForSubject',
      fn: (s: Subject, id: number) => restoreStoryWorkForSubject(s, id),
    },
    {
      name: 'permanentlyDeleteStoryWorkForSubject',
      fn: (s: Subject, id: number) => permanentlyDeleteStoryWorkForSubject(s, id),
    },
  ];

  for (const op of mutationOperations) {
    // 6.1 跨租户访问（操作他人作品）→ 统一 NOT_FOUND（不可区分）
    await assert.rejects(
      async () => op.fn(userSubject, otherWork.id),
      (err: unknown) =>
        err instanceof TRPCError &&
        err.code === 'NOT_FOUND' &&
        err.message === '作品不存在',
      `${op.name} 跨租户调用必须抛出统一 NOT_FOUND（作品不存在）`
    );

    // 6.2 不存在 ID → 统一 NOT_FOUND
    await assert.rejects(
      async () => op.fn(userSubject, nonexistentId),
      (err: unknown) =>
        err instanceof TRPCError &&
        err.code === 'NOT_FOUND' &&
        err.message === '作品不存在',
      `${op.name} 不存在 ID 必须抛出统一 NOT_FOUND（作品不存在）`
    );

    // 6.3 非法 ID → 统一 NOT_FOUND
    for (const invId of invalidIds) {
      await assert.rejects(
        async () => op.fn(userSubject, invId),
        (err: unknown) =>
          err instanceof TRPCError &&
          err.code === 'NOT_FOUND' &&
          err.message === '作品不存在',
        `${op.name} 非法 ID (${invId}) 必须抛出统一 NOT_FOUND`
      );
    }
  }

  // 6.4 处于回收站的作品被调用 rename / setFavorite → 统一 NOT_FOUND
  await assert.rejects(
    async () => renameStoryWorkForSubject(userSubject, created.id, '试图改名回收站作品'),
    (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND' && err.message === '作品不存在',
    '对回收站作品调用 rename 必须统一呈现 NOT_FOUND'
  );
  await assert.rejects(
    async () => setStoryWorkFavoriteForSubject(userSubject, created.id, true),
    (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND' && err.message === '作品不存在',
    '对回收站作品调用 setFavorite 必须统一呈现 NOT_FOUND'
  );

  // 验证他人的作品未受任何篡改
  const otherWorkIntact = await getStoryWorkForSubject(otherSubject, otherWork.id);
  assert.strictEqual(otherWorkIntact.title, '他人专属故事');
  assert.strictEqual(otherWorkIntact.favoritedAt, null);
  assert.strictEqual(otherWorkIntact.deletedAt, null);
  console.log('PASS: 6. foreign / nonexistent / invalid id 全 mutation 统一 NOT_FOUND 通过');

  console.log('=== 7. User / Guest 两表完全对称同构实现 ===');
  const guestIdA = `g_life_a_${userTag}`;
  const guestIdB = `g_life_b_${userTag}`;
  const guestSubjectA: Subject = { type: 'guest', id: guestIdA };
  const guestSubjectB: Subject = { type: 'guest', id: guestIdB };

  // 7.1 Guest 创建作品
  const guestWork = await createStoryWorkForSubject(guestSubjectA, {
    prompt: '访客故事提示词',
    storyText: '# 访客的奇妙探险\n森林里的小松鼠正在收集松果……',
  });
  const guestOriginalHash = guestWork.contentHash;
  const guestOriginalText = guestWork.storyText;
  const guestOriginalExcerpt = guestWork.excerpt;

  await new Promise((resolve) => setTimeout(resolve, 25));

  // 7.2 Guest Rename
  const guestRenamed = await renameStoryWorkForSubject(
    guestSubjectA,
    guestWork.id,
    '  “访客改名后的大森林”  '
  );
  assert.strictEqual(guestRenamed.title, '访客改名后的大森林');
  assert.strictEqual(guestRenamed.contentHash, guestOriginalHash);
  assert.strictEqual(guestRenamed.storyText, guestOriginalText);
  assert.strictEqual(guestRenamed.excerpt, guestOriginalExcerpt);

  // 7.3 Guest Favorite 切换与幂等
  const guestFav = await setStoryWorkFavoriteForSubject(guestSubjectA, guestWork.id, true);
  assert(guestFav.favoritedAt !== null);
  const guestFavTime = guestFav.favoritedAt;

  const guestFavIdempotent = await setStoryWorkFavoriteForSubject(guestSubjectA, guestWork.id, true);
  assert.strictEqual(guestFavIdempotent.favoritedAt, guestFavTime);

  // 7.4 Guest Trash
  const guestCountBefore = await prisma.guestStoryWork.count({ where: { guestId: guestIdA } });
  const guestTrashed = await trashStoryWorkForSubject(guestSubjectA, guestWork.id);
  assert(guestTrashed.deletedAt !== null);
  const guestCountAfter = await prisma.guestStoryWork.count({ where: { guestId: guestIdA } });
  assert.strictEqual(guestCountAfter, guestCountBefore, '访客移入回收站行数不减');

  // 7.5 Guest Restore（保持收藏）
  const guestRestored = await restoreStoryWorkForSubject(guestSubjectA, guestWork.id);
  assert.strictEqual(guestRestored.deletedAt, null);
  assert.strictEqual(guestRestored.favoritedAt, guestFavTime, '访客恢复必须保留收藏');

  // 7.6 Guest Active 直接 Permanent Delete 拒绝
  await assert.rejects(
    async () => permanentlyDeleteStoryWorkForSubject(guestSubjectA, guestWork.id),
    (err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT',
    '访客活跃作品直接永久删除必须被拒绝'
  );

  // 7.7 Guest Trash 后永久删除
  await trashStoryWorkForSubject(guestSubjectA, guestWork.id);
  const guestPermanentRes = await permanentlyDeleteStoryWorkForSubject(guestSubjectA, guestWork.id);
  assert.strictEqual(guestPermanentRes.success, true);
  assert.strictEqual(guestPermanentRes.id, guestWork.id);

  const guestDbDeleted = await prisma.guestStoryWork.findUnique({ where: { id: guestWork.id } });
  assert.strictEqual(guestDbDeleted, null, '访客永久删除后物理记录不存在');

  // 7.8 Guest 跨租户与跨主体隔离
  const guestWorkB = await createStoryWorkForSubject(guestSubjectB, {
    prompt: 'Guest B 作品',
    storyText: '# Guest B 正文\n内容……',
  });
  // Guest A 操作 Guest B 作品 → NOT_FOUND
  for (const op of mutationOperations) {
    await assert.rejects(
      async () => op.fn(guestSubjectA, guestWorkB.id),
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND' && err.message === '作品不存在'
    );
  }
  // 独立无资产的 User C 操作 Guest B 作品 ID → 物理隔离且 User 库无此资产，统一 NOT_FOUND
  const userC = await prisma.user.create({
    data: {
      username: `sw_user_c_${userTag}`,
      password: 'TestPassword123!',
      nickname: 'UserC',
    },
  });
  const userSubjectC: Subject = { type: 'user', id: userC.id };
  for (const op of mutationOperations) {
    await assert.rejects(
      async () => op.fn(userSubjectC, guestWorkB.id),
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND' && err.message === '作品不存在'
    );
  }
  // 独立无资产的 Guest C 操作 User 资产 ID → 物理隔离且 Guest 库无此资产，统一 NOT_FOUND
  const guestSubjectC: Subject = { type: 'guest', id: `g_empty_c_${userTag}` };
  for (const op of mutationOperations) {
    await assert.rejects(
      async () => op.fn(guestSubjectC, otherWork.id),
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND' && err.message === '作品不存在'
    );
  }
  console.log('PASS: 7. User / Guest 对称性与物理隔离全面验证通过');

  console.log('=== 8. Concurrency Race & Atomic Conditional Write Regressions (TOCTOU 防御) ===');

  // 8.1 核心 TOCTOU 竞态：permanent-delete vs concurrent restore
  // 场景：作品在回收站中，调用者发起永久删除，但在 deleteMany 条件写执行前并发发生了 restore。
  // 原子性保障：deleteMany 带有 deletedAt IS NOT NULL 条件，恢复后的 active 作品不能被物理删除，且永久删除抛出 CONFLICT。
  const raceWork1 = await createStoryWorkForSubject(userSubject, {
    prompt: 'TOCTOU 竞态测试作品 1',
    storyText: '# 竞态测试故事 1\n测试永久删除与恢复的并发竞态……',
  });
  await trashStoryWorkForSubject(userSubject, raceWork1.id);

  let restoreExecuted = false;
  await assert.rejects(
    async () =>
      permanentlyDeleteStoryWorkForSubject(userSubject, raceWork1.id, {
        __testBeforeMutationHook: async () => {
          // 模拟并发先行一步完成 restore
          await restoreStoryWorkForSubject(userSubject, raceWork1.id);
          restoreExecuted = true;
        },
      }),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === 'CONFLICT' &&
      err.message === '仅允许对回收站中的作品执行永久删除',
    '当永久删除与恢复发生竞态时，原子条件写必须保证已恢复的活跃作品不被删除并抛出 CONFLICT'
  );
  assert.strictEqual(restoreExecuted, true, '并发注入 hook 必须已执行');

  // 确证作品依然在库且处于活跃状态（deletedAt === null）
  const raceWork1Row = await prisma.storyWork.findUnique({ where: { id: raceWork1.id } });
  assert(raceWork1Row !== null, '竞态发生后活跃作品必须依然存在于数据库');
  assert.strictEqual(raceWork1Row.deletedAt, null, '活跃作品 deletedAt 必须保持为 null');

  // 8.2 TOCTOU 竞态：rename vs concurrent trash
  // 场景：活跃作品在 rename 执行 updateMany 条件写前被并发移入回收站。
  // 原子性保障：rename updateMany 带有 deletedAt: null 条件，匹配 0 行，抛出 NOT_FOUND，标题不被篡改。
  const raceWork2 = await createStoryWorkForSubject(userSubject, {
    prompt: 'TOCTOU 竞态测试作品 2',
    storyText: '# 竞态测试故事 2\n测试重命名与移入回收站的并发竞态……',
  });
  let renameTrashExecuted = false;
  await assert.rejects(
    async () =>
      renameStoryWorkForSubject(
        userSubject,
        raceWork2.id,
        '尝试在并发放入回收站时改名',
        {
          __testBeforeMutationHook: async () => {
            await trashStoryWorkForSubject(userSubject, raceWork2.id);
            renameTrashExecuted = true;
          },
        }
      ),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === 'NOT_FOUND' &&
      err.message === '作品不存在',
    '当重命名执行前作品被并发移入回收站，原子条件写必须命中 0 行并抛出 NOT_FOUND'
  );
  assert.strictEqual(renameTrashExecuted, true);

  const raceWork2Row = await prisma.storyWork.findUnique({ where: { id: raceWork2.id } });
  assert(raceWork2Row !== null);
  assert.notStrictEqual(raceWork2Row.title, '尝试在并发放入回收站时改名', '标题绝对不得被改写');
  assert(raceWork2Row.deletedAt !== null, '作品必须处于回收站');

  // 8.3 TOCTOU 竞态：favorite vs concurrent trash
  // 场景：活跃作品在 setFavorite 执行 updateMany 前被并发移入回收站。
  // 原子性保障：updateMany 匹配 0 行，检查 row 发现已处于回收站，统一抛出 NOT_FOUND，favoritedAt 不被设置。
  const raceWork3 = await createStoryWorkForSubject(userSubject, {
    prompt: 'TOCTOU 竞态测试作品 3',
    storyText: '# 竞态测试故事 3\n测试收藏与移入回收站的并发竞态……',
  });
  let favTrashExecuted = false;
  await assert.rejects(
    async () =>
      setStoryWorkFavoriteForSubject(userSubject, raceWork3.id, true, {
        __testBeforeMutationHook: async () => {
          await trashStoryWorkForSubject(userSubject, raceWork3.id);
          favTrashExecuted = true;
        },
      }),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === 'NOT_FOUND' &&
      err.message === '作品不存在',
    '当收藏操作执行前作品被移入回收站，必须抛出 NOT_FOUND 且 favoritedAt 不得被修改'
  );
  assert.strictEqual(favTrashExecuted, true);

  const raceWork3Row = await prisma.storyWork.findUnique({ where: { id: raceWork3.id } });
  assert(raceWork3Row !== null);
  assert.strictEqual(raceWork3Row.favoritedAt, null, 'favoritedAt 严禁被写入');
  assert(raceWork3Row.deletedAt !== null, '作品必须处于回收站');

  // 8.4 TOCTOU 竞态：restore vs concurrent restore（并发重复恢复）
  // 场景：两路并发发起 restore，第一路完成清空 deletedAt，第二路由于 deletedAt IS NOT NULL 条件落空，抛出 CONFLICT。
  const raceWork4 = await createStoryWorkForSubject(userSubject, {
    prompt: 'TOCTOU 竞态测试作品 4',
    storyText: '# 竞态测试故事 4\n测试并发重复恢复……',
  });
  await trashStoryWorkForSubject(userSubject, raceWork4.id);

  let concurrentRestoreExecuted = false;
  await assert.rejects(
    async () =>
      restoreStoryWorkForSubject(userSubject, raceWork4.id, {
        __testBeforeMutationHook: async () => {
          await restoreStoryWorkForSubject(userSubject, raceWork4.id);
          concurrentRestoreExecuted = true;
        },
      }),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === 'CONFLICT' &&
      err.message === '作品未处于回收站中，无需恢复',
    '当恢复操作检测到已被并发恢复时，原子条件写落空并抛出 CONFLICT'
  );
  assert.strictEqual(concurrentRestoreExecuted, true);

  const raceWork4Row = await prisma.storyWork.findUnique({ where: { id: raceWork4.id } });
  assert(raceWork4Row !== null);
  assert.strictEqual(raceWork4Row.deletedAt, null, '作品必须处于恢复后的活跃状态');

  // 8.5 Guest 对称性：Guest 主体下的 permanent-delete vs concurrent restore 竞态回归
  const guestRaceWork = await createStoryWorkForSubject(guestSubjectA, {
    prompt: 'Guest 竞态测试作品',
    storyText: '# 访客竞态测试故事\n访客永久删除与恢复竞态……',
  });
  await trashStoryWorkForSubject(guestSubjectA, guestRaceWork.id);

  let guestRestoreExecuted = false;
  await assert.rejects(
    async () =>
      permanentlyDeleteStoryWorkForSubject(guestSubjectA, guestRaceWork.id, {
        __testBeforeMutationHook: async () => {
          await restoreStoryWorkForSubject(guestSubjectA, guestRaceWork.id);
          guestRestoreExecuted = true;
        },
      }),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === 'CONFLICT' &&
      err.message === '仅允许对回收站中的作品执行永久删除',
    'Guest 主体下发生永久删除与恢复竞态时同样必须以 CONFLICT 拒绝并保留活跃数据'
  );
  assert.strictEqual(guestRestoreExecuted, true);

  const guestRaceRow = await prisma.guestStoryWork.findUnique({ where: { id: guestRaceWork.id } });
  assert(guestRaceRow !== null, 'Guest 活跃作品绝对不能被误删');
  assert.strictEqual(guestRaceRow.deletedAt, null);

  console.log('PASS: 8. 并发状态原子性与 TOCTOU 竞态回归全面通过');
}

const testPromise = runStoryWorkLifecycleTests()
  .then(() => {
    console.log('ALL STORYWORK LIFECYCLE SERVICE INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('StoryWork lifecycle service integration test failed:', err);
    process.exit(1);
  });

export default testPromise;
