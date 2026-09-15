import assert from 'node:assert';

import {
  CONTINUOUS_WINDOW_COLD_START_MS,
  CONTINUOUS_WINDOW_MAX_MS,
  CONTINUOUS_WINDOW_MIN_MS,
  applyAudioActiveTick,
  canScheduleNext,
  clampWindowMs,
  computeWindowMs,
  createInitialState,
  hasBudgetRemaining,
  hasNextJob,
  isStaleCallback,
  isWithinScheduleWindow,
  reduce,
  recordPrepSample,
  resolveBudgetMs,
} from '../../../lib/continuous-creation/stateMachine';

/**
 * M9-C1 T2 L1：连续创作状态机、预算、调度窗、lookahead=1 与 epoch stale guard。
 * 纯领域断言，不触 DB、不触 store。
 */
async function runContinuousCreationStateMachineUnitTests(): Promise<void> {
  console.log('=== 1. 预算快照 resolveBudgetMs ===');
  {
    assert.strictEqual(resolveBudgetMs(30), 30 * 60000, '30 分钟 → 1800000ms');
    assert.strictEqual(resolveBudgetMs(10.5), 630000, '小数分钟四舍五入');
    assert.strictEqual(resolveBudgetMs(0), null, '0 分钟 = 不限预算');
    assert.strictEqual(resolveBudgetMs(-3), null, '负值 = 不限预算');
    assert.strictEqual(resolveBudgetMs(null), null, 'null = 不限预算');
    assert.strictEqual(resolveBudgetMs(undefined), null, 'undefined = 不限预算');
    assert.strictEqual(resolveBudgetMs(Number.NaN), null, 'NaN = 不限预算');
    console.log('PASS: 1');
  }

  console.log('=== 2. 调度窗 clamp 与移动平均（冷启动 60s，30–120s） ===');
  {
    assert.strictEqual(clampWindowMs(5_000), CONTINUOUS_WINDOW_MIN_MS, '低于下界 clamp 到 30s');
    assert.strictEqual(clampWindowMs(500_000), CONTINUOUS_WINDOW_MAX_MS, '高于上界 clamp 到 120s');
    assert.strictEqual(clampWindowMs(45_000), 45_000, '窗内原样');
    assert.strictEqual(clampWindowMs(Number.NaN), CONTINUOUS_WINDOW_COLD_START_MS, 'NaN → 冷启动');
    assert.strictEqual(computeWindowMs([]), CONTINUOUS_WINDOW_COLD_START_MS, '无样本 = 冷启动 60s');
    assert.strictEqual(computeWindowMs([20_000]), CONTINUOUS_WINDOW_MIN_MS, '单样本 clamp');
    assert.strictEqual(computeWindowMs([60_000, 60_000]), 60_000, '稳定样本保持 60s');
    // EWMA alpha=0.5：40s,80s → 60s。
    assert.strictEqual(computeWindowMs([40_000, 80_000]), 60_000, 'EWMA 0.5 收敛 60s');
    // 大样本被 clamp 到 120s。
    assert.strictEqual(computeWindowMs([300_000, 300_000]), CONTINUOUS_WINDOW_MAX_MS, '大样本 clamp 120s');
    console.log('PASS: 2');
  }

  console.log('=== 3. 初始态默认开启 + 预算快照 ===');
  {
    const state = createInitialState({ budgetMinutes: 30 });
    assert.strictEqual(state.status, 'enabled_idle', '默认 enabled_idle');
    assert.strictEqual(state.enabled, true, '默认开启');
    assert.strictEqual(state.budgetMs, 1_800_000, '预算 = 设置快照');
    assert.strictEqual(state.remainingMs, 1_800_000, '剩余 = 预算');
    assert.strictEqual(state.windowMs, CONTINUOUS_WINDOW_COLD_START_MS, '冷启动窗 60s');
    assert.strictEqual(hasNextJob(state), false, '初始无 next job');
    const bounded = createInitialState({ budgetMinutes: 0 });
    assert.strictEqual(bounded.budgetMs, null, '0 分钟 = 不限预算');
    assert.strictEqual(hasBudgetRemaining(bounded), true, '不限预算视为有效');
    console.log('PASS: 3');
  }

  console.log('=== 4. 调度门 canScheduleNext（enabled/预算/播放/epoch/无 job） ===');
  {
    const state = createInitialState({ budgetMinutes: 30 });
    assert.strictEqual(canScheduleNext(state, { nowPlaying: true, epoch: 0 }), true, '满足条件可调度');
    assert.strictEqual(canScheduleNext(state, { nowPlaying: false, epoch: 0 }), false, '未播放不调度');
    assert.strictEqual(canScheduleNext(state, { nowPlaying: true, epoch: 1 }), false, 'epoch 失配不调度');
    assert.strictEqual(
      canScheduleNext(reduce(state, { type: 'disable' }), { nowPlaying: true, epoch: 0 }),
      false,
      'disabled 不调度',
    );
    const generating = reduce(state, { type: 'schedule' });
    assert.strictEqual(hasNextJob(generating), true, 'schedule 后占用唯一槽位');
    assert.strictEqual(canScheduleNext(generating, { nowPlaying: true, epoch: 0 }), false, '已有 next job 不重复调度');
    const exhausted = applyAudioActiveTick(state, 1_800_000);
    assert.strictEqual(exhausted.status, 'ended_budget', '预算耗尽 → ended_budget');
    assert.strictEqual(canScheduleNext(exhausted, { nowPlaying: true, epoch: 0 }), false, '耗尽不调度');
    console.log('PASS: 4');
  }

  console.log('=== 5. lookahead=1：重复 schedule 幂等 no-op ===');
  {
    const state = createInitialState({ budgetMinutes: 30 });
    const once = reduce(state, { type: 'schedule' });
    const twice = reduce(once, { type: 'schedule' });
    assert.strictEqual(twice, once, '第二次 schedule 必须 no-op（严格 lookahead=1）');
    console.log('PASS: 5');
  }

  console.log('=== 6. 正向状态链 generating → preparing → next_ready → consumed ===');
  {
    let state = createInitialState({ budgetMinutes: 30 });
    state = reduce(state, { type: 'schedule' });
    assert.strictEqual(state.status, 'generating_next', 'schedule → generating_next');
    state = reduce(state, { type: 'audioPreparing' });
    assert.strictEqual(state.status, 'preparing_audio', 'audioPreparing → preparing_audio');
    state = reduce(state, { type: 'audioReady', prepMs: 45_000 });
    assert.strictEqual(state.status, 'next_ready', 'audioReady → next_ready');
    assert.deepStrictEqual(state.prepSamplesMs, [45_000], '记录准备耗时样本');
    assert.strictEqual(state.windowMs, 45_000, '窗口更新为 EWMA clamp 结果');
    state = reduce(state, { type: 'trackEnded', hasReadyNext: true });
    assert.strictEqual(state.status, 'enabled_idle', '有 ready next：自动续播回到 idle');
    console.log('PASS: 6');
  }

  console.log('=== 7. waiting_next：无 ready next 不扣预算 ===');
  {
    const state = createInitialState({ budgetMinutes: 30 });
    const waiting = reduce(state, { type: 'trackEnded', hasReadyNext: false });
    assert.strictEqual(waiting.status, 'waiting_next', '无 ready next → waiting_next');
    const ticked = applyAudioActiveTick(waiting, 10_000);
    assert.strictEqual(ticked.remainingMs, 1_800_000, 'waiting_next 期间不扣预算');
    assert.strictEqual(ticked, waiting, 'waiting_next tick 必须 no-op');
    console.log('PASS: 7');
  }

  console.log('=== 8. 预算只在 audioActive 递减，耗尽 terminal ===');
  {
    const state = createInitialState({ budgetMinutes: 1 });
    assert.strictEqual(state.remainingMs, 60_000, '1 分钟 = 60000ms');
    const partial = applyAudioActiveTick(state, 25_000);
    assert.strictEqual(partial.remainingMs, 35_000, '按 delta 递减');
    assert.strictEqual(partial.status, 'enabled_idle', '未耗尽仍 idle');
    const zeroDelta = applyAudioActiveTick(partial, 0);
    assert.strictEqual(zeroDelta, partial, '非正 delta no-op（生成/缓冲不上报）');
    const exhausted = applyAudioActiveTick(partial, 60_000);
    assert.strictEqual(exhausted.remainingMs, 0, '耗尽归一 0');
    assert.strictEqual(exhausted.status, 'ended_budget', '耗尽 → ended_budget');
    const afterExhaust = applyAudioActiveTick(exhausted, 5_000);
    assert.strictEqual(afterExhaust, exhausted, 'terminal 后不再递减');
    assert.strictEqual(
      reduce(exhausted, { type: 'schedule' }).status,
      'ended_budget',
      '耗尽后不得再调度',
    );
    console.log('PASS: 8');
  }

  console.log('=== 9. 关闭/暂停/切换集合（epoch）停止续作 ===');
  {
    const generating = reduce(createInitialState({ budgetMinutes: 30 }), { type: 'schedule' });
    const disabled = reduce(generating, { type: 'disable' });
    assert.strictEqual(disabled.status, 'disabled', 'disable → disabled');
    assert.strictEqual(hasNextJob(disabled), false, 'disable 清除 next job');
    assert.strictEqual(disabled.enabled, false, 'enabled 意图关闭');
    const reEnabled = reduce(disabled, { type: 'enable' });
    assert.strictEqual(reEnabled.status, 'enabled_idle', 'enable 恢复 idle');

    const advanced = reduce(generating, { type: 'advanceEpoch' });
    assert.strictEqual(advanced.epoch, generating.epoch + 1, 'advanceEpoch 递增 epoch');
    assert.strictEqual(hasNextJob(advanced), false, 'advanceEpoch 清除 next job');
    assert.strictEqual(advanced.status, 'enabled_idle', 'advanceEpoch 回到 idle');

    const reset = reduce(generating, { type: 'reset', epoch: 7, budgetMinutes: 15 });
    assert.strictEqual(reset.epoch, 7, 'reset 设置新 epoch');
    assert.strictEqual(reset.budgetMs, 900_000, 'reset 重新快照预算');
    assert.strictEqual(reset.remainingMs, 900_000, 'reset 重置剩余');
    assert.strictEqual(reset.status, 'enabled_idle', 'reset 回初始态');
    assert.deepStrictEqual(reset.prepSamplesMs, [], 'reset 清空窗口样本');
    console.log('PASS: 9');
  }

  console.log('=== 10. epoch stale guard ===');
  {
    const state = createInitialState({ budgetMinutes: 30, epoch: 3 });
    assert.strictEqual(isStaleCallback(state, 3), false, '同 epoch 非 stale');
    assert.strictEqual(isStaleCallback(state, 2), true, '旧 epoch stale');
    assert.strictEqual(isStaleCallback(state, 4), true, '未来 epoch stale');
    console.log('PASS: 10');
  }

  console.log('=== 11. 失败态与恢复 ===');
  {
    const generating = reduce(createInitialState({ budgetMinutes: 30 }), { type: 'schedule' });
    const failed = reduce(generating, { type: 'generationFailed', error: 'boom' });
    assert.strictEqual(failed.status, 'error', 'generationFailed → error');
    assert.strictEqual(failed.lastError, 'boom', '记录错误文案');
    const recovered = reduce(failed, { type: 'enable' });
    assert.strictEqual(recovered.status, 'enabled_idle', 'enable 从 error 恢复');
    assert.strictEqual(recovered.lastError, null, '恢复清错误');
    console.log('PASS: 11');
  }

  console.log('=== 12. 窗口样本与 within-window 判定 ===');
  {
    let state = createInitialState({ budgetMinutes: 30 });
    state = recordPrepSample(state, 90_000);
    assert.strictEqual(state.windowMs, 90_000, '单样本窗口 90s');
    state = recordPrepSample(state, 10_000);
    assert.strictEqual(state.windowMs, 50_000, 'EWMA 0.5：90000/10000 → 50000（窗内）');
    assert.deepStrictEqual(state.prepSamplesMs, [90_000, 10_000], '样本累积');
    assert.strictEqual(isWithinScheduleWindow(30_000, state.windowMs), true, '剩余 30s 进入 50s 窗');
    assert.strictEqual(isWithinScheduleWindow(50_000, state.windowMs), true, '剩余恰等于窗 → 进入');
    assert.strictEqual(isWithinScheduleWindow(50_001, state.windowMs), false, '剩余超窗未进入');
    assert.strictEqual(isWithinScheduleWindow(Number.NaN, state.windowMs), false, 'NaN 不进入窗');
    console.log('PASS: 12');
  }

  console.log('ALL CONTINUOUS CREATION STATE MACHINE UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runContinuousCreationStateMachineUnitTests()
  .then(() => {
    console.log('ALL CONTINUOUS CREATION STATE MACHINE UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
