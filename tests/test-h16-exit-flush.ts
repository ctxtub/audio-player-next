import assert from 'node:assert';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// 中文注释：H-16 快速退出丢尾部回归——退出时必须同步落盘 pending 行，失败置标记位不静默丢。
// 覆盖：flush 立即可用（不等 1s 防抖）/ 在途 sending 下仍落盘已完结前缀 / 失败置位且可恢复。
// 全程内存打桩，不建 socket、不绑端口，不碰 prisma/dev.db 与既有 .e2e-runtime 资产。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：预置 GlassToast 打桩，避免 store 失败路径触真实 UI 依赖。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

// 中文注释：会话落库可控桩——成功态记录 payload；失败态抛 TRPCError 供标记位断言。
import { TRPCError } from '../lib/trpc/init';
let saveMode: 'success' | 'fail' = 'success';
type ChatMessageInputLike = { messageId: string; role: string; content: string };
const savedSnapshots: ChatMessageInputLike[][] = [];
const chatConversationPath = path.resolve(process.cwd(), 'lib/client/chatConversation.ts');
nodeRequire.cache[chatConversationPath] = {
    id: chatConversationPath,
    filename: chatConversationPath,
    loaded: true,
    exports: {
        fetchMyConversation: async () => [],
        saveMyConversation: async (messages: ChatMessageInputLike[]) => {
            if (saveMode === 'fail') {
                throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '探针保存失败' });
            }
            savedSnapshots.push(messages);
            return { ok: true };
        },
    },
} as unknown as NodeModule;

const chatStoreModule = nodeRequire('../stores/chatStore') as Record<string, unknown>;
const { useChatStore } = chatStoreModule as {
    useChatStore: typeof import('../stores/chatStore').useChatStore;
};

// 中文注释：重置聊天 store 到干净基线并开启同步。
function resetBaseline(): void {
    useChatStore.getState().reset();
    useChatStore.setState({ syncEnabled: true });
    savedSnapshots.length = 0;
    saveMode = 'success';
}

// 中文注释：构造一条已完结的用户与助手消息对，模拟刚投递的尾部。
function seedDeliveredTail(): void {
    const now = new Date().toISOString();
    useChatStore.setState({
        messages: [
            {
                id: 'h16-user-1',
                role: 'user',
                content: '尾部问题',
                status: 'delivered',
                createdAt: now,
            },
            {
                id: 'h16-assistant-1',
                role: 'assistant',
                content: '尾部回答',
                status: 'delivered',
                createdAt: now,
            },
        ],
        syncEnabled: true,
    });
}

async function runH16Tests(): Promise<void> {
    console.log('=== H-16-01: 退出 flush 立即落盘尾部（不等防抖）===');
    resetBaseline();
    assert.strictEqual(
        typeof useChatStore.getState().flushPendingSave,
        'function',
        'RED: chatStore 必须暴露 flushPendingSave 供退出时同步落盘',
    );
    seedDeliveredTail();
    savedSnapshots.length = 0;
    // 中文注释：投递后 200ms 内退出——直接 flush，不等待 1s 防抖定时器。
    await new Promise((resolve) => setTimeout(resolve, 200));
    const flushed = await useChatStore.getState().flushPendingSave();
    assert.strictEqual(flushed, true, '登录态下 flush 应执行保存并返回 true');
    assert.strictEqual(savedSnapshots.length, 1, 'flush 应立即产生一次保存（不等防抖）');
    assert.ok(
        savedSnapshots[0].some((message) => message.content === '尾部回答'),
        'flush 保存必须包含尾部回答',
    );
    console.log('PASS: H-16-01 exit flush retains tail');

    console.log('=== H-16-02: 在途 sending 下仍落盘已完结前缀 ===');
    resetBaseline();
    seedDeliveredTail();
    // 中文注释：模拟新一轮发送在途（sending 占位），旧防抖会整单跳过；flush 必须仍落盘已完结前缀。
    useChatStore.getState().dispatch({ type: 'user.submit', content: '在途问题' });
    savedSnapshots.length = 0;
    const flushedDuringSending = await useChatStore.getState().flushPendingSave();
    assert.strictEqual(flushedDuringSending, true, '在途时 flush 仍应落盘已完结前缀');
    assert.strictEqual(savedSnapshots.length, 1, '在途时 flush 应产生一次保存');
    assert.ok(
        savedSnapshots[0].some((message) => message.content === '尾部回答'),
        '在途时 flush 必须保留已完结尾部',
    );
    assert.ok(
        !savedSnapshots[0].some((message) => message.content === '在途问题'),
        '在途 sending 消息不得进入快照',
    );
    console.log('PASS: H-16-02 flush saves delivered prefix while sending');

    console.log('=== H-16-03: 保存失败置标记位且可恢复（不静默丢）===');
    resetBaseline();
    seedDeliveredTail();
    assert.ok(
        'saveError' in useChatStore.getState(),
        'RED: chatStore 必须暴露 saveError 标记位',
    );
    assert.strictEqual(useChatStore.getState().saveError, null, '基线 saveError 应为 null');
    saveMode = 'fail';
    const failResult = await useChatStore.getState().flushPendingSave();
    assert.strictEqual(failResult, false, '保存失败时 flush 应返回 false');
    const failureMark = useChatStore.getState().saveError as unknown;
    assert.ok(
        typeof failureMark === 'string' && failureMark.length > 0,
        '保存失败必须置 saveError 标记位（不静默丢）',
    );
    saveMode = 'success';
    const retryResult = await useChatStore.getState().flushPendingSave();
    assert.strictEqual(retryResult, true, '恢复后 flush 应成功');
    assert.strictEqual(useChatStore.getState().saveError, null, '成功后标记位应清除');
    console.log('PASS: H-16-03 failure flag and recovery');

    console.log('=== H-16-04: 退出事件接线静态锁定 ===');
    const chatStoreSource = readFileSync(path.join(process.cwd(), 'stores', 'chatStore.ts'), 'utf8');
    assert.ok(chatStoreSource.includes('beforeunload'), 'RED: 必须注册 beforeunload 退出 flush');
    assert.ok(chatStoreSource.includes('pagehide'), 'RED: 必须注册 pagehide 退出 flush');
    assert.ok(
        chatStoreSource.includes('flushPendingSave'),
        '退出接线必须委托给 flushPendingSave',
    );
    console.log('PASS: H-16-04 exit wiring locked');

    console.log('\nALL H-16 EXIT FLUSH TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runH16Tests()
    .then(() => {
        console.log('ALL H-16 EXIT FLUSH TEST CASES PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Test execution failed:', error);
        process.exit(1);
    })
    .finally(() => {
        useChatStore.getState().reset();
    });

export default testPromise;
