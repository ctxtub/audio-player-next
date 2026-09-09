import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：GlassToast 打桩（accountSync 间接依赖的 store 可能引用）。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

const { usePlaybackStore } = nodeRequire('../stores/playbackStore') as {
    usePlaybackStore: typeof import('../stores/playbackStore').usePlaybackStore;
};
const accountSync = nodeRequire('../stores/accountSync') as typeof import('../stores/accountSync');

// 中文注释：H-06 观测探针——登出链 reset→controller.pause 序列必须可采样。
async function runH06Tests(): Promise<void> {
    console.log('=== H-06: 登出停声时序探针必须采样到 reset→pause 序列 ===');

    // 探针 API 存在性（纯观测，不改登出行为）。
    assert.strictEqual(
        typeof (accountSync as unknown as Record<string, unknown>).getLogoutProbeSamples,
        'function',
        'accountSync 必须暴露 getLogoutProbeSamples 探针',
    );
    assert.strictEqual(
        typeof (accountSync as unknown as Record<string, unknown>).clearLogoutProbeSamples,
        'function',
        'accountSync 必须暴露 clearLogoutProbeSamples 探针',
    );
    const getSamples = (accountSync as unknown as {
        getLogoutProbeSamples: () => Array<{
            at: number;
            participants: string[];
            playbackBefore: { isPlaying: boolean; currentAudioUrl: string | null; hasController: boolean };
            playbackAfter: { isPlaying: boolean; currentAudioUrl: string | null; hasController: boolean };
        }>;
        clearLogoutProbeSamples: () => void;
    }).getLogoutProbeSamples;
    const clearSamples = (
        accountSync as unknown as { clearLogoutProbeSamples: () => void }
    ).clearLogoutProbeSamples;

    // 构造播放中现场 + 可观测的 pause  spy。
    const pauseCalls: number[] = [];
    usePlaybackStore.getState().registerAudioController({
        unlock: async () => {},
        play: async () => {},
        resume: async () => {},
        pause: () => {
            pauseCalls.push(Date.now());
        },
        seek: () => {},
        setPlaybackRate: () => {},
    });
    usePlaybackStore.setState({
        isPlaying: true,
        currentAudioUrl: 'blob:mock-h06-audio',
        currentMessageId: 'msg_h06',
        isFloatingVisible: true,
    });
    assert.strictEqual(usePlaybackStore.getState().isPlaying, true, '前置条件：登出前应处于播放中');
    assert.ok(
        usePlaybackStore.getState().audioController !== null,
        '前置条件：登出前应已注册音频控制器',
    );

    clearSamples();
    assert.strictEqual(getSamples().length, 0, '采样前探针应为空');

    // 触发登出清理链（唯一行为入口，不直接调 playback.reset）。
    pauseCalls.length = 0;
    accountSync.resetAccountData();

    // 探针必须采样到卸载瞬间快照：播放中 → 已停声。
    const samples = getSamples();
    assert.strictEqual(samples.length, 1, '一次 resetAccountData 应恰好产生一条探针采样');
    const sample = samples[0];
    assert.ok(
        Array.isArray(sample.participants) && sample.participants.length >= 5,
        '探针应记录参与块序列（含 config/chat/playbackProgress 等）',
    );
    assert.ok(
        sample.participants.includes('config') && sample.participants.includes('playbackProgress'),
        '参与序列应包含 config 与 playbackProgress',
    );
    assert.strictEqual(
        sample.playbackBefore.isPlaying,
        true,
        '探针应采样到卸载瞬间播放中（before.isPlaying=true）',
    );
    assert.strictEqual(
        sample.playbackBefore.currentAudioUrl,
        'blob:mock-h06-audio',
        '探针应采样到卸载瞬间音频地址',
    );
    assert.strictEqual(
        sample.playbackBefore.hasController,
        true,
        '探针应采样到卸载瞬间控制器已注册',
    );
    assert.strictEqual(
        sample.playbackAfter.isPlaying,
        false,
        '探针应采样到清理后已停声（after.isPlaying=false）',
    );
    assert.strictEqual(
        sample.playbackAfter.currentAudioUrl,
        null,
        '探针应采样到清理后音频地址已清空',
    );

    // 停声时序可观测：reset 链内控制器 pause 恰好被调用一次。
    assert.strictEqual(pauseCalls.length, 1, '登出链内控制器 pause 应恰好被调用一次');

    // 登出行为本身不变：播放态已重置、控制器引用保留。
    assert.strictEqual(usePlaybackStore.getState().isPlaying, false, '登出后应停声');
    assert.strictEqual(
        usePlaybackStore.getState().currentAudioUrl,
        null,
        '登出后音频地址应清空',
    );
    assert.ok(
        usePlaybackStore.getState().audioController !== null,
        '登出后控制器引用应保留（playbackStore.reset 语义不变）',
    );

    // 清理现场。
    usePlaybackStore.getState().registerAudioController(null);
    usePlaybackStore.getState().reset();
    clearSamples();

    console.log('PASS: H-06 登出 reset→pause 序列可观测且行为不变');
    console.log('ALL H-06 LOGOUT PROBE TESTS PASSED SUCCESSFULLY');
}

const testPromise = runH06Tests()
    .then(() => {
        console.log('ALL H-06 LOGOUT PROBE TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('H-06 test failed:', err);
        process.exit(1);
    });

export default testPromise;
