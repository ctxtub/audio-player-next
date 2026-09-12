/**
 * StoryWork 访客注册迁移与 ID Map 契约测试（M2-08）
 *
 * 核心验证：
 * 1. 彻底取消迁移路径的 take:100 限制：150+（测试用 160 条）全量作品完整迁移，逐 id 与关键字段严格核对；
 * 2. 状态原样保真迁移：title / excerpt / contentHash / sourceMessageId / favoritedAt / deletedAt / createdAt 等全部保持；
 * 3. 逐行创建取得新 ID 并建立 guestStoryWorkId → userStoryWorkId 映射，持久可查询且正确落库；
 * 4. Legacy Playback 引用映射：断点若引用 guest generation ID，必须借本次 map 映射到新 User Work ID，且找不到时 fail closed 丢弃锚点；
 * 5. 迁移后 Guest 原始记录全量保留（用于审计与 30 天 GC，无删除）；
 * 6. 既有账号登录绝不触发 merge，主体隔离不渗漏；
 * 7. 边界与幂等性：空 guest 安全无动作；重复调用幂等不产生重复记录。
 */

import assert from 'node:assert';
import bcrypt from 'bcryptjs';
import * as nextHeaders from 'next/headers';
import { prisma } from '../../../lib/db';
import { authRouter } from '../../../lib/trpc/routers/auth';
import {
  migrateGuestCreativeRecordsToUser,
  migrateGuestPlaybackProgressToUser,
  getStoryWorkIdMapForGuest,
  getUserStoryWorkIdByGuestWorkId,
} from '../../../lib/server/unifiedMigration';
import { encodeGuestId } from '../../../lib/session';

process.env.SESSION_SECRET = 'test-secret-story-work-guest-registration-12345';

async function runGuestRegistrationMigrationTests() {
  console.log('=== 1. 150+ 条（160条）StoryWork 全量迁移完整性与关键字段保真（取消 100 条限制）===');
  const tag1 = Date.now();
  const guestId1 = `g_reg_160_${tag1}`;
  const totalGenerations = 160;

  // 预先向 User 表与 StoryWork 表写入基线数据，使两表的自增主键产生偏移，保证 targetGuestWork.id !== mappedUserId
  const baselineUser = await prisma.user.create({
    data: {
      username: `u_baseline_offset_${tag1}`,
      password: 'Password123!',
      nickname: 'BaselineOffsetUser',
    },
  });
  for (let b = 0; b < 25; b++) {
    await prisma.storyWork.create({
      data: {
        userId: baselineUser.id,
        prompt: `基线故事 ${b}`,
        storyText: `基线内容 ${b}`,
        title: `基线标题 ${b}`,
        contentHash: `baseline_hash_${b}`,
      },
    });
  }

  // 1.1 在访客表直建 160 条具有多维状态特征的作品
  const baseDate = new Date('2026-07-01T08:00:00.000Z');
  const guestRecordsToCreate = [];
  for (let i = 0; i < totalGenerations; i++) {
    const createdAt = new Date(baseDate.getTime() + i * 3600 * 1000); // 逐条递增时间戳
    let favoritedAt: Date | null = null;
    let deletedAt: Date | null = null;
    let sourceMessageId: string | null = null;

    // 前 20 条设置收藏
    if (i < 20) {
      favoritedAt = new Date(createdAt.getTime() + 1800 * 1000);
    }
    // 20~35 条移入回收站（软删除）
    if (i >= 20 && i < 35) {
      deletedAt = new Date(createdAt.getTime() + 2400 * 1000);
    }
    // 35~45 条既收藏又软删除
    if (i >= 35 && i < 45) {
      favoritedAt = new Date(createdAt.getTime() + 1800 * 1000);
      deletedAt = new Date(createdAt.getTime() + 2400 * 1000);
    }
    // 45~55 条带有来源消息 ID
    if (i >= 45 && i < 55) {
      sourceMessageId = `msg_guest_source_${tag1}_${i}`;
    }

    guestRecordsToCreate.push({
      guestId: guestId1,
      prompt: `故事提示词 ${i + 1}号：关于探索第${i + 1}颗星球的奇幻历险`,
      storyText: `# 星球探索第${i + 1}章\n探险家穿过了星际裂隙，来到了第${i + 1}号星球，这里有着紫色的水晶森林与低语的泉水。`,
      voiceId: i % 2 === 0 ? 'alloy' : 'onyx',
      title: `星球探索第${i + 1}章`,
      excerpt: `探险家穿过了星际裂隙，来到了第${i + 1}号星球...`,
      contentHash: `hash_val_${tag1}_${i}`,
      sourceMessageId,
      favoritedAt,
      deletedAt,
      createdAt,
      updatedAt: createdAt,
    });
  }

  // 写入访客作品表
  for (const item of guestRecordsToCreate) {
    await prisma.guestStoryWork.create({ data: item });
  }

  const guestWorksBefore = await prisma.guestStoryWork.findMany({
    where: { guestId: guestId1 },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  assert.strictEqual(guestWorksBefore.length, totalGenerations, `前置：访客端应准确存有 ${totalGenerations} 条作品`);

  // 1.2 创建目标用户并执行迁移服务
  const testUser1 = await prisma.user.create({
    data: {
      username: `u_mig_target_${tag1}`,
      password: 'HashedPassword123!',
      nickname: 'MigrationTarget1',
    },
  });

  const migrationResult = await migrateGuestCreativeRecordsToUser(guestId1, testUser1.id);

  // 1.3 关键计数断言：必须突破 100 条旧限，完整迁出 160 条
  assert.strictEqual(
    migrationResult.generationsMigrated,
    totalGenerations,
    `必须全部迁移 ${totalGenerations} 条，不得被 take:100 截断`
  );
  assert.strictEqual(
    migrationResult.storyWorkIdMap.size,
    totalGenerations,
    `ID Map 必须包含全部 ${totalGenerations} 对新旧 ID 映射`
  );

  // 1.4 用户侧数据表行数验证
  const userWorksAfter = await prisma.storyWork.findMany({
    where: { userId: testUser1.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  assert.strictEqual(userWorksAfter.length, totalGenerations, `用户作品表必须存在 ${totalGenerations} 条记录`);

  // 1.5 逐条逐字段核对状态原样保真（逐 id 校验）
  for (let i = 0; i < totalGenerations; i++) {
    const guestRow = guestWorksBefore[i];
    const mappedUserId = migrationResult.storyWorkIdMap.get(guestRow.id);
    assert.ok(mappedUserId !== undefined, `第 ${i} 条访客 ID ${guestRow.id} 必须在 ID Map 中存在映射`);

    const userRow = await prisma.storyWork.findUnique({
      where: { id: mappedUserId },
    });
    assert.ok(userRow !== null, `映射的 User Work ID ${mappedUserId} 必须真实存在于数据库中`);

    // 字段原样核对
    assert.strictEqual(userRow.userId, testUser1.id, `第 ${i} 条 userId 必须归属于新用户`);
    assert.strictEqual(userRow.prompt, guestRow.prompt, `第 ${i} 条 prompt 必须完全一致`);
    assert.strictEqual(userRow.storyText, guestRow.storyText, `第 ${i} 条 storyText 必须完全一致`);
    assert.strictEqual(userRow.voiceId, guestRow.voiceId, `第 ${i} 条 voiceId 必须完全一致`);
    assert.strictEqual(userRow.title, guestRow.title, `第 ${i} 条 title 必须完全一致`);
    assert.strictEqual(userRow.excerpt, guestRow.excerpt, `第 ${i} 条 excerpt 必须完全一致`);
    assert.strictEqual(userRow.contentHash, guestRow.contentHash, `第 ${i} 条 contentHash 必须完全一致`);
    assert.strictEqual(userRow.sourceMessageId, guestRow.sourceMessageId, `第 ${i} 条 sourceMessageId 必须完全一致`);

    // 时间戳与状态原样核对（不得重置）
    assert.strictEqual(
      userRow.favoritedAt?.toISOString() ?? null,
      guestRow.favoritedAt?.toISOString() ?? null,
      `第 ${i} 条 favoritedAt 必须原样保持，严禁被重置`
    );
    assert.strictEqual(
      userRow.deletedAt?.toISOString() ?? null,
      guestRow.deletedAt?.toISOString() ?? null,
      `第 ${i} 条 deletedAt 必须原样保持（Trash 状态不变），严禁被重置`
    );
    assert.strictEqual(
      userRow.createdAt.toISOString(),
      guestRow.createdAt.toISOString(),
      `第 ${i} 条 createdAt 必须原样保持`
    );
  }
  console.log(`PASS: 150+ (${totalGenerations}) 条作品全量迁移与关键字段（favoritedAt/deletedAt/createdAt/title/hash等）逐条核对完全通过`);

  console.log('=== 2. ID Map 持久化、查询契约与 Legacy Playback 引用映射 ===');
  // 2.1 数据库持久化表 StoryWorkMigration 校验
  const dbMigrationRecords = await prisma.storyWorkMigration.findMany({
    where: { guestId: guestId1, userId: testUser1.id },
  });
  assert.strictEqual(
    dbMigrationRecords.length,
    totalGenerations,
    `持久化表 StoryWorkMigration 必须正好记录 ${totalGenerations} 条新旧对应`
  );

  // 2.2 辅助查询契约校验
  const queriedMap = await getStoryWorkIdMapForGuest(guestId1);
  assert.strictEqual(queriedMap.size, totalGenerations);
  for (const guestRow of guestWorksBefore) {
    const singleLookup = await getUserStoryWorkIdByGuestWorkId(guestId1, guestRow.id);
    assert.strictEqual(
      singleLookup,
      migrationResult.storyWorkIdMap.get(guestRow.id),
      `getUserStoryWorkIdByGuestWorkId 必须准确返回持久化的新用户作品 ID`
    );
  }

  // 2.3 Legacy Playback 引用映射（场景 A：有效引用 guest generation ID）
  const targetGuestWork = guestWorksBefore[42];
  const mappedExpectedUserId = migrationResult.storyWorkIdMap.get(targetGuestWork.id)!;
  await prisma.guestPlaybackProgress.create({
    data: {
      guestId: guestId1,
      sourceType: 'generation',
      sourceId: String(targetGuestWork.id), // 访客回放历史时存的是访客作品 ID
      title: targetGuestWork.title,
      contentHash: targetGuestWork.contentHash,
      segmentationVersion: 'v1',
      lastCompletedParagraphIndex: 1,
      nextParagraphIndex: 2,
      totalParagraphs: 5,
      voiceId: targetGuestWork.voiceId,
      speed: 1.25,
      isOneShot: true,
    },
  });

  const playbackMigrated = await migrateGuestPlaybackProgressToUser(
    guestId1,
    testUser1.id,
    migrationResult.storyWorkIdMap
  );
  assert.strictEqual(playbackMigrated, true, '断点播放进度应成功迁移');

  const userProgress = await prisma.userPlaybackProgress.findUnique({
    where: { userId: testUser1.id },
  });
  assert.ok(userProgress !== null, '用户断点播放进度必须已落库');
  assert.strictEqual(userProgress.sourceType, 'generation', 'sourceType 必须保持 generation');
  // 核心契约：sourceId 必须通过 ID Map 映射为新用户作品 ID，严禁原样保留旧 guest ID！
  assert.strictEqual(
    userProgress.sourceId,
    String(mappedExpectedUserId),
    `legacy playback 必须映射为新 User Work ID (${mappedExpectedUserId})，不得保留旧 Guest ID (${targetGuestWork.id})`
  );
  assert.notStrictEqual(
    userProgress.sourceId,
    String(targetGuestWork.id),
    '严禁原样复用旧访客 ID'
  );

  // 2.4 Legacy Playback 引用映射（场景 B：未映射的 generation ID 必须 fail closed）
  // B1: Guest 有 generation playback 但无 StoryWorkMigration → migrateGuestPlaybackProgressToUser(...) === false → 目标用户无新 playback row
  const unmappedGuestId = `g_unmapped_${tag1}`;
  const unmappedUserId = (await prisma.user.create({
    data: { username: `u_unmapped_${tag1}`, password: 'Password123!' },
  })).id;

  await prisma.guestPlaybackProgress.create({
    data: {
      guestId: unmappedGuestId,
      sourceType: 'generation',
      sourceId: '9999999', // 未在 map 中的 generation ID
      title: 'Unmapped Generation Story',
    },
  });

  const unmappedMigrateRes = await migrateGuestPlaybackProgressToUser(unmappedGuestId, unmappedUserId);
  assert.strictEqual(unmappedMigrateRes, false, '未映射的 generation ID 必须 fail closed 返回 false');
  const unmappedUserProgress = await prisma.userPlaybackProgress.findUnique({
    where: { userId: unmappedUserId },
  });
  assert.strictEqual(unmappedUserProgress, null, '目标用户不得生成悬空未映射的 playback progress 记录');

  // B2: 目标用户已有 anchor → unmapped generation playback → false → 原 anchor 完全不变
  const existingAnchorUserId = (await prisma.user.create({
    data: { username: `u_anchor_${tag1}`, password: 'Password123!' },
  })).id;
  await prisma.userPlaybackProgress.create({
    data: {
      userId: existingAnchorUserId,
      sourceType: 'generation',
      sourceId: '12345',
      title: 'Original User Anchor Story',
      nextParagraphIndex: 3,
      totalParagraphs: 10,
    },
  });

  const anchorGuestId = `g_unmapped_anchor_${tag1}`;
  await prisma.guestPlaybackProgress.create({
    data: {
      guestId: anchorGuestId,
      sourceType: 'generation',
      sourceId: '8888888',
      title: 'Unmapped Guest Anchor Story',
      nextParagraphIndex: 1,
      totalParagraphs: 5,
    },
  });

  const anchorMigrateRes = await migrateGuestPlaybackProgressToUser(anchorGuestId, existingAnchorUserId);
  assert.strictEqual(anchorMigrateRes, false, '未映射的 generation ID 必须 fail closed 返回 false');

  const unchangedUserProgress = await prisma.userPlaybackProgress.findUnique({
    where: { userId: existingAnchorUserId },
  });
  assert.ok(unchangedUserProgress !== null, '目标用户原有 anchor 必须保留');
  assert.strictEqual(unchangedUserProgress.sourceId, '12345', '原 anchor sourceId 保持完全不变');
  assert.strictEqual(unchangedUserProgress.title, 'Original User Anchor Story', '原 anchor title 保持完全不变');
  assert.strictEqual(unchangedUserProgress.nextParagraphIndex, 3, '原 anchor nextParagraphIndex 保持完全不变');

  console.log('PASS: ID Map 持久化、逐条查询与 Legacy Playback Remap（Remap 成功 + Fail-closed 安全）通过');

  console.log('=== 3. Guest Rows 保留（迁移后访客表数据完好保留）===');
  const preservedGuestWorks = await prisma.guestStoryWork.findMany({
    where: { guestId: guestId1 },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  assert.strictEqual(
    preservedGuestWorks.length,
    totalGenerations,
    '迁移后访客表原有 160 条记录必须完全保留，严禁删除'
  );
  assert.strictEqual(preservedGuestWorks[0].id, guestWorksBefore[0].id);
  assert.strictEqual(preservedGuestWorks[0].title, guestWorksBefore[0].title);
  assert.strictEqual(
    preservedGuestWorks[0].favoritedAt?.toISOString() ?? null,
    guestWorksBefore[0].favoritedAt?.toISOString() ?? null
  );

  const preservedGuestProgress = await prisma.guestPlaybackProgress.findUnique({
    where: { guestId: guestId1 },
  });
  assert.ok(preservedGuestProgress !== null, '迁移后访客断点记录依然保留');
  console.log('PASS: 迁移后访客行数据全部保留（兼容旧引用）');

  console.log('=== 4. 既有账号登录绝不触发 merge Guest Work ===');
  // 4.1 创建既有用户并写入作品
  const existingUsername = `u_exist_${tag1}`;
  const hashedExistingPassword = await bcrypt.hash('HashedPassword123!', 10);
  const existingUser = await prisma.user.create({
    data: {
      username: existingUsername,
      password: hashedExistingPassword,
      nickname: 'ExistingUser4',
    },
  });
  await prisma.storyWork.create({
    data: {
      userId: existingUser.id,
      prompt: '老用户固有提示词',
      storyText: '老用户固有的作品内容',
      title: '老用户作品',
      contentHash: 'hash_exist_001',
    },
  });

  // 4.2 访客带着未迁移的独立作品
  const transientGuestId = `g_transient_${tag1}`;
  await prisma.guestStoryWork.create({
    data: {
      guestId: transientGuestId,
      prompt: '临时访客提示词',
      storyText: '临时访客未注册内容',
      title: '临时访客作品',
      contentHash: 'hash_guest_transient',
    },
  });

  // 4.3 执行真实 login
  const cookieJar = new Map<string, string>([['guest', encodeGuestId(transientGuestId)]]);
  const originalCookies = nextHeaders.cookies;
  (nextHeaders as { cookies: unknown }).cookies = async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (opts: { name: string; value: string }) => { cookieJar.set(opts.name, opts.value); },
    delete: () => {},
  });

  try {
    const caller = authRouter.createCaller({
      session: null,
      guestId: transientGuestId,
      isGuest: true,
      clientIp: '127.0.0.1',
    });
    const loginRes = await caller.login({
      username: existingUsername,
      password: 'HashedPassword123!',
    });
    assert.strictEqual(loginRes.success, true);
  } finally {
    (nextHeaders as { cookies: unknown }).cookies = originalCookies;
  }

  // 4.4 校验：老用户作品库绝对没有合并访客作品
  const existingUserWorksAfterLogin = await prisma.storyWork.findMany({
    where: { userId: existingUser.id },
  });
  assert.strictEqual(existingUserWorksAfterLogin.length, 1, '登录后老用户作品总数必须仍为 1，严禁合并访客作品');
  assert.strictEqual(existingUserWorksAfterLogin[0].title, '老用户作品');

  const guestWorksAfterLogin = await prisma.guestStoryWork.findMany({
    where: { guestId: transientGuestId },
  });
  assert.strictEqual(guestWorksAfterLogin.length, 1, '访客端作品依然保留在访客名下');

  const noMigrationRecords = await prisma.storyWorkMigration.findMany({
    where: { userId: existingUser.id },
  });
  assert.strictEqual(noMigrationRecords.length, 0, '登录操作不得创建任何 StoryWorkMigration 记录');
  console.log('PASS: 既有账号登录绝不合并 Guest 作品验证通过');

  console.log('=== 5. 边界与幂等性验证（空 guest 与重复调用）===');
  // 5.1 空 guest 迁移安全
  const emptyGuestId = `g_empty_${tag1}`;
  const emptyUser = await prisma.user.create({
    data: { username: `u_empty_${tag1}`, password: 'Password123!' },
  });
  const emptyResult = await migrateGuestCreativeRecordsToUser(emptyGuestId, emptyUser.id);
  assert.strictEqual(emptyResult.generationsMigrated, 0);
  assert.strictEqual(emptyResult.messagesMigrated, 0);
  assert.strictEqual(emptyResult.promptsMigrated, 0);
  assert.strictEqual(emptyResult.storyWorkIdMap.size, 0);
  const emptyUserWorks = await prisma.storyWork.findMany({ where: { userId: emptyUser.id } });
  assert.strictEqual(emptyUserWorks.length, 0, '空访客不应向用户写入任何作品');

  // 5.2 重复调用幂等性（对 guestId1 与 testUser1 再次执行）
  const repeatResult = await migrateGuestCreativeRecordsToUser(guestId1, testUser1.id);
  assert.strictEqual(repeatResult.generationsMigrated, totalGenerations);
  assert.strictEqual(repeatResult.storyWorkIdMap.size, totalGenerations);

  // 映射必须完全一致
  for (const [gId, uId] of migrationResult.storyWorkIdMap.entries()) {
    assert.strictEqual(
      repeatResult.storyWorkIdMap.get(gId),
      uId,
      '重复迁移返回的 ID Map 必须与首次完全一致'
    );
  }

  // 数据库记录行数不变（无重复插入）
  const userWorksAfterRepeat = await prisma.storyWork.findMany({
    where: { userId: testUser1.id },
  });
  assert.strictEqual(
    userWorksAfterRepeat.length,
    totalGenerations,
    `重复调用必须幂等，作品总行数必须依然为 ${totalGenerations}`
  );

  const migrationRecordsAfterRepeat = await prisma.storyWorkMigration.findMany({
    where: { guestId: guestId1, userId: testUser1.id },
  });
  assert.strictEqual(
    migrationRecordsAfterRepeat.length,
    totalGenerations,
    'StoryWorkMigration 记录数必须保持不变'
  );
  console.log('PASS: 空 guest 与重复迁移幂等性验证通过');

  console.log('=== 6. 端到端 authRouter.register 完整迁移链路校验 ===');
  const e2eGuestId = `g_e2e_${tag1}`;
  // 准备访客多态数据
  const g1 = await prisma.guestStoryWork.create({
    data: {
      guestId: e2eGuestId,
      prompt: 'E2E 故事 1',
      storyText: 'E2E 正文 1',
      title: 'E2E 标题 1',
      excerpt: 'E2E 摘要 1',
      contentHash: 'e2e_hash_1',
      favoritedAt: new Date('2026-08-15T12:00:00.000Z'),
    },
  });
  const g2 = await prisma.guestStoryWork.create({
    data: {
      guestId: e2eGuestId,
      prompt: 'E2E 故事 2',
      storyText: 'E2E 正文 2',
      title: 'E2E 标题 2',
      excerpt: 'E2E 摘要 2',
      contentHash: 'e2e_hash_2',
      deletedAt: new Date('2026-08-16T12:00:00.000Z'),
    },
  });
  // 建立关联断点（引用 g1 作品）
  await prisma.guestPlaybackProgress.create({
    data: {
      guestId: e2eGuestId,
      sourceType: 'generation',
      sourceId: String(g1.id),
      title: 'E2E 标题 1',
      contentHash: 'e2e_hash_1',
      nextParagraphIndex: 3,
      totalParagraphs: 6,
    },
  });

  const e2eCookieJar = new Map<string, string>();
  const origCookies = nextHeaders.cookies;
  (nextHeaders as { cookies: unknown }).cookies = async () => ({
    get: (name: string) => (e2eCookieJar.has(name) ? { name, value: e2eCookieJar.get(name)! } : undefined),
    set: (opts: { name: string; value: string }) => { e2eCookieJar.set(opts.name, opts.value); },
    delete: () => {},
  });

  const e2eUsername = `u_e2e_reg_${tag1}`;
  try {
    const caller = authRouter.createCaller({
      session: null,
      guestId: e2eGuestId,
      isGuest: true,
      clientIp: '127.0.0.1',
    });
    const regResult = await caller.register({
      username: e2eUsername,
      password: 'Password123!',
      nickname: 'E2E Registered User',
    });
    assert.strictEqual(regResult.success, true);
  } finally {
    (nextHeaders as { cookies: unknown }).cookies = origCookies;
  }

  const e2eUser = await prisma.user.findUnique({
    where: { username: e2eUsername },
    include: {
      storyWorks: true,
      playbackProgress: true,
      storyWorkMigrations: true,
    },
  });
  assert.ok(e2eUser !== null);
  assert.strictEqual(e2eUser.storyWorks.length, 2, '两部作品必须全部迁入新用户');
  assert.strictEqual(e2eUser.storyWorkMigrations.length, 2, '必须有 2 条迁移映射记录');

  // 验证收藏与软删除状态保真
  const uWork1 = e2eUser.storyWorks.find((w) => w.title === 'E2E 标题 1');
  const uWork2 = e2eUser.storyWorks.find((w) => w.title === 'E2E 标题 2');
  assert.ok(uWork1 && uWork2);
  assert.strictEqual(uWork1.favoritedAt?.toISOString(), g1.favoritedAt?.toISOString(), 'E2E: favoritedAt 保真');
  assert.strictEqual(uWork2.deletedAt?.toISOString(), g2.deletedAt?.toISOString(), 'E2E: deletedAt 保真');

  // 验证断点映射
  assert.ok(e2eUser.playbackProgress !== null);
  assert.strictEqual(e2eUser.playbackProgress.sourceType, 'generation');
  assert.strictEqual(
    e2eUser.playbackProgress.sourceId,
    String(uWork1.id),
    'E2E: 注册后断点 sourceId 必须精确映射为新创建的 User Work ID'
  );

  console.log('PASS: 端到端 authRouter.register 完整迁移链路校验通过');

  console.log('=== 7. sourceMessageId 碰撞安全与 contentHash 校验回归验证 ===');
  // 7.1 same sourceMessageId + same contentHash → 不新增 Work、建立正确 map
  const collisionTag = `c_${Date.now()}`;
  const collisionUser1 = await prisma.user.create({
    data: { username: `u_col1_${collisionTag}`, password: 'Password123!' },
  });
  const existingWork1 = await prisma.storyWork.create({
    data: {
      userId: collisionUser1.id,
      prompt: '原有作品提示词',
      storyText: '原有作品正文',
      title: '原有作品',
      contentHash: 'hash_same_123',
      sourceMessageId: `msg_col_${collisionTag}`,
    },
  });

  const guestSameHash = `g_col_same_${collisionTag}`;
  const guestWorkSame = await prisma.guestStoryWork.create({
    data: {
      guestId: guestSameHash,
      prompt: '原有作品提示词',
      storyText: '原有作品正文',
      title: '原有作品',
      contentHash: 'hash_same_123',
      sourceMessageId: `msg_col_${collisionTag}`,
    },
  });

  const migResultSame = await migrateGuestCreativeRecordsToUser(guestSameHash, collisionUser1.id);
  assert.strictEqual(
    migResultSame.storyWorkIdMap.get(guestWorkSame.id),
    existingWork1.id,
    '同源同 hash 必须映射至既有 Work ID'
  );

  const userWorksAfterSame = await prisma.storyWork.findMany({
    where: { userId: collisionUser1.id },
  });
  assert.strictEqual(userWorksAfterSame.length, 1, '同源同 hash 绝不新增 Work，行数保持 1');
  assert.strictEqual(userWorksAfterSame[0].id, existingWork1.id);
  assert.strictEqual(userWorksAfterSame[0].contentHash, 'hash_same_123');

  const migRecordSame = await prisma.storyWorkMigration.findUnique({
    where: {
      guestId_guestStoryWorkId: {
        guestId: guestSameHash,
        guestStoryWorkId: guestWorkSame.id,
      },
    },
  });
  assert.ok(migRecordSame !== null, '同源同 hash 必须持久化记录迁移映射');
  assert.strictEqual(migRecordSame.userStoryWorkId, existingWork1.id);

  // 7.2 same sourceMessageId + different contentHash → migration fails（明确抛冲突）、不建立错误 map、原 User Work 不被覆盖
  const collisionUser2 = await prisma.user.create({
    data: { username: `u_col2_${collisionTag}`, password: 'Password123!' },
  });
  const existingWork2 = await prisma.storyWork.create({
    data: {
      userId: collisionUser2.id,
      prompt: '用户原生提示词',
      storyText: '用户原生故事文本',
      title: '用户原生作品',
      contentHash: 'hash_original_456',
      sourceMessageId: `msg_col_diff_${collisionTag}`,
    },
  });

  const guestDiffHash = `g_col_diff_${collisionTag}`;
  const guestWorkDiff = await prisma.guestStoryWork.create({
    data: {
      guestId: guestDiffHash,
      prompt: '访客不同提示词',
      storyText: '访客完全不同的故事文本',
      title: '访客不同作品',
      contentHash: 'hash_different_789',
      sourceMessageId: `msg_col_diff_${collisionTag}`,
    },
  });

  let threwConflict = false;
  try {
    await migrateGuestCreativeRecordsToUser(guestDiffHash, collisionUser2.id);
  } catch (err: unknown) {
    threwConflict = true;
    const errorObj = err as { code?: string; message?: string };
    assert.strictEqual(errorObj.code, 'CONFLICT', '同源异 hash 必须抛出 CONFLICT 异常');
  }
  assert.strictEqual(threwConflict, true, '同源异 hash 迁移必须明确失败拒绝');

  // 校验原 User Work 完好无损未被篡改
  const userWorksAfterDiff = await prisma.storyWork.findMany({
    where: { userId: collisionUser2.id },
  });
  assert.strictEqual(userWorksAfterDiff.length, 1, '同源异 hash 失败后作品表不得有残留新建行');
  assert.strictEqual(userWorksAfterDiff[0].id, existingWork2.id);
  assert.strictEqual(userWorksAfterDiff[0].storyText, '用户原生故事文本', '原 User Work 内容不得被覆盖');
  assert.strictEqual(userWorksAfterDiff[0].contentHash, 'hash_original_456');

  // 校验不建立错误 map
  const migRecordDiff = await prisma.storyWorkMigration.findUnique({
    where: {
      guestId_guestStoryWorkId: {
        guestId: guestDiffHash,
        guestStoryWorkId: guestWorkDiff.id,
      },
    },
  });
  assert.strictEqual(migRecordDiff, null, '同源异 hash 绝不建立错误 map 记录');

  console.log('PASS: sourceMessageId 碰撞安全与 contentHash 校验回归验证通过');
}

const testPromise = runGuestRegistrationMigrationTests()
  .then(() => {
    console.log('ALL STORY WORK GUEST REGISTRATION MIGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
