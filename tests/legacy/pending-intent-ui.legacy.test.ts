import assert from 'node:assert';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// 中文注释：02-02 UX——发送中点击推荐仍预填输入框 + toast“正在生成，完成后自动发送”+ 生成结束重触发消费 pending。
// 组件级渲染需 DOM，在 jiti/node 运行器下成本过高；沿用 H-04 同范式——源码级静态断言接线 + 与副作用同语义的仿真。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
const toastCalls: Array<{ icon?: string; content?: string }> = [];
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: { default: { show: (opts: { icon?: string; content?: string }) => { toastCalls.push(opts); }, clear: () => {} } },
} as unknown as NodeModule;

const { useChatStore } = nodeRequire('../../stores/chatStore') as {
    useChatStore: typeof import('../../stores/chatStore').useChatStore;
};

const CHAT_LAYOUT_PATH = path.join(
    process.cwd(),
    'app/(main)/chat/components/ChatLayout/index.tsx',
);

function readChatLayoutSource(): string {
    return readFileSync(CHAT_LAYOUT_PATH, 'utf8');
}

// 中文注释：检测发送中点击是否预填 + 暂存 pending + 新 toast（缺一不可）。
function detectSendingPrefillAndQueue(source: string): boolean {
    const handlerIdx = source.indexOf('handleSuggestionSelect');
    if (handlerIdx === -1) {
        return false;
    }
    const body = source.slice(handlerIdx, handlerIdx + 1200);
    const hasNewToast = body.includes('正在生成，完成后自动发送');
    const hasPrefill = body.includes('setInputValue(value)');
    const hasQueue = body.includes('setPendingAutoSend(value)') || body.includes('setPendingAutoSend(pending)');
    const sendingGuard = body.includes('isSending') && body.includes('if (isSending)');
    return hasNewToast && hasPrefill && hasQueue && sendingGuard;
}

// 中文注释：检测 pending 消费副作用是否具备“生成结束重触发”（依赖含 isSending，发送结束会重跑消费）。
function detectRetriggerOnIdle(source: string): boolean {
    const anchor = 'useChatStore.getState().pendingAutoSend';
    const anchorIdx = source.indexOf(anchor);
    if (anchorIdx === -1) {
        return false;
    }
    // 取包含该消费点的 useEffect 全段（向前找 useEffect，向后找 deps 数组）。
    const effectStart = source.lastIndexOf('useEffect', anchorIdx);
    if (effectStart === -1) {
        return false;
    }
    const tail = source.slice(effectStart, effectStart + 1500);
    const hasSendingCheck =
        tail.includes("status === 'sending'") || tail.includes('status === "sending"') || tail.includes('isSending');
    const depsMatch = /\[\s*[^\]]*isSending[^\]]*\]/.test(tail);
    const hasConsume =
        tail.includes('setPendingAutoSend(null)') && tail.includes('handleSubmit(pending)');
    return hasSendingCheck && depsMatch && hasConsume;
}

// 中文注释：复刻 handleSuggestionSelect 语义（接线由源码检测派生：有新接线走预填+暂存+新 toast，否则走旧拦截）。
function emulateSuggestionSelect(wired: boolean, value: string): 'queued' | 'blocked' | 'filled' {
    const isSending = useChatStore.getState().messages.some((m) => m.status === 'sending');
    const show = (nodeRequire.cache[glassToastPath]?.exports as unknown as {
        default: { show: (o: { icon?: string; content?: string }) => void };
    }).default.show;
    if (isSending) {
        if (wired) {
            useChatStore.getState().setInputValue(value);
            useChatStore.getState().setPendingAutoSend(value);
            show({ icon: 'fail', content: '正在生成，完成后自动发送' });
            return 'queued';
        }
        show({ icon: 'fail', content: '正在生成回答，请稍后再试' });
        return 'blocked';
    }
    useChatStore.getState().setInputValue(value);
    return 'filled';
}

// 中文注释：复刻 pending 消费副作用语义（发送中跳过保留待发，非发送中消费并提交）。
function emulatePendingEffect(submit: (content: string) => void): 'sent' | 'skipped-sending' | 'skipped-empty' {
    const pending = useChatStore.getState().pendingAutoSend;
    if (!pending) {
        return 'skipped-empty';
    }
    const sending = useChatStore.getState().messages.some((m) => m.status === 'sending');
    if (sending) {
        return 'skipped-sending';
    }
    useChatStore.getState().setPendingAutoSend(null);
    useChatStore.getState().setInputValue(pending);
    submit(pending);
    return 'sent';
}

async function run0202W2Tests(): Promise<void> {
    console.log('=== 02-02-W2-01: 发送中点击接线锁定（预填 + 暂存 + 新 toast）===');
    {
        const source = readChatLayoutSource();
        assert.ok(
            source.includes('正在生成，完成后自动发送'),
            'RED: 发送中点击必须 toast“正在生成，完成后自动发送”',
        );
        assert.ok(
            detectSendingPrefillAndQueue(source),
            'RED: 发送中点击必须预填输入框（setInputValue）+ 暂存 pending（setPendingAutoSend）+ isSending 守卫',
        );
    }
    console.log('PASS: 02-02-W2-01 sending-click wiring locked');

    console.log('=== 02-02-W2-02: 发送中点击行为（预填可见 + 待发保留 + 新 toast）===');
    {
        const wired = detectSendingPrefillAndQueue(readChatLayoutSource());
        useChatStore.getState().reset();
        useChatStore.getState().setPendingAutoSend(null);
        useChatStore.getState().dispatch({ type: 'user.submit', content: '进行中的提问-0202W2' });
        toastCalls.length = 0;
        const result = emulateSuggestionSelect(wired, '星际冒险探针');
        assert.strictEqual(result, 'queued', `发送中点击应排队待发，实际 ${result}（wired=${wired}）`);
        assert.strictEqual(
            useChatStore.getState().inputValue,
            '星际冒险探针',
            'RED: 发送中点击必须预填输入框（输入框即时可见用户意图）',
        );
        assert.strictEqual(
            useChatStore.getState().pendingAutoSend,
            '星际冒险探针',
            'RED: 发送中点击必须暂存 pending 待生成结束自动发送',
        );
        assert.ok(
            toastCalls.some((c) => c.content === '正在生成，完成后自动发送'),
            'RED: 发送中点击必须 toast 新文案',
        );
        useChatStore.getState().reset();
        useChatStore.getState().setPendingAutoSend(null);
        toastCalls.length = 0;
    }
    console.log('PASS: 02-02-W2-02 sending-click queues with prefill');

    console.log('=== 02-02-W2-03: 生成结束重触发消费 pending（保留语义 + 自动补发）===');
    {
        const retriggerWired = detectRetriggerOnIdle(readChatLayoutSource());
        assert.ok(
            retriggerWired,
            'RED: pending 消费副作用必须依赖 isSending，生成结束重触发消费（deps 含 isSending + sending 守卫 + handleSubmit(pending)）',
        );
        // 中文注释：先复刻发送中到达 pending（跳过保留），再结束生成重跑副作用（补发）。
        useChatStore.getState().reset();
        useChatStore.getState().setPendingAutoSend(null);
        useChatStore.getState().dispatch({ type: 'user.submit', content: '进行中的提问-重触发' });
        useChatStore.getState().setPendingAutoSend('排队待发-重触发');
        let submitCalls = 0;
        let submittedContent = '';
        const whileSending = emulatePendingEffect(() => { submitCalls += 1; });
        assert.strictEqual(whileSending, 'skipped-sending', '发送中必须跳过且保留待发');
        assert.strictEqual(submitCalls, 0, '发送中不得旁路提交');
        assert.strictEqual(useChatStore.getState().pendingAutoSend, '排队待发-重触发', '跳过时不得消费 pending');
        // 中文注释：结束生成（finish 置完结），复刻 isSending 翻转后副作用重跑。
        useChatStore.getState().dispatch({
            type: 'stream.finish',
            payload: { type: 'done', finishReason: 'stop' },
        } as Parameters<ReturnType<typeof useChatStore.getState>['dispatch']>[0]);
        const afterIdle = emulatePendingEffect((content) => {
            submitCalls += 1;
            submittedContent = content;
        });
        assert.strictEqual(afterIdle, 'sent', '生成结束后重触发必须自动发送');
        assert.strictEqual(submitCalls, 1, '重触发必须恰好提交一次');
        assert.strictEqual(submittedContent, '排队待发-重触发', '提交内容必须为排队原文');
        assert.strictEqual(useChatStore.getState().pendingAutoSend, null, '发送后必须消费 pending（仅一次）');
        assert.strictEqual(useChatStore.getState().inputValue, '排队待发-重触发', '发送前必须预填输入框');
        useChatStore.getState().reset();
        useChatStore.getState().setPendingAutoSend(null);
    }
    console.log('PASS: 02-02-W2-03 retrigger on idle');

    console.log('=== 02-02-W2-04: 非发送中点击与自动发送行为不变（无回归）===');
    {
        const wired = detectSendingPrefillAndQueue(readChatLayoutSource());
        useChatStore.getState().reset();
        useChatStore.getState().setPendingAutoSend(null);
        const idleResult = emulateSuggestionSelect(wired, '空闲预填探针');
        assert.strictEqual(idleResult, 'filled', '空闲点击应直接预填');
        assert.strictEqual(useChatStore.getState().inputValue, '空闲预填探针', '空闲预填必须写入输入框');
        assert.strictEqual(useChatStore.getState().pendingAutoSend, null, '空闲点击不得误设 pending');
        useChatStore.getState().reset();
        useChatStore.getState().setPendingAutoSend('跨页探针-0202W2');
        let submitCalls = 0;
        const autoResult = emulatePendingEffect(() => { submitCalls += 1; });
        assert.strictEqual(autoResult, 'sent', '非发送中 pending 必须正常自动发送');
        assert.strictEqual(submitCalls, 1, '必须恰好提交一次');
        useChatStore.getState().reset();
        useChatStore.getState().setPendingAutoSend(null);
    }
    console.log('PASS: 02-02-W2-04 idle behavior unchanged');

    console.log('\nALL 02-02-W2 TESTS PASSED SUCCESSFULLY!');
}

const testPromise = run0202W2Tests()
    .then(() => {
        console.log('ALL 02-02-W2 TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('02-02-W2 test failed:', error);
        process.exit(1);
    });

export default testPromise;
