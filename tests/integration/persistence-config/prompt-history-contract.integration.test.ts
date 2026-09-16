/**
 * M9-C1 T4 行为级 RED/GREEN oracle：PromptHistory contract migration。
 *
 * T2 已停止一切 user PromptHistory 新写且零读取；T4 contract 允许删除该物理表
 * （GuestPromptHistory 因 guestGc 依赖保留；StoryWorkMigration 风险转移表保留；
 * GenerationHistory/GuestGenerationHistory 作品物理表保留；旧 Segment 表保留）。
 * 本套件直查隔离库 sqlite_master 断言表级契约：基线（未执行 contract）必然因
 * PromptHistory 仍存在而红。
 */

import assert from 'node:assert';

import { prisma } from '../../../lib/db';

async function tableExists(name: string): Promise<boolean> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`,
  )) as Array<{ name: string }>;
  return rows.length > 0;
}

async function runPromptHistoryContractTests(): Promise<void> {
  console.log('=== 1. contract 已执行：PromptHistory 物理表消失 ===');
  {
    const gone = !(await tableExists('PromptHistory'));
    assert.ok(gone, 'T4 contract 后 PromptHistory 表必须不存在');
    console.log('PASS: 1');
  }

  console.log('=== 2. 收缩边界：其余表一律保留 ===');
  {
    assert.ok(await tableExists('GuestPromptHistory'), 'guestGc 依赖 GuestPromptHistory，必须保留');
    assert.ok(await tableExists('StoryWorkMigration'), 'T2 风险转移表必须保留');
    assert.ok(await tableExists('GenerationHistory'), '作品物理表必须保留（零作品删除）');
    assert.ok(
      await tableExists('GuestGenerationHistory'),
      '访客作品物理表必须保留（零作品删除）',
    );
    assert.ok(await tableExists('StoryAudioSegment'), '旧 Segment 表必须保留（T3 观察期）');
    assert.ok(await tableExists('StoryCollection'), '集合表必须存在');
    console.log('PASS: 2');
  }

  console.log('ALL PROMPT HISTORY CONTRACT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runPromptHistoryContractTests().catch((err) => {
  console.error('prompt-history-contract test crashed:', err);
  process.exit(1);
});

export default testPromise;
