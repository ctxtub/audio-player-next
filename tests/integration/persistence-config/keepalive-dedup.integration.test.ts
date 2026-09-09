import assert from 'node:assert';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// 中文注释：NodeRequire 兼容取值（jiti 运行器下 require 可能未全局暴露）。
const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
// 中文注释：jsdom 最小形态（无 @types/jsdom，经 require 加载，避免新增类型依赖）。
type JSDOMWindowLike = Record<string, unknown>;
type JSDOMLike = { window: JSDOMWindowLike };
type JSDOMCtorLike = new (html: string, opts?: Record<string, unknown>) => JSDOMLike;
// 中文注释：仓库根目录。
const repoRoot: string = process.cwd();
// 中文注释：会话落库输入最小形态（与 ChatMessageInput 同形子集）。
type MessageInputLike = { messageId: string; role: string; content: string };
// 中文注释：chatStore 最小形态（本测试用到的 flush/同步/消息子集）。
type ChatStoreLike = {
    getState: () => {
        messages: Array<{ id: string; role: string; content: string; status?: string }>;
        dispatch: (action: unknown) => void;
        flushPendingSave: () => Promise<boolean>;
        reset: () => void;
    };
    setState: (p: Record<string, unknown>) => void;
};
// 中文注释：可控落库桩状态（仅桩网络边界，flush/keepalive/去重锁均为真实实现）。
const stubState: {
    saveCalls: number;
    saveDelayMs: number;
    snapshots: MessageInputLike[][];
    spyFetchCalls: Array<{ url: unknown; init: unknown }>;
    fetchPatchedDuringSave: boolean | null;
    keepaliveFlag: unknown;
} = {
    saveCalls: 0,
    saveDelayMs: 0,
    snapshots: [],
    spyFetchCalls: [],
    fetchPatchedDuringSave: null,
    keepaliveFlag: null,
};

/**
 * 搭建 jsdom 真实 window（替代旧测试的手工 window 仿真对象，触发真实浏览器 keepalive 分支）。
 * 旧测试以 {fetch, addEventListener} 裸对象冒充 window；本测试以 jsdom 真实 window 为底，仅注入 spy fetch。
 */
function setupJsdomWithFetch(): { spyFetch: unknown; originalFetch: unknown; originalWindow: unknown } {
    const { JSDOM } = nodeRequire('jsdom') as unknown as { JSDOM: JSDOMCtorLike };
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://localhost/',
        pretendToBeVisual: true,
    });
    const win = dom.window as unknown as Record<string, unknown>;
    const g = globalThis as unknown as Record<string, unknown>;
    const originalFetch = g.fetch;
    const originalWindow = g.window;
    const spyFetch = async (url: unknown, init: unknown): Promise<unknown> => {
        stubState.spyFetchCalls.push({ url, init });
        return { ok: true, json: async () => ({ ok: true }) };
    };
    // 中文注释：以 jsdom 真实 window 为底注入 spy（保留真实 window 原型链与 navigator，仅 fetch 被观测桩替换）。
    try {
        Object.defineProperty(g, 'window', { value: win, writable: true, configurable: true });
    } catch {
        g.window = win;
    }
    try {
        Object.defineProperty(g, 'navigator', { value: win.navigator, writable: true, configurable: true });
    } catch {
        g.navigator = win.navigator;
    }
    g.fetch = spyFetch as unknown;
    try {
        Object.defineProperty(win, 'fetch', { value: spyFetch, writable: true, configurable: true });
    } catch {
        win.fetch = spyFetch;
    }
    if (!win.addEventListener) {
        win.addEventListener = (): void => {};
    }
    return { spyFetch, originalFetch, originalWindow };
}

/**
 * 预置会话落库可控桩（inner/outer 共享 require.cache，真实 flush 经此桩计数；keepalive 自证见桩内观测）。
 * 桩内不仿真去重/keepalive 逻辑，仅记录调用并穿透观测真实包装器。
 */
function stubChatConversation(spyFetch: unknown): void {
    const chatConversationPath = path.resolve(repoRoot, 'lib/client/chatConversation.ts');
    const glassToastPath = path.resolve(repoRoot, 'components/ui/GlassToast.tsx');
    const cache = (nodeRequire as unknown as { cache: Record<string, NodeModule> }).cache;
    cache[glassToastPath] = {
        id: glassToastPath,
        filename: glassToastPath,
        loaded: true,
        exports: { default: { show: (): void => {}, clear: (): void => {} } },
    } as unknown as NodeModule;
    cache[chatConversationPath] = {
        id: chatConversationPath,
        filename: chatConversationPath,
        loaded: true,
        exports: {
            fetchMyConversation: async () => [],
            saveMyConversation: async (messages: MessageInputLike[]) => {
                stubState.saveCalls += 1;
                // 中文注释：自证 keepalive 包装——记录调用瞬间 globalThis.fetch 是否为真实包装器（≠ spy 本体）。
                const currentFetch = (globalThis as unknown as Record<string, unknown>).fetch;
                stubState.fetchPatchedDuringSave = currentFetch !== spyFetch;
                // 中文注释：穿透调用一次当前 fetch，观测 keepalive 标记是否透传到底层（真实包装器行为）。
                try {
                    await (currentFetch as (u: unknown, i: unknown) => Promise<unknown>)(
                        'https://keepalive-probe.invalid/__keepalive__',
                        {},
                    );
                } catch {
                    // 中文注释：忽略探针调用自身失败，仅观测参数。
                }
                const lastCall = stubState.spyFetchCalls[stubState.spyFetchCalls.length - 1];
                stubState.keepaliveFlag = (lastCall?.init as Record<string, unknown> | undefined)?.keepalive;
                if (stubState.saveDelayMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, stubState.saveDelayMs));
                }
                stubState.snapshots.push(messages);
                return { ok: true };
            },
        },
    } as unknown as NodeModule;
}

/**
 * 重置 store 与桩到干净基线并开启同步。
 * @param useChatStore 真实 chatStore。
 */
function resetBaseline(useChatStore: ChatStoreLike): void {
    useChatStore.getState().reset();
    useChatStore.setState({ syncEnabled: true });
    stubState.saveCalls = 0;
    stubState.saveDelayMs = 0;
    stubState.snapshots.length = 0;
    stubState.spyFetchCalls.length = 0;
    stubState.fetchPatchedDuringSave = null;
    stubState.keepaliveFlag = null;
}

/**
 * 构造一条已完结的用户与助手消息对（模拟刚投递的尾部）。
 * @param useChatStore 真实 chatStore。
 */
function seedDeliveredTail(useChatStore: ChatStoreLike): void {
    const now = new Date().toISOString();
    useChatStore.setState({
        messages: [
            { id: 'keepalive-user-1', role: 'user', content: '尾部问题-keepalive', status: 'delivered', createdAt: now },
            { id: 'keepalive-assistant-1', role: 'assistant', content: '尾部回答-keepalive', status: 'delivered', createdAt: now },
        ],
        syncEnabled: true,
    });
}

async function runKeepaliveDedupTests(): Promise<void> {
    const { spyFetch, originalFetch, originalWindow } = setupJsdomWithFetch();
    stubChatConversation(spyFetch);
    // 中文注释：真实 chatStore 经 outer-jiti 加载（.ts 无需 jsx；flush/keepalive/去重锁均为真实实现）。
    const chatStoreMod = nodeRequire('../../../stores/chatStore') as unknown as {
        useChatStore: ChatStoreLike;
    };
    const useChatStore = chatStoreMod.useChatStore;
    try {
        console.log('=== KEEPALIVE-01: 并发双 flush 在途去重（真实 flushInFlight 锁，只存一次）===');
        resetBaseline(useChatStore);
        seedDeliveredTail(useChatStore);
        stubState.saveDelayMs = 60;
        stubState.snapshots.length = 0;
        // 中文注释：beforeunload+pagehide 双触发并发（两次调用间不 await，共享同一次真实保存）。
        const first = useChatStore.getState().flushPendingSave();
        const second = useChatStore.getState().flushPendingSave();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.strictEqual(firstResult, true, '首个 flush 应成功');
        assert.strictEqual(secondResult, true, '去重共享的第二个 flush 应同为 true');
        assert.strictEqual(stubState.saveCalls, 1, '双触发并发必须去重为一次底层保存');
        assert.strictEqual(stubState.snapshots.length, 1, '去重后快照应恰好一次');
        console.log('PASS: KEEPALIVE-01 真实锁在途去重');

        console.log('=== KEEPALIVE-02: 真实 keepalive 包装透传到底层 fetch（送达保障）===');
        // 中文注释：沿用上一用例桩观测（save 内已穿透调用真实包装器并记录 keepalive）。
        assert.strictEqual(
            stubState.fetchPatchedDuringSave,
            true,
            'flush 必须以 keepalive 语义包装底层 fetch（jsdom 真实 window 分支）',
        );
        assert.strictEqual(stubState.keepaliveFlag, true, '底层 fetch 必须收到 keepalive:true');
        console.log('PASS: KEEPALIVE-02 真实 keepalive 透传');

        console.log('=== KEEPALIVE-03: 锁结算后释放（串行再次保存不受粘住）===');
        stubState.saveCalls = 0;
        stubState.saveDelayMs = 0;
        stubState.snapshots.length = 0;
        stubState.spyFetchCalls.length = 0;
        const retryResult = await useChatStore.getState().flushPendingSave();
        assert.strictEqual(retryResult, true, '锁释放后串行 flush 应仍可保存');
        assert.strictEqual(stubState.saveCalls, 1, '串行再次保存应产生一次新的底层保存（锁不得粘住）');
        console.log('PASS: KEEPALIVE-03 真实锁结算释放');

        console.log('=== KEEPALIVE-04: 退出接线与 keepalive 选型静态锁定 ===');
        const chatStoreSource = readFileSync(path.join(repoRoot, 'stores', 'chatStore.ts'), 'utf8');
        assert.ok(chatStoreSource.includes('beforeunload'), '必须保留 beforeunload 退出 flush');
        assert.ok(chatStoreSource.includes('pagehide'), '必须保留 pagehide 退出 flush');
        assert.ok(chatStoreSource.includes('flushPendingSave'), '退出接线必须委托 flushPendingSave');
        assert.ok(chatStoreSource.includes('keepalive'), '必须包含 keepalive 选型（fetch keepalive）');
        assert.ok(
            chatStoreSource.includes('flushInFlight') || chatStoreSource.includes('inFlight'),
            '必须包含在途去重锁',
        );
        console.log('PASS: KEEPALIVE-04 接线锁定');

        console.log('\nALL KEEPALIVE DEDUP TESTS PASSED SUCCESSFULLY!');
    } finally {
        // 中文注释：还原全局 fetch/window，复位 store，避免跨 suite 污染（各 suite 独进程，此处为 hygiene）。
        try {
            (globalThis as unknown as Record<string, unknown>).fetch = originalFetch as unknown;
        } catch {
            // 中文注释：还原失败忽略。
        }
        try {
            if (originalWindow === undefined) {
                delete (globalThis as unknown as Record<string, unknown>).window;
            } else {
                (globalThis as unknown as Record<string, unknown>).window = originalWindow as unknown;
            }
        } catch {
            // 中文注释：还原失败忽略。
        }
        try {
            useChatStore.getState().reset();
        } catch {
            // 中文注释：复位失败忽略。
        }
    }
}

const testPromise = runKeepaliveDedupTests()
    .then(() => {
        console.log('ALL KEEPALIVE DEDUP TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Keepalive dedup test failed:', error);
        process.exit(1);
    });

export default testPromise;
