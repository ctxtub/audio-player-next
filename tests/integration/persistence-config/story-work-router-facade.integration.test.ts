/**
 * StoryWork tRPC Router 与 Client Facade 集成测试（M2-06，L2）
 *
 * 验收矩阵：
 * 1. Context, Guard & Subject Resolution Matrix:
 *    - 匿名主体访问任意 8 个 procedure 均被拦截并抛出 UNAUTHORIZED (401)；
 *    - 具名访客与已登录用户通过验证，租户物理隔离。
 * 2. 8 个 Procedure 的入参校验（BAD_REQUEST 路径）：
 *    - list: limit 越界（<1 或 >50）拒绝；
 *    - get / trash / restore / permanentDelete: 非正整数 ID 拒绝；
 *    - create: prompt/storyText 为空或超长拒绝；
 *    - rename: title 为空或超长拒绝；
 *    - setFavorite: 非布尔类型拒绝。
 * 3. 8 个 Procedure 的成功路径：
 *    - 全链路通过 appRouter.createCaller 执行；
 *    - 返回值严格符合 DTO 契约（包含 missing audio 投影，无 Prisma 内部模型泄漏）；
 *    - create 幂等性、list 视图隔离与游标、rename/favorite 状态变更、trash/restore/permanentDelete 正确持久化。
 * 4. NOT_FOUND 与 CONFLICT 领域错误码透出：
 *    - nonexistent / foreign id 统一透出 NOT_FOUND；
 *    - active 状态下 restore / permanentDelete 统一透出 CONFLICT；
 *    - 同源异正文创建统一透出 CONFLICT。
 * 5. 错误脱敏与 Prisma 内部细节防护：
 *    - 模拟/捕获异常时，断言绝不向上暴露任何 Prisma 原始错误、字段名或 P2002/P2025 细节；
 *    - 异常统一转为 INTERNAL_SERVER_ERROR。
 * 6. Rate Limit 滑动窗口确定性可测：
 *    - 访客/用户在达到限额后触发 TOO_MANY_REQUESTS (429)；
 *    - 窗口滑动或 reset 后恢复正常访问。
 * 7. Client Facade 消费入口校验：
 *    - 全部 8 个 API 可通过 facade 函数及 libraryClient 对象正常调用；
 *    - 入参重载（ID 数值与入参对象）均规范化透传；
 *    - 绝对不含 __testBeforeMutationHook 等 server-internal 细节。
 * 8. 静态契约审计：
 *    - 冻结仅 8 个 procedure，无未冻结旁路；
 *    - 契约文件绝无 __testBeforeMutationHook 污染。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import { prisma } from '../../../lib/db';
import { appRouter } from '../../../lib/trpc/routers';
import {
  libraryRouter,
  handleLibraryError,
  setLibraryRateLimiter,
  resetLibraryRateLimiter,
  LIBRARY_RATE_LIMITS,
} from '../../../lib/trpc/routers/library';
import { TRPCError } from '../../../lib/trpc/init';
import type { Context } from '../../../lib/trpc/context';
import {
  storyWorkDetailDtoSchema,
  storyWorkSummaryDtoSchema,
  libraryListOutputSchema,
} from '../../../lib/trpc/schemas/library';
import {
  fetchLibraryList,
  fetchLibraryDetail,
  createStoryWork,
  renameStoryWork,
  setStoryWorkFavorite,
  trashStoryWork,
  restoreStoryWork,
  permanentDeleteStoryWork,
  libraryClient,
  setLibraryTrpcClient,
  resetLibraryTrpcClient,
} from '../../../lib/client/library';
import { trpc } from '../../../lib/trpc/client';
import { SlidingWindowRateLimiter } from '../../../lib/server/rateLimit';

async function runStoryWorkRouterFacadeTests(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? '';
  assert.ok(dbUrl, 'DATABASE_URL 必须由运行器注入隔离库');
  assert.ok(
    !dbUrl.includes('dev.db') && !dbUrl.includes('app.db'),
    `拒绝写真实/生产库，DATABASE_URL=${dbUrl.slice(0, 80)}`
  );

  const testTag = Date.now();

  // 创建测试用户与访客身份
  const testUser = await prisma.user.create({
    data: {
      username: `sw_rf_u1_${testTag}`,
      password: 'TestPassword123!',
      nickname: 'RouterFacadeUser',
    },
  });
  const userCtx: Context = {
    session: { userId: testUser.id, nickname: testUser.nickname ?? 'RouterFacadeUser' },
    isGuest: false,
    guestId: null,
    clientIp: '192.168.10.1',
  };

  const guestId = `g_rf_${testTag}`;
  const guestCtx: Context = {
    session: null,
    isGuest: true,
    guestId,
    clientIp: '192.168.10.2',
  };

  const anonCtx: Context = {
    session: null,
    isGuest: false,
    guestId: null,
    clientIp: '192.168.10.3',
  };

  const userCaller = appRouter.createCaller(userCtx);
  const guestCaller = appRouter.createCaller(guestCtx);
  const anonCaller = appRouter.createCaller(anonCtx);

  console.log('=== 1. Context, Guard & Subject Resolution Matrix (401 UNAUTHORIZED) ===');
  await assert.rejects(
    async () => { await anonCaller.library.list(); },
    (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
    'Anonymous calling library.list must throw UNAUTHORIZED'
  );
  await assert.rejects(
    async () => { await anonCaller.library.get({ id: 1 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
    'Anonymous calling library.get must throw UNAUTHORIZED'
  );
  await assert.rejects(
    async () => { await anonCaller.library.create({ prompt: 'p', storyText: 't' }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
    'Anonymous calling library.create must throw UNAUTHORIZED'
  );
  await assert.rejects(
    async () => { await anonCaller.library.rename({ id: 1, title: 'new' }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
    'Anonymous calling library.rename must throw UNAUTHORIZED'
  );
  await assert.rejects(
    async () => { await anonCaller.library.setFavorite({ id: 1, favorite: true }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
    'Anonymous calling library.setFavorite must throw UNAUTHORIZED'
  );
  await assert.rejects(
    async () => { await anonCaller.library.trash({ id: 1 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
    'Anonymous calling library.trash must throw UNAUTHORIZED'
  );
  await assert.rejects(
    async () => { await anonCaller.library.restore({ id: 1 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
    'Anonymous calling library.restore must throw UNAUTHORIZED'
  );
  await assert.rejects(
    async () => { await anonCaller.library.permanentDelete({ id: 1 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
    'Anonymous calling library.permanentDelete must throw UNAUTHORIZED'
  );
  console.log('PASS: 1. 匿名访问 8 个 procedure 均被安全拦截为 UNAUTHORIZED (401)');

  console.log('=== 2. 8 个 Procedure 的入参校验（BAD_REQUEST 路径）===');
  // list limit bounds
  await assert.rejects(
    async () => { await userCaller.library.list({ limit: 0 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'list limit < 1 must be BAD_REQUEST'
  );
  await assert.rejects(
    async () => { await userCaller.library.list({ limit: 51 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'list limit > 50 must be BAD_REQUEST'
  );

  // get non-positive ID
  await assert.rejects(
    async () => { await userCaller.library.get({ id: 0 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'get id: 0 must be BAD_REQUEST'
  );
  await assert.rejects(
    async () => { await userCaller.library.get({ id: -1 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'get id: -1 must be BAD_REQUEST'
  );

  // create bounds
  await assert.rejects(
    async () => { await userCaller.library.create({ prompt: '', storyText: 'Valid story text' }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'create empty prompt must be BAD_REQUEST'
  );
  await assert.rejects(
    async () => { await userCaller.library.create({ prompt: 'Valid prompt', storyText: '' }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'create empty storyText must be BAD_REQUEST'
  );
  await assert.rejects(
    async () => { await userCaller.library.create({ prompt: 'a'.repeat(2001), storyText: 'Valid text' }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'create oversized prompt must be BAD_REQUEST'
  );
  await assert.rejects(
    async () => { await userCaller.library.create({ prompt: 'Valid prompt', storyText: 'b'.repeat(20001) }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'create oversized storyText must be BAD_REQUEST'
  );

  // rename bounds
  await assert.rejects(
    async () => { await userCaller.library.rename({ id: 0, title: 'Valid title' }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'rename id: 0 must be BAD_REQUEST'
  );
  await assert.rejects(
    async () => { await userCaller.library.rename({ id: 1, title: '' }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'rename empty title must be BAD_REQUEST'
  );
  await assert.rejects(
    async () => { await userCaller.library.rename({ id: 1, title: 't'.repeat(81) }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'rename oversized title must be BAD_REQUEST'
  );

  // setFavorite bounds
  await assert.rejects(
    async () => { await userCaller.library.setFavorite({ id: 0, favorite: true }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'setFavorite id: 0 must be BAD_REQUEST'
  );
  await assert.rejects(
    async () => {
      await userCaller.library.setFavorite({ id: 1, favorite: 'not-a-bool' as unknown as boolean });
    },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'setFavorite non-bool favorite must be BAD_REQUEST'
  );

  // trash / restore / permanentDelete ID bounds
  await assert.rejects(
    async () => { await userCaller.library.trash({ id: -2 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'trash negative id must be BAD_REQUEST'
  );
  await assert.rejects(
    async () => { await userCaller.library.restore({ id: 0 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'restore id: 0 must be BAD_REQUEST'
  );
  await assert.rejects(
    async () => { await userCaller.library.permanentDelete({ id: -10 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    'permanentDelete id: -10 must be BAD_REQUEST'
  );
  console.log('PASS: 2. 全部 8 个 Procedure 的入参非法拦截（BAD_REQUEST）校验通过');

  console.log('=== 3. 8 个 Procedure 的成功路径与 DTO 规范校验 ===');
  // 3.1 create
  const storyText1 = '# 星际探索记录\n宇航员在火星基地发现了第一朵火星花，它在暗红色土壤中微微闪烁着荧光。';
  const prompt1 = '写一个火星发现植物的故事';
  const createdWork1 = await userCaller.library.create({
    prompt: prompt1,
    storyText: storyText1,
    voiceId: 'voice_alloy',
    sourceMessageId: `src_msg_user_${testTag}`,
  });

  const parsedDetail = storyWorkDetailDtoSchema.parse(createdWork1);
  assert.strictEqual(parsedDetail.id, createdWork1.id);
  assert.strictEqual(createdWork1.prompt, prompt1);
  assert.strictEqual(createdWork1.storyText, storyText1);
  assert.strictEqual(createdWork1.voiceId, 'voice_alloy');
  assert.strictEqual(createdWork1.title, '星际探索记录');
  assert.strictEqual(createdWork1.audio.status, 'missing');
  assert.strictEqual(createdWork1.audio.durationMs, null);
  assert.strictEqual(createdWork1.deletedAt, null);
  assert.strictEqual(createdWork1.favoritedAt, null);
  assert.strictEqual(createdWork1.sourceMessageId, `src_msg_user_${testTag}`);

  // 3.2 create 幂等：同 sourceMessageId 同 contentHash 返回相同 ID
  const duplicateCreated = await userCaller.library.create({
    prompt: prompt1,
    storyText: storyText1,
    sourceMessageId: `src_msg_user_${testTag}`,
  });
  assert.strictEqual(duplicateCreated.id, createdWork1.id, '同源消息同内容创建必须幂等返回相同 ID');

  // 3.3 get
  const fetchedDetail = await userCaller.library.get({ id: createdWork1.id });
  assert.deepStrictEqual(fetchedDetail, createdWork1, 'get 返回结果必须与 create 严格一致');

  // 3.4 list（默认查询与分页）
  const listResult = await userCaller.library.list();
  const parsedList = libraryListOutputSchema.parse(listResult);
  assert.ok(parsedList.items.length >= 1);
  const foundItem = parsedList.items.find((item) => item.id === createdWork1.id);
  assert.ok(foundItem !== undefined, 'list 应包含新创建的作品');
  assert.strictEqual(foundItem.title, '星际探索记录');
  assert.strictEqual(foundItem.audio.status, 'missing');
  assert.strictEqual((foundItem as unknown as Record<string, unknown>).storyText, undefined, 'Summary DTO 严禁包含 storyText');
  assert.strictEqual((foundItem as unknown as Record<string, unknown>).prompt, undefined, 'Summary DTO 严禁包含 prompt');
  assert.strictEqual(listResult.hasMore, listResult.nextCursor !== null, 'hasMore 必须恒等于 nextCursor !== null');

  // 3.5 rename
  const renamedWork = await userCaller.library.rename({
    id: createdWork1.id,
    title: '  “火星之花新篇章”  ',
  });
  assert.strictEqual(renamedWork.id, createdWork1.id);
  assert.strictEqual(renamedWork.title, '火星之花新篇章', '标题应被规范化剥离外层引号与多余空格');
  assert.strictEqual(renamedWork.contentHash, createdWork1.contentHash, 'rename 严禁更改 contentHash');

  // 3.6 setFavorite
  const favedWork = await userCaller.library.setFavorite({
    id: createdWork1.id,
    favorite: true,
  });
  assert.ok(favedWork.favoritedAt !== null, '收藏后 favoritedAt 必须有值');

  const favoritesList = await userCaller.library.list({ view: 'favorites' });
  assert.ok(
    favoritesList.items.some((item) => item.id === createdWork1.id),
    'favorites 视图必须可见已收藏作品'
  );

  const unfavedWork = await userCaller.library.setFavorite({
    id: createdWork1.id,
    favorite: false,
  });
  assert.strictEqual(unfavedWork.favoritedAt, null, '取消收藏后 favoritedAt 必须为 null');

  // 3.7 trash
  const trashedWork = await userCaller.library.trash({ id: createdWork1.id });
  assert.ok(trashedWork.deletedAt !== null, 'trash 后 deletedAt 必须有值');

  const activeListAfterTrash = await userCaller.library.list({ view: 'active' });
  assert.ok(
    !activeListAfterTrash.items.some((item) => item.id === createdWork1.id),
    'active 视图不得包含已软删除作品'
  );

  const trashList = await userCaller.library.list({ view: 'trash' });
  assert.ok(
    trashList.items.some((item) => item.id === createdWork1.id),
    'trash 视图必须包含已软删除作品'
  );

  // 3.8 restore
  const restoredWork = await userCaller.library.restore({ id: createdWork1.id });
  assert.strictEqual(restoredWork.deletedAt, null, 'restore 后 deletedAt 必须为 null');

  const activeListAfterRestore = await userCaller.library.list({ view: 'active' });
  assert.ok(
    activeListAfterRestore.items.some((item) => item.id === createdWork1.id),
    'active 视图在 restore 后必须重新包含该作品'
  );

  // 3.9 permanentDelete (物理删除，必须在 trash 之后)
  await userCaller.library.trash({ id: createdWork1.id });
  const deleteResult = await userCaller.library.permanentDelete({ id: createdWork1.id });
  assert.strictEqual(deleteResult.success, true);
  assert.strictEqual(deleteResult.id, createdWork1.id);

  // 底层数据库验证行彻底删除
  const rowInDb = await prisma.storyWork.findUnique({ where: { id: createdWork1.id } });
  assert.strictEqual(rowInDb, null, '永久删除后数据库记录必须被彻底移除');

  // 3.10 Guest 主体对称性验证
  const guestCreated = await guestCaller.library.create({
    prompt: '访客故事提示词',
    storyText: '访客故事正文内容...',
  });
  assert.strictEqual(guestCreated.title, '访客故事提示词');
  assert.strictEqual(guestCreated.audio.status, 'missing');
  const guestRow = await prisma.guestStoryWork.findUnique({ where: { id: guestCreated.id } });
  assert.ok(guestRow !== null, '访客作品必须在 guestStoryWork 表中入库');
  assert.strictEqual(guestRow.guestId, guestId);
  console.log('PASS: 3. 全部 8 个 Procedure 成功路径、DTO 结构与 User/Guest 对称性校验通过');

  console.log('=== 4. NOT_FOUND 与 CONFLICT 领域错误码透出 ===');
  // 4.1 get nonexistent / foreign
  await assert.rejects(
    async () => { await userCaller.library.get({ id: 99999999 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    'get nonexistent ID must throw NOT_FOUND'
  );
  await assert.rejects(
    async () => { await userCaller.library.get({ id: guestCreated.id }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    'get foreign guest work from user must throw NOT_FOUND (isolation)'
  );

  // 4.2 mutations on nonexistent id
  await assert.rejects(
    async () => { await userCaller.library.rename({ id: 99999999, title: 'Title' }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    'rename nonexistent id must throw NOT_FOUND'
  );
  await assert.rejects(
    async () => { await userCaller.library.setFavorite({ id: 99999999, favorite: true }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    'setFavorite nonexistent id must throw NOT_FOUND'
  );
  await assert.rejects(
    async () => { await userCaller.library.trash({ id: 99999999 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    'trash nonexistent id must throw NOT_FOUND'
  );
  await assert.rejects(
    async () => { await userCaller.library.restore({ id: 99999999 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    'restore nonexistent id must throw NOT_FOUND'
  );
  await assert.rejects(
    async () => { await userCaller.library.permanentDelete({ id: 99999999 }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    'permanentDelete nonexistent id must throw NOT_FOUND'
  );

  // 4.3 CONFLICT: restore on active work
  const activeWorkForConflict = await userCaller.library.create({
    prompt: '冲突测试提示词',
    storyText: '活跃作品测试 restore CONFLICT',
    sourceMessageId: `conflict_src_${testTag}`,
  });
  await assert.rejects(
    async () => { await userCaller.library.restore({ id: activeWorkForConflict.id }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT',
    'restore on active work must throw CONFLICT'
  );

  // 4.4 CONFLICT: permanentDelete on active work
  await assert.rejects(
    async () => { await userCaller.library.permanentDelete({ id: activeWorkForConflict.id }); },
    (err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT',
    'permanentDelete on active work must throw CONFLICT'
  );

  // 4.5 CONFLICT: create with same sourceMessageId but different content
  await assert.rejects(
    async () => {
      await userCaller.library.create({
        prompt: '完全不同的提示词',
        storyText: '完全不同的正文内容造成哈希不一致',
        sourceMessageId: `conflict_src_${testTag}`,
      });
    },
    (err: unknown) => err instanceof TRPCError && err.code === 'CONFLICT',
    'create with same sourceMessageId but different content must throw CONFLICT'
  );
  console.log('PASS: 4. NOT_FOUND 与 CONFLICT 领域异常透出契约校验通过');

  console.log('=== 5. 错误脱敏与 Prisma 内部细节防护 ===');
  // 5.1 业务级 TRPCError 原样透出
  try {
    handleLibraryError(new TRPCError({ code: 'CONFLICT', message: '同源内容冲突：业务异常' }));
    assert.fail('handleLibraryError should have thrown');
  } catch (err) {
    assert(err instanceof TRPCError);
    assert.strictEqual(err.code, 'CONFLICT');
    assert.strictEqual(err.message, '同源内容冲突：业务异常');
  }

  // 5.2 模拟 PrismaClientKnownRequestError 等底层异常，必须收口为 INTERNAL_SERVER_ERROR 且脱敏
  const fakePrismaError = new Error(
    'PrismaClientKnownRequestError: P2002 Unique constraint failed on the fields: (`userId`, `sourceMessageId`)'
  );
  try {
    handleLibraryError(fakePrismaError);
    assert.fail('handleLibraryError should have thrown');
  } catch (err) {
    assert(err instanceof TRPCError);
    assert.strictEqual(err.code, 'INTERNAL_SERVER_ERROR');
    assert.strictEqual(err.message, '内部服务错误，请稍后重试');
    assert.ok(!err.message.includes('Prisma'), '错误信息不得含 Prisma');
    assert.ok(!err.message.includes('P2002'), '错误信息不得含 P2002');
    assert.ok(!err.message.includes('userId'), '错误信息不得含 userId');
  }

  // 5.3 模拟包含 Prisma 关键字的 TRPCError 亦被拦截
  const prismaLeakingTrpcError = new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Raw prisma error P2025: An operation failed because it depends on one or more records',
  });
  try {
    handleLibraryError(prismaLeakingTrpcError);
    assert.fail('handleLibraryError should have thrown');
  } catch (err) {
    assert(err instanceof TRPCError);
    assert.strictEqual(err.code, 'INTERNAL_SERVER_ERROR');
    assert.strictEqual(err.message, '内部服务错误，请稍后重试');
  }
  console.log('PASS: 5. 错误脱敏与 Prisma 底层细节防泄漏校验通过');

  console.log('=== 6. Rate Limit 滑动窗口确定性验证 ===');
  const testLimiter = new SlidingWindowRateLimiter({
    windowMs: 60_000,
  });
  setLibraryRateLimiter(testLimiter);

  try {
    const rateLimitGuestId = `g_rl_${testTag}`;
    const rateLimitGuestCtx: Context = {
      session: null,
      isGuest: true,
      guestId: rateLimitGuestId,
      clientIp: '10.99.88.77',
    };
    const rateLimitGuestCaller = appRouter.createCaller(rateLimitGuestCtx);

    // 针对 create procedure，guestLimit 为 30
    const limit = LIBRARY_RATE_LIMITS.create.guestLimit;
    assert.strictEqual(limit, 30);

    for (let i = 0; i < limit; i++) {
      await rateLimitGuestCaller.library.create({
        prompt: `限流前置调用 ${i}`,
        storyText: `限流前置正文 ${i}`,
      });
    }

    // 第 limit + 1 次调用必须被拒绝，抛出 TOO_MANY_REQUESTS (429)
    await assert.rejects(
      async () => {
        await rateLimitGuestCaller.library.create({
          prompt: '超出配额的创建尝试',
          storyText: '超出配额的正文内容',
        });
      },
      (err: unknown) => {
        return (
          err instanceof TRPCError &&
          err.code === 'TOO_MANY_REQUESTS' &&
          err.message === '请求过于频繁，请稍后再试'
        );
      },
      'Exceeding rate limit must throw TOO_MANY_REQUESTS (429)'
    );

    // reset 后应恢复正常访问
    testLimiter.reset();
    const afterResetWork = await rateLimitGuestCaller.library.create({
      prompt: '限流重置后的创建',
      storyText: '限流重置后的正文',
    });
    assert.ok(afterResetWork.id > 0);
  } finally {
    resetLibraryRateLimiter();
  }
  console.log('PASS: 6. Rate limit 滑动窗口确定性限流与恢复验证通过');

  console.log('=== 7. Client Facade 消费入口与入参重载校验 ===');
  const callsRecorded: Record<string, unknown[]> = {
    list: [],
    get: [],
    create: [],
    rename: [],
    setFavorite: [],
    trash: [],
    restore: [],
    permanentDelete: [],
  };

  const mockDetailDto = {
    id: 101,
    title: 'Facade Test Title',
    excerpt: 'Facade excerpt',
    voiceId: 'alloy',
    contentHash: 'abc123hash',
    favoritedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    audio: { status: 'missing' as const, durationMs: null },
    prompt: 'Facade prompt',
    storyText: 'Facade storyText',
    sourceMessageId: null,
  };

  const mockListDto = {
    items: [mockDetailDto],
    nextCursor: null,
    hasMore: false,
  };

  const mockTrpcClient = {
    library: {
      list: {
        query: async (input: unknown) => {
          callsRecorded.list.push(input);
          return mockListDto;
        },
      },
      get: {
        query: async (input: unknown) => {
          callsRecorded.get.push(input);
          return mockDetailDto;
        },
      },
      create: {
        mutate: async (input: unknown) => {
          callsRecorded.create.push(input);
          return mockDetailDto;
        },
      },
      rename: {
        mutate: async (input: unknown) => {
          callsRecorded.rename.push(input);
          return mockDetailDto;
        },
      },
      setFavorite: {
        mutate: async (input: unknown) => {
          callsRecorded.setFavorite.push(input);
          return mockDetailDto;
        },
      },
      trash: {
        mutate: async (input: unknown) => {
          callsRecorded.trash.push(input);
          return mockDetailDto;
        },
      },
      restore: {
        mutate: async (input: unknown) => {
          callsRecorded.restore.push(input);
          return mockDetailDto;
        },
      },
      permanentDelete: {
        mutate: async (input: unknown) => {
          callsRecorded.permanentDelete.push(input);
          return { success: true as const, id: 101 };
        },
      },
    },
  } as unknown as typeof trpc;

  setLibraryTrpcClient(mockTrpcClient);

  try {
    // 7.1 fetchLibraryList & libraryClient.list
    const listRes1 = await fetchLibraryList({ view: 'favorites', limit: 15 });
    assert.strictEqual(listRes1, mockListDto);
    assert.deepStrictEqual(callsRecorded.list[0], { view: 'favorites', limit: 15 });

    const listRes2 = await libraryClient.list();
    assert.strictEqual(listRes2, mockListDto);
    assert.deepStrictEqual(callsRecorded.list[1], {});

    // 7.2 fetchLibraryDetail: number vs object
    await fetchLibraryDetail(101);
    assert.deepStrictEqual(callsRecorded.get[0], { id: 101 });
    await libraryClient.get({ id: 102 });
    assert.deepStrictEqual(callsRecorded.get[1], { id: 102 });

    // 7.3 createStoryWork
    const createPayload = { prompt: 'cp', storyText: 'ct' };
    await createStoryWork(createPayload);
    assert.deepStrictEqual(callsRecorded.create[0], createPayload);
    await libraryClient.create(createPayload);
    assert.deepStrictEqual(callsRecorded.create[1], createPayload);

    // 7.4 renameStoryWork: (id, title) vs object
    await renameStoryWork(101, 'Title A');
    assert.deepStrictEqual(callsRecorded.rename[0], { id: 101, title: 'Title A' });
    await libraryClient.rename({ id: 102, title: 'Title B' });
    assert.deepStrictEqual(callsRecorded.rename[1], { id: 102, title: 'Title B' });

    // 7.5 setStoryWorkFavorite: (id, bool) vs object
    await setStoryWorkFavorite(101, true);
    assert.deepStrictEqual(callsRecorded.setFavorite[0], { id: 101, favorite: true });
    await libraryClient.setFavorite({ id: 102, favorite: false });
    assert.deepStrictEqual(callsRecorded.setFavorite[1], { id: 102, favorite: false });

    // 7.6 trashStoryWork: number vs object
    await trashStoryWork(101);
    assert.deepStrictEqual(callsRecorded.trash[0], { id: 101 });
    await libraryClient.trash({ id: 102 });
    assert.deepStrictEqual(callsRecorded.trash[1], { id: 102 });

    // 7.7 restoreStoryWork: number vs object
    await restoreStoryWork(101);
    assert.deepStrictEqual(callsRecorded.restore[0], { id: 101 });
    await libraryClient.restore({ id: 102 });
    assert.deepStrictEqual(callsRecorded.restore[1], { id: 102 });

    // 7.8 permanentDeleteStoryWork: number vs object
    const delRes1 = await permanentDeleteStoryWork(101);
    assert.strictEqual(delRes1.success, true);
    assert.deepStrictEqual(callsRecorded.permanentDelete[0], { id: 101 });
    const delRes2 = await libraryClient.permanentDelete({ id: 102 });
    assert.strictEqual(delRes2.id, 101);
    assert.deepStrictEqual(callsRecorded.permanentDelete[1], { id: 102 });
  } finally {
    resetLibraryTrpcClient();
  }
  console.log('PASS: 7. Client Facade 与 libraryClient 8 个 Procedure 调用与重载校验通过');

  console.log('=== 8. 静态契约与测试接缝隔离审计 ===');
  // 8.1 严禁在 tRPC input schema、client facade、public contract 中出现 __testBeforeMutationHook
  const schemaFile = fs.readFileSync('lib/trpc/schemas/library.ts', 'utf-8');
  assert.ok(!schemaFile.includes('__testBeforeMutationHook'), 'schemas/library.ts 严禁出现 __testBeforeMutationHook');

  const routerFile = fs.readFileSync('lib/trpc/routers/library.ts', 'utf-8');
  assert.ok(!routerFile.includes('__testBeforeMutationHook'), 'routers/library.ts 严禁出现 __testBeforeMutationHook');

  const clientFile = fs.readFileSync('lib/client/library.ts', 'utf-8');
  assert.ok(!clientFile.includes('__testBeforeMutationHook'), 'client/library.ts 严禁出现 __testBeforeMutationHook');

  const trpcClientFile = fs.readFileSync('lib/trpc/client.ts', 'utf-8');
  assert.ok(!trpcClientFile.includes('__testBeforeMutationHook'), 'trpc/client.ts 严禁出现 __testBeforeMutationHook');

  // 8.2 router 仅冻结暴露指定的 8 个 procedure
  const libraryProcedures = Object.keys((libraryRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures).sort();
  const expectedProcedures = [
    'create',
    'get',
    'list',
    'permanentDelete',
    'rename',
    'restore',
    'setFavorite',
    'trash',
  ].sort();
  assert.deepStrictEqual(
    libraryProcedures,
    expectedProcedures,
    'libraryRouter 只能且必须暴露已冻结的 8 个 procedure'
  );

  // 8.3 全部入口统一使用 guardedProcedure + resolveSubject
  assert.ok(routerFile.includes('guardedProcedure'), 'router 必须使用 guardedProcedure');
  assert.ok(!routerFile.includes('publicProcedure'), 'library router 严禁使用 publicProcedure');
  assert.ok(routerFile.includes('resolveSubject'), 'router 必须使用 resolveSubject');
  console.log('PASS: 8. 静态契约审计与测试接缝隔离验证通过');

  console.log('\nALL STORYWORK ROUTER & FACADE INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runStoryWorkRouterFacadeTests()
  .then(() => {
    console.log('ALL STORYWORK ROUTER FACADE TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
