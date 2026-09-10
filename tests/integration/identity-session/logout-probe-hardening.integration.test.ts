import assert from 'node:assert';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// 中文注释：H-06 follow-up 加固集成测试（任务11 STEP-3，L2）。
// 来源：tests/legacy/logout-probe-hardening.legacy.test.ts 全量承接（W2-01/W2-02/W2-03），无一丢弃。
// 对照：tests/integration/identity-session/logout-playback-reset.integration.test.ts（H-06 主探针）仅覆盖正常登出 reset→pause 采样 + 参与序列 + 前后快照；
// 本文件覆盖其未覆盖的故障注入隔离（单块 reset 抛错不阻断 + finally 仍采样）与深拷贝/深冻隔离 + 接线静态锁定。
// 全程内存，不碰 prisma/dev.db。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

const { usePlaybackStore } = nodeRequire('../../../stores/playbackStore') as {
    usePlaybackStore: typeof import('../../../stores/playbackStore').usePlaybackStore;
};
const { useChatStore } = nodeRequire('../../../stores/chatStore') as {
    useChatStore: typeof import('../../../stores/chatStore').useChatStore;
};
const { useConfigStore } = nodeRequire('../../../stores/configStore') as {
    useConfigStore: typeof import('../../../stores/configStore').useConfigStore;
};
const accountSync = nodeRequire('../../../stores/accountSync') as typeof import('../../../stores/accountSync');

function resetStoresForProbe(): void {
    accountSync.clearLogoutProbeSamples();
    usePlaybackStore.getState().registerAudioController(null);
    usePlaybackStore.getState().reset();
    useChatStore.getState().reset();
}

async function runH06W2Tests(): Promise<void> {
    console.log('=== H-06-W2-01: 单块 reset 抛错不阻断其余清理且探针仍记录（try/finally）===');
    resetStoresForProbe();
    // 中文注释：构造播放中现场 + 可观测 pause。
    const pauseCalls: number[] = [];
    usePlaybackStore.getState().registerAudioController({
        unlock: async () => {},
        play: async () => {},
        resume: async () => {},
        pause: () => { pauseCalls.push(Date.now()); },
        seek: () => {},
        setPlaybackRate: () => {},
    });
    usePlaybackStore.setState({
        isPlaying: true,
        currentAudioUrl: 'blob:mock-h06w2-audio',
        currentMessageId: 'msg_h06w2',
        isFloatingVisible: true,
    });
    useChatStore.setState({
        messages: [
            { id: 'h06w2-u', role: 'user', content: '待清消息', status: 'delivered', createdAt: new Date().toISOString() },
        ],
        syncEnabled: true,
    });
    // 中文注释：注入单块故障——config reset 抛错（首个参与块），复刻下游 store 异常。
    const originalConfigReset = useConfigStore.getState().reset;
    (useConfigStore.setState as unknown as (p: Record<string, unknown>) => void)({
        reset: () => { throw new Error('H06W2_MOCK_CONFIG_RESET_FAIL'); },
    });
    let threw = false;
    try {
        accountSync.resetAccountData();
    } catch {
        threw = true;
    } finally {
        (useConfigStore.setState as unknown as (p: Record<string, unknown>) => void)({
            reset: originalConfigReset,
        });
    }
    assert.strictEqual(threw, false, 'RED: 单块 reset 抛错外泄阻断登出；修后必须 try/finally 吞错不抛');
    assert.strictEqual(usePlaybackStore.getState().isPlaying, false, 'RED: 后续块（playback）被跳过未停声；修后必须继续清理');
    assert.strictEqual(useChatStore.getState().messages.length, 0, 'RED: 后续块（chat）被跳过未清理；修后必须继续清理');
    assert.strictEqual(pauseCalls.length, 1, '登出链内 pause 应恰好一次（行为不变）');
    const samplesAfterFault = accountSync.getLogoutProbeSamples();
    assert.strictEqual(samplesAfterFault.length, 1, 'RED: 故障时探针未记录；修后 finally 必须仍记录一条采样');
    console.log('PASS: H-06-W2-01 fault isolated, probe recorded');

    console.log('=== H-06-W2-02: 探针返回深拷贝/深冻（调用方不得改写内部暂存）===');
    {
        const first = accountSync.getLogoutProbeSamples();
        assert.ok(first.length >= 1, '前置：应有至少一条采样供拷贝断言');
        const beforeLen = first.length;
        // 中文注释：尝试改写返回体（顶层 push、嵌套 participants push、快照翻转）。
        try {
            (first as unknown as Array<unknown>).push({ poisoned: true });
        } catch {}
        try {
            (first[0].participants as unknown as Array<unknown>).push('poisoned-participant');
        } catch {}
        try {
            (first[0].playbackBefore as unknown as Record<string, unknown>).isPlaying =
                !first[0].playbackBefore.isPlaying;
        } catch {}
        const second = accountSync.getLogoutProbeSamples();
        assert.strictEqual(second.length, beforeLen, 'RED: 顶层 push 污染内部暂存；修后必须深拷贝隔离');
        assert.ok(
            !second[0].participants.includes('poisoned-participant' as never),
            'RED: 嵌套 participants 被外部改写；修后必须深拷贝隔离',
        );
        // 中文注释：深冻断言——返回体顶层与嵌套均冻结（冻结失败即未深冻）。
        assert.ok(Object.isFrozen(first), 'RED: 返回数组必须冻结（深冻）');
        assert.ok(Object.isFrozen(first[0]), 'RED: 采样对象必须冻结');
        assert.ok(Object.isFrozen(first[0].participants), 'RED: participants 数组必须冻结');
        assert.ok(Object.isFrozen(first[0].playbackBefore), 'RED: playbackBefore 必须冻结');
        assert.ok(Object.isFrozen(first[0].playbackAfter), 'RED: playbackAfter 必须冻结');
    }
    console.log('PASS: H-06-W2-02 deep copy and frozen');

    console.log('=== H-06-W2-03: try/finally 与深拷贝接线静态锁定 ===');
    {
        const source = readFileSync(path.join(process.cwd(), 'stores', 'accountSync.ts'), 'utf8');
        assert.ok(source.includes('try'), '必须包含 try 守卫');
        assert.ok(source.includes('finally'), '必须包含 finally（探针永不阻断登出）');
        assert.ok(source.includes('Object.freeze') || source.includes('structuredClone'), '必须深拷贝/深冻返回');
    }
    console.log('PASS: H-06-W2-03 wiring locked');

    console.log('\nALL H-06-W2 TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runH06W2Tests()
    .then(() => {
        console.log('ALL H-06-W2 TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('H-06-W2 test failed:', error);
        process.exit(1);
    })
    .finally(() => {
        resetStoresForProbe();
    });

export default testPromise;
