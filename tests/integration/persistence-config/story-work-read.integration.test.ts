/**
 * StoryWork 作品库读模型服务层集成测试（M2-03）
 *
 * 覆盖验收矩阵：
 * 1. Keyset 分页（65 条 → 20→20→20→5 无重复无遗漏，同 timestamp 靠 id DESC 确定性排序）；
 * 2. 游标 view / query 强绑定校验（跨视图/跨检索词/格式损坏立即拒绝）；
 * 3. 视图过滤（active 不含 trash，favorites 只含 active+favorited，trash 只含 deleted）；
 * 4. 检索安全性（只搜 title/prompt/excerpt，正文独有关键词严格不命中）；
 * 5. 主体隔离与统一 NOT_FOUND（User A/B 隔离，Guest A/B 隔离，trash/foreign/nonexistent 统一 NOT_FOUND）；
 * 6. 旧数据懒修复（Lazy Backfill：首次读取补齐并落盘，不跨主体，二次读取零开销，搜索前修复）；
 * 7. hasMore 派生回归恒等式（hasMore === (nextCursor !== null)）；
 * 8. DTO 契约与缺省音频投影结构。
 */

import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import { TRPCError } from '@trpc/server';
import type { Subject } from '../../../lib/server/subject';
import {
  listStoryWorksForSubject,
  getStoryWorkForSubject,
  repairLegacyStoryWorksForSubject,
} from '../../../lib/server/storyWork';
import {
  storyWorkSummaryDtoSchema,
  storyWorkDetailDtoSchema,
} from '../../../lib/trpc/schemas/library';
import {
  encodeLibraryCursor,
} from '../../../lib/storyWork/cursor';

async function runStoryWorkReadTests() {
  console.log('=== 1. Keyset 分页与时间戳冲突有序性（65 条 → 20→20→20→5）===');
  const userTag = Date.now();
  const testUserPagination = await prisma.user.create({
    data: {
      username: `sw_page_user_${userTag}`,
      password: 'TestPassword123!',
      nickname: 'PaginationTester',
    },
  });
  const paginationSubject: Subject = { type: 'user', id: testUserPagination.id };

  // 构造 65 条数据：分成 3 组不同时间戳（25 条、25 条、15 条），组内所有记录 createdAt 完全相同
  // 严格验证同 timestamp 下靠 id DESC 保证确定序、无重复、无遗漏
  const baseTime = new Date('2026-09-10T12:00:00.000Z');
  const timeGroup1 = new Date(baseTime.getTime() + 1000 * 60 * 10); // +10m (最新)
  const timeGroup2 = new Date(baseTime.getTime() + 1000 * 60 * 5);  // +5m
  const timeGroup3 = baseTime;                                       // base (最老)

  const createdIds: number[] = [];
  for (let i = 1; i <= 65; i++) {
    const createdAt = i <= 25 ? timeGroup1 : i <= 50 ? timeGroup2 : timeGroup3;
    const row = await prisma.storyWork.create({
      data: {
        userId: testUserPagination.id,
        title: `故事编号-${String(i).padStart(3, '0')}`,
        prompt: `提示词-${i}`,
        excerpt: `这是故事-${i}的摘要`,
        storyText: `这是故事-${i}的正文内容……`,
        contentHash: `hash${String(i).padStart(8, '0')}`,
        createdAt,
      },
    });
    createdIds.push(row.id);
  }

  // 1.1 第一页：20 条
  const page1 = await listStoryWorksForSubject(paginationSubject, { limit: 20 });
  assert.strictEqual(page1.items.length, 20, '第一页应返回 20 条');
  assert(page1.nextCursor !== null, '第一页应有 nextCursor');
  assert.strictEqual(page1.hasMore, true, '第一页 hasMore 应为 true');
  assert.strictEqual(page1.hasMore, page1.nextCursor !== null, 'hasMore 必须恒等于 (nextCursor !== null)');

  // 1.2 第二页：20 条
  const page2 = await listStoryWorksForSubject(paginationSubject, {
    limit: 20,
    cursor: page1.nextCursor,
  });
  assert.strictEqual(page2.items.length, 20, '第二页应返回 20 条');
  assert(page2.nextCursor !== null, '第二页应有 nextCursor');
  assert.strictEqual(page2.hasMore, true, '第二页 hasMore 应为 true');
  assert.strictEqual(page2.hasMore, page2.nextCursor !== null);

  // 1.3 第三页：20 条
  const page3 = await listStoryWorksForSubject(paginationSubject, {
    limit: 20,
    cursor: page2.nextCursor,
  });
  assert.strictEqual(page3.items.length, 20, '第三页应返回 20 条');
  assert(page3.nextCursor !== null, '第三页应有 nextCursor');
  assert.strictEqual(page3.hasMore, true, '第三页 hasMore 应为 true');
  assert.strictEqual(page3.hasMore, page3.nextCursor !== null);

  // 1.4 第四页：剩余 5 条
  const page4 = await listStoryWorksForSubject(paginationSubject, {
    limit: 20,
    cursor: page3.nextCursor,
  });
  assert.strictEqual(page4.items.length, 5, '第四页应返回剩余 5 条');
  assert.strictEqual(page4.nextCursor, null, '第四页应无 nextCursor');
  assert.strictEqual(page4.hasMore, false, '第四页 hasMore 应为 false');
  assert.strictEqual(page4.hasMore, page4.nextCursor !== null);

  // 1.5 整体检验：无重复、无遗漏、严格满足 (createdAt DESC, id DESC)
  const allPagedItems = [
    ...page1.items,
    ...page2.items,
    ...page3.items,
    ...page4.items,
  ];
  assert.strictEqual(allPagedItems.length, 65, '累计拉取必须为 65 条');

  const pagedIdSet = new Set(allPagedItems.map((item) => item.id));
  assert.strictEqual(pagedIdSet.size, 65, '65 条拉取结果中严禁出现重复主键');
  for (const cid of createdIds) {
    assert(pagedIdSet.has(cid), `创建的 ID ${cid} 必须出现在分页结果中（无遗漏）`);
  }

  for (let i = 0; i < allPagedItems.length - 1; i++) {
    const cur = allPagedItems[i];
    const next = allPagedItems[i + 1];
    const curTime = new Date(cur.createdAt).getTime();
    const nextTime = new Date(next.createdAt).getTime();
    if (curTime === nextTime) {
      assert(cur.id > next.id, `相同创建时间下，当前 id(${cur.id}) 必须大于后一项 id(${next.id})`);
    } else {
      assert(curTime > nextTime, `创建时间必须单调递减`);
    }
  }
  console.log('PASS: 65条分页 20→20→20→5 无重复、无遗漏且时间戳冲突下确定排序');

  console.log('=== 2. Cursor View / Query 强绑定校验 ===');
  // 2.1 跨视图游标误用：active 游标用于 favorites / trash
  await assert.rejects(
    async () => {
      await listStoryWorksForSubject(paginationSubject, {
        view: 'favorites',
        cursor: page1.nextCursor!,
      });
    },
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      assert.strictEqual(err.message, '无效或不匹配的分页游标');
      return true;
    },
    'active 游标请求 favorites 视图必须以 BAD_REQUEST 拒绝'
  );

  await assert.rejects(
    async () => {
      await listStoryWorksForSubject(paginationSubject, {
        view: 'trash',
        cursor: page1.nextCursor!,
      });
    },
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'active 游标请求 trash 视图必须拒绝'
  );

  // 2.2 跨检索词游标误用：无 query 游标用于有 query 请求
  await assert.rejects(
    async () => {
      await listStoryWorksForSubject(paginationSubject, {
        query: '故事',
        cursor: page1.nextCursor!,
      });
    },
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    'query 改变后使用旧游标必须以 BAD_REQUEST 拒绝'
  );

  // 2.3 非法损坏游标
  await assert.rejects(
    async () => {
      await listStoryWorksForSubject(paginationSubject, {
        cursor: 'invalid-not-base64-random-string',
      });
    },
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    },
    '非法游标必须以 BAD_REQUEST 拒绝'
  );

  // 2.4 检索词指纹一致性放行与变更拦截
  const queryListRes = await listStoryWorksForSubject(paginationSubject, {
    query: '编号',
    limit: 10,
  });
  assert(queryListRes.nextCursor !== null);
  // 相同 query 放行
  const queryNextRes = await listStoryWorksForSubject(paginationSubject, {
    query: '编号',
    cursor: queryListRes.nextCursor,
    limit: 10,
  });
  assert.strictEqual(queryNextRes.items.length, 10);
  // 首尾带空格等价放行
  const queryTrimmedRes = await listStoryWorksForSubject(paginationSubject, {
    query: '  编号  ',
    cursor: queryListRes.nextCursor,
    limit: 10,
  });
  assert.strictEqual(queryTrimmedRes.items.length, 10);
  // 不同 query 拒绝
  await assert.rejects(
    async () => {
      await listStoryWorksForSubject(paginationSubject, {
        query: '故事',
        cursor: queryListRes.nextCursor!,
      });
    },
    (err: unknown) => {
      assert(err instanceof TRPCError);
      assert.strictEqual(err.code, 'BAD_REQUEST');
      return true;
    }
  );
  console.log('PASS: Cursor View 与 Query 绑定校验有效');

  console.log('=== 3. 视图过滤（active / favorites / trash）===');
  const testUserViews = await prisma.user.create({
    data: {
      username: `sw_view_user_${userTag}`,
      password: 'TestPassword123!',
      nickname: 'ViewTester',
    },
  });
  const viewsSubject: Subject = { type: 'user', id: testUserViews.id };

  const now = new Date();
  // 3.1 准备 4 种状态的作品
  const activeItem = await prisma.storyWork.create({
    data: {
      userId: testUserViews.id,
      title: 'Active 未收藏',
      prompt: 'p1',
      excerpt: 'e1',
      storyText: 's1',
      contentHash: 'h1',
      favoritedAt: null,
      deletedAt: null,
    },
  });
  const favoriteItem = await prisma.storyWork.create({
    data: {
      userId: testUserViews.id,
      title: 'Active 已收藏',
      prompt: 'p2',
      excerpt: 'e2',
      storyText: 's2',
      contentHash: 'h2',
      favoritedAt: new Date(now.getTime() - 1000),
      deletedAt: null,
    },
  });
  const trashItem = await prisma.storyWork.create({
    data: {
      userId: testUserViews.id,
      title: 'Trash 未收藏',
      prompt: 'p3',
      excerpt: 'e3',
      storyText: 's3',
      contentHash: 'h3',
      favoritedAt: null,
      deletedAt: new Date(now.getTime() - 2000),
    },
  });
  const trashFavoritedItem = await prisma.storyWork.create({
    data: {
      userId: testUserViews.id,
      title: 'Trash 已收藏',
      prompt: 'p4',
      excerpt: 'e4',
      storyText: 's4',
      contentHash: 'h4',
      favoritedAt: new Date(now.getTime() - 3000),
      deletedAt: new Date(now.getTime() - 1000),
    },
  });

  // 3.2 active 视图：必须包含 activeItem, favoriteItem；严禁包含 trashItem, trashFavoritedItem
  const activeRes = await listStoryWorksForSubject(viewsSubject, { view: 'active' });
  const activeIds = activeRes.items.map((i) => i.id);
  assert(activeIds.includes(activeItem.id), 'active 必须包含 activeItem');
  assert(activeIds.includes(favoriteItem.id), 'active 必须包含 favoriteItem');
  assert(!activeIds.includes(trashItem.id), 'active 绝不得包含 trashItem');
  assert(!activeIds.includes(trashFavoritedItem.id), 'active 绝不得包含 trashFavoritedItem');

  // 3.3 favorites 视图：只包含 active+favorited（favoriteItem），严禁包含 activeItem 与回收站条目
  const favRes = await listStoryWorksForSubject(viewsSubject, { view: 'favorites' });
  const favIds = favRes.items.map((i) => i.id);
  assert(favIds.includes(favoriteItem.id), 'favorites 必须包含 favoriteItem');
  assert(!favIds.includes(activeItem.id), 'favorites 不得包含未收藏项');
  assert(!favIds.includes(trashItem.id), 'favorites 不得包含回收站项');
  assert(!favIds.includes(trashFavoritedItem.id), 'favorites 不得包含回收站中的已收藏项');

  // 3.4 trash 视图：只包含 trashItem, trashFavoritedItem
  const trashRes = await listStoryWorksForSubject(viewsSubject, { view: 'trash' });
  const trashIds = trashRes.items.map((i) => i.id);
  assert(trashIds.includes(trashItem.id), 'trash 必须包含 trashItem');
  assert(trashIds.includes(trashFavoritedItem.id), 'trash 必须包含 trashFavoritedItem');
  assert(!trashIds.includes(activeItem.id), 'trash 不得包含 activeItem');
  assert(!trashIds.includes(favoriteItem.id), 'trash 不得包含 favoriteItem');

  // 3.5 trash 排序与游标检验：deletedAt DESC, id DESC
  assert(trashRes.items.length >= 2);
  const t1 = new Date(trashRes.items[0].deletedAt!).getTime();
  const t2 = new Date(trashRes.items[1].deletedAt!).getTime();
  assert(t1 >= t2, 'trash 视图必须按 deletedAt DESC 排序');
  console.log('PASS: views 隔离断言（active/favorites/trash）通过');

  console.log('=== 4. 检索安全性：只搜 title/prompt/excerpt，正文独有关键词不得命中 ===');
  const searchUser = await prisma.user.create({
    data: {
      username: `sw_search_user_${userTag}`,
      password: 'TestPassword123!',
      nickname: 'SearchTester',
    },
  });
  const searchSubject: Subject = { type: 'user', id: searchUser.id };

  const secretBodyKey = 'SECRET_BODY_ONLY_MAGIC_X999';
  const itemTitle = await prisma.storyWork.create({
    data: {
      userId: searchUser.id,
      title: '金色秋天的故事TITLE',
      prompt: '普通提示词A',
      excerpt: '普通摘要A',
      storyText: '普通故事正文A',
      contentHash: 'hash_s1',
    },
  });
  const itemPrompt = await prisma.storyWork.create({
    data: {
      userId: searchUser.id,
      title: '普通标题B',
      prompt: '魔法小猫咪PROMPT_KEY',
      excerpt: '普通摘要B',
      storyText: '普通故事正文B',
      contentHash: 'hash_s2',
    },
  });
  const itemExcerpt = await prisma.storyWork.create({
    data: {
      userId: searchUser.id,
      title: '普通标题C',
      prompt: '普通提示词C',
      excerpt: '夜空中的极光EXCERPT_KEY',
      storyText: '普通故事正文C',
      contentHash: 'hash_s3',
    },
  });
  const itemBodyOnly = await prisma.storyWork.create({
    data: {
      userId: searchUser.id,
      title: '普通标题D',
      prompt: '普通提示词D',
      excerpt: '普通摘要D',
      storyText: `这篇故事包含正文独有且完全不出现在前三字段的暗号：${secretBodyKey}，请保持保密。`,
      contentHash: 'hash_s4',
    },
  });

  // 4.1 命中 title
  const resTitle = await listStoryWorksForSubject(searchSubject, { query: '秋天的故事TITLE' });
  assert.strictEqual(resTitle.items.length, 1);
  assert.strictEqual(resTitle.items[0].id, itemTitle.id);

  // 4.2 命中 prompt
  const resPrompt = await listStoryWorksForSubject(searchSubject, { query: '魔法小猫咪PROMPT_KEY' });
  assert.strictEqual(resPrompt.items.length, 1);
  assert.strictEqual(resPrompt.items[0].id, itemPrompt.id);

  // 4.3 命中 excerpt
  const resExcerpt = await listStoryWorksForSubject(searchSubject, { query: '极光EXCERPT_KEY' });
  assert.strictEqual(resExcerpt.items.length, 1);
  assert.strictEqual(resExcerpt.items[0].id, itemExcerpt.id);

  // 4.4 搜索正文独有关键词：严格必须返回 0 条！
  const resBody = await listStoryWorksForSubject(searchSubject, { query: secretBodyKey });
  assert.strictEqual(resBody.items.length, 0, '正文独有关键词严格不得被检索命中！');
  console.log('PASS: 检索范围严格约束（只搜 title/prompt/excerpt，严禁扫描 storyText）');

  console.log('=== 5. 主体隔离与统一 NOT_FOUND（跨租户/回收站/不存在）===');
  const userA = await prisma.user.create({
    data: { username: `sw_iso_ua_${userTag}`, password: 'Password123!' },
  });
  const userB = await prisma.user.create({
    data: { username: `sw_iso_ub_${userTag}`, password: 'Password123!' },
  });
  const subjectA: Subject = { type: 'user', id: userA.id };
  const subjectB: Subject = { type: 'user', id: userB.id };

  const guestAId = `g_iso_a_${userTag}`;
  const guestBId = `g_iso_b_${userTag}`;
  const subjectGA: Subject = { type: 'guest', id: guestAId };
  const subjectGB: Subject = { type: 'guest', id: guestBId };

  // 为各主体建数
  const userAItem = await prisma.storyWork.create({
    data: {
      userId: userA.id,
      title: 'UserA作品',
      prompt: 'p',
      excerpt: 'e',
      storyText: 's',
      contentHash: 'hash_ua',
      deletedAt: null,
    },
  });
  const userATrashItem = await prisma.storyWork.create({
    data: {
      userId: userA.id,
      title: 'UserA软删除作品',
      prompt: 'p',
      excerpt: 'e',
      storyText: 's',
      contentHash: 'hash_uatrash',
      deletedAt: new Date(),
    },
  });

  const guestAItem = await prisma.guestStoryWork.create({
    data: {
      guestId: guestAId,
      title: 'GuestA作品',
      prompt: 'gp',
      excerpt: 'ge',
      storyText: 'gs',
      contentHash: 'hash_ga',
      deletedAt: null,
    },
  });
  const guestATrashItem = await prisma.guestStoryWork.create({
    data: {
      guestId: guestAId,
      title: 'GuestA软删除作品',
      prompt: 'gp',
      excerpt: 'ge',
      storyText: 'gs',
      contentHash: 'hash_gatrash',
      deletedAt: new Date(),
    },
  });

  // 5.1 列表隔离
  const listB = await listStoryWorksForSubject(subjectB);
  assert(!listB.items.some((i) => i.id === userAItem.id), 'User B 绝不可 list 到 User A 的作品');

  const listGB = await listStoryWorksForSubject(subjectGB);
  assert(!listGB.items.some((i) => i.id === guestAItem.id), 'Guest B 绝不可 list 到 Guest A 的作品');

  const listA = await listStoryWorksForSubject(subjectA);
  assert(!listA.items.some((i) => i.id === guestAItem.id), 'User A 绝不可看到 Guest A 的作品');

  // 5.2 详情隔离与统一 NOT_FOUND
  // 正常获取
  const detailA = await getStoryWorkForSubject(subjectA, userAItem.id);
  assert.strictEqual(detailA.id, userAItem.id);
  assert.strictEqual(detailA.title, 'UserA作品');

  // 不存在 ID
  let notFoundNonexistent: TRPCError | null = null;
  try {
    await getStoryWorkForSubject(subjectA, 99999999);
  } catch (e) {
    notFoundNonexistent = e as TRPCError;
  }
  assert(notFoundNonexistent instanceof TRPCError);
  assert.strictEqual(notFoundNonexistent.code, 'NOT_FOUND');
  assert.strictEqual(notFoundNonexistent.message, '作品不存在');

  // 属于他人（foreign）
  let notFoundForeign: TRPCError | null = null;
  try {
    await getStoryWorkForSubject(subjectB, userAItem.id);
  } catch (e) {
    notFoundForeign = e as TRPCError;
  }
  assert(notFoundForeign instanceof TRPCError);
  assert.strictEqual(notFoundForeign.code, 'NOT_FOUND');
  assert.strictEqual(notFoundForeign.message, '作品不存在');

  // 已软删除（trash）
  let notFoundTrash: TRPCError | null = null;
  try {
    await getStoryWorkForSubject(subjectA, userATrashItem.id);
  } catch (e) {
    notFoundTrash = e as TRPCError;
  }
  assert(notFoundTrash instanceof TRPCError);
  assert.strictEqual(notFoundTrash.code, 'NOT_FOUND');
  assert.strictEqual(notFoundTrash.message, '作品不存在');

  // 跨类型主体访问（User 查 Guest 记录）
  let notFoundCrossType: TRPCError | null = null;
  try {
    await getStoryWorkForSubject(subjectA, guestAItem.id);
  } catch (e) {
    notFoundCrossType = e as TRPCError;
  }
  assert(notFoundCrossType instanceof TRPCError);
  assert.strictEqual(notFoundCrossType.code, 'NOT_FOUND');
  assert.strictEqual(notFoundCrossType.message, '作品不存在');

  // 访客跨租户与访客软删除统一 NOT_FOUND
  await assert.rejects(
    async () => getStoryWorkForSubject(subjectGB, guestAItem.id),
    (e: unknown) => e instanceof TRPCError && e.code === 'NOT_FOUND' && e.message === '作品不存在'
  );
  await assert.rejects(
    async () => getStoryWorkForSubject(subjectGA, guestATrashItem.id),
    (e: unknown) => e instanceof TRPCError && e.code === 'NOT_FOUND' && e.message === '作品不存在'
  );

  // 断言 foreign / missing / trash 对外语义完全等价一致
  assert.strictEqual(notFoundForeign.code, notFoundNonexistent.code);
  assert.strictEqual(notFoundForeign.message, notFoundNonexistent.message);
  assert.strictEqual(notFoundTrash.code, notFoundNonexistent.code);
  assert.strictEqual(notFoundTrash.message, notFoundNonexistent.message);
  console.log('PASS: 主体隔离与统一 NOT_FOUND（foreign/missing/trash 不可区分）通过');

  console.log('=== 6. Legacy 元数据懒修补（Lazy Backfill）===');
  const userLegacy = await prisma.user.create({
    data: { username: `sw_legacy_u_${userTag}`, password: 'Password123!' },
  });
  const legacySubject: Subject = { type: 'user', id: userLegacy.id };

  const userOther = await prisma.user.create({
    data: { username: `sw_other_u_${userTag}`, password: 'Password123!' },
  });

  // 6.1 造一条 pre-M2 的老数据（title/excerpt/contentHash 为空，正文包含 markdown 标题）
  const legacyRow = await prisma.storyWork.create({
    data: {
      userId: userLegacy.id,
      title: '',
      excerpt: '',
      contentHash: '',
      prompt: '请写一个森林探险故事',
      storyText: '# 茂密森林大冒险\n在古老的橡树下，住着一只小松鼠……它今天决定去远方探险。',
    },
  });

  // 造一条他人的 legacy 数据（验证不跨 Subject 修数据）
  const otherLegacyRow = await prisma.storyWork.create({
    data: {
      userId: userOther.id,
      title: '',
      excerpt: '',
      contentHash: '',
      prompt: '他人提示词',
      storyText: '# 他人故事\n他人正文内容……',
    },
  });

  // 校验修补前 DB 确实为空
  const dbRowBefore = await prisma.storyWork.findUnique({ where: { id: legacyRow.id } });
  assert(dbRowBefore !== null);
  assert.strictEqual(dbRowBefore.title, '');
  assert.strictEqual(dbRowBefore.excerpt, '');
  assert.strictEqual(dbRowBefore.contentHash, '');

  // 6.2 首次读取：通过 listStoryWorksForSubject 触发当前主体的懒修复
  const listAfterBackfill = await listStoryWorksForSubject(legacySubject);
  assert.strictEqual(listAfterBackfill.items.length, 1);
  const itemDto = listAfterBackfill.items[0];

  // 验证 DTO 字段正确填充（标题抽取为 Markdown 首行标题，摘要生成，contentHash 计算）
  assert.strictEqual(itemDto.title, '茂密森林大冒险', '标题应被正确解析');
  assert(itemDto.excerpt.includes('在古老的橡树下'), '摘要应被正确提取');
  assert.strictEqual(itemDto.contentHash.length, 12, 'contentHash 应为 12 位十六进制短哈希');

  // 验证 DB 字段已真实持久化
  const dbRowAfter = await prisma.storyWork.findUnique({ where: { id: legacyRow.id } });
  assert(dbRowAfter !== null);
  assert.strictEqual(dbRowAfter.title, '茂密森林大冒险', 'DB title 已持久化');
  assert(dbRowAfter.excerpt.length > 0, 'DB excerpt 已持久化');
  assert.strictEqual(dbRowAfter.contentHash, itemDto.contentHash, 'DB contentHash 已持久化');

  // 验证他人数据严禁被当前 Subject 越权修补
  const dbOtherRow = await prisma.storyWork.findUnique({ where: { id: otherLegacyRow.id } });
  assert(dbOtherRow !== null);
  assert.strictEqual(dbOtherRow.title, '', '他人 legacy 行严禁被跨租户修复');
  assert.strictEqual(dbOtherRow.excerpt, '', '他人 legacy 行严禁被跨租户修复');

  // 6.3 二次读取不重复 repair
  const secondRepairCount = await repairLegacyStoryWorksForSubject(legacySubject);
  assert.strictEqual(secondRepairCount, 0, '二次读取应检测到 0 条旧行，不重复 repair');

  // 6.4 搜索前 legacy repair 保障（避免老作品因 excerpt 为空漏搜）
  const userSearchBackfill = await prisma.user.create({
    data: { username: `sw_sb_u_${userTag}`, password: 'Password123!' },
  });
  const searchBackfillSubject: Subject = { type: 'user', id: userSearchBackfill.id };
  await prisma.storyWork.create({
    data: {
      userId: userSearchBackfill.id,
      title: '',
      excerpt: '',
      contentHash: '',
      prompt: '普通老提示词',
      storyText: '很久以前在彩虹山脉之巅有一座古老的风车……',
    },
  });
  // 检索摘要中才会出现的词汇「彩虹山脉」
  const searchRepairRes = await listStoryWorksForSubject(searchBackfillSubject, {
    query: '彩虹山脉',
  });
  assert.strictEqual(searchRepairRes.items.length, 1, '检索前自动懒修复使老作品摘要被填充并成功命中');
  console.log('PASS: Legacy 元数据懒修补（正确性/持久化/租户隔离/零重复开销/检索前生效）通过');

  console.log('=== 7. hasMore 派生恒等式回归（Service 层）===');
  // 7.1 空列表
  const emptyRes = await listStoryWorksForSubject(legacySubject, { query: 'NON_EXISTENT_MAGIC_QUERY' });
  assert.strictEqual(emptyRes.items.length, 0);
  assert.strictEqual(emptyRes.nextCursor, null);
  assert.strictEqual(emptyRes.hasMore, false);
  assert.strictEqual(emptyRes.hasMore, emptyRes.nextCursor !== null);

  // 7.2 单条记录（limit 20）
  const singleRes = await listStoryWorksForSubject(legacySubject, { limit: 20 });
  assert.strictEqual(singleRes.items.length, 1);
  assert.strictEqual(singleRes.nextCursor, null);
  assert.strictEqual(singleRes.hasMore, false);
  assert.strictEqual(singleRes.hasMore, singleRes.nextCursor !== null);

  // 7.3 精确等于 limit（构造 20 条）
  const userExact20 = await prisma.user.create({
    data: { username: `sw_exact20_${userTag}`, password: 'Password123!' },
  });
  const exact20Subject: Subject = { type: 'user', id: userExact20.id };
  for (let i = 1; i <= 20; i++) {
    await prisma.storyWork.create({
      data: {
        userId: userExact20.id,
        title: `精确20-${i}`,
        prompt: `p-${i}`,
        excerpt: `e-${i}`,
        storyText: `s-${i}`,
        contentHash: `hash_e20_${i}`,
      },
    });
  }
  const exact20Res = await listStoryWorksForSubject(exact20Subject, { limit: 20 });
  assert.strictEqual(exact20Res.items.length, 20);
  assert.strictEqual(exact20Res.nextCursor, null, '刚好 20 条且无后续，nextCursor 必须为 null');
  assert.strictEqual(exact20Res.hasMore, false, 'hasMore 必须为 false');
  assert.strictEqual(exact20Res.hasMore, exact20Res.nextCursor !== null, 'hasMore 必须恒等于 (nextCursor !== null)');

  // 7.4 limit + 1 条（21 条，第 1 页有后续，第 2 页无后续）
  await prisma.storyWork.create({
    data: {
      userId: userExact20.id,
      title: '第21条',
      prompt: 'p-21',
      excerpt: 'e-21',
      storyText: 's-21',
      contentHash: 'hash_e20_21',
    },
  });
  const p1Res = await listStoryWorksForSubject(exact20Subject, { limit: 20 });
  assert.strictEqual(p1Res.items.length, 20);
  assert(p1Res.nextCursor !== null);
  assert.strictEqual(p1Res.hasMore, true);
  assert.strictEqual(p1Res.hasMore, p1Res.nextCursor !== null);

  const p2Res = await listStoryWorksForSubject(exact20Subject, {
    limit: 20,
    cursor: p1Res.nextCursor,
  });
  assert.strictEqual(p2Res.items.length, 1);
  assert.strictEqual(p2Res.nextCursor, null);
  assert.strictEqual(p2Res.hasMore, false);
  assert.strictEqual(p2Res.hasMore, p2Res.nextCursor !== null);
  console.log('PASS: hasMore === (nextCursor !== null) 派生恒等式回归严格成立');

  console.log('=== 8. DTO 契约与缺省音频投影结构 ===');
  // 8.1 Summary DTO
  const summaryDto = p1Res.items[0];
  const parsedSummary = storyWorkSummaryDtoSchema.parse(summaryDto);
  assert.strictEqual(parsedSummary.audio.status, 'missing');
  assert.strictEqual(parsedSummary.audio.durationMs, null);
  assert.strictEqual((summaryDto as unknown as Record<string, unknown>).storyText, undefined, 'Summary DTO 严禁包含 storyText');
  assert.strictEqual((summaryDto as unknown as Record<string, unknown>).prompt, undefined, 'Summary DTO 严禁包含 prompt');

  // 8.2 Detail DTO
  const detailDto = await getStoryWorkForSubject(exact20Subject, summaryDto.id);
  const parsedDetail = storyWorkDetailDtoSchema.parse(detailDto);
  assert.strictEqual(parsedDetail.id, summaryDto.id);
  assert.strictEqual(parsedDetail.audio.status, 'missing');
  assert.strictEqual(parsedDetail.audio.durationMs, null);
  assert.strictEqual(typeof parsedDetail.storyText, 'string');
  assert.strictEqual(typeof parsedDetail.prompt, 'string');
  assert(parsedDetail.storyText.length > 0);
  console.log('PASS: DTO 契约与缺省音频投影结构断言通过');
}

const testPromise = runStoryWorkReadTests()
  .then(() => {
    console.log('ALL STORYWORK READ SERVICE INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('StoryWork read service integration test failed:', err);
    process.exit(1);
  });

export default testPromise;
