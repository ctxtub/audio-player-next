/**
 * Legacy generationHistory 兼容割接集成测试（M2-07）
 *
 * 验收矩阵：
 * 1. 连续 legacy record 150 条后，第 1 条数据库记录仍存在（逐 id / 关键字段严格断言，不可仅断言 count）；
 * 2. legacy list（读取）：严格限制返回最近 50 条展示窗口，但纯为展示兼容语义，不承担数据保留或裁剪职责；
 * 3. legacy record（写入）：委托 createStoryWorkForSubject(..., sourceMessageId: null)，
 *    不参与消息幂等、允许相同内容重复创建独立作品，自动权威派生 title/excerpt/contentHash；
 * 4. 旧写链彻底无 KEEP_LIMIT=100 与 delete-oldest 逻辑残留（静态源码扫描断言）；
 * 5. legacy remove（删除）：从物理 delete 切换为 moveToTrash 软删除（deletedAt 非空、行仍保留在库）；
 * 6. User 与 Guest 主体双向完全同构对称，防越权与跨主体隔离严格生效；
 * 7. /player 旧 DTO 与契约不破坏（id/prompt/storyText/voiceId/createdAt 字段完全保真）。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../lib/db';
import type { Subject } from '../../../lib/server/subject';
import {
  listGenerationHistory,
  recordGenerationHistory,
  removeGenerationHistory,
  listGenerationHistoryForSubject,
  recordGenerationHistoryForSubject,
  removeGenerationHistoryForSubject,
} from '../../../lib/server/generationHistory';
import { generationHistoryDtoSchema } from '../../../lib/trpc/schemas/generationHistory';

async function runLegacyGenerationHistoryCutoverTests() {
  console.log('=== 1. 连续 legacy record 150 条后，第 1 条数据库记录仍存在（User 主体）===');
  const userTag = Date.now();
  const testUser = await prisma.user.create({
    data: {
      username: `u_cutover_150_${userTag}`,
      password: 'Password123!',
      nickname: 'CutoverTester150',
    },
  });
  const userSubject: Subject = { type: 'user', id: testUser.id };

  // 1.1 写入第 1 条
  const firstRecord = await recordGenerationHistory(testUser.id, {
    prompt: '故事001：森林里的小熊',
    storyText: '# 小熊的蜂蜜罐\n小熊在深山里找到了一罐神奇的蜂蜜，散发着七彩的光芒。',
    voiceId: 'alloy',
  });

  // 验证返回 DTO 契约
  assert.strictEqual(firstRecord.prompt, '故事001：森林里的小熊');
  assert.strictEqual(firstRecord.storyText, '# 小熊的蜂蜜罐\n小熊在深山里找到了一罐神奇的蜂蜜，散发着七彩的光芒。');
  assert.strictEqual(firstRecord.voiceId, 'alloy');
  assert.ok(typeof firstRecord.id === 'number' && firstRecord.id > 0);
  assert.ok(typeof firstRecord.createdAt === 'string' && !isNaN(Date.parse(firstRecord.createdAt)));
  generationHistoryDtoSchema.parse(firstRecord);

  // 记录关键锚点记录
  const milestoneRecords: Record<number, { id: number; prompt: string; storyText: string }> = {
    1: { id: firstRecord.id, prompt: firstRecord.prompt, storyText: firstRecord.storyText },
  };

  // 1.2 连续追加写至 150 条
  for (let i = 2; i <= 150; i++) {
    const pad = String(i).padStart(3, '0');
    const rec = await recordGenerationHistory(testUser.id, {
      prompt: `故事${pad}：编号${i}的奇妙冒险`,
      storyText: `故事正文段落${i}：在遥远的第${i}个星球上，小探险家遇到了奇妙的星际旅人……`,
      voiceId: i % 2 === 0 ? 'echo' : 'fable',
    });

    if (i === 50 || i === 100 || i === 101 || i === 150) {
      milestoneRecords[i] = { id: rec.id, prompt: rec.prompt, storyText: rec.storyText };
    }
  }

  // 1.3 数据库全量检查：必须完整存在 150 条记录（未被任何 100 条硬裁剪拦截）
  const userStoryCount = await prisma.storyWork.count({
    where: { userId: testUser.id },
  });
  assert.strictEqual(userStoryCount, 150, '数据库中该用户的作品总数必须严格等于 150（无容量裁剪）');

  // 1.4 逐 ID 与关键字段严格断言：第 1 条数据库记录仍完好存在！
  const dbRow1 = await prisma.storyWork.findUnique({
    where: { id: milestoneRecords[1].id },
  });
  assert(dbRow1 !== null, '第 1 条数据库记录必须仍存在于主数据库中（未被 delete-oldest 剔除）');
  assert.strictEqual(dbRow1.id, milestoneRecords[1].id);
  assert.strictEqual(dbRow1.userId, testUser.id);
  assert.strictEqual(dbRow1.prompt, '故事001：森林里的小熊');
  assert.strictEqual(dbRow1.storyText, '# 小熊的蜂蜜罐\n小熊在深山里找到了一罐神奇的蜂蜜，散发着七彩的光芒。');
  assert.strictEqual(dbRow1.voiceId, 'alloy');
  assert.strictEqual(dbRow1.deletedAt, null, '第 1 条记录必须处于活跃态（deletedAt 为 null）');
  assert.strictEqual(dbRow1.sourceMessageId, null, '兼容创建路径 sourceMessageId 必须为 null');
  // 验证 M2-02 派生元数据字段均被权威补齐
  assert.ok(dbRow1.title.length > 0, '权威标题必须由服务端派生');
  assert.ok(dbRow1.excerpt.length > 0, '权威摘要必须由服务端派生');
  assert.ok(dbRow1.contentHash.length > 0, '正文内容哈希必须由服务端权威计算');

  // 逐 ID 验证中间锚点记录（50, 100, 150）均在库
  for (const idx of [50, 100, 150]) {
    const row = await prisma.storyWork.findUnique({
      where: { id: milestoneRecords[idx].id },
    });
    assert(row !== null, `第 ${idx} 条记录必须在库`);
    assert.strictEqual(row.prompt, milestoneRecords[idx].prompt);
    assert.strictEqual(row.storyText, milestoneRecords[idx].storyText);
    assert.strictEqual(row.deletedAt, null);
  }

  // 1.5 legacy list 展示兼容窗口断言：仅返回最近 50 条，但数据未受裁剪影响
  const displayList = await listGenerationHistory(testUser.id);
  assert.strictEqual(displayList.length, 50, 'legacy list 必须按展示兼容语义返回最近 50 条');
  assert.strictEqual(displayList[0].id, milestoneRecords[150].id, '最新一条（第 150 条）位于列表首位');
  assert.strictEqual(displayList[49].id, milestoneRecords[101].id, '列表第 50 项为第 101 条');
  for (const item of displayList) {
    generationHistoryDtoSchema.parse(item);
  }
  console.log('PASS: 1. 连续写入 150 条后第 1 条数据库记录完好存在，全字段断言与 50 条展示兼容窗口通过');

  console.log('=== 2. 旧写链无 KEEP_LIMIT / delete-oldest 残留（静态扫描断言）===');
  const repoRoot = process.cwd();
  const writeChainFiles = [
    path.join(repoRoot, 'lib/server/generationHistory.ts'),
    path.join(repoRoot, 'lib/trpc/routers/generationHistory.ts'),
    path.join(repoRoot, 'lib/client/generationHistory.ts'),
    path.join(repoRoot, 'stores/generationHistoryStore.ts'),
    path.join(repoRoot, 'app/services/chatFlow.ts'),
  ];

  for (const filePath of writeChainFiles) {
    assert.ok(fs.existsSync(filePath), `文件必须存在：${filePath}`);
    const content = fs.readFileSync(filePath, 'utf-8');

    // 严禁生产写链中出现 KEEP_LIMIT
    const keepLimitMatch = content.match(/KEEP_LIMIT/i);
    assert.strictEqual(
      keepLimitMatch,
      null,
      `写链文件 ${path.relative(repoRoot, filePath)} 严禁出现 KEEP_LIMIT`
    );

    // 严禁生产写链中出现 delete-oldest
    const deleteOldestMatch = content.match(/delete-oldest/i);
    assert.strictEqual(
      deleteOldestMatch,
      null,
      `写链文件 ${path.relative(repoRoot, filePath)} 严禁出现 delete-oldest`
    );
  }

  // 专门对 lib/server/generationHistory.ts 断言无任何裁剪性 deleteMany 语句
  const serverGenContent = fs.readFileSync(path.join(repoRoot, 'lib/server/generationHistory.ts'), 'utf-8');
  assert.ok(
    !serverGenContent.includes('deleteMany'),
    'lib/server/generationHistory.ts 不得再包含 deleteMany 物理裁剪或物理删除'
  );
  console.log('PASS: 2. 生产旧写链 5 个关键源码文件无 KEEP_LIMIT / delete-oldest 静态扫描断言通过');

  console.log('=== 3. legacy remove → Trash 软删除（deletedAt 非空、行仍保留）===');
  const removeTarget = await recordGenerationHistory(testUser.id, {
    prompt: '待软删除测试提示词',
    storyText: '待软删除的故事正文，验证被移入回收站后物理记录依然在库。',
    voiceId: 'alloy',
  });

  // 删除前确认 deletedAt 为 null
  const preRemoveRow = await prisma.storyWork.findUnique({
    where: { id: removeTarget.id },
  });
  assert(preRemoveRow !== null);
  assert.strictEqual(preRemoveRow.deletedAt, null);

  const countBeforeRemove = await prisma.storyWork.count({
    where: { userId: testUser.id },
  });

  // 执行 legacy remove
  await removeGenerationHistory(testUser.id, removeTarget.id);

  // 3.1 物理行仍在库（count 不减少）
  const countAfterRemove = await prisma.storyWork.count({
    where: { userId: testUser.id },
  });
  assert.strictEqual(
    countAfterRemove,
    countBeforeRemove,
    'legacy remove 严禁物理删除数据行，数据库行总数不得减少'
  );

  // 3.2 deletedAt 已被设置为当前时间（非空）
  const postRemoveRow = await prisma.storyWork.findUnique({
    where: { id: removeTarget.id },
  });
  assert(postRemoveRow !== null, '软删除后数据行在库中仍完整可查');
  assert(postRemoveRow.deletedAt instanceof Date, 'deletedAt 必须为 Date 对象');
  assert.ok(!isNaN(postRemoveRow.deletedAt.getTime()), 'deletedAt 必须为有效时间戳');

  // 3.3 legacy list 不再出现已软删除的记录（展示端不可见）
  const listAfterRemove = await listGenerationHistory(testUser.id);
  const foundInList = listAfterRemove.some((r) => r.id === removeTarget.id);
  assert.strictEqual(foundInList, false, '被移入回收站的作品严禁出现在 legacy list 活跃列表中');

  // 3.4 幂等删除：对已软删除的作品再次调用 remove 不报错、不刷新原 deletedAt
  const originalDeletedAt = postRemoveRow.deletedAt.getTime();
  await removeGenerationHistory(testUser.id, removeTarget.id);
  const recheckedRow = await prisma.storyWork.findUnique({
    where: { id: removeTarget.id },
  });
  assert(recheckedRow !== null);
  assert.strictEqual(recheckedRow.deletedAt?.getTime(), originalDeletedAt, '重复 remove 必须幂等且不刷新 deletedAt');

  // 3.5 越权与不存在 ID 防御：静默忽略、不影响其他用户记录
  const otherUser = await prisma.user.create({
    data: {
      username: `u_cutover_other_${userTag}`,
      password: 'Password123!',
      nickname: 'OtherUser',
    },
  });
  await removeGenerationHistory(otherUser.id, removeTarget.id);
  const untamperedRow = await prisma.storyWork.findUnique({
    where: { id: removeTarget.id },
  });
  assert(untamperedRow !== null);
  assert.strictEqual(untamperedRow.userId, testUser.id, '跨主体 remove 不得篡改或影响原主记录');

  // 对不存在的 ID 调用不抛未处理异常
  await removeGenerationHistory(testUser.id, 999999999);
  console.log('PASS: 3. legacy remove → Trash 软删除、行留存、时间戳写入与幂等安全验证通过');

  console.log('=== 4. Guest 具名访客主体同构对称性与独立可重复创建 ===');
  const guestTag = `g_cutover_${Date.now()}`;
  const guestSubject: Subject = { type: 'guest', id: guestTag };

  // 4.1 访客可连续创建，sourceMessageId: null 允许完全相同的内容多次创建独立作品
  const guestRec1 = await recordGenerationHistoryForSubject(guestSubject, {
    prompt: '相同提示词重复生成',
    storyText: '相同正文文本：小松鼠在树洞里储存了松果。',
    voiceId: 'alloy',
  });
  const guestRec2 = await recordGenerationHistoryForSubject(guestSubject, {
    prompt: '相同提示词重复生成',
    storyText: '相同正文文本：小松鼠在树洞里储存了松果。',
    voiceId: 'alloy',
  });

  assert.notStrictEqual(guestRec1.id, guestRec2.id, 'sourceMessageId 为 null 时相同正文必须生成两个独立作品');
  const guestDbCount = await prisma.guestStoryWork.count({
    where: { guestId: guestTag },
  });
  assert.strictEqual(guestDbCount, 2, '两部作品必须全部落盘');

  // 4.2 访客连续写入 150 条后第 1 条依然存在
  const firstGuestRec = await recordGenerationHistoryForSubject(guestSubject, {
    prompt: '访客第1条',
    storyText: '访客第1条正文：海龟慢慢爬向大海。',
  });

  for (let i = 2; i <= 150; i++) {
    await recordGenerationHistoryForSubject(guestSubject, {
      prompt: `访客生成${i}`,
      storyText: `访客正文${i}：内容详情测试保留。`,
    });
  }

  const guestTotalCount = await prisma.guestStoryWork.count({
    where: { guestId: guestTag },
  });
  assert.strictEqual(guestTotalCount, 152, '访客作品全部留存，无任何容量裁剪');

  const guestRow1 = await prisma.guestStoryWork.findUnique({
    where: { id: firstGuestRec.id },
  });
  assert(guestRow1 !== null, '访客第 1 条数据库记录在 150 次写入后必须完好存在');
  assert.strictEqual(guestRow1.guestId, guestTag);
  assert.strictEqual(guestRow1.prompt, '访客第1条');
  assert.strictEqual(guestRow1.deletedAt, null);

  // 4.3 访客 soft delete
  await removeGenerationHistoryForSubject(guestSubject, firstGuestRec.id);
  const guestRow1AfterTrash = await prisma.guestStoryWork.findUnique({
    where: { id: firstGuestRec.id },
  });
  assert(guestRow1AfterTrash !== null, '访客作品在软删除后行依然保留');
  assert(guestRow1AfterTrash.deletedAt instanceof Date, '访客作品 deletedAt 必须非空');

  const guestListAfterTrash = await listGenerationHistoryForSubject(guestSubject);
  assert(!guestListAfterTrash.some((r) => r.id === firstGuestRec.id), '访客列表不再展示软删除记录');
  assert.strictEqual(guestListAfterTrash.length, 50, '访客展示列表上限为 50 条');

  console.log('PASS: 4. Guest 访客同构对称、可重复创建与软删除全部验证通过');
}

runLegacyGenerationHistoryCutoverTests()
  .then(() => {
    console.log('ALL LEGACY GENERATION HISTORY CUTOVER TESTS PASSED');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
