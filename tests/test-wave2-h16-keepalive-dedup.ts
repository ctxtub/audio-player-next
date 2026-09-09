import assert from 'node:assert';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// 中文注释：H-16 follow-up——退出 flush 必须 keepalive 送达 + 在途去重（双事件只存一次）。
// 全程内存打桩，不建 socket、不绑端口，不碰 prisma/dev.db。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

// 中文注释：会话落库可控桩——先占 require.cache（chatStore 静态导入前），计数 + 延迟可控供去重断言；
// keepalive 自证：桩内观测 globalThis.fetch 是否被 keepalive 包装（见 H-16-02）。
type ChatMessageInputLike = { messageId: string; role: string; content: string };
let saveCalls = 0;
let saveDelayMs = 0;
const savedSnapshots: ChatMessageInputLike[][] = [];
let observedFetchPatchedDuringSave: boolean | null = null;
let observedKeepaliveFlag: unknown = null;
const chatConversationPath = path.resolve(process.cwd(), 'lib/client/chatConversation.ts');
const originalGlobalFetch = (globalThis as unknown as Record<string, unknown>).fetch;
let spyFetchCalls: Array<{ url: unknown; init: unknown }> = [];
const spyFetch = async (url: unknown, init: unknown) => {
    spyFetchCalls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true }) };
};
nodeRequire.cache[chatConversationPath] = {
    id: chatConversationPath,
    filename: chatConversationPath,
    loaded: true,
    exports: {
        fetchMyConversation: async () => [],
        saveMyConversation: async (messages: ChatMessageInputLike[]) => {
            saveCalls += 1;
            // 中文注释：自证 keepalive 包装——记录调用瞬间 globalThis.fetch 是否为包装器（≠ spy 本体）。
            const currentFetch = (globalThis as unknown as Record<string, unknown>).fetch;
            observedFetchPatchedDuringSave = currentFetch !== spyFetch;
            // 中文注释：穿透调用一次当前 fetch，观测 keepalive 标记是否透传到底层。
            try {
                await (currentFetch as (u: unknown, i: unknown) => Promise<unknown>)(
                    'https://h16-probe.invalid/__keepalive__',
                    {},
                );
            } catch {
                // 忽略探针调用自身失败，仅观测参数。
            }
            const lastCall = spyFetchCalls[spyFetchCalls.length - 1];
            observedKeepaliveFlag = (lastCall?.init as Record<string, unknown> | undefined)?.keepalive;
            if (saveDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, saveDelayMs));
            }
            savedSnapshots.push(messages);
            return { ok: true };
        },
    },
} as unknown as NodeModule;

const { useChatStore } = nodeRequire('../stores/chatStore') as {
    useChatStore: typeof import('../stores/chatStore').useChatStore;
};

function resetBaseline(): void {
    useChatStore.getState().reset();
    useChatStore.setState({ syncEnabled: true });
    saveCalls = 0;
    saveDelayMs = 0;
    savedSnapshots.length = 0;
    spyFetchCalls = [];
    observedFetchPatchedDuringSave = null;
    observedKeepaliveFlag = null;
}

function seedDeliveredTail(): void {
    const now = new Date().toISOString();
    useChatStore.setState({
        messages: [
            { id: 'h16w2-user-1', role: 'user', content: '尾部问题-H16W2', status: 'delivered', createdAt: now },
            { id: 'h16w2-assistant-1', role: 'assistant', content: '尾部回答-H16W2', status: 'delivered', createdAt: now },
        ],
        syncEnabled: true,
    });
}

async function runH16W2Tests(): Promise<void> {
    console.log('=== H-16-W2-01: beforeunload+pagehide 双触发在途去重（只存一次）===');
    resetBaseline();
    // 中文注释：安装 spy fetch + window 桩以启用浏览器 keepalive 分支（Node 默认无 window 则走基线透传）。
    (globalThis as unknown as Record<string, unknown>).fetch = spyFetch as unknown;
    (globalThis as unknown as Record<string, unknown>).window = {
        fetch: spyFetch,
        addEventListener: () => {},
    };
    seedDeliveredTail();
    saveDelayMs = 60;
    savedSnapshots.length = 0;
    const first = useChatStore.getState().flushPendingSave();
    const second = useChatStore.getState().flushPendingSave();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.strictEqual(firstResult, true, '首个 flush 应成功');
    assert.strictEqual(secondResult, true, '去重共享的第二个 flush 应同为 true');
    assert.strictEqual(saveCalls, 1, 'RED: 双触发并发必须去重为一次底层保存');
    assert.strictEqual(savedSnapshots.length, 1, '去重后快照应恰好一次');
    console.log('PASS: H-16-W2-01 in-flight dedup');

    console.log('=== H-16-W2-02: flush 透传底层 fetch 时注入 keepalive（送达保障）===');
    // 中文注释：沿用上一用例桩观测（save 内已穿透调用 fetch 并记录 keepalive）。
    assert.strictEqual(
        observedFetchPatchedDuringSave,
        true,
        'RED: flush 必须以 keepalive 语义包装底层 fetch（浏览器分支）',
    );
    assert.strictEqual(
        observedKeepaliveFlag,
        true,
        'RED: 底层 fetch 必须收到 keepalive:true',
    );
    console.log('PASS: H-16-W2-02 keepalive injected');

    console.log('=== H-16-W2-03: 锁结算后释放（串行再次保存不受粘住）===');
    saveCalls = 0;
    saveDelayMs = 0;
    savedSnapshots.length = 0;
    spyFetchCalls = [];
    const retryResult = await useChatStore.getState().flushPendingSave();
    assert.strictEqual(retryResult, true, '锁释放后串行 flush 应仍可保存');
    assert.strictEqual(saveCalls, 1, '串行再次保存应产生一次新的底层保存（锁不得粘住）');
    console.log('PASS: H-16-W2-03 lock released after settle');

    console.log('=== H-16-W2-04: 退出接线与 keepalive 选型静态锁定 ===');
    const chatStoreSource = readFileSync(path.join(process.cwd(), 'stores', 'chatStore.ts'), 'utf8');
    assert.ok(chatStoreSource.includes('beforeunload'), '必须保留 beforeunload 退出 flush');
    assert.ok(chatStoreSource.includes('pagehide'), '必须保留 pagehide 退出 flush');
    assert.ok(chatStoreSource.includes('flushPendingSave'), '退出接线必须委托 flushPendingSave');
    assert.ok(chatStoreSource.includes('keepalive'), '必须包含 keepalive 选型（fetch keepalive）');
    assert.ok(
        chatStoreSource.includes('flushInFlight') || chatStoreSource.includes('inFlight'),
        '必须包含在途去重锁',
    );
    console.log('PASS: H-16-W2-04 wiring locked');

    console.log('\nALL H-16-W2 TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runH16W2Tests()
    .then(() => {
        console.log('ALL H-16-W2 TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('H-16-W2 test failed:', error);
        process.exit(1);
    })
    .finally(() => {
        (globalThis as unknown as Record<string, unknown>).fetch = originalGlobalFetch;
        try {
            delete (globalThis as unknown as Record<string, unknown>).window;
        } catch {}
        useChatStore.getState().reset();
    });

export default testPromise;
