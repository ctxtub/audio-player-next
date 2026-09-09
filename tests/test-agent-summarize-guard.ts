import assert from 'node:assert';
import fs from 'node:fs';
import { TRPCError } from '../lib/trpc/init';
import { createContext } from '../lib/trpc/context';
import type { Context } from '../lib/trpc/context';
import { agentRouter } from '../lib/trpc/routers/agent';
import { encodeSession, encodeGuestId } from '../lib/session';
import * as summaryModule from '../lib/agent/nodes/summary';

process.env.SESSION_SECRET = 'test-secret-summarize-guard-12345';

// 中文注释：R19 回归测试——agent.summarize 必须是 guardedProcedure（匿名 401），
// 且受 enforceProcedureRateLimit 保护（guest 6 / authed 20）。测试全程不真调 LLM：
// 空消息数组在命中 LLM 前直接返回 ""；非空数组走 monkey-patch 后的 mock。

async function runSummarizeGuardTests() {
    console.log('--- 1. 匿名调用 summarize 必须 401 UNAUTHORIZED（且不触达 LLM） ---');
    const anonCtx = await createContext({
        req: new Request('http://localhost:3000/api/trpc'),
    });
    assert.strictEqual(anonCtx.session, null);
    assert.strictEqual(anonCtx.isGuest, false);
    const anonCaller = agentRouter.createCaller(anonCtx);

    // 用非空消息断言：若守卫缺失会继续走到 LLM（mock 计数器可感知），401 则直接拒绝。
    let llmCalls = 0;
    const originalSummarize = summaryModule.summarizeContext;
    (summaryModule as unknown as Record<string, unknown>).summarizeContext = async () => {
        llmCalls += 1;
        return 'mock-summary-should-not-happen-for-anon';
    };
    try {
        await assert.rejects(
            async () => {
                await anonCaller.summarize({
                    messages: [{ role: 'user', content: '请总结这段话' }],
                });
            },
            (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
            '匿名调用 summarize 必须返回 UNAUTHORIZED（401）'
        );
        assert.strictEqual(llmCalls, 0, '匿名请求必须在守卫层被拒，不得触达 LLM');
    } finally {
        (summaryModule as unknown as Record<string, unknown>).summarizeContext = originalSummarize;
    }
    console.log('PASS: 匿名 summarize 被拒 401 且零 LLM 调用');

    console.log('--- 2. 具名访客与登录用户放行（mock LLM，不真调） ---');
    const guestValue = encodeGuestId('g_summarize_test');
    const guestCtx = await createContext({
        req: new Request('http://localhost:3000/api/trpc', {
            headers: { cookie: `guest=${guestValue}` },
        }),
    });
    assert.strictEqual(guestCtx.isGuest, true, '签名访客上下文 isGuest 应为 true');
    const authedCtx = await createContext({
        req: new Request('http://localhost:3000/api/trpc', {
            headers: { cookie: `auth=${encodeSession(7, 'SummTester')}` },
        }),
    });
    assert.deepStrictEqual(authedCtx.session, { userId: 7, nickname: 'SummTester' });

    const mocked = summaryModule.summarizeContext;
    let mockCalls = 0;
    (summaryModule as unknown as Record<string, unknown>).summarizeContext = async () => {
        mockCalls += 1;
        return 'mock-summary-ok';
    };
    try {
        const guestResult = await agentRouter
            .createCaller(guestCtx)
            .summarize({ messages: [{ role: 'user', content: 'hello' }] });
        assert.strictEqual(guestResult, 'mock-summary-ok', '访客 summarize 应放行并返回总结');
        const authedResult = await agentRouter
            .createCaller(authedCtx)
            .summarize({ messages: [{ role: 'user', content: 'hello' }] });
        assert.strictEqual(authedResult, 'mock-summary-ok', '登录用户 summarize 应放行并返回总结');
        assert.strictEqual(mockCalls, 2, '访客+登录各一次，共 2 次 mock LLM 调用');
    } finally {
        (summaryModule as unknown as Record<string, unknown>).summarizeContext = mocked;
    }
    console.log('PASS: 访客与登录用户均放行（mock LLM）');

    console.log('--- 3. 静态审计：summarize 为 guardedProcedure + agent:summarize 限流 ---');
    const agentContent = fs.readFileSync('lib/trpc/routers/agent.ts', 'utf-8');
    assert(
        agentContent.includes('summarize: guardedProcedure'),
        'agent.summarize 必须是 guardedProcedure'
    );
    assert(
        !agentContent.includes('summarize: publicProcedure'),
        'agent.summarize 不得是 publicProcedure'
    );
    assert(
        agentContent.includes('agent:summarize'),
        'summarize 必须接入 agent:summarize 限流键'
    );
    assert(agentContent.includes('guestLimit: 6'), '访客 summarize 限额应为每分钟 6 次');
    assert(agentContent.includes('authedLimit: 20'), '登录用户 summarize 限额应为每分钟 20 次');
    console.log('PASS: 静态审计通过');

    console.log('--- 4. 限流：访客 6 次放行、第 7 次 429；登录 20 次放行、第 21 次 429 ---');
    // 中文注释：空消息数组在限流检查之后、LLM 调用之前直接返回 ""，故可零 LLM 成本测限流。
    // 使用独立 clientIp / guestId，与其他用例共享的全局限流器隔离。
    const rateGuestCtx: Context = {
        session: null,
        guestId: 'g_summarize_rate',
        isGuest: true,
        clientIp: '10.200.9.1',
    };
    const rateGuestCaller = agentRouter.createCaller(rateGuestCtx);
    for (let i = 0; i < 6; i++) {
        const r = await rateGuestCaller.summarize({ messages: [] });
        assert.strictEqual(r, '', `访客第 ${i + 1} 次应放行`);
    }
    await assert.rejects(
        async () => {
            await rateGuestCaller.summarize({ messages: [] });
        },
        (err: unknown) => err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS',
        '访客第 7 次必须 429 TOO_MANY_REQUESTS'
    );

    const rateAuthedCtx: Context = {
        session: { userId: 9001, nickname: 'RateTester' },
        guestId: null,
        isGuest: false,
        clientIp: '10.200.9.2',
    };
    const rateAuthedCaller = agentRouter.createCaller(rateAuthedCtx);
    for (let i = 0; i < 20; i++) {
        const r = await rateAuthedCaller.summarize({ messages: [] });
        assert.strictEqual(r, '', `登录用户第 ${i + 1} 次应放行`);
    }
    await assert.rejects(
        async () => {
            await rateAuthedCaller.summarize({ messages: [] });
        },
        (err: unknown) => err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS',
        '登录用户第 21 次必须 429 TOO_MANY_REQUESTS'
    );
    console.log('PASS: summarize 限流（guest 6 / authed 20）生效');

    console.log('ALL SUMMARIZE GUARD TESTS PASSED');
}

const testPromise = runSummarizeGuardTests()
    .then(() => {
        console.log('ALL SUMMARIZE GUARD TESTS PASSED (done)');
    })
    .catch((err) => {
        console.error('Test failed:', err);
        process.exit(1);
    });

export default testPromise;
