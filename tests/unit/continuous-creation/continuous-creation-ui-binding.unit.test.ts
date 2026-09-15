import assert from 'node:assert';

import {
  CONTINUOUS_CREATION_STATUS_LABEL,
  formatRemainingMs,
  useContinuousCreationStore,
} from '../../../stores/continuousCreationStore';

/**
 * M9-C1 T2 L1：连续创作 store 绑定（状态卡/开关/剩余预算/epoch）。
 * 不触 DB、不触网络。
 */
async function runContinuousCreationUiBindingUnitTests(): Promise<void> {
  const store = useContinuousCreationStore;

  console.log('=== 1. 默认开启与状态标签 ===');
  {
    store.getState().reset();
    const state = store.getState();
    assert.strictEqual(state.enabled, true, '默认开启');
    assert.strictEqual(state.status, 'enabled_idle', '默认 enabled_idle');
    assert.strictEqual(state.collectionId, null, '初始无集合');
    assert.strictEqual(CONTINUOUS_CREATION_STATUS_LABEL.enabled_idle, '连续创作已开启', '标签映射');
    assert.strictEqual(CONTINUOUS_CREATION_STATUS_LABEL.ended_budget, '播放预算已用完', '耗尽标签');
    assert.strictEqual(CONTINUOUS_CREATION_STATUS_LABEL.waiting_next, '等待下一集', '等待标签');
    console.log('PASS: 1');
  }

  console.log('=== 2. 新建创作重置：预算快照 + epoch ===');
  {
    store.getState().reset();
    store.getState().resetForNewCreation({ collectionId: 'col-1', budgetMinutes: 30, epoch: 5 });
    const state = store.getState();
    assert.strictEqual(state.collectionId, 'col-1', '集合身份写入');
    assert.strictEqual(state.epoch, 5, 'epoch 写入');
    assert.strictEqual(state.budgetMs, 1_800_000, '预算快照');
    assert.strictEqual(state.remainingMs, 1_800_000, '剩余 = 预算');
    assert.strictEqual(state.status, 'enabled_idle', '回初始态');
    console.log('PASS: 2');
  }

  console.log('=== 3. 开关与调度门 ===');
  {
    store.getState().reset();
    store.getState().resetForNewCreation({ collectionId: 'col-1', budgetMinutes: 30, epoch: 1 });
    assert.strictEqual(store.getState().canSchedule({ nowPlaying: true, epoch: 1 }), true, '满足条件可调度');
    assert.strictEqual(store.getState().canSchedule({ nowPlaying: false, epoch: 1 }), false, '未播放不调度');
    assert.strictEqual(store.getState().canSchedule({ nowPlaying: true, epoch: 2 }), false, 'epoch 失配不调度');
    store.getState().disable();
    assert.strictEqual(store.getState().status, 'disabled', '关闭 → disabled');
    assert.strictEqual(store.getState().canSchedule({ nowPlaying: true, epoch: 1 }), false, '关闭不调度');
    store.getState().enable();
    assert.strictEqual(store.getState().status, 'enabled_idle', '重新开启');
    console.log('PASS: 3');
  }

  console.log('=== 4. lookahead=1 + 状态链 ===');
  {
    store.getState().reset();
    store.getState().resetForNewCreation({ collectionId: 'col-1', budgetMinutes: 30, epoch: 1 });
    assert.strictEqual(store.getState().schedule(), true, '首次调度接受');
    assert.strictEqual(store.getState().status, 'generating_next', 'schedule → generating_next');
    assert.strictEqual(store.getState().hasNextJob(), true, '占用 next job');
    assert.strictEqual(store.getState().schedule(), false, '重复调度拒绝（lookahead=1）');
    store.getState().audioPreparing();
    assert.strictEqual(store.getState().status, 'preparing_audio', 'audioPreparing');
    store.getState().audioReady(45_000);
    assert.strictEqual(store.getState().status, 'next_ready', 'audioReady');
    assert.strictEqual(store.getState().windowMs, 45_000, '窗口记录样本');
    store.getState().trackEnded(true);
    assert.strictEqual(store.getState().status, 'enabled_idle', 'ready 自动续播回 idle');
    console.log('PASS: 4');
  }

  console.log('=== 5. waiting_next 不扣预算 + 预算耗尽 ===');
  {
    store.getState().reset();
    store.getState().resetForNewCreation({ collectionId: 'col-1', budgetMinutes: 1, epoch: 1 });
    store.getState().trackEnded(false);
    assert.strictEqual(store.getState().status, 'waiting_next', '无 ready → waiting_next');
    store.getState().audioActiveTick(30_000);
    assert.strictEqual(store.getState().remainingMs, 60_000, 'waiting_next 不扣预算');
    store.getState().nextConsumed();
    assert.strictEqual(store.getState().status, 'enabled_idle', 'nextConsumed 回 idle');
    store.getState().audioActiveTick(60_000);
    assert.strictEqual(store.getState().status, 'ended_budget', '耗尽 → ended_budget');
    assert.strictEqual(store.getState().remainingMs, 0, '剩余归一 0');
    assert.strictEqual(store.getState().schedule(), false, '耗尽不再调度');
    console.log('PASS: 5');
  }

  console.log('=== 6. epoch / 切换集合 stale guard ===');
  {
    store.getState().reset();
    store.getState().resetForNewCreation({ collectionId: 'col-1', budgetMinutes: 30, epoch: 10 });
    assert.strictEqual(store.getState().isStale(10), false, '同 epoch 非 stale');
    assert.strictEqual(store.getState().isStale(9), true, '旧 epoch stale');
    store.getState().schedule();
    assert.strictEqual(store.getState().hasNextJob(), true, '有 next job');
    const nextEpoch = store.getState().advanceEpoch();
    assert.strictEqual(nextEpoch, 11, 'advanceEpoch 递增');
    assert.strictEqual(store.getState().hasNextJob(), false, 'advanceEpoch 清 next job');
    const switchEpoch = store.getState().switchCollection('col-2');
    assert.strictEqual(store.getState().collectionId, 'col-2', '切换集合');
    assert.strictEqual(switchEpoch, 12, '切换集合递增 epoch');
    assert.strictEqual(store.getState().isStale(11), true, '切换后旧 epoch stale');
    console.log('PASS: 6');
  }

  console.log('=== 7. 剩余预算格式化 ===');
  {
    assert.strictEqual(formatRemainingMs(null), '不限', 'null = 不限');
    assert.strictEqual(formatRemainingMs(0), '00:00', '0');
    assert.strictEqual(formatRemainingMs(65_000), '01:05', '65s → 01:05');
    assert.strictEqual(formatRemainingMs(3_600_000), '60:00', '60 分钟');
    console.log('PASS: 7');
  }

  console.log('=== 8. UI 组件与 store 同源（静态） ===');
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const repoRoot = process.cwd();
    const componentPath = path.join(
      repoRoot,
      'app/(main)/chat/components/ContinuousCreationBar/index.tsx',
    );
    assert.ok(fs.existsSync(componentPath), '状态卡组件必须存在');
    const source = fs.readFileSync(componentPath, 'utf8');
    assert.ok(source.includes('useContinuousCreationStore'), '状态卡必须订阅连续创作 store');
    assert.ok(
      source.includes('CONTINUOUS_CREATION_STATUS_LABEL'),
      '状态卡文案必须来自 store 标签映射（同源）',
    );
    assert.ok(source.includes('formatRemainingMs'), '状态卡必须消费剩余预算格式化');
    assert.ok(source.includes('aria-label'), '开关必须有可访问名称');
    console.log('PASS: 8');
  }

  console.log('ALL CONTINUOUS CREATION UI BINDING UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runContinuousCreationUiBindingUnitTests()
  .then(() => {
    console.log('ALL CONTINUOUS CREATION UI BINDING UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
