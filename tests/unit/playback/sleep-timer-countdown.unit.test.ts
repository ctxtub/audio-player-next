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

// 中文注释：fake clock——劫持 window.setInterval 捕获 tick 回调 + 可手动推进的 Date.now，
// 确定性驱动 countdown，无真实等待（M7-03 门：unit fake clock）。
type TickFn = () => void;
let capturedTick: TickFn | null = null;
let fakeNow = 1_000_000;
const realDateNow = Date.now;

function installFakeClock(): void {
    capturedTick = null;
    fakeNow = 1_000_000;
    // 中文注释：store 起表用 window.setInterval、停表用裸 clearInterval（浏览器两者同源）；
    // fake clock 须同时劫持全局与 window 两面，否则停表在测试侧不可见。
    const fakeSetInterval = (fn: TickFn) => {
        capturedTick = fn;
        return 4242 as unknown as NodeJS.Timeout;
    };
    const fakeClearInterval = () => {
        capturedTick = null;
    };
    (globalThis as Record<string, unknown>).setInterval = fakeSetInterval;
    (globalThis as Record<string, unknown>).clearInterval = fakeClearInterval;
    (globalThis as Record<string, unknown>).window = {
        setInterval: fakeSetInterval,
        clearInterval: fakeClearInterval,
    };
    Date.now = () => fakeNow;
}

function uninstallFakeClock(): void {
    Date.now = realDateNow;
    const w = (globalThis as Record<string, unknown>).window as
        | { clearInterval?: (id: unknown) => void }
        | undefined;
    try {
        w?.clearInterval?.(4242);
    } catch {
        // 忽略清理异常。
    }
    delete (globalThis as Record<string, unknown>).window;
    capturedTick = null;
}

/** 中文注释：推进 fake 时间并执行一次 tick（模拟 1s 真实播放）。 */
function advanceTick(ms: number): void {
    fakeNow += ms;
    const tick = capturedTick;
    assert.ok(tick, 'countdown tick 必须已注册');
    (tick as TickFn)();
}

/** 中文注释：复位 transport（含到期回调与计时器），避免用例间串扰。 */
function resetTransport(): void {
    try {
        usePlaybackStore.getState().registerSleepTimerExpiryHandler(null);
    } catch {
        // 忽略。
    }
    usePlaybackStore.getState().reset();
    usePlaybackStore.setState({
        _tickIntervalId: null,
        _lastTickAt: null,
        isPlaying: false,
    });
}

async function runSleepTimerCountdownTests(): Promise<void> {
    console.log('=== M7-03: Sleep Timer countdown fake-clock ===');
    installFakeClock();
    try {
        // —— 1. minutes 播放中扣减；暂停后 tick 不扣（§25.1“再听 N 分钟”语义） ——
        console.log('--- §25.1: playing decrements, paused does not ---');
        resetTransport();
        usePlaybackStore.getState().setSleepTimerState('minutes', 1800000, 1800000);
        usePlaybackStore.getState().start();
        assert.strictEqual(usePlaybackStore.getState().isPlaying, true);
        advanceTick(5000);
        assert.strictEqual(usePlaybackStore.getState().remainingMs, 1795000, '播放 5s 应扣 5s');
        // 暂停：isPlaying=false 后 tick 自清且不再扣减。
        usePlaybackStore.setState({ isPlaying: false });
        const frozen = usePlaybackStore.getState().remainingMs;
        // 中文注释：暂停后 tick 入口即 clearCountdown（capturedTick 置 null），模拟 60s 停顿无 tick 可执行。
        const tickAfterPause = capturedTick;
        assert.ok(tickAfterPause, '暂停前 tick 已注册');
        (tickAfterPause as TickFn)();
        assert.strictEqual(capturedTick, null, '暂停后 tick 必须自清（停表）');
        assert.strictEqual(usePlaybackStore.getState().remainingMs, frozen, '暂停期间 remaining 不得减少');
        // resume 后继续：重新 start 起表，继续扣减。
        usePlaybackStore.getState().start();
        advanceTick(3000);
        assert.strictEqual(
            usePlaybackStore.getState().remainingMs,
            (frozen as number) - 3000,
            'resume 后继续扣减',
        );
        console.log('PASS: pause-freeze-resume');

        // —— 2. 非 minutes 模式不起表（off 放行播放但无 countdown） ——
        console.log('--- §25: off mode plays without countdown ---');
        resetTransport();
        usePlaybackStore.getState().setSleepTimerState('off', null, null);
        usePlaybackStore.getState().start();
        assert.strictEqual(usePlaybackStore.getState().isPlaying, true, 'off+null 必须放行播放');
        assert.strictEqual(capturedTick, null, 'off 模式不得注册 tick');
        console.log('PASS: off no countdown');

        // —— 3. story_end 模式不起表 ——
        console.log('--- §25: story_end mode plays without countdown ---');
        resetTransport();
        usePlaybackStore.getState().setSleepTimerState('story_end', null, null);
        usePlaybackStore.getState().start();
        assert.strictEqual(usePlaybackStore.getState().isPlaying, true);
        assert.strictEqual(capturedTick, null, 'story_end 不得注册 tick');
        console.log('PASS: story_end no countdown');

        // —— 4. minutes 耗尽早退（0 预算 start 阻塞；H-08 新语义） ——
        console.log('--- H-08/M7-03: minutes zero-budget start blocked ---');
        resetTransport();
        usePlaybackStore.getState().setSleepTimerState('minutes', 0, 1800000);
        usePlaybackStore.getState().start();
        assert.strictEqual(usePlaybackStore.getState().isPlaying, false, 'minutes 0 预算不得放行');
        console.log('PASS: zero-budget blocked');

        // —— 5. 到期：pause element + off/null + 回调（§26） ——
        console.log('--- §26: expiry pauses element and resets off ---');
        resetTransport();
        let pauseCalls = 0;
        let expiryCalls = 0;
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
        usePlaybackStore.getState().registerSleepTimerExpiryHandler(() => {
            expiryCalls += 1;
        });
        usePlaybackStore.getState().setSleepTimerState('minutes', 2000, 1800000);
        usePlaybackStore.getState().start();
        advanceTick(2500);
        const expired = usePlaybackStore.getState();
        assert.strictEqual(expired.isPlaying, false, '到期 UI 回暂停态');
        assert.strictEqual(expired.sleepTimerMode, 'off', '到期 mode→off');
        assert.strictEqual(expired.remainingMs, null, '到期 remaining→null（不得以 0 持久化）');
        assert.strictEqual(expired.totalAllowedMs, null, '到期 total→null');
        assert.ok(pauseCalls >= 1, '到期必须联动 controller.pause()（声画一致）');
        assert.strictEqual(expiryCalls, 1, '到期必须触发 Flow 编排回调');
        // 到期后 Play 正常继续：off+null start 放行（不得被旧 <=0 守卫锁死）。
        usePlaybackStore.getState().start();
        assert.strictEqual(usePlaybackStore.getState().isPlaying, true, '到期后重新 Play 必须正常继续');
        console.log('PASS: expiry semantics');

        // —— 6. 切出 minutes 立即停表（setSleepTimer off 在播放中设置） ——
        console.log('--- §24: switching to off stops countdown ---');
        resetTransport();
        usePlaybackStore.getState().setSleepTimerState('minutes', 1800000, 1800000);
        usePlaybackStore.getState().start();
        advanceTick(1000);
        usePlaybackStore.getState().setSleepTimerState('off', null, null);
        assert.strictEqual(capturedTick, null, '切 off 必须停掉在途 countdown');
        assert.strictEqual(usePlaybackStore.getState().isPlaying, true, '切 off 不暂停播放本身');
        console.log('PASS: switch stops countdown');

        resetTransport();
        usePlaybackStore.getState().registerAudioController(null);
        console.log('\nALL M7-03 SLEEP TIMER COUNTDOWN UNIT TESTS PASSED SUCCESSFULLY!');
    } finally {
        uninstallFakeClock();
    }
}

const testPromise = runSleepTimerCountdownTests()
    .then(() => {
        console.log('ALL M7-03 SLEEP TIMER COUNTDOWN UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('Test execution failed:', err);
        process.exit(1);
    });

export default testPromise;
