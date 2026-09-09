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
 */

const COMPOSER_PATH = path.join(
    process.cwd(),
    'app/(main)/chat/components/Composer/Composer.tsx',
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
