/**
 * StoryWork Retention 与垃圾回收 (GC) 集成测试（M2-09 FIXUP）
 *
 * 验收矩阵：
 * 1. User active 老作品（远早于 30 天，例如 60 天前）在 purge 后完好保留，严禁自动删除；
 * 2. User Trash 仅按 30 天窗口条件删除：未到期（29 天）不删，到期（31 天）彻底物理删除；
 * 3. Guest 数据 per-row 30 天语义回归：
 *    - Guest StoryWork：29d 保留 / 31d 删；
 *    - Guest Chat / Prompt / Config / Playback：保持各自既有 updatedAt < 30d 规则；
 *    - User 数据完全不受影响；
 * 4. 无数量 cap：批量 >100/150 条（例如 160 条）路径不触发任何删除或容量裁剪；
 * 5. 并发安全（高风险）：purge 与 restore 竞争——通过 __testBeforeMutationHook 确定性注入，
 *    恢复后的 active 作品绝对不被误删；
 * 6. 统一物理删除 primitive (M8 Audio Seam) 验证：
 *    - manual permanentlyDeleteStoryWorkForSubject 与 retention purgeExpiredUserTrash 共用同一内部底层执行点；
 *    - active 作品禁止物理删除（CONFLICT）；
 * 7. 边界与幂等性：空数据调用、重复调用安全幂等。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { TRPCError } from '@trpc/server';
import { prisma } from '../../../lib/db';
import type { Subject } from '../../../lib/server/subject';
import {
  purgeExpiredUserTrash,
  purgeExpiredGuestData,
  THIRTY_DAYS_MS,
} from '../../../lib/server/retention';
import {
  createStoryWorkForSubject,
  trashStoryWorkForSubject,
  restoreStoryWorkForSubject,
  permanentlyDeleteStoryWorkForSubject,
  executeStoryWorkPhysicalDelete,
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

  console.log('=== 3. Guest 数据 per-row 30 天语义回归（29d 保留 / 31d 删，User 数据不受影响） ===');
  const guestAId = `g_a_${tag}`;
  const guestBId = `g_b_${tag}`;

  // 3.1 Guest StoryWork: 一条 29d（保留），一条 31d（删除）
  const guestWork29d = await prisma.guestStoryWork.create({
    data: {
      guestId: guestAId,
      prompt: '29天访客作品提示词',
      storyText: '29天访客作品正文……',
      title: '29天未到期访客作品',
      contentHash: `hash_guest_29d_${tag}`,
      createdAt: twentyNineDaysAgo,
      updatedAt: twentyNineDaysAgo,
    },
  });
  const guestWork31d = await prisma.guestStoryWork.create({
    data: {
      guestId: guestAId,
      prompt: '31天访客作品提示词',
      storyText: '31天访客作品正文……',
      title: '31天到期应清理访客作品',
      contentHash: `hash_guest_31d_${tag}`,
      createdAt: thirtyOneDaysAgo,
      updatedAt: thirtyOneDaysAgo,
    },
  });

  // 3.2 Guest ChatMessage: 一条 29d（保留），一条 31d（删除）
  const guestMsg29d = await prisma.guestChatMessage.create({
    data: {
      guestId: guestAId,
      position: 0,
      messageId: `msg_29d_${tag}`,
      role: 'user',
      content: '29天消息内容',
      createdAt: twentyNineDaysAgo.toISOString(),
      updatedAt: twentyNineDaysAgo,
    },
  });
  const guestMsg31d = await prisma.guestChatMessage.create({
    data: {
      guestId: guestAId,
      position: 1,
      messageId: `msg_31d_${tag}`,
      role: 'user',
      content: '31天消息内容',
      createdAt: thirtyOneDaysAgo.toISOString(),
      updatedAt: thirtyOneDaysAgo,
    },
  });

  // 3.3 Guest PromptHistory: 一条 29d（保留），一条 31d（删除）
  const guestPrompt29d = await prisma.guestPromptHistory.create({
    data: {
      guestId: guestBId,
      prompt: '29天提示词历史',
      lastUsed: twentyNineDaysAgo,
      updatedAt: twentyNineDaysAgo,
    },
  });
  const guestPrompt31d = await prisma.guestPromptHistory.create({
    data: {
      guestId: guestBId,
      prompt: '31天提示词历史',
      lastUsed: thirtyOneDaysAgo,
      updatedAt: thirtyOneDaysAgo,
    },
  });

  // 3.4 Guest Config: 一条 29d（保留），一条 31d（删除）
  const guestCfg29d = await prisma.guestConfig.create({
    data: {
      guestId: `g_cfg_29d_${tag}`,
      voiceId: 'voice_1',
      createdAt: twentyNineDaysAgo,
      updatedAt: twentyNineDaysAgo,
    },
  });
  const guestCfg31d = await prisma.guestConfig.create({
    data: {
      guestId: `g_cfg_31d_${tag}`,
      voiceId: 'voice_2',
      createdAt: thirtyOneDaysAgo,
      updatedAt: thirtyOneDaysAgo,
    },
  });

  // 3.5 Guest PlaybackProgress: 一条 29d（保留），一条 31d（删除）
  const guestPlay29d = await prisma.guestPlaybackProgress.create({
    data: {
      guestId: `g_play_29d_${tag}`,
      sourceType: 'chat',
      sourceId: '90001',
      title: '29天播放进度',
      createdAt: twentyNineDaysAgo,
      updatedAt: twentyNineDaysAgo,
    },
  });
  const guestPlay31d = await prisma.guestPlaybackProgress.create({
    data: {
      guestId: `g_play_31d_${tag}`,
      sourceType: 'chat',
      sourceId: '90002',
      title: '31天播放进度',
      createdAt: thirtyOneDaysAgo,
      updatedAt: thirtyOneDaysAgo,
    },
  });

  // 执行基于行语义的 Guest GC 清理（传入 30 天分界时间点）
  const guestCutoff = new Date(baseTime.getTime() - THIRTY_DAYS_MS);
  const guestGcRes = await purgeExpiredGuestData(guestCutoff);
  assert.ok(guestGcRes.generationsDeleted >= 1, '31天的 Guest StoryWork 应被清理');
  assert.ok(guestGcRes.messagesDeleted >= 1, '31天的 Guest Chat 应被清理');
  assert.ok(guestGcRes.promptsDeleted >= 1, '31天的 Guest Prompt 应被清理');
  assert.ok(guestGcRes.configsDeleted >= 1, '31天的 Guest Config 应被清理');
  assert.ok(guestGcRes.playbackProgressDeleted >= 1, '31天的 Guest Playback 应被清理');

  // 校验 29d 记录严格保留
  const checkGuestWork29d = await prisma.guestStoryWork.findUnique({ where: { id: guestWork29d.id } });
  assert.ok(checkGuestWork29d !== null, '29天的 Guest StoryWork 必须保留');

  const checkGuestMsg29d = await prisma.guestChatMessage.findUnique({ where: { id: guestMsg29d.id } });
  assert.ok(checkGuestMsg29d !== null, '29天的 Guest Chat 必须保留');

  const checkGuestPrompt29d = await prisma.guestPromptHistory.findUnique({ where: { id: guestPrompt29d.id } });
  assert.ok(checkGuestPrompt29d !== null, '29天的 Guest Prompt 必须保留');

  const checkGuestCfg29d = await prisma.guestConfig.findUnique({ where: { id: guestCfg29d.id } });
  assert.ok(checkGuestCfg29d !== null, '29天的 Guest Config 必须保留');

  const checkGuestPlay29d = await prisma.guestPlaybackProgress.findUnique({ where: { id: guestPlay29d.id } });
  assert.ok(checkGuestPlay29d !== null, '29天的 Guest Playback 必须保留');

  // 校验 31d 记录确凿被物理删除
  const checkGuestWork31d = await prisma.guestStoryWork.findUnique({ where: { id: guestWork31d.id } });
  assert.strictEqual(checkGuestWork31d, null, '31天的 Guest StoryWork 必须被删除');

  const checkGuestMsg31d = await prisma.guestChatMessage.findUnique({ where: { id: guestMsg31d.id } });
  assert.strictEqual(checkGuestMsg31d, null, '31天的 Guest Chat 必须被删除');

  const checkGuestPrompt31d = await prisma.guestPromptHistory.findUnique({ where: { id: guestPrompt31d.id } });
  assert.strictEqual(checkGuestPrompt31d, null, '31天的 Guest Prompt 必须被删除');

  const checkGuestCfg31d = await prisma.guestConfig.findUnique({ where: { id: guestCfg31d.id } });
  assert.strictEqual(checkGuestCfg31d, null, '31天的 Guest Config 必须被删除');

  const checkGuestPlay31d = await prisma.guestPlaybackProgress.findUnique({ where: { id: guestPlay31d.id } });
  assert.strictEqual(checkGuestPlay31d, null, '31天的 Guest Playback 必须被删除');

  // 校验 User 数据绝不受 Guest GC 任何影响
  const checkUser1ActiveAfterGuestGc = await prisma.storyWork.findUnique({ where: { id: activeOldWork.id } });
  assert.ok(checkUser1ActiveAfterGuestGc !== null, '用户活跃作品不受 Guest GC 任何影响');

  const checkUser1TrashAfterGuestGc = await prisma.storyWork.findUnique({ where: { id: trashWork29d.id } });
  assert.ok(checkUser1TrashAfterGuestGc !== null, '用户回收站作品不受 Guest GC 任何影响');

  // 3.6 源码静态守卫：lib/server/guestGc.ts 严禁直接调用 prisma.guestStoryWork.delete/deleteMany
  const repoRoot = process.cwd();
  const guestGcPath = path.join(repoRoot, 'lib/server/guestGc.ts');
  assert.ok(fs.existsSync(guestGcPath), `文件必须存在：${guestGcPath}`);
  const guestGcContent = fs.readFileSync(guestGcPath, 'utf-8');
  assert.ok(
    !guestGcContent.includes('prisma.guestStoryWork.delete') &&
    !guestGcContent.includes('prisma.guestStoryWork.deleteMany'),
    'lib/server/guestGc.ts 严禁直接调用 prisma.guestStoryWork.delete / deleteMany，必须经由 executeStoryWorkPhysicalDelete 唯一 seam'
  );
  console.log('PASS: Guest 数据 per-row 30 天语义回归（29d 保留 / 31d 删，User 数据不受影响）与源码静态守卫验证通过');

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

  // 创建拥有 160 条 29d 作品的访客
  const guestCapId = `g_cap_${tag}`;
  const guestWorksData = [];
  for (let i = 0; i < totalBulk; i++) {
    guestWorksData.push({
      guestId: guestCapId,
      prompt: `访客批量作品提示词 ${i}`,
      storyText: `访客批量正文内容 ${i}`,
      title: `访客批量作品 ${i}`,
      contentHash: `hash_guest_bulk_${tag}_${i}`,
      createdAt: twentyNineDaysAgo,
      updatedAt: twentyNineDaysAgo,
    });
  }
  await prisma.guestStoryWork.createMany({ data: guestWorksData });

  // 执行 Retention 与 GC 服务
  const capPurgeRes = await purgeExpiredUserTrash(baseTime);
  const capGcRes = await purgeExpiredGuestData(guestCutoff);
  assert.strictEqual(capPurgeRes.purged, 0, '活跃批量作品绝不被 purge');
  assert.strictEqual(capGcRes.generationsDeleted, 0, '未过期访客批量作品绝不被 GC');

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

  console.log('=== 6. 统一物理删除 primitive (executeStoryWorkPhysicalDelete / M8 Seam) 契约 ===');
  // 6.1 active 作品严禁物理删除
  const activeWorkForSeam = await prisma.storyWork.create({
    data: {
      userId: user1.id,
      prompt: 'Seam 测试提示词',
      storyText: 'Seam 活跃作品正文……',
      title: 'Seam 活跃作品',
      contentHash: `hash_seam_act_${tag}`,
      createdAt: sixtyDaysAgo,
      updatedAt: sixtyDaysAgo,
      deletedAt: null,
    },
  });
  const user1Subject: Subject = { type: 'user', id: user1.id };

  await assert.rejects(
    async () => permanentlyDeleteStoryWorkForSubject(user1Subject, activeWorkForSeam.id),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === 'CONFLICT' &&
      err.message === '仅允许对回收站中的作品执行永久删除',
    '活跃作品必须拒绝永久物理删除'
  );

  // 6.2 移入回收站后通过统一 primitive 执行删除
  await trashStoryWorkForSubject(user1Subject, activeWorkForSeam.id);
  const deletePermRes = await permanentlyDeleteStoryWorkForSubject(user1Subject, activeWorkForSeam.id);
  assert.strictEqual(deletePermRes.success, true);
  assert.strictEqual(deletePermRes.id, activeWorkForSeam.id);

  const checkSeamWorkDeleted = await prisma.storyWork.findUnique({ where: { id: activeWorkForSeam.id } });
  assert.strictEqual(checkSeamWorkDeleted, null, '回收站作品经统一 primitive 彻底物理清理');

  // 6.3 Guest manual trash 形态通过 executeStoryWorkPhysicalDelete 删除
  const guestSeamWork1 = await prisma.guestStoryWork.create({
    data: {
      guestId: `g_seam_${tag}`,
      prompt: 'Guest seam trash prompt',
      storyText: 'Guest seam trash text',
      title: 'Guest Seam Trash',
      contentHash: `hash_g_seam_1_${tag}`,
      deletedAt: new Date(),
    },
  });
  const delGuestTrashRes = await executeStoryWorkPhysicalDelete({
    target: 'guest',
    reason: 'trash',
    where: {
      id: guestSeamWork1.id,
      guestId: `g_seam_${tag}`,
      deletedAt: { not: null },
    },
  });
  assert.strictEqual(delGuestTrashRes.count, 1);
  const checkGuestSeam1 = await prisma.guestStoryWork.findUnique({ where: { id: guestSeamWork1.id } });
  assert.strictEqual(checkGuestSeam1, null, 'Guest 回收站作品经 reason: trash 物理清理');

  // 6.4 Guest retention 形态通过 executeStoryWorkPhysicalDelete 删除
  const guestSeamWork2 = await prisma.guestStoryWork.create({
    data: {
      guestId: `g_seam_${tag}`,
      prompt: 'Guest seam retention prompt',
      storyText: 'Guest seam retention text',
      title: 'Guest Seam Retention',
      contentHash: `hash_g_seam_2_${tag}`,
      createdAt: thirtyFiveDaysAgo,
      updatedAt: thirtyFiveDaysAgo,
      deletedAt: null,
    },
  });
  const delGuestRetRes = await executeStoryWorkPhysicalDelete({
    target: 'guest',
    reason: 'retention',
    where: {
      id: guestSeamWork2.id,
      guestId: `g_seam_${tag}`,
      updatedAt: { lt: guestCutoff },
    },
  });
  assert.strictEqual(delGuestRetRes.count, 1);
  const checkGuestSeam2 = await prisma.guestStoryWork.findUnique({ where: { id: guestSeamWork2.id } });
  assert.strictEqual(checkGuestSeam2, null, 'Guest 过期作品经 reason: retention 物理清理');

  console.log('PASS: 统一物理删除 primitive (executeStoryWorkPhysicalDelete / M8 Seam) 3 种契约形态验证通过');

  console.log('=== 7. 边界条件与幂等性校验 ===');
  // 7.1 重复调用 purgeExpiredUserTrash
  const dupPurge1 = await purgeExpiredUserTrash(baseTime);
  const dupPurge2 = await purgeExpiredUserTrash(baseTime);
  assert.strictEqual(dupPurge1.purged, 0);
  assert.strictEqual(dupPurge2.purged, 0);

  // 7.2 重复调用 purgeExpiredGuestData
  const dupGc1 = await purgeExpiredGuestData(guestCutoff);
  const dupGc2 = await purgeExpiredGuestData(guestCutoff);
  assert.strictEqual(dupGc1.generationsDeleted, 0);
  assert.strictEqual(dupGc2.generationsDeleted, 0);
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
