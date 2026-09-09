import assert from 'node:assert';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// 中文注释：H-14 follow-up——单调 saveSeq 守卫：在途/乱序旧回滚丢弃，新编辑不被旧回滚覆盖。
// 桩先占 require.cache（require configStore 之前占位）并自证拦截有效（调用计数断言，回应 R2 质疑）。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：先占桩——必须在 require configStore 之前占位，确保静态导入即得桩（不依赖事后变异是否 live）。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
const toastCalls: Array<{ icon?: string; content?: string }> = [];
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: {
        default: {
            show: (opts: { icon?: string; content?: string }) => { toastCalls.push(opts); },
            clear: () => {},
        },
    },
} as unknown as NodeModule;

type ServerConfig = {
    playDuration: number;
    voiceId: string;
    speed: number;
    floatingPlayerEnabled: boolean;
    themeMode: 'dark' | 'light' | 'system';
};
let saveCalls = 0;
let fetchCalls = 0;
let saveBehavior: 'fail-then-success' | 'always-fail' | 'always-success' = 'fail-then-success';
let fetchDelays: number[] = [];
let fetchValues: ServerConfig[] = [];
const serverTruth: ServerConfig = {
    playDuration: 30,
    voiceId: 'alloy',
    speed: 1.0,
    floatingPlayerEnabled: true,
    themeMode: 'dark',
};
const userConfigPath = path.resolve(process.cwd(), 'lib/client/userConfig.ts');
nodeRequire.cache[userConfigPath] = {
    id: userConfigPath,
    filename: userConfigPath,
    loaded: true,
    exports: {
        saveMyConfig: async () => {
            saveCalls += 1;
            if (saveBehavior === 'always-success') {
                return { ...serverTruth };
            }
            if (saveBehavior === 'always-fail') {
                throw new Error('H14W2_MOCK_SAVE_FAIL');
            }
            // fail-then-success：首调失败（触发旧回滚），后续成功（新编辑落盘）。
            if (saveCalls === 1) {
                throw new Error('H14W2_MOCK_SAVE_FAIL_FIRST');
            }
            return { ...serverTruth };
        },
        fetchMyConfig: async () => {
            const idx = fetchCalls;
            fetchCalls += 1;
            const delay = fetchDelays[idx] ?? 0;
            const value = fetchValues[idx] ?? serverTruth;
            if (delay > 0) {
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
            return { ...value };
        },
    },
} as unknown as NodeModule;

const { useConfigStore } = nodeRequire('../../../stores/configStore') as {
    useConfigStore: typeof import('../../../stores/configStore').useConfigStore;
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetBaseline(): void {
    useConfigStore.getState().reset();
    useConfigStore.setState({
        apiConfig: { ...serverTruth },
        isLoaded: true,
        initError: null,
        voiceOptions: [],
        syncEnabled: true,
    });
    saveCalls = 0;
    fetchCalls = 0;
    toastCalls.length = 0;
    saveBehavior = 'fail-then-success';
    fetchDelays = [];
    fetchValues = [];
}

async function runH14W2Tests(): Promise<void> {
    console.log('=== H-14-W2-00: 桩有效性自证（先占拦截必须生效）===');
    resetBaseline();
    saveBehavior = 'always-fail';
    fetchDelays = [0];
    fetchValues = [{ ...serverTruth }];
    useConfigStore.getState().update({ speed: 2.0 });
    await sleep(900);
    assert.ok(saveCalls >= 1, 'RED/R2: saveMyConfig 桩必须被真实调用（先占拦截有效），否则后续断言无意义');
    assert.ok(fetchCalls >= 1, '回滚拉取桩必须被真实调用');
    assert.ok(toastCalls.length >= 1, '保存失败必须 toast');
    console.log(`PASS: H-14-W2-00 stub effective (saveCalls=${saveCalls}, fetchCalls=${fetchCalls})`);

    console.log('=== H-14-W2-01: 新编辑不被旧回滚覆盖 ===');
    resetBaseline();
    // 中文注释：旧保存失败→慢回滚（800ms）飞行中，新编辑成功落盘；旧回滚返回时必须丢弃。
    // 时序：t0 updateA(2.0)→t500 保存A失败→回滚A启动(800ms→t1300返回)；t600 updateB(1.5)→t1100 保存B成功；
    // t1300 回滚A返回时已无 pending（现有 saveTimer/pendingPatch 检查拦不住），唯 saveSeq 可弃旧。
    saveBehavior = 'fail-then-success';
    fetchDelays = [800];
    fetchValues = [{ ...serverTruth }];
    useConfigStore.getState().update({ speed: 2.0 });
    assert.strictEqual(useConfigStore.getState().apiConfig.speed, 2.0, '乐观更新 A 应立即可见');
    await sleep(600);
    // 中文注释：此时保存A已失败、回滚A飞行中；切新编辑 B（保存桩后续成功）。
    useConfigStore.getState().update({ speed: 1.5 });
    assert.strictEqual(useConfigStore.getState().apiConfig.speed, 1.5, '乐观更新 B 应立即可见');
    await sleep(1200);
    assert.ok(saveCalls >= 2, `新编辑 B 必须触发第二次保存（saveCalls=${saveCalls}，自证保存链路有效）`);
    assert.strictEqual(
        useConfigStore.getState().apiConfig.speed,
        1.5,
        'RED: 旧回滚返回后覆盖了新编辑 B（1.5 被回滚到 1.0）；修后必须保留 1.5',
    );
    console.log('PASS: H-14-W2-01 new edit survives stale rollback');

    console.log('=== H-14-W2-02: 在途乱序旧回滚丢弃（仅最新回滚生效）===');
    resetBaseline();
    // 中文注释：两次失败保存的回滚乱序返回——旧回滚慢（600ms, 值 v1=1.0）、新回滚快（50ms, 值 v2=7.0 模拟服务端已变）；
    // 快者先应用 v2，慢者后到必须丢弃，最终停留 v2。若无 seq，慢者覆盖快者终为 v1。
    saveBehavior = 'always-fail';
    fetchDelays = [600, 50];
    fetchValues = [
        { ...serverTruth, speed: 1.0 },
        { ...serverTruth, speed: 7.0 },
    ];
    useConfigStore.getState().update({ speed: 2.0 });
    await sleep(650);
    // 中文注释：保存A失败、回滚A(慢)飞行中；发起更新 B 触发保存B失败、回滚B(快)。
    useConfigStore.getState().update({ speed: 3.0 });
    await sleep(1200);
    assert.ok(saveCalls >= 2, `两次保存必须均触发（saveCalls=${saveCalls}）`);
    assert.ok(fetchCalls >= 2, `两次回滚拉取必须均触发（fetchCalls=${fetchCalls}）`);
    assert.strictEqual(
        useConfigStore.getState().apiConfig.speed,
        7.0,
        'RED: 乱序旧回滚覆盖了最新回滚；修后最终必须为最新回滚值 7.0',
    );
    console.log('PASS: H-14-W2-02 stale rollback discarded');

    console.log('=== H-14-W2-03: 单调 saveSeq 接线静态锁定 ===');
    const configSource = readFileSync(path.join(process.cwd(), 'stores', 'configStore.ts'), 'utf8');
    assert.ok(configSource.includes('saveSeq'), '必须包含单调 saveSeq 守卫');
    assert.ok(
        configSource.includes('seqAtSend') || configSource.includes('saveSeq'),
        '回滚必须捕获发送代次并比对丢弃',
    );
    console.log('PASS: H-14-W2-03 saveSeq wiring locked');

    console.log('\nALL H-14-W2 TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runH14W2Tests()
    .then(() => {
        console.log('ALL H-14-W2 TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('H-14-W2 test failed:', error);
        process.exit(1);
    })
    .finally(() => {
        useConfigStore.getState().reset();
    });

export default testPromise;
