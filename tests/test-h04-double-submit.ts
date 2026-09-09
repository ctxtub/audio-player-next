import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TRPCError } from '../lib/trpc/init';
import { useChatStore } from '../stores/chatStore';

/**
 * H-04 回归测试——Composer 同帧双发防重（P0）。
 *
 * 缺陷：Composer.tsx 仅用 useState 锁（isLocalSending / effectiveDisabled），
 * setState 在同 tick 内不可见，同帧双 Enter 会各走完整提交流（2 倍 token＋入库＋双续写链）。
 * 修法：加 useRef 同步锁（与 isLocalSending 双保险），不改提交语义。
 *
 * 取舍：组件级渲染测试需 DOM，在 jiti/node 运行器下成本过高；采用与
 * R15 接线锁同范式——源码级静态断言锁接线＋与 handleSubmit 同语义的提交门仿真
 * 复刻闭包快照行为（state 置位同 tick 内不可见、ref 置位同步可见），门模式由源码
 * 检测结果派生：无同步锁时仿真走 state-only（复现双发，RED），有锁时走
 * state-plus-ref（单次提交，GREEN）。
 *
 * 附带 02-02（同文件域顺手覆盖）：ChatLayout pendingAutoSend 消费副作用无
 * sending 守卫。回归要求发送中时不旁路提交且保留待发，非发送中时自动发送
 * 行为不变（一次提交并消费、预填输入框）；守卫有无同样由源码检测派生。
 */

const COMPOSER_PATH = path.join(
    process.cwd(),
    'app/(main)/chat/components/Composer/Composer.tsx',
);

/**
 * ChatLayout 源码路径（pendingAutoSend 跨页自动发送消费点）。
 */
const CHAT_LAYOUT_PATH = path.join(
    process.cwd(),
    'app/(main)/chat/components/ChatLayout/index.tsx',
);

/**
 * 读取 Composer 源码。
 * @returns Composer.tsx 全文。
 */
function readComposerSource(): string {
    return readFileSync(COMPOSER_PATH, 'utf8');
}

/**
 * 检测 Composer 是否具备 useRef 同步提交锁（与 isLocalSending 双保险）。
 * 要求同时满足：声明 useRef(false)；handleSubmit 内先查锁再置锁；
 * 置锁先于 setIsLocalSending(true)；finally 内释放锁。
 * @param source Composer.tsx 全文。
 * @returns 具备完整同步锁接线时为 true。
 */
function detectComposerSyncLock(source: string): boolean {
    const refDecl = /const\s+([A-Za-z_$][\w$]*)\s*=\s*useRef\s*\(\s*false\s*\)/.exec(source);
    if (!refDecl) {
        return false;
    }
    const lockName = refDecl[1];
    const handleIdx = source.indexOf('const handleSubmit');
    if (handleIdx === -1) {
        return false;
    }
    const body = source.slice(handleIdx);
    const checkIdx = body.indexOf(`${lockName}.current`);
    const setTrueIdx = body.indexOf(`${lockName}.current = true`);
    const setSendingIdx = body.indexOf('setIsLocalSending(true)');
    const finallyIdx = body.indexOf('finally');
    const resetIdx = body.indexOf(`${lockName}.current = false`);
    return (
        checkIdx !== -1 &&
        setTrueIdx !== -1 &&
        setSendingIdx !== -1 &&
        checkIdx < setTrueIdx &&
        setTrueIdx < setSendingIdx &&
        finallyIdx !== -1 &&
        resetIdx > finallyIdx
    );
}

/**
 * 提交门模式：state-only 复刻修复前的 useState 单锁；state-plus-ref 复刻修复后的双保险。
 */
type SubmitGateMode = 'state-only' | 'state-plus-ref';

/**
 * 创建与 Composer.handleSubmit 同语义的提交门仿真。
 * 守卫只读 render 快照（复刻 effectiveDisabled 闭包旧值语义：同 tick 内第二次调用
 * 看到的仍是旧值）；state 置位同 tick 内不可见，ref 置位同步可见。
 * @param mode 门模式，由源码检测结果派生。
 * @param onSubmit 提交回调，模拟上层 beginChatStream。
 * @returns 提交门实例。
 */
function createSubmitGate(
    mode: SubmitGateMode,
    onSubmit: (content: string) => Promise<void>,
): {
    /** 单次提交尝试，返回 submitted 或 blocked。 */
    submitOnce: () => Promise<'submitted' | 'blocked'>;
} {
    /** render 快照：同 tick 内两次调用共享同一份 effectiveDisabled 闭包值。 */
    const snapshotDisabled = false;
    /** ref 侧同步锁，置位后同 tick 内立即可见。 */
    let refLocked = false;
    const submitOnce = async (): Promise<'submitted' | 'blocked'> => {
        if (mode === 'state-plus-ref' && refLocked) {
            return 'blocked';
        }
        if (snapshotDisabled) {
            return 'blocked';
        }
        if (mode === 'state-plus-ref') {
            refLocked = true;
        }
        try {
            useChatStore.getState().dispatch({ type: 'user.submit', content: 'H-04 双发探针' });
            await onSubmit('H-04 双发探针');
            return 'submitted';
        } finally {
            if (mode === 'state-plus-ref') {
                refLocked = false;
            }
        }
    };
    return { submitOnce };
}

/**
 * 由源码检测结果派生提交门模式。
 * @param source Composer.tsx 全文。
 * @returns 有同步锁时为 state-plus-ref，否则为 state-only。
 */
function modeFromSource(source: string): SubmitGateMode {
    return detectComposerSyncLock(source) ? 'state-plus-ref' : 'state-only';
}

/**
 * 读取 ChatLayout 源码。
 * @returns ChatLayout/index.tsx 全文。
 */
function readChatLayoutSource(): string {
    return readFileSync(CHAT_LAYOUT_PATH, 'utf8');
}

/**
 * 检测 pendingAutoSend 消费副作用是否具备 sending 守卫。
 * 要求在取 pending 与 handleSubmit(pending) 之间存在发送中判定，
 * 且判定位于提交之前（旁路不得先提交后检查）。
 * @param source ChatLayout/index.tsx 全文。
 * @returns 具备最小守卫时为 true。
 */
function detectPendingAutoSendGuard(source: string): boolean {
    const anchor = 'useChatStore.getState().pendingAutoSend';
    const anchorIdx = source.indexOf(anchor);
    if (anchorIdx === -1) {
        return false;
    }
    const tail = source.slice(anchorIdx, anchorIdx + 800);
    const submitIdx = tail.indexOf('handleSubmit(pending)');
    if (submitIdx === -1) {
        return false;
    }
    const head = tail.slice(0, submitIdx);
    return (
        head.includes("status === 'sending'") ||
        head.includes('status === "sending"') ||
        head.includes('isSending')
    );
}

/**
 * 复刻 ChatLayout pendingAutoSend 消费副作用的判定语义，守卫有无由源码检测派生。
 * @param guarded 源码是否具备 sending 守卫。
 * @param submit 模拟 handleSubmit 的提交回调。
 * @returns 消费结果：已发送 / 发送中跳过 / 无待发。
 */
function emulatePendingAutoSendEffect(
    guarded: boolean,
    submit: (content: string) => void,
): 'sent' | 'skipped-sending' | 'skipped-empty' {
    const pending = useChatStore.getState().pendingAutoSend;
    if (!pending) {
        return 'skipped-empty';
    }
    if (guarded) {
        const sending = useChatStore.getState().messages.some((message) => message.status === 'sending');
        if (sending) {
            return 'skipped-sending';
        }
    }
    useChatStore.getState().setPendingAutoSend(null);
    useChatStore.getState().setInputValue(pending);
    submit(pending);
    return 'sent';
}

async function runH04DoubleSubmitTests(): Promise<void> {
    console.log('=== H-04-01: 同 tick 双 Enter 只产生一次提交/一次入库 ===');
    {
        const mode = modeFromSource(readComposerSource());
        useChatStore.getState().reset();
        let onSubmitCalls = 0;
        const gate = createSubmitGate(mode, async () => {
            onSubmitCalls += 1;
        });
        // 中文注释：同 tick 双发——两次调用之间不 await，复刻双 Enter 同帧到达。
        const first = gate.submitOnce();
        const second = gate.submitOnce();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.strictEqual(
            onSubmitCalls,
            1,
            `同 tick 双发必须只提交一次，实际提交 ${onSubmitCalls} 次（${firstResult}/${secondResult}，mode=${mode}）`,
        );
        const userMessages = useChatStore
            .getState()
            .messages.filter((message) => message.role === 'user');
        assert.strictEqual(
            userMessages.length,
            1,
            `同 tick 双发必须只入库一条用户消息，实际 ${userMessages.length} 条（mode=${mode}）`,
        );
        useChatStore.getState().reset();
    }
    console.log('PASS: H-04-01 同 tick 双发单次提交/单次入库');

    console.log('=== H-04-02: Composer 源码级同步锁接线锁定 ===');
    {
        const source = readComposerSource();
        assert.ok(
            /const\s+[A-Za-z_$][\w$]*\s*=\s*useRef\s*\(\s*false\s*\)/.test(source),
            '必须声明 useRef(false) 同步提交锁',
        );
        assert.ok(
            detectComposerSyncLock(source),
            '同步锁必须在 handleSubmit 内先查后置、置锁先于 setIsLocalSending(true)、finally 内释放',
        );
        assert.ok(
            source.includes('isLocalSending'),
            '须保留 isLocalSending state 侧锁（与 ref 双保险，不得删其一）',
        );
        assert.ok(
            source.includes('disabled || isSending || isLocalSending'),
            'effectiveDisabled 须保留三源合并（外部禁用/上层发送中/本地发送中）',
        );
        const keyDownIdx = source.indexOf('const handleKeyDown');
        assert.ok(keyDownIdx !== -1, '须保留 handleKeyDown 快捷提交入口');
        const keyDownBody = source.slice(keyDownIdx);
        assert.ok(
            keyDownBody.includes('void handleSubmit()'),
            '键盘入口必须经 handleSubmit 单一 choke 点提交（守卫不得被旁路）',
        );
        assert.ok(
            !keyDownBody.slice(0, keyDownBody.indexOf('void handleSubmit()')).includes('onSubmit('),
            '键盘入口在到达 handleSubmit 前不得直调 onSubmit',
        );
    }
    console.log('PASS: H-04-02 同步锁接线锁定');

    console.log('=== H-04-03: 提交失败（TRPCError）后锁必须释放，不改提交语义 ===');
    {
        const mode = modeFromSource(readComposerSource());
        useChatStore.getState().reset();
        let shouldFail = true;
        const gate = createSubmitGate(mode, async () => {
            if (shouldFail) {
                throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '发送过于频繁，请稍后再试' });
            }
        });
        await assert.rejects(
            () => gate.submitOnce(),
            (error: unknown) =>
                error instanceof TRPCError && error.code === 'TOO_MANY_REQUESTS',
            '提交失败必须原样透出 TRPCError（取自 lib/trpc/init，不吞错）',
        );
        shouldFail = false;
        const retryResult = await gate.submitOnce();
        assert.strictEqual(
            retryResult,
            'submitted',
            '失败后同步锁必须已释放，允许用户重试提交（锁不得粘住）',
        );
        useChatStore.getState().reset();
    }
    console.log('PASS: H-04-03 失败释放锁且错误透出');

    console.log('=== 02-02-01: pendingAutoSend 消费副作用最小守卫接线锁定 ===');
    {
        const source = readChatLayoutSource();
        assert.ok(
            source.includes('useChatStore.getState().pendingAutoSend'),
            '须保留 pendingAutoSend 跨页自动发送消费点（仅消费一次）',
        );
        assert.ok(
            detectPendingAutoSendGuard(source),
            'pendingAutoSend 提交前必须具备 sending 守卫（发送中不得旁路自动发送）',
        );
        assert.ok(
            source.includes('handleSubmit(pending)'),
            '正常路径（非发送中）须保留 handleSubmit(pending) 自动发送行为',
        );
    }
    console.log('PASS: 02-02-01 最小守卫接线锁定');

    console.log('=== 02-02-02: 发送中时 pendingAutoSend 不得旁路提交且保留待发 ===');
    {
        const guarded = detectPendingAutoSendGuard(readChatLayoutSource());
        useChatStore.getState().reset();
        useChatStore.getState().setPendingAutoSend(null);
        // 中文注释：制造一条发送中消息，复刻生成进行中的 store 现场。
        useChatStore.getState().dispatch({ type: 'user.submit', content: '进行中的提问' });
        useChatStore.getState().setPendingAutoSend('跨页自动发送探针');
        let submitCalls = 0;
        const result = emulatePendingAutoSendEffect(guarded, () => {
            submitCalls += 1;
        });
        assert.strictEqual(
            result,
            'skipped-sending',
            `发送中时必须跳过自动发送，实际 ${result}（guarded=${guarded}）`,
        );
        assert.strictEqual(
            submitCalls,
            0,
            `发送中时旁路提交必须为 0 次，实际 ${submitCalls} 次（guarded=${guarded}）`,
        );
        assert.strictEqual(
            useChatStore.getState().pendingAutoSend,
            '跨页自动发送探针',
            '发送中跳过时不得消费 pending（保留待发，不丢用户意图）',
        );
        useChatStore.getState().reset();
        useChatStore.getState().setPendingAutoSend(null);
    }
    console.log('PASS: 02-02-02 发送中旁路被拦且待发保留');

    console.log('=== 02-02-03: 非发送中时自动发送行为不变（一次提交并消费） ===');
    {
        const guarded = detectPendingAutoSendGuard(readChatLayoutSource());
        useChatStore.getState().reset();
        useChatStore.getState().setPendingAutoSend(null);
        useChatStore.getState().setPendingAutoSend('跨页自动发送探针');
        let submitCalls = 0;
        let submittedContent = '';
        const result = emulatePendingAutoSendEffect(guarded, (content) => {
            submitCalls += 1;
            submittedContent = content;
        });
        assert.strictEqual(result, 'sent', '非发送中时必须正常自动发送');
        assert.strictEqual(submitCalls, 1, '非发送中时必须恰好提交一次');
        assert.strictEqual(submittedContent, '跨页自动发送探针', '提交内容必须为 pending 原文');
        assert.strictEqual(
            useChatStore.getState().pendingAutoSend,
            null,
            '正常发送后必须消费 pending（仅一次）',
        );
        assert.strictEqual(
            useChatStore.getState().inputValue,
            '跨页自动发送探针',
            '正常发送前必须预填输入框（既有行为保留）',
        );
        useChatStore.getState().reset();
        useChatStore.getState().setPendingAutoSend(null);
    }
    console.log('PASS: 02-02-03 正常自动发送行为不变');

    console.log('\nALL H-04 DOUBLE-SUBMIT TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runH04DoubleSubmitTests()
    .then(() => {
        console.log('ALL H-04 DOUBLE-SUBMIT TEST CASES PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('H-04 double-submit test failed:', err);
        process.exit(1);
    });

export default testPromise;
