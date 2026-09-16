/**
 * 连续创作预算停止矩阵 / lookahead=1 / stale guard 集成测试（L2，M9-C1 T2）。
 *
 * case_id: continuous-creation-budget-stop-matrix
 * oracle（docs/e2e/10-会话与作品集连续创作/06-连续创作预算停止矩阵.md）：
 * 1. 预算只在 audio 实际推进时递减；生成/TTS/缓冲/暂停一律不扣；
 * 2. 预算耗尽 → ended_budget，且不再调度、不再扣减；
 * 3. 严格 work lookahead=1：同一时刻至多一个在途/就绪 next；
 * 4. 所有异步回写携带 epoch，stale 一律 no-op；
 * 5. 当前轨结束无 ready next → waiting_next；
 * 6. 用户输入抢占丢弃在途/就绪 next 并作废旧回调。
 *
 * 纯内存 + 注入生成器（不触网）；L2 隔离库由 runner 注入。
 */

import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const cwd = process.cwd();

// ---- GlassToast 桩（与既有 L2 同手法：jiti 不能在 Node 侧解析 .tsx，configStore 间接依赖）----
const glassToastPath = path.resolve(cwd, 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
  id: glassToastPath,
  filename: glassToastPath,
  loaded: true,
  exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

// ---- chatFlow 桩：记录真实 abort 调用（切换集合必须走到传输 abort seam）----
const abortCalls: string[] = [];
const chatFlowPath = path.resolve(cwd, 'app/services/chatFlow.ts');
nodeRequire.cache[chatFlowPath] = {
  id: chatFlowPath,
  filename: chatFlowPath,
  loaded: true,
  exports: {
    beginChatStream: async () => ({ messageId: 'stub', audioUrl: 'blob:stub', content: 'stub' }),
    abortActiveChatStream: () => {
      abortCalls.push('abort');
    },
  },
} as unknown as NodeModule;

const { CONTINUOUS_WINDOW_COLD_START_MS, resolveBudgetMs } = nodeRequire(
  path.resolve(cwd, 'lib/continuous-creation/stateMachine'),
) as typeof import('../../../lib/continuous-creation/stateMachine');
const { useContinuousCreationStore } = nodeRequire(
  path.resolve(cwd, 'stores/continuousCreationStore'),
) as typeof import('../../../stores/continuousCreationStore');
const {
  __setContinuousCreationGeneratorForTests,
  consumePreparedNextWork,
  handleTrackEnded,
  hasPreparedNextWork,
  preemptContinuousCreationForUserInput,
  reportContinuousAudioActive,
  resetContinuousCreationRuntime,
  scheduleNextWork,
} = nodeRequire(
  path.resolve(cwd, 'app/services/continuousCreationFlow'),
) as typeof import('../../../app/services/continuousCreationFlow');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resetAll(budgetMinutes: number | null, epoch: number, collectionId = 'col-1'): number {
  resetContinuousCreationRuntime();
  useContinuousCreationStore.getState().reset();
  useContinuousCreationStore.getState().resetForNewCreation({
    collectionId,
    budgetMinutes,
    epoch,
  });
  return useContinuousCreationStore.getState().epoch;
}

async function runTests() {
  console.log('=== 1. 预算快照与初始化默认态 ===');
  assert.strictEqual(useContinuousCreationStore.getState().enabled, true, '连续创作必须默认开启');
  assert.strictEqual(
    useContinuousCreationStore.getState().status,
    'enabled_idle',
    '默认状态必须是 enabled_idle',
  );
  assert.strictEqual(resolveBudgetMs(30), 30 * 60_000, '30 分钟换算为毫秒快照');
  assert.strictEqual(resolveBudgetMs(0), null, '0/缺失视为不限');
  assert.strictEqual(resolveBudgetMs(-5), null, '负数视为不限');
  console.log('PASS: 1');

  console.log('=== 2. 生成 / 准备音频 / 缓冲不扣预算 ===');
  {
    const epoch = resetAll(1, 1);
    const before = useContinuousCreationStore.getState().remainingMs;
    assert.strictEqual(before, 60_000, '1 分钟预算快照');
    assert.strictEqual(useContinuousCreationStore.getState().schedule(), true, '调度被接受');
    useContinuousCreationStore.getState().audioPreparing();
    useContinuousCreationStore.getState().audioReady(5_000);
    assert.strictEqual(
      useContinuousCreationStore.getState().remainingMs,
      before,
      '生成/准备期间预算不得扣减',
    );
    assert.strictEqual(useContinuousCreationStore.getState().status, 'next_ready');
    assert.strictEqual(useContinuousCreationStore.getState().windowMs, 30_000, '窗口按样本收敛并 clamp 下界');
    assert.strictEqual(typeof epoch, 'number');
  }
  console.log('PASS: 2');

  console.log('=== 3. 暂停不扣、恢复推进才扣 ===');
  {
    resetAll(1, 1);
    const before = useContinuousCreationStore.getState().remainingMs as number;
    // 播放 → 暂停：暂停只是清采样点，不得产生 delta。
    reportContinuousAudioActive(true);
    reportContinuousAudioActive(false);
    assert.strictEqual(
      useContinuousCreationStore.getState().remainingMs,
      before,
      '暂停不得扣预算',
    );
    // 恢复推进：真实经过 ~40ms 后再次上报，应扣掉正 delta。
    reportContinuousAudioActive(true);
    await sleep(40);
    reportContinuousAudioActive(true);
    const after = useContinuousCreationStore.getState().remainingMs as number;
    assert(after < before, '音频真实推进必须扣减预算');
    assert(before - after >= 10, `推进 40ms 应至少扣 10ms（实际 ${before - after}）`);
    reportContinuousAudioActive(false);
  }
  console.log('PASS: 3');

  console.log('=== 4. 预算耗尽 → ended_budget 且停止扣减 / 停止调度 ===');
  {
    const epoch = resetAll(null, 1);
    useContinuousCreationStore.getState().setBudget(50);
    useContinuousCreationStore.getState().audioActiveTick(30);
    assert.strictEqual(useContinuousCreationStore.getState().status, 'enabled_idle');
    assert.strictEqual(useContinuousCreationStore.getState().remainingMs, 20);
    useContinuousCreationStore.getState().audioActiveTick(20);
    assert.strictEqual(useContinuousCreationStore.getState().status, 'ended_budget');
    assert.strictEqual(useContinuousCreationStore.getState().remainingMs, 0);
    // 耗尽后继续 tick 不复活、不变成负数。
    useContinuousCreationStore.getState().audioActiveTick(999);
    assert.strictEqual(useContinuousCreationStore.getState().remainingMs, 0);
    assert.strictEqual(useContinuousCreationStore.getState().status, 'ended_budget');
    // 调度门关闭。
    assert.strictEqual(
      useContinuousCreationStore.getState().canSchedule({ nowPlaying: true, epoch }),
      false,
      '耗尽后不得再调度',
    );
    assert.strictEqual(useContinuousCreationStore.getState().schedule(), false);
    // 重新开启恢复预算快照（setBudget 后的快照 = 50ms）。
    useContinuousCreationStore.getState().enable();
    assert.strictEqual(useContinuousCreationStore.getState().remainingMs, 50);
  }
  console.log('PASS: 4');

  console.log('=== 5. lookahead=1：并发调度只接受一个 ===');
  {
    const epoch = resetAll(30, 1);
    let resolveGenerator!: (value: { messageId: string; audioUrl: string; content: string }) => void;
    const gate = new Promise<{ messageId: string; audioUrl: string; content: string }>((resolve) => {
      resolveGenerator = resolve;
    });
    __setContinuousCreationGeneratorForTests(() => gate);

    const first = scheduleNextWork({ epoch, nowPlaying: true, remainingTrackMs: 1_000 });
    const second = await scheduleNextWork({ epoch, nowPlaying: true, remainingTrackMs: 1_000 });
    assert.strictEqual(second, false, 'lookahead=1：在途时第二次调度必须被拒');
    assert.strictEqual(useContinuousCreationStore.getState().status, 'generating_next');

    resolveGenerator({ messageId: 'm-next', audioUrl: 'blob:next', content: '下一段' });
    assert.strictEqual(await first, true, '首个调度完成');
    assert.strictEqual(useContinuousCreationStore.getState().status, 'next_ready');
    assert.strictEqual(hasPreparedNextWork(), true);
    assert.strictEqual(useContinuousCreationStore.getState().hasNextJob(), true);

    const third = await scheduleNextWork({ epoch, nowPlaying: true, remainingTrackMs: 1_000 });
    assert.strictEqual(third, false, '已有 ready next 时不得再调度');

    // exactly-once 消费。
    const consumed = consumePreparedNextWork(epoch);
    assert.deepStrictEqual(consumed, {
      audioUrl: 'blob:next',
      segment: '下一段',
      messageId: 'm-next',
    });
    assert.strictEqual(hasPreparedNextWork(), false);
    assert.strictEqual(consumePreparedNextWork(epoch), null, 'next 只能被消费一次');
    assert.strictEqual(useContinuousCreationStore.getState().status, 'enabled_idle');
  }
  console.log('PASS: 5');

  console.log('=== 6. 调度窗与 epoch stale guard ===');
  {
    const epoch = resetAll(30, 1);
    assert.strictEqual(
      await scheduleNextWork({ epoch, nowPlaying: false, remainingTrackMs: 1_000 }),
      false,
      '未在播放不得调度',
    );
    assert.strictEqual(
      await scheduleNextWork({ epoch, nowPlaying: true, remainingTrackMs: 90_000 }),
      false,
      '未进入调度窗不得调度',
    );
    assert.strictEqual(
      await scheduleNextWork({ epoch: epoch + 1, nowPlaying: true, remainingTrackMs: 1_000 }),
      false,
      'stale epoch 不得调度',
    );

    // 新 epoch 下调度成功后，推进 epoch 使 ready next 失效。
    __setContinuousCreationGeneratorForTests(async () => ({
      messageId: 'm-stale',
      audioUrl: 'blob:stale',
      content: '旧集合段落',
    }));
    assert.strictEqual(
      await scheduleNextWork({ epoch, nowPlaying: true, remainingTrackMs: 1_000 }),
      true,
    );
    const nextEpoch = useContinuousCreationStore.getState().advanceEpoch();
    assert.notStrictEqual(nextEpoch, epoch);
    assert.strictEqual(
      consumePreparedNextWork(epoch),
      null,
      '旧 epoch 的 ready next 必须被丢弃',
    );
  }
  console.log('PASS: 6');

  console.log('=== 7. 轨道结束无 ready next → waiting_next ===');
  {
    const epoch = resetAll(30, 1);
    assert.strictEqual(handleTrackEnded(epoch), null);
    assert.strictEqual(useContinuousCreationStore.getState().status, 'waiting_next');
    const before = useContinuousCreationStore.getState().remainingMs as number;
    useContinuousCreationStore.getState().audioActiveTick(5_000);
    assert.strictEqual(
      useContinuousCreationStore.getState().remainingMs,
      before,
      'waiting_next 不得扣预算',
    );

    // 有 ready next 时轨道结束应正常消费。
    const epoch2 = useContinuousCreationStore.getState().advanceEpoch();
    __setContinuousCreationGeneratorForTests(async () => ({
      messageId: 'm-ready',
      audioUrl: 'blob:ready',
      content: '就绪段落',
    }));
    assert.strictEqual(
      await scheduleNextWork({ epoch: epoch2, nowPlaying: true, remainingTrackMs: 1_000 }),
      true,
    );
    const consumed = handleTrackEnded(epoch2);
    assert.strictEqual(consumed?.messageId, 'm-ready');
    assert.strictEqual(useContinuousCreationStore.getState().status, 'enabled_idle');
  }
  console.log('PASS: 7');

  console.log('=== 8. 用户输入抢占丢弃在途/就绪 next 并作废 epoch ===');
  {
    const epoch = resetAll(30, 1);
    __setContinuousCreationGeneratorForTests(async () => ({
      messageId: 'm-preempt',
      audioUrl: 'blob:preempt',
      content: '待抢占段落',
    }));
    assert.strictEqual(
      await scheduleNextWork({ epoch, nowPlaying: true, remainingTrackMs: 1_000 }),
      true,
    );
    assert.strictEqual(hasPreparedNextWork(), true);
    preemptContinuousCreationForUserInput();
    assert.strictEqual(hasPreparedNextWork(), false, '抢占后不得残留 ready next');
    assert.notStrictEqual(useContinuousCreationStore.getState().epoch, epoch);
    assert.strictEqual(consumePreparedNextWork(epoch), null, '旧回调不得复活');
  }
  console.log('PASS: 8');

  console.log('=== 9. 冷启动窗口常量与不限预算 ===');
  {
    resetAll(null, 1);
    assert.strictEqual(
      useContinuousCreationStore.getState().windowMs,
      CONTINUOUS_WINDOW_COLD_START_MS,
      '冷启动窗口 60s',
    );
    assert.strictEqual(useContinuousCreationStore.getState().remainingMs, null, '不限预算');
    useContinuousCreationStore.getState().audioActiveTick(3_600_000);
    assert.strictEqual(useContinuousCreationStore.getState().remainingMs, null, '不限预算不扣减');
    assert.notStrictEqual(useContinuousCreationStore.getState().status, 'ended_budget');
  }
  console.log('PASS: 9');

  console.log('=== 10. 停止矩阵：关闭开关后在途结算不得写回/残留 ===');
  {
    const epoch = resetAll(30, 1);
    let resolveLate!: (v: { messageId: string; audioUrl: string; content: string }) => void;
    __setContinuousCreationGeneratorForTests(
      () => new Promise((resolve) => { resolveLate = resolve; }),
    );
    const inflight = scheduleNextWork({ epoch, nowPlaying: true, remainingTrackMs: 1_000 });
    assert.strictEqual(useContinuousCreationStore.getState().status, 'generating_next');
    useContinuousCreationStore.getState().disable();
    resolveLate({ messageId: 'm-late-disable', audioUrl: 'blob:late-disable', content: '关闭后晚到' });
    assert.strictEqual(await inflight, false, '关闭后晚到结算必须被丢弃');
    assert.strictEqual(hasPreparedNextWork(), false, '关闭后不得残留 prepared');
    assert.strictEqual(consumePreparedNextWork(epoch), null);
    assert.strictEqual(handleTrackEnded(epoch), null, '等待中的结果不得复活自动续播');
    assert.strictEqual(useContinuousCreationStore.getState().status, 'disabled');
  }
  console.log('PASS: 10');

  console.log('=== 11. 停止矩阵：预算耗尽后在途结算丢弃且新会话可立即重调度 ===');
  {
    const epoch = resetAll(30, 1);
    useContinuousCreationStore.getState().setBudget(20);
    let resolveLate!: (v: { messageId: string; audioUrl: string; content: string }) => void;
    __setContinuousCreationGeneratorForTests(
      () => new Promise((resolve) => { resolveLate = resolve; }),
    );
    const inflight = scheduleNextWork({ epoch, nowPlaying: true, remainingTrackMs: 1_000 });
    assert.strictEqual(useContinuousCreationStore.getState().status, 'generating_next');
    // 真实推进耗尽预算（生产唯一扣减入口）。
    reportContinuousAudioActive(true);
    await sleep(30);
    reportContinuousAudioActive(true);
    assert.strictEqual(useContinuousCreationStore.getState().status, 'ended_budget');
    resolveLate({ messageId: 'm-late-budget', audioUrl: 'blob:late-budget', content: '耗尽后晚到' });
    assert.strictEqual(await inflight, false, '预算耗尽后晚到结算必须丢弃');
    assert.strictEqual(hasPreparedNextWork(), false, '预算耗尽不得残留 prepared');
    assert.strictEqual(consumePreparedNextWork(epoch), null);
    assert.strictEqual(handleTrackEnded(epoch), null, '等待中的结果不得复活自动续播');
    // 新会话（新建创作重置预算）可立即重新调度（单槽位已释放、无旧锁残留）。
    const nextEpoch = useContinuousCreationStore.getState().epoch + 1;
    useContinuousCreationStore.getState().resetForNewCreation({
      collectionId: 'col-2',
      budgetMinutes: 30,
      epoch: nextEpoch,
    });
    __setContinuousCreationGeneratorForTests(async () => ({
      messageId: 'm-after-budget',
      audioUrl: 'blob:after-budget',
      content: '新会话段落',
    }));
    assert.strictEqual(
      await scheduleNextWork({ epoch: nextEpoch, nowPlaying: true, remainingTrackMs: 1_000 }),
      true,
      '预算耗尽后新会话必须能立即重新调度',
    );
    assert.deepStrictEqual(consumePreparedNextWork(nextEpoch), {
      audioUrl: 'blob:after-budget',
      segment: '新会话段落',
      messageId: 'm-after-budget',
    });
  }
  console.log('PASS: 11');

  console.log('=== 12. 停止矩阵：登出 reset 后旧回调不得复活（epoch 单调）===');
  {
    const epoch = resetAll(30, 0);
    let resolveLate!: (v: { messageId: string; audioUrl: string; content: string }) => void;
    __setContinuousCreationGeneratorForTests(
      () => new Promise((resolve) => { resolveLate = resolve; }),
    );
    const inflight = scheduleNextWork({ epoch, nowPlaying: true, remainingTrackMs: 1_000 });
    // 登出/全局重置：epoch 必须单调递增，绝不回落到旧值。
    useContinuousCreationStore.getState().reset();
    const afterLogoutEpoch = useContinuousCreationStore.getState().epoch;
    assert.notStrictEqual(afterLogoutEpoch, epoch, '登出 reset 后 epoch 不得回落到旧值');
    resolveLate({ messageId: 'm-late-logout', audioUrl: 'blob:late-logout', content: '登出后晚到' });
    assert.strictEqual(await inflight, false, '登出后晚到结算必须被丢弃');
    assert.strictEqual(hasPreparedNextWork(), false, '登出后不得残留 prepared');
    assert.strictEqual(consumePreparedNextWork(afterLogoutEpoch), null, '旧状态不得复活');
  }
  console.log('PASS: 12');

  console.log('=== 13. 停止矩阵：切换集合真取消在途/就绪 next 且新会话可立即重调度 ===');
  {
    // 13a：旧会话已有 ready next → 切换集合必须真 abort、清 prepared，新会话立即可调度。
    const epoch = resetAll(30, 1); // col-1
    __setContinuousCreationGeneratorForTests(async () => ({
      messageId: 'm-old-ready',
      audioUrl: 'blob:old-ready',
      content: '旧就绪',
    }));
    assert.strictEqual(
      await scheduleNextWork({ epoch, nowPlaying: true, remainingTrackMs: 1_000 }),
      true,
    );
    assert.strictEqual(hasPreparedNextWork(), true, '前置：旧会话已有 ready next');
    abortCalls.length = 0;

    const switchEpoch = useContinuousCreationStore.getState().switchCollection('col-2');
    assert.notStrictEqual(switchEpoch, epoch, '切换集合必须递增 epoch');
    assert.strictEqual(useContinuousCreationStore.getState().collectionId, 'col-2', '集合身份切换');
    assert(abortCalls.length >= 1, '切换集合必须真实 abort 在途传输');
    assert.strictEqual(hasPreparedNextWork(), false, '切换集合必须清空 prepared 残留');
    assert.strictEqual(useContinuousCreationStore.getState().hasNextJob(), false, '新会话不得继承 next job 槽位');
    assert.strictEqual(consumePreparedNextWork(epoch), null, '旧 epoch 的 ready next 不得复活');

    __setContinuousCreationGeneratorForTests(async () => ({
      messageId: 'm-new-ready',
      audioUrl: 'blob:new-ready',
      content: '新就绪',
    }));
    assert.strictEqual(
      await scheduleNextWork({ epoch: switchEpoch, nowPlaying: true, remainingTrackMs: 1_000 }),
      true,
      '切换集合后新会话必须能立即重新调度',
    );
    assert.deepStrictEqual(consumePreparedNextWork(switchEpoch), {
      audioUrl: 'blob:new-ready',
      segment: '新就绪',
      messageId: 'm-new-ready',
    });

    // 13b：旧会话生成在途（generating_next）时切换 → 真 abort + 释放调度锁 + 晚到丢弃。
    abortCalls.length = 0;
    const epoch2 = resetAll(30, 1);
    let resolveLate!: (v: { messageId: string; audioUrl: string; content: string }) => void;
    __setContinuousCreationGeneratorForTests(
      () => new Promise((resolve) => { resolveLate = resolve; }),
    );
    const inflight = scheduleNextWork({ epoch: epoch2, nowPlaying: true, remainingTrackMs: 1_000 });
    assert.strictEqual(useContinuousCreationStore.getState().status, 'generating_next');
    const switchEpoch2 = useContinuousCreationStore.getState().switchCollection('col-2');
    assert(abortCalls.length >= 1, '切换集合必须 abort 在途生成');
    __setContinuousCreationGeneratorForTests(async () => ({
      messageId: 'm-new-inflight',
      audioUrl: 'blob:new-inflight',
      content: '新在途',
    }));
    assert.strictEqual(
      await scheduleNextWork({ epoch: switchEpoch2, nowPlaying: true, remainingTrackMs: 1_000 }),
      true,
      '在途切换后新会话必须能立即重新调度（旧调度锁不得残留）',
    );
    assert.strictEqual(consumePreparedNextWork(switchEpoch2)?.messageId, 'm-new-inflight');
    resolveLate({ messageId: 'm-late-switch', audioUrl: 'blob:late-switch', content: '切换后晚到' });
    assert.strictEqual(await inflight, false, '切换集合后晚到结算必须被丢弃');
    assert.strictEqual(hasPreparedNextWork(), false, '晚到结果不得写回 prepared');
    assert.strictEqual(consumePreparedNextWork(epoch2), null, '旧结果不得污染新会话');

    // 13c：预算耗尽后切换会话 → 以新 collection identity 重新初始化（预算重新快照），新会话可立即重调度。
    const epoch3 = resetAll(null, 1);
    useContinuousCreationStore.getState().setBudget(20);
    useContinuousCreationStore.getState().audioActiveTick(20);
    assert.strictEqual(useContinuousCreationStore.getState().status, 'ended_budget');
    const switchEpoch3 = useContinuousCreationStore.getState().switchCollection('col-2');
    assert.strictEqual(
      useContinuousCreationStore.getState().status,
      'enabled_idle',
      '切换集合必须以新 identity 重新初始化（不得停在 ended_budget）',
    );
    assert.notStrictEqual(switchEpoch3, epoch3, '切换集合必须递增 epoch');
    __setContinuousCreationGeneratorForTests(async () => ({
      messageId: 'm-after-switch-budget',
      audioUrl: 'blob:after-switch-budget',
      content: '切后新段落',
    }));
    assert.strictEqual(
      await scheduleNextWork({ epoch: switchEpoch3, nowPlaying: true, remainingTrackMs: 1_000 }),
      true,
      '预算耗尽后切换会话，新会话必须能立即重新调度（预算重新快照）',
    );
    assert.strictEqual(consumePreparedNextWork(switchEpoch3)?.messageId, 'm-after-switch-budget');
  }
  console.log('PASS: 13');

  console.log('=== 14. 停止矩阵：disable 真 abort、清 prepared、终态锁死 ===');
  {
    // 14a：已有 ready next 时关闭 → 真 abort + 清 prepared + 迟到轨道结束不得取出旧 next。
    const epoch = resetAll(30, 1);
    __setContinuousCreationGeneratorForTests(async () => ({
      messageId: 'm-ready-disable',
      audioUrl: 'blob:ready-disable',
      content: '关闭前就绪',
    }));
    assert.strictEqual(
      await scheduleNextWork({ epoch, nowPlaying: true, remainingTrackMs: 1_000 }),
      true,
    );
    assert.strictEqual(hasPreparedNextWork(), true, '前置：关闭前已有 ready next');
    abortCalls.length = 0;

    useContinuousCreationStore.getState().disable();
    assert(abortCalls.length >= 1, 'disable 必须真实 abort 在途/就绪 next 传输');
    assert.strictEqual(hasPreparedNextWork(), false, 'disable 必须清空 prepared 残留');
    assert.strictEqual(useContinuousCreationStore.getState().status, 'disabled');
    assert.strictEqual(handleTrackEnded(epoch), null, 'disable 后迟到轨道结束不得取出旧 next');
    assert.strictEqual(
      useContinuousCreationStore.getState().status,
      'disabled',
      'disable 终态不得被迟到轨道结束复活',
    );
    assert.strictEqual(consumePreparedNextWork(epoch), null, 'disable 后旧 next 不得复活');

    // 14b：在途生成时关闭 → 真 abort + 晚到丢弃 + 终态锁死。
    abortCalls.length = 0;
    const epoch2 = resetAll(30, 1);
    let resolveLate!: (v: { messageId: string; audioUrl: string; content: string }) => void;
    __setContinuousCreationGeneratorForTests(
      () => new Promise((resolve) => { resolveLate = resolve; }),
    );
    const inflight = scheduleNextWork({ epoch: epoch2, nowPlaying: true, remainingTrackMs: 1_000 });
    assert.strictEqual(useContinuousCreationStore.getState().status, 'generating_next');
    useContinuousCreationStore.getState().disable();
    assert(abortCalls.length >= 1, 'disable 必须 abort 在途生成');
    assert.strictEqual(hasPreparedNextWork(), false);
    resolveLate({ messageId: 'm-late-disable', audioUrl: 'blob:late-disable', content: '关闭后晚到' });
    assert.strictEqual(await inflight, false, 'disable 后晚到结算必须丢弃');
    assert.strictEqual(handleTrackEnded(epoch2), null, 'disable 后迟到结束不得复活');
    assert.strictEqual(
      useContinuousCreationStore.getState().status,
      'disabled',
      'disable 终态必须锁死',
    );
  }
  console.log('PASS: 14');

  console.log('=== 15. 停止矩阵：预算耗尽终态守卫（迟到事件不得复活）===');
  {
    const epoch = resetAll(30, 1);
    useContinuousCreationStore.getState().setBudget(20);
    useContinuousCreationStore.getState().audioActiveTick(20);
    assert.strictEqual(useContinuousCreationStore.getState().status, 'ended_budget');
    // 迟到轨道结束：不得把 ended_budget 翻成 waiting_next / enabled_idle。
    assert.strictEqual(handleTrackEnded(epoch), null);
    assert.strictEqual(
      useContinuousCreationStore.getState().status,
      'ended_budget',
      'ended_budget 终态不得被迟到轨道结束复活',
    );
    // 迟到 audio active：不得重新开账。
    reportContinuousAudioActive(true);
    assert.strictEqual(useContinuousCreationStore.getState().status, 'ended_budget');
    // 迟到 nextConsumed / generationFailed：不得复活。
    useContinuousCreationStore.getState().nextConsumed();
    assert.strictEqual(
      useContinuousCreationStore.getState().status,
      'ended_budget',
      'ended_budget 终态不得被迟到 nextConsumed 复活',
    );
    useContinuousCreationStore.getState().generationFailed('迟到失败');
    assert.strictEqual(
      useContinuousCreationStore.getState().status,
      'ended_budget',
      'ended_budget 终态不得被迟到 generationFailed 复活',
    );
    // 显式 enable 仍是唯一合法恢复路径（用户重新开启）。
    useContinuousCreationStore.getState().enable();
    assert.strictEqual(useContinuousCreationStore.getState().status, 'enabled_idle');
  }
  console.log('PASS: 15');

  __setContinuousCreationGeneratorForTests(null);
  resetContinuousCreationRuntime();
  console.log('ALL CONTINUOUS CREATION BUDGET TESTS PASSED SUCCESSFULLY');
}

const testPromise = runTests()
  .then(() => {
    console.log('ALL CONTINUOUS CREATION BUDGET TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
