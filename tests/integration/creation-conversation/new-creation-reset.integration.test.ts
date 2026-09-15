/**
 * 新建创作强重置集成测试（L2，M9-C1 T2）。
 *
 * case_id: new-creation-strong-reset
 * oracle（docs/e2e/10-会话与作品集连续创作/07-新建创作强重置.md）：
 * 1. 唯一 `startNewCreation()`：确认 → epoch++ → abort → unload/clear → createNew → 初始态；
 * 2. 拒绝确认时零副作用；
 * 3. Chat 与 Now Playing 归 idle，旧集合不复活；
 * 4. 新会话预算 = 设置快照，连续创作默认开启（即使先前关闭）；
 * 5. 旧 epoch 的 ready next 与在途回调一律作废。
 */

import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const cwd = process.cwd();

// ---- GlassToast 桩（与既有 L2 同手法：jiti 不能在 Node 侧解析 .tsx）----
const glassToastPath = path.resolve(cwd, 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
  id: glassToastPath,
  filename: glassToastPath,
  loaded: true,
  exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

const {
  __setContinuousCreationGeneratorForTests,
  consumePreparedNextWork,
  hasPreparedNextWork,
  resetContinuousCreationRuntime,
  scheduleNextWork,
} = nodeRequire(
  path.resolve(cwd, 'app/services/continuousCreationFlow'),
) as typeof import('../../../app/services/continuousCreationFlow');
const { resolveContinuousCreationBudgetMinutes, startNewCreation } = nodeRequire(
  path.resolve(cwd, 'app/services/startNewCreation'),
) as typeof import('../../../app/services/startNewCreation');
const { useChatStore } = nodeRequire(
  path.resolve(cwd, 'stores/chatStore'),
) as typeof import('../../../stores/chatStore');
const { useConfigStore } = nodeRequire(
  path.resolve(cwd, 'stores/configStore'),
) as typeof import('../../../stores/configStore');
const { useContinuousCreationStore } = nodeRequire(
  path.resolve(cwd, 'stores/continuousCreationStore'),
) as typeof import('../../../stores/continuousCreationStore');
const { useGenerationStore } = nodeRequire(
  path.resolve(cwd, 'stores/generationStore'),
) as typeof import('../../../stores/generationStore');
const { usePlaybackStore } = nodeRequire(
  path.resolve(cwd, 'stores/playbackStore'),
) as typeof import('../../../stores/playbackStore');

const OLD_MESSAGE = {
  id: 'old-m1',
  role: 'assistant',
  content: '旧集合消息',
  status: 'delivered',
  createdAt: '2026-09-15T00:00:00.000Z',
  parts: [],
} as never;

function setSettings(enabled: boolean, minutes: number): void {
  const config = useConfigStore.getState().apiConfig;
  useConfigStore.setState({
    apiConfig: {
      ...config,
      defaultSleepTimerEnabled: enabled,
      defaultSleepTimerMinutes: minutes,
    },
  });
}

function seedOldSession(epoch = 5): void {
  resetContinuousCreationRuntime();
  useContinuousCreationStore.getState().reset();
  useContinuousCreationStore.getState().resetForNewCreation({
    collectionId: 'old-col',
    budgetMinutes: 30,
    epoch,
  });
  useChatStore.setState({
    messages: [OLD_MESSAGE],
    syncEnabled: false,
    conversationId: 'old-conv',
    collectionId: 'old-col',
    collectionTitle: '旧集合',
    epoch: 3,
  });
  usePlaybackStore.setState({ isPlaying: true });
  useGenerationStore.setState({ phase: 'generating_audio' });
}

async function runTests() {
  console.log('=== 1. 预算解析：设置页快照 ===');
  setSettings(true, 30);
  assert.strictEqual(resolveContinuousCreationBudgetMinutes(), 30);
  setSettings(true, 0);
  assert.strictEqual(resolveContinuousCreationBudgetMinutes(), 0, '时长 0 视为不限');
  setSettings(false, 45);
  assert.strictEqual(resolveContinuousCreationBudgetMinutes(), 0, '定时关闭视为不限');
  console.log('PASS: 1');

  console.log('=== 2. 拒绝确认：零副作用 ===');
  {
    seedOldSession(5);
    const beforeEpoch = useContinuousCreationStore.getState().epoch;
    const result = await startNewCreation({ confirm: () => false });
    assert.strictEqual(result.started, false);
    assert.strictEqual(result.reason, 'declined');
    assert.strictEqual(result.conversationId, null);
    assert.strictEqual(useContinuousCreationStore.getState().epoch, beforeEpoch);
    assert.strictEqual(useChatStore.getState().messages.length, 1, '拒绝不得清空消息');
    assert.strictEqual(useChatStore.getState().conversationId, 'old-conv');
    assert.strictEqual(usePlaybackStore.getState().isPlaying, true, '拒绝不得停声');
  }
  console.log('PASS: 2');

  console.log('=== 3. 强重置：Chat/播放归 idle，新会话 identity 生效 ===');
  {
    setSettings(true, 30);
    seedOldSession(5);
    // 旧会话已有一个 ready next 与在途生成器。
    __setContinuousCreationGeneratorForTests(async () => ({
      messageId: 'm-old-next',
      audioUrl: 'blob:old-next',
      content: '旧集合下一段',
    }));
    const oldEpoch = useContinuousCreationStore.getState().epoch;
    assert.strictEqual(
      await scheduleNextWork({ epoch: oldEpoch, nowPlaying: true, remainingTrackMs: 1_000 }),
      true,
    );
    assert.strictEqual(hasPreparedNextWork(), true);
    // 用户先前关闭连续创作：新建创作必须重新默认开启。
    useContinuousCreationStore.getState().disable();

    const result = await startNewCreation({
      expectedOldId: 'old-conv',
      createNew: async () => ({ id: 'conv-new', collectionId: 'col-new' }),
    });

    assert.strictEqual(result.started, true);
    assert.strictEqual(result.reason, undefined, '远端成功无 reason');
    assert.strictEqual(result.conversationId, 'conv-new');
    assert.strictEqual(result.collectionId, 'col-new');
    assert(result.epoch > oldEpoch, 'epoch 必须递增');

    // Chat 归 idle 且切换到新会话 identity。
    assert.deepStrictEqual(useChatStore.getState().messages, []);
    assert.strictEqual(useChatStore.getState().conversationId, 'conv-new');
    assert.strictEqual(useChatStore.getState().collectionId, 'col-new');
    assert.strictEqual(useChatStore.getState().collectionTitle, null);

    // Now Playing 归 idle。
    assert.strictEqual(usePlaybackStore.getState().isPlaying, false);
    assert.strictEqual(useGenerationStore.getState().phase, 'idle');

    // 连续创作默认开启 + 新集合 + 预算快照。
    const cc = useContinuousCreationStore.getState();
    assert.strictEqual(cc.enabled, true, '新建创作必须默认开启连续创作');
    assert.strictEqual(cc.status, 'enabled_idle');
    assert.strictEqual(cc.collectionId, 'col-new');
    assert.strictEqual(cc.budgetMs, 30 * 60_000, '预算 = 设置快照');
    assert.strictEqual(cc.remainingMs, 30 * 60_000);

    // 旧 epoch 的 ready next 与在途回调一律作废。
    assert.strictEqual(hasPreparedNextWork(), false, '强重置必须清空已准备下一作品');
    assert.strictEqual(cc.isStale(oldEpoch), true);
    assert.strictEqual(consumePreparedNextWork(oldEpoch), null, '旧回调不得复活');

    // 新 epoch 可正常再次调度（证明单槽位已释放）。
    assert.strictEqual(
      await scheduleNextWork({
        epoch: cc.epoch,
        nowPlaying: true,
        remainingTrackMs: 1_000,
      }),
      true,
      '强重置后新会话必须能重新调度',
    );
  }
  console.log('PASS: 3');

  console.log('=== 4. createNew 远端失败：保持安全态且不恢复旧播放 ===');
  {
    setSettings(true, 30);
    seedOldSession(7);
    const oldEpoch = useContinuousCreationStore.getState().epoch;
    const result = await startNewCreation({
      createNew: async () => {
        throw new Error('network down');
      },
    });
    assert.strictEqual(result.started, true, '强重置已执行');
    assert.strictEqual(result.reason, 'remote-failed');
    assert.strictEqual(result.conversationId, null);
    assert.strictEqual(result.collectionId, null);
    assert(result.epoch > oldEpoch);
    assert.deepStrictEqual(useChatStore.getState().messages, [], '远端失败仍保持 chat idle');
    assert.strictEqual(usePlaybackStore.getState().isPlaying, false, '绝不恢复旧播放');
    assert.strictEqual(useContinuousCreationStore.getState().enabled, true);
    assert.strictEqual(useContinuousCreationStore.getState().collectionId, null);
  }
  console.log('PASS: 4');

  console.log('=== 5. 不限预算：设置时长 0 ===');
  {
    setSettings(true, 0);
    seedOldSession(9);
    const result = await startNewCreation({
      createNew: async () => ({ id: 'conv-unlimited', collectionId: null }),
    });
    assert.strictEqual(result.started, true);
    assert.strictEqual(useContinuousCreationStore.getState().budgetMs, null);
    assert.strictEqual(useContinuousCreationStore.getState().remainingMs, null);
  }
  console.log('PASS: 5');

  __setContinuousCreationGeneratorForTests(null);
  resetContinuousCreationRuntime();
  console.log('ALL NEW CREATION RESET TESTS PASSED SUCCESSFULLY');
}

const testPromise = runTests()
  .then(() => {
    console.log('ALL NEW CREATION RESET TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
