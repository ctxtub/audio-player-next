import assert from 'node:assert';
import {
  mergeRemappedWorkProgress,
  type RemappableWorkProgress,
} from '../../../lib/playback/progress';

/**
 * M5-08 Subject remap 进度合并纯领域单元测试（L1）。
 * 锁定 lib/playback/progress.ts mergeRemappedWorkProgress（spec §31.4 + 任务 4g）：
 * max(next) 取胜（持平取 User 既有）、位置五元组整体取胜者、completedAt 首个非空、
 * lastPlayedAt 取更晚者。纯函数，不触库。
 */

const base: RemappableWorkProgress = {
  contentHash: 'hash_base',
  segmentationVersion: 'v1',
  lastCompletedParagraphIndex: 0,
  nextParagraphIndex: 1,
  totalParagraphs: 6,
  completedAt: null,
  lastPlayedAt: '2026-01-15T00:00:00.000Z',
};

async function runPlaybackSubjectRemapTests(): Promise<void> {
  console.log('=== M5-08: mergeRemappedWorkProgress ===');

  // —— 1. incoming 更完整 → 整体取 incoming ——
  const behind: RemappableWorkProgress = { ...base, completedAt: null };
  const ahead: RemappableWorkProgress = {
    ...base,
    lastCompletedParagraphIndex: 3,
    nextParagraphIndex: 4,
    completedAt: '2026-03-01T00:00:00.000Z',
    lastPlayedAt: '2026-03-02T00:00:00.000Z',
  };
  const m1 = mergeRemappedWorkProgress(behind, ahead);
  assert.strictEqual(m1.nextParagraphIndex, 4, 'guest 更新时推进到 max(next)');
  assert.strictEqual(m1.lastCompletedParagraphIndex, 3, '位置整体取胜者，不拼凑');
  assert.strictEqual(m1.completedAt, '2026-03-01T00:00:00.000Z', '首个非空 completedAt 保留');
  assert.strictEqual(m1.lastPlayedAt, '2026-03-02T00:00:00.000Z', 'lastPlayedAt 取更晚者');
  console.log('PASS: incoming ahead wins');

  // —— 2. existing 更完整 → 保持 existing（含 completedAt 首完） ——
  const existingDone: RemappableWorkProgress = {
    ...base,
    lastCompletedParagraphIndex: 4,
    nextParagraphIndex: 5,
    completedAt: '2026-01-01T00:00:00.000Z',
    lastPlayedAt: '2026-02-01T00:00:00.000Z',
  };
  const incomingStale: RemappableWorkProgress = {
    ...base,
    lastCompletedParagraphIndex: 1,
    nextParagraphIndex: 2,
    completedAt: null,
    lastPlayedAt: '2026-01-20T00:00:00.000Z',
  };
  const m2 = mergeRemappedWorkProgress(existingDone, incomingStale);
  assert.strictEqual(m2.nextParagraphIndex, 5, 'User 更完整时不被覆盖');
  assert.strictEqual(m2.lastCompletedParagraphIndex, 4);
  assert.strictEqual(m2.completedAt, '2026-01-01T00:00:00.000Z', '既有首完保留');
  assert.strictEqual(m2.lastPlayedAt, '2026-02-01T00:00:00.000Z', 'lastPlayedAt 取更晚者（既有）');
  console.log('PASS: existing ahead keeps');

  // —— 3. 持平 → 取 existing（register 重试幂等） ——
  const tieA: RemappableWorkProgress = { ...base, nextParagraphIndex: 2, contentHash: 'h_user' };
  const tieB: RemappableWorkProgress = { ...base, nextParagraphIndex: 2, contentHash: 'h_guest' };
  const m3 = mergeRemappedWorkProgress(tieA, tieB);
  assert.strictEqual(m3.contentHash, 'h_user', '持平取 User 既有');
  assert.strictEqual(m3.nextParagraphIndex, 2);
  console.log('PASS: tie keeps existing');

  // —— 4. 非法 next 输入 fail-safe（NaN/负数按 0 计，不抛错） ——
  const weird: RemappableWorkProgress = { ...base, nextParagraphIndex: NaN };
  const m4 = mergeRemappedWorkProgress(weird, { ...base, nextParagraphIndex: 1 });
  assert.strictEqual(m4.nextParagraphIndex, 1);
  const bothNullTime = mergeRemappedWorkProgress(
    { ...base, lastPlayedAt: null },
    { ...base, lastPlayedAt: 'not-a-date' }
  );
  assert.strictEqual(bothNullTime.lastPlayedAt, null, '双非法时间 → null，不抛错');
  console.log('PASS: invalid input fail-safe');

  console.log('\nALL PLAYBACK SUBJECT REMAP UNIT TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runPlaybackSubjectRemapTests()
  .then(() => {
    console.log('ALL PLAYBACK SUBJECT REMAP UNIT TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
