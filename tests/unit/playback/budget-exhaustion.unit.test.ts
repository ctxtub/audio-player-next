import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：预置 GlassToast 打桩，避免 store 触发真实 UI 依赖。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
  id: glassToastPath,
  filename: glassToastPath,
  loaded: true,
  exports: {
    default: {
      show: () => {},
      clear: () => {},
    },
  },
} as unknown as NodeModule;

const { usePlaybackStore } = nodeRequire('../../../stores/playbackStore') as {
  usePlaybackStore: typeof import('../../../stores/playbackStore').usePlaybackStore;
};

/** 中文注释：清理倒计时定时器并复位 store，避免用例间串扰。 */
function resetPlayback(): void {
  try {
    const state = usePlaybackStore.getState();
    const intervalId = (state as unknown as { _tickIntervalId: number | null })._tickIntervalId;
    if (intervalId !== null) {
      clearInterval(intervalId);
    }
  } catch {
    // 中文注释：清理失败则忽略，复位继续。
  }
  usePlaybackStore.getState().reset();
  usePlaybackStore.setState({
    _tickIntervalId: null,
    _lastTickAt: null,
    isPlaying: false,
  });
}

async function runH08Tests(): Promise<void> {
  console.log('=== H-08: 预算耗尽声画一致（0 值早退＋耗尽停元素） ===');

  // 用例一：minutes 模式 0 预算 start 不放行（E2E-03-02：0 值可入导致 UI 秒回暂停而音频续响）。
  // M7-03：耗尽早退只适用于 minutes 模式（off/story_end 的 null 为合法无限态，必须放行）。
  console.log('--- H-08-01: 0 预算 start 必须早退 ---');
  resetPlayback();
  usePlaybackStore.getState().setSleepTimerState('minutes', 0, 30 * 60000);
  usePlaybackStore.setState({
    isPlaying: false,
    _tickIntervalId: null,
    _lastTickAt: null,
  });
  usePlaybackStore.getState().start();
  assert.strictEqual(
    usePlaybackStore.getState().isPlaying,
    false,
    '0 预算 start 不得进入播放态（minutes 模式须与 null 同等早退）',
  );
  assert.strictEqual(
    (usePlaybackStore.getState() as unknown as { _tickIntervalId: number | null })._tickIntervalId,
    null,
    '0 预算 start 不得启动倒计时定时器',
  );
  console.log('PASS: H-08-01 0-budget-start-blocked verified');

  // 用例二：tick 耗尽必须联动暂停音频元素（E2E-03-01：仅置 isPlaying 导致声画分歧）。
  console.log('--- H-08-02: tick 耗尽必须暂停音频元素 ---');
  resetPlayback();
  let pauseCalls = 0;
  usePlaybackStore.getState().registerAudioController({
    unlock: async () => {},
    play: async () => {},
    resume: async () => {},
    pause: () => {
      pauseCalls += 1;
    },
    seek: () => {},
    setPlaybackRate: () => {},
  });
  // 中文注释：Node 侧无 window，startCountdown 会早退；此处注入最小 window 以驱动真实 tick。
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const g = globalThis as unknown as {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
  (globalThis as Record<string, unknown>).window = {
    setInterval: (...args: [Parameters<typeof setInterval>[0], Parameters<typeof setInterval>[1]]) =>
      g.setInterval(...args),
    clearInterval: (...args: [Parameters<typeof clearInterval>[0]]) => g.clearInterval(...args),
  };
  try {
    // 中文注释：极小正预算，1s tick 后必耗尽（elapsed >> 50ms）。
    // M7-03：minutes 模式显式同步（Transport 默认 off；到期归一 off/null，§26）。
    usePlaybackStore.getState().setSleepTimerState('minutes', 50, 30 * 60000);
    usePlaybackStore.setState({
      isPlaying: false,
      _tickIntervalId: null,
      _lastTickAt: null,
    });
    usePlaybackStore.getState().start();
    assert.strictEqual(
      usePlaybackStore.getState().isPlaying,
      true,
      '正预算 start 应进入播放态（对照组）',
    );
    // 中文注释：等待 tick 触发耗尽（间隔 1000ms，留足余量）。
    await new Promise((resolve) => setTimeout(resolve, 1300));
    // M7-03 到期归一（§26）：remaining 不再以 0 持久化，mode→off。
    assert.strictEqual(
      usePlaybackStore.getState().remainingMs,
      null,
      '耗尽后 remainingMs 必须归一 null（不得以 0 持久化，防旧守卫锁死）',
    );
    assert.strictEqual(
      usePlaybackStore.getState().sleepTimerMode,
      'off',
      '耗尽后 mode 必须→off',
    );
    assert.strictEqual(
      usePlaybackStore.getState().isPlaying,
      false,
      '耗尽后 UI 须回到暂停态',
    );
    assert.ok(pauseCalls >= 1, '耗尽 tick 必须联动 controller.pause() 停音频元素（声画一致）');
    console.log('PASS: H-08-02 tick-exhaustion-pauses-element verified');
  } finally {
    try {
      const intervalId = (usePlaybackStore.getState() as unknown as { _tickIntervalId: number | null })
        ._tickIntervalId;
      if (intervalId !== null) {
        g.clearInterval(intervalId as unknown as Parameters<typeof clearInterval>[0]);
      }
    } catch {
      // 中文注释：清理失败忽略。
    }
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
    resetPlayback();
    usePlaybackStore.getState().registerAudioController(null);
  }

  console.log('\nALL H-08 BUDGET-EXHAUSTION TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runH08Tests()
  .then(() => {
    console.log('ALL H-08 BUDGET-EXHAUSTION TEST CASES PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
