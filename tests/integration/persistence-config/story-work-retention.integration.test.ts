/**
 * StoryWork Retention 与垃圾回收 (GC) 集成测试（M2-09）
 *
 * 验收矩阵：
 * 1. User active 老作品（远早于 30 天，例如 60 天前）在 purge 后完好保留，严禁自动删除；
 * 2. User Trash 仅按 30 天窗口条件删除：未到期（29 天）不删，到期（31 天）彻底物理删除；
 * 3. Guest inactivity：活跃 guest（30 天内有任一交互）即使拥有 >30d 作品也不 GC；
 *    不活跃 guest（>30d 无交互）整体 GC 清理其作品及关联数据；User 数据绝对不受影响；
 * 4. 无数量 cap：批量 >100/150 条（例如 160 条）路径不触发任何删除或容量裁剪；
 * 5. 并发安全（高风险）：purge 与 restore 竞争——通过 __testBeforeMutationHook 确定性注入，
 *    恢复后的 active 作品绝对不被误删；
 * 6. 边界与幂等性：空数据调用、重复调用安全幂等。
 */

import assert from 'node:assert';
import { prisma } from '../../../lib/db';
import type { Subject } from '../../../lib/server/subject';
import {
  purgeExpiredUserTrash,
  gcInactiveGuests,
  THIRTY_DAYS_MS,
} from '../../../lib/server/retention';
import {
  createStoryWorkForSubject,
  trashStoryWorkForSubject,
  restoreStoryWorkForSubject,
} from '../../../lib/server/storyWork';

async function runStoryWorkRetentionTests() {
  const baseTime = new Date('2026-09-12T12:00:00.000Z');
  const tag = Date.now();

  console.log('=== 1. active 老作品（远早于 30 天）在 purge 后完好保留 ===');
  const user1 = await prisma.user.create({
    data: {
      username: `u_retention_1_${tag}`,
      password: 'HashedPassword123!',
      nickname: 'RetentionUser1',
    },
  });
  const sixtyDaysAgo = new Date(baseTime.getTime() - 60 * 24 * 60 * 60 * 1000);

  // 创建一个 60 天前的活跃作品（deletedAt 为 null）
  const activeOldWork = await prisma.storyWork.create({
    data: {
      userId: user1.id,
      prompt: '老作品提示词 1',
      storyText: '60 天前创作的长久活跃故事正文……',
      title: '60天前活跃老故事',
      contentHash: `hash_old_active_${tag}`,
      createdAt: sixtyDaysAgo,
      updatedAt: sixtyDaysAgo,
      deletedAt: null,
    },
  });

  const purgeRes1 = await purgeExpiredUserTrash(baseTime);
  assert.strictEqual(purgeRes1.purged, 0, '活跃作品绝不计入 purged 计数');

  const checkActiveOldWork = await prisma.storyWork.findUnique({
    where: { id: activeOldWork.id },
  });
  assert.ok(checkActiveOldWork !== null, '60 天前的活跃作品必须完好保留在数据库中');
  assert.strictEqual(checkActiveOldWork.deletedAt, null, '活跃作品 deletedAt 必须保持为 null');
  console.log('PASS: active 老作品（无论多老）在 purge 后完好保留');

  console.log('=== 2. Trash 未到期（29 天）不删；到期（31 天）删除 ===');
  const twentyNineDaysAgo = new Date(baseTime.getTime() - 29 * 24 * 60 * 60 * 1000);
  const thirtyOneDaysAgo = new Date(baseTime.getTime() - 31 * 24 * 60 * 60 * 1000);

  // 创建一个 29 天前移入回收站的作品（未到期）
  const trashWork29d = await prisma.storyWork.create({
    data: {
      userId: user1.id,
      prompt: '29 天回收站提示词',
      storyText: '29 天前移入回收站的内容……',
      title: '29天未到期回收站故事',
      contentHash: `hash_trash_29d_${tag}`,
      createdAt: sixtyDaysAgo,
      updatedAt: twentyNineDaysAgo,
      deletedAt: twentyNineDaysAgo,
    },
  });

  // 创建一个 31 天前移入回收站的作品（已到期）
  const trashWork31d = await prisma.storyWork.create({
    data: {
      userId: user1.id,
      prompt: '31 天回收站提示词',
      storyText: '31 天前移入回收站的内容……',
      title: '31天到期应清理回收站故事',
      contentHash: `hash_trash_31d_${tag}`,
      createdAt: sixtyDaysAgo,
      updatedAt: thirtyOneDaysAgo,
      deletedAt: thirtyOneDaysAgo,
    },
  });

  const purgeRes2 = await purgeExpiredUserTrash(baseTime);
  assert.strictEqual(purgeRes2.purged, 1, '仅到期（31天）的回收站作品应被清理，29天不得清理');

  // 校验 29 天未到期作品仍完好在库
  const checkTrash29d = await prisma.storyWork.findUnique({
    where: { id: trashWork29d.id },
  });
  assert.ok(checkTrash29d !== null, '未到期（29天）回收站作品必须保留在数据库中');
  assert.strictEqual(
    checkTrash29d.deletedAt?.toISOString(),
    twentyNineDaysAgo.toISOString(),
    '未到期回收站作品 deletedAt 不变'
  );

  // 校验 31 天已到期作品已被物理删除
  const checkTrash31d = await prisma.storyWork.findUnique({
    where: { id: trashWork31d.id },
  });
  assert.strictEqual(checkTrash31d, null, '已到期（31天）回收站作品必须彻底物理清理');
  console.log('PASS: Trash 未到期（29 天）不删；到期（31 天）删除验证通过');

  console.log('=== 3. Guest inactivity：活跃 guest 不 GC；不活跃（>30d）GC；User 数据不受影响 ===');
  const guestActiveId = `g_act_${tag}`;
  const guestInactiveId = `g_inact_${tag}`;
  const fortyFiveDaysAgo = new Date(baseTime.getTime() - 45 * 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(baseTime.getTime() - 2 * 24 * 60 * 60 * 1000);

  // 3.1 活跃访客（拥有 45 天前的作品，但 2 天前有聊天记录活跃交互）
  const guestActiveWork = await prisma.guestStoryWork.create({
    data: {
      guestId: guestActiveId,
      prompt: '活跃访客的老作品',
      storyText: '活跃访客在 45 天前创作的故事……',
      title: '活跃访客老作品',
      contentHash: `hash_act_guest_${tag}`,
      createdAt: fortyFiveDaysAgo,
      updatedAt: fortyFiveDaysAgo,
    },
  });
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestActiveId,
      position: 0,
      messageId: `msg_act_${tag}`,
      role: 'user',
      content: '活跃访客近期发送的消息',
      createdAt: twoDaysAgo.toISOString(),
      updatedAt: twoDaysAgo,
    },
  });

  // 3.2 不活跃访客（拥有 2 部作品，所有数据更新时间均在 45 天前）
  const guestInactiveWork1 = await prisma.guestStoryWork.create({
    data: {
      guestId: guestInactiveId,
      prompt: '不活跃访客作品 1',
      storyText: '不活跃访客作品 1 正文……',
      title: '不活跃作品 1',
      contentHash: `hash_inact_guest_1_${tag}`,
      createdAt: fortyFiveDaysAgo,
      updatedAt: fortyFiveDaysAgo,
    },
  });
  const guestInactiveWork2 = await prisma.guestStoryWork.create({
    data: {
      guestId: guestInactiveId,
      prompt: '不活跃访客作品 2',
      storyText: '不活跃访客作品 2 正文……',
      title: '不活跃作品 2',
      contentHash: `hash_inact_guest_2_${tag}`,
      createdAt: fortyFiveDaysAgo,
      updatedAt: fortyFiveDaysAgo,
    },
  });
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestInactiveId,
      position: 0,
      messageId: `msg_inact_${tag}`,
      role: 'user',
      content: '不活跃访客远期消息',
      createdAt: fortyFiveDaysAgo.toISOString(),
      updatedAt: fortyFiveDaysAgo,
    },
  });

  // 3.3 执行 Guest Inactivity GC
  const gcResult = await gcInactiveGuests(baseTime);
  assert.strictEqual(gcResult.purgedGuests, 1, '应准确判定并清理 1 位不活跃访客');
  assert.strictEqual(gcResult.purgedWorks, 2, '应清理不活跃访客的全部 2 部作品');

  // 3.4 校验活跃访客作品安然无恙（活跃 guest 不因作品老而被裁剪）
  const checkGuestActiveWork = await prisma.guestStoryWork.findUnique({
    where: { id: guestActiveWork.id },
  });
  assert.ok(checkGuestActiveWork !== null, '活跃访客的 45 天老作品绝对不被 GC 清理');

  // 3.5 校验不活跃访客作品与数据被彻底清理
  const checkGuestInactiveWork1 = await prisma.guestStoryWork.findUnique({
    where: { id: guestInactiveWork1.id },
  });
  const checkGuestInactiveWork2 = await prisma.guestStoryWork.findUnique({
    where: { id: guestInactiveWork2.id },
  });
  assert.strictEqual(checkGuestInactiveWork1, null, '不活跃访客作品 1 必须已彻底物理清理');
  assert.strictEqual(checkGuestInactiveWork2, null, '不活跃访客作品 2 必须已彻底物理清理');

  // 3.6 校验 User 数据绝对不受 Guest GC 任何影响
  const checkUser1Active = await prisma.storyWork.findUnique({
    where: { id: activeOldWork.id },
  });
  const checkUser1Trash = await prisma.storyWork.findUnique({
    where: { id: trashWork29d.id },
  });
  assert.ok(checkUser1Active !== null, '用户活跃作品不受 Guest GC 任何影响');
  assert.ok(checkUser1Trash !== null, '用户回收站作品不受 Guest GC 任何影响');
  console.log('PASS: Guest inactivity：活跃 guest 不 GC；不活跃（>30d）GC；User 数据不受影响通过');

  console.log('=== 4. 无数量 cap：批量 >100/150 条路径不触发任何删除 ===');
  // 创建拥有 160 条活跃作品的用户
  const userCapTest = await prisma.user.create({
    data: {
      username: `u_cap_${tag}`,
      password: 'Password123!',
      nickname: 'CapTestUser',
    },
  });
  const totalBulk = 160;
  const userWorksData = [];
  for (let i = 0; i < totalBulk; i++) {
    userWorksData.push({
      userId: userCapTest.id,
      prompt: `批量作品提示词 ${i}`,
      storyText: `批量正文内容 ${i}`,
      title: `批量作品 ${i}`,
      contentHash: `hash_bulk_${tag}_${i}`,
      createdAt: sixtyDaysAgo,
      updatedAt: sixtyDaysAgo,
      deletedAt: null,
    });
  }
  await prisma.storyWork.createMany({ data: userWorksData });

  // 创建拥有 160 条作品的活跃访客（带 1 天前活跃会话）
  const guestCapId = `g_cap_${tag}`;
  const guestWorksData = [];
  for (let i = 0; i < totalBulk; i++) {
    guestWorksData.push({
      guestId: guestCapId,
      prompt: `访客批量作品提示词 ${i}`,
      storyText: `访客批量正文内容 ${i}`,
      title: `访客批量作品 ${i}`,
      contentHash: `hash_guest_bulk_${tag}_${i}`,
      createdAt: sixtyDaysAgo,
      updatedAt: sixtyDaysAgo,
    });
  }
  await prisma.guestStoryWork.createMany({ data: guestWorksData });
  await prisma.guestChatMessage.create({
    data: {
      guestId: guestCapId,
      position: 0,
      messageId: `msg_cap_${tag}`,
      role: 'user',
      content: '访客批量测试近期活跃消息',
      createdAt: twoDaysAgo.toISOString(),
      updatedAt: twoDaysAgo,
    },
  });

  // 执行 Retention 与 GC 服务
  const capPurgeRes = await purgeExpiredUserTrash(baseTime);
  const capGcRes = await gcInactiveGuests(baseTime);
  assert.strictEqual(capPurgeRes.purged, 0, '活跃批量作品绝不被 purge');
  assert.strictEqual(capGcRes.purgedWorks, 0, '活跃访客批量作品绝不被 GC');

  // 严格验证总行数与首尾 ID 保留（严禁出现淘汰旧作的 KEEP_LIMIT / 100 裁剪行为）
  const userWorksAfter = await prisma.storyWork.findMany({
    where: { userId: userCapTest.id },
    orderBy: { id: 'asc' },
  });
  assert.strictEqual(userWorksAfter.length, totalBulk, `用户端必须完整保留全部 ${totalBulk} 条，无任何容量截断`);
  assert.strictEqual(userWorksAfter[0].title, '批量作品 0', '第 1 条作品依然存在未被淘汰');
  assert.strictEqual(userWorksAfter[totalBulk - 1].title, `批量作品 ${totalBulk - 1}`, '最后 1 条作品完好');

  const guestWorksAfter = await prisma.guestStoryWork.findMany({
    where: { guestId: guestCapId },
    orderBy: { id: 'asc' },
  });
  assert.strictEqual(guestWorksAfter.length, totalBulk, `访客端必须完整保留全部 ${totalBulk} 条，无任何容量截断`);
  assert.strictEqual(guestWorksAfter[0].title, '访客批量作品 0');
  assert.strictEqual(guestWorksAfter[totalBulk - 1].title, `访客批量作品 ${totalBulk - 1}`);
  console.log('PASS: 无数量 cap：批量 >100/150 条路径不触发任何删除通过');

  console.log('=== 5. 竞态 regression：purge 与 restore 竞争——恢复后 active 作品不被删除 ===');
  // 场景：某作品原本处于已过期的回收站中（deletedAt 为 35 天前）。
  // 在 purgeExpiredUserTrash 即将执行原子 deleteMany 瞬间，用户并发点击 restore 将其恢复为 active。
  // 原子条件写保障：deleteMany 带有 deletedAt: { not: null, lt: threshold } 谓词，绝不误删刚恢复的作品。
  const userRace = await prisma.user.create({
    data: {
      username: `u_race_${tag}`,
      password: 'Password123!',
      nickname: 'RaceTester',
    },
  });
  const userRaceSubject: Subject = { type: 'user', id: userRace.id };
  const thirtyFiveDaysAgo = new Date(baseTime.getTime() - 35 * 24 * 60 * 60 * 1000);

  const raceWork = await prisma.storyWork.create({
    data: {
      userId: userRace.id,
      prompt: '竞态测试提示词',
      storyText: '竞态测试作品正文……',
      title: '竞态恢复作品',
      contentHash: `hash_race_${tag}`,
      createdAt: sixtyDaysAgo,
      updatedAt: thirtyFiveDaysAgo,
      deletedAt: thirtyFiveDaysAgo,
    },
  });

  let restoreCalled = false;
  const racePurgeRes = await purgeExpiredUserTrash(baseTime, {
    __testBeforeMutationHook: async () => {
      // 模拟并发先行一步将作品从回收站恢复
      const restored = await restoreStoryWorkForSubject(userRaceSubject, raceWork.id);
      assert.strictEqual(restored.deletedAt, null, '作品已成功恢复为活跃状态');
      restoreCalled = true;
    },
  });

  assert.strictEqual(restoreCalled, true, '并发测试注入钩子必须被执行');
  assert.strictEqual(racePurgeRes.purged, 0, '已恢复活跃的作品绝不被原子删除，purged 计数为 0');

  const raceWorkRow = await prisma.storyWork.findUnique({
    where: { id: raceWork.id },
  });
  assert.ok(raceWorkRow !== null, '发生竞态后，恢复的作品必须依然完整保存在数据库中');
  assert.strictEqual(raceWorkRow.deletedAt, null, '作品状态必须确凿为活跃状态（deletedAt === null）');
  console.log('PASS: purge 与 restore 竞态回归验证通过（恢复后的 active 作品未被误删）');

  console.log('=== 6. 边界条件与幂等性校验 ===');
  // 6.1 重复调用 purgeExpiredUserTrash
  const dupPurge1 = await purgeExpiredUserTrash(baseTime);
  const dupPurge2 = await purgeExpiredUserTrash(baseTime);
  assert.strictEqual(dupPurge1.purged, 0);
  assert.strictEqual(dupPurge2.purged, 0);

  // 6.2 重复调用 gcInactiveGuests
  const dupGc1 = await gcInactiveGuests(baseTime);
  const dupGc2 = await gcInactiveGuests(baseTime);
  assert.strictEqual(dupGc1.purgedGuests, 0);
  assert.strictEqual(dupGc2.purgedGuests, 0);
  console.log('PASS: 边界条件与幂等性校验通过');
}

const testPromise = runStoryWorkRetentionTests()
  .then(() => {
    console.log('ALL STORY WORK RETENTION INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
