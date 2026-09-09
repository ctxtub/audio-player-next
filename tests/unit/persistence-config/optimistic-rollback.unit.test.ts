import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：GlassToast 打桩（捕获失败提示，不断言其文案以外的行为）。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
const toastCalls: Array<{ icon?: string; content?: string }> = [];
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: {
        default: {
            show: (opts: { icon?: string; content?: string }) => {
                toastCalls.push(opts);
            },
            clear: () => {},
        },
    },
} as unknown as NodeModule;

const { useConfigStore } = nodeRequire('../../../stores/configStore') as {
    useConfigStore: typeof import('../../../stores/configStore').useConfigStore;
};
const userConfigModule = nodeRequire('../../../lib/client/userConfig') as {
    saveMyConfig: (patch: unknown) => Promise<unknown>;
    fetchMyConfig: () => Promise<{
        playDuration: number;
        voiceId: string;
        speed: number;
        floatingPlayerEnabled: boolean;
        themeMode: 'dark' | 'light' | 'system';
    }>;
};

// 中文注释：等待防抖保存（500ms）与回滚拉取落定。
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

// 中文注释：H-14 回归——配置保存失败必须回滚到服务端值（保留 toast）。
async function runH14Tests(): Promise<void> {
    console.log('=== H-14: 配置保存失败必须回滚到服务端值 ===');
    const originalSave = userConfigModule.saveMyConfig;
    const originalFetch = userConfigModule.fetchMyConfig;
    try {
        // 服务端真值（保存失败时回滚目标）。
        const serverTruth = {
            playDuration: 30,
            voiceId: 'alloy',
            speed: 1.0,
            floatingPlayerEnabled: true,
            themeMode: 'dark' as const,
        };

        // 用例 1：保存失败 → 回滚到服务端值 + toast。
        useConfigStore.getState().reset();
        useConfigStore.setState({
            apiConfig: { ...serverTruth },
            isLoaded: true,
            initError: null,
            voiceOptions: [],
            syncEnabled: true,
        });
        toastCalls.length = 0;
        (userConfigModule as unknown as Record<string, unknown>).saveMyConfig = async () => {
            throw new Error('H14_MOCK_SAVE_FAIL');
        };
        (userConfigModule as unknown as Record<string, unknown>).fetchMyConfig = async () => ({
            ...serverTruth,
        });

        useConfigStore.getState().update({ speed: 2.0 });
        assert.strictEqual(
            useConfigStore.getState().apiConfig.speed,
            2.0,
            '乐观更新应先立即可见 speed=2.0',
        );
        await sleep(900);
        assert.strictEqual(
            useConfigStore.getState().apiConfig.speed,
            serverTruth.speed,
            '保存失败后必须回滚到服务端 speed=1.0，不得停留乐观值',
        );
        assert.ok(toastCalls.length >= 1, '保存失败必须保留 toast 提示');
        console.log('PASS: H-14 保存失败回滚到服务端值 + 保留 toast');

        // 用例 2：保存成功 → 保留乐观值，不回滚。
        useConfigStore.getState().reset();
        useConfigStore.setState({
            apiConfig: { ...serverTruth },
            isLoaded: true,
            initError: null,
            voiceOptions: [],
            syncEnabled: true,
        });
        toastCalls.length = 0;
        (userConfigModule as unknown as Record<string, unknown>).saveMyConfig = async () => ({
            ...serverTruth,
            speed: 1.5,
        });
        (userConfigModule as unknown as Record<string, unknown>).fetchMyConfig = async () => ({
            ...serverTruth,
        });

        useConfigStore.getState().update({ speed: 1.5 });
        await sleep(900);
        assert.strictEqual(
            useConfigStore.getState().apiConfig.speed,
            1.5,
            '保存成功时必须保留乐观值 speed=1.5，不得回滚',
        );
        console.log('PASS: H-14 保存成功保留乐观值');
    } finally {
        (userConfigModule as unknown as Record<string, unknown>).saveMyConfig = originalSave;
        (userConfigModule as unknown as Record<string, unknown>).fetchMyConfig = originalFetch;
        useConfigStore.getState().reset();
    }

    console.log('ALL H-14 CONFIG ROLLBACK TESTS PASSED SUCCESSFULLY');
}

const testPromise = runH14Tests()
    .then(() => {
        console.log('ALL H-14 CONFIG ROLLBACK TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('H-14 test failed:', err);
        process.exit(1);
    });

export default testPromise;
