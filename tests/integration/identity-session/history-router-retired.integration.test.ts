/**
 * M9-C1 T2 行为级 RED/GREEN oracle：根 Router 不再暴露 Prompt/Generation History 过程。
 *
 * 在基线 cdbf5d3 上 appRouter 由真实 router() 组合，含 promptHistory/generationHistory
 * 子 router；T2 退役后根 router record 中必须不存在这两个键。oracle 读取运行期组合结果，
 * 不是文件清单断言。
 */

import assert from 'node:assert';

import { appRouter } from '../../../lib/trpc/routers';

type RouterRecord = Record<string, unknown>;

async function runHistoryRouterRetiredIntegrationTests(): Promise<void> {
  console.log('=== 1. 根 router 不再注册 Prompt/Generation History ===');
  {
    const record = (appRouter as unknown as { _def: { record: RouterRecord } })._def.record;
    assert.strictEqual(
      record.promptHistory,
      undefined,
      'appRouter 不得再注册 promptHistory（基线仍注册）',
    );
    assert.strictEqual(
      record.generationHistory,
      undefined,
      'appRouter 不得再注册 generationHistory（基线仍注册）',
    );
    console.log('PASS: 1');
  }

  console.log('=== 2. 保留的 router 不受退役影响 ===');
  {
    const record = (appRouter as unknown as { _def: { record: RouterRecord } })._def.record;
    for (const key of ['auth', 'config', 'tts', 'agent', 'conversation', 'collection', 'playback', 'library']) {
      assert.ok(record[key], `保留 router 必须存在：${key}`);
    }
    console.log('PASS: 2');
  }

  console.log('ALL HISTORY ROUTER RETIRED INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runHistoryRouterRetiredIntegrationTests()
  .then(() => {
    console.log('ALL HISTORY ROUTER RETIRED INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
