/**
 * M9-C1 T2 行为级 RED/GREEN oracle：注册迁移不得再复制 Prompt History。
 *
 * 在基线 cdbf5d3 上，migrateGuestCreativeRecordsToUser 会把访客 Prompt History
 * 拷贝到新用户（真实服务路径）；T2 停迁移后 user PromptHistory 必须恒为 0 行。
 * 本 oracle 驱动真实迁移服务并断言新契约，基线必然因旧行为不符而红。
 */

import assert from 'node:assert';

import { prisma } from '../../../lib/db';
import { migrateGuestCreativeRecordsToUser } from '../../../lib/server/unifiedMigration';

async function runHistoryStopMigrateIntegrationTests(): Promise<void> {
  const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  console.log('=== 1. 注册迁移不得复制 Prompt History（T2 停迁移） ===');
  {
    const guestId = `guest_hsm_${tag}`;
    await prisma.guestPromptHistory.create({
      data: {
        guestId,
        prompt: `旧提示词历史_${tag}`,
        lastUsed: new Date(),
      },
    });

    const user = await prisma.user.create({
      data: {
        username: `u_hsm_${tag}`,
        password: 'HashedPassword123!',
        nickname: 'HistoryStopMigrate',
      },
    });

    const result = await migrateGuestCreativeRecordsToUser(guestId, user.id);

    assert.strictEqual(
      result.promptsMigrated,
      0,
      'Prompt History 已退役；迁移计数必须为 0（旧行为会返回 1 条）',
    );

    // M9-C1 T4：user PromptHistory 表已 contract 删除——“0 行”语义升级为“表不存在”。
    const userPromptTables = (await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='PromptHistory'",
    )) as Array<{ name: string }>;
    assert.strictEqual(
      userPromptTables.length,
      0,
      'T4 contract 后 PromptHistory 表必须不存在（旧行为会拷贝访客记录）',
    );

    const guestPromptCount = await prisma.guestPromptHistory.count({ where: { guestId } });
    assert.strictEqual(guestPromptCount, 1, 'Guest 原行保留给 GC，不做物理删除');

    console.log('PASS: 1');
  }

  console.log('=== 2. 迁移幂等：重复调用仍不产生 Prompt History ===');
  {
    const guestId = `guest_hsm_idem_${tag}`;
    await prisma.guestPromptHistory.create({
      data: { guestId, prompt: `幂等提示词_${tag}`, lastUsed: new Date() },
    });
    const user = await prisma.user.create({
      data: {
        username: `u_hsm_idem_${tag}`,
        password: 'HashedPassword123!',
        nickname: 'HistoryStopMigrateIdem',
      },
    });

    await migrateGuestCreativeRecordsToUser(guestId, user.id);
    const second = await migrateGuestCreativeRecordsToUser(guestId, user.id);

    assert.strictEqual(second.promptsMigrated, 0, '重复迁移仍为 0');
    // M9-C1 T4：同上，重复迁移亦不得复活该表（表级断言详见 prompt-history-contract 套件）。
    const userPromptTablesAgain = (await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='PromptHistory'",
    )) as Array<{ name: string }>;
    assert.strictEqual(
      userPromptTablesAgain.length,
      0,
      '重复迁移不复活 PromptHistory 表',
    );
    console.log('PASS: 2');
  }

  console.log('ALL HISTORY STOP MIGRATE INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runHistoryStopMigrateIntegrationTests()
  .then(() => {
    console.log('ALL HISTORY STOP MIGRATE INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
