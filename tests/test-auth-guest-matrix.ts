import assert from 'node:assert';
import fs from 'node:fs';
import { router, guardedProcedure, authedProcedure, publicProcedure, TRPCError } from '../lib/trpc/init';
import { createContext, getSafeClientIp } from '../lib/trpc/context';
import { encodeSession } from '../lib/session';

process.env.SESSION_SECRET = 'test-secret-matrix-1234567890';

async function runMatrixTests() {
    console.log('--- 1. Testing Safe Client IP Extraction & Header Priority ---');
    assert.strictEqual(getSafeClientIp(null), '127.0.0.1', 'Null headers should fallback to 127.0.0.1');
    assert.strictEqual(getSafeClientIp(new Headers({})), '127.0.0.1', 'Empty headers should fallback to 127.0.0.1');

    // Multi-header precedence: cf-connecting-ip takes precedence over x-real-ip and x-forwarded-for
    const allHeaders = new Headers({
        'cf-connecting-ip': ' 192.0.2.1 ',
        'x-real-ip': ' 198.51.100.42 ',
        'x-forwarded-for': ' 203.0.113.195 , 70.41.3.18 ',
    });
    assert.strictEqual(
        getSafeClientIp(allHeaders),
        '192.0.2.1',
        'cf-connecting-ip must take precedence over x-real-ip and x-forwarded-for'
    );

    // Multi-header precedence: x-real-ip takes precedence over x-forwarded-for when cf-connecting-ip is absent
    const realIpAndXffHeaders = new Headers({
        'x-real-ip': ' 198.51.100.42 ',
        'x-forwarded-for': ' 203.0.113.195 , 70.41.3.18 ',
    });
    assert.strictEqual(
        getSafeClientIp(realIpAndXffHeaders),
        '198.51.100.42',
        'x-real-ip must take precedence over x-forwarded-for'
    );

    // Forged X-Forwarded-For alone (without trusted headers) yields its value only as last-resort fallback
    const forgedXffAloneHeaders = new Headers({
        'x-forwarded-for': ' 203.0.113.195 , 70.41.3.18, 150.172.238.178 ',
    });
    assert.strictEqual(
        getSafeClientIp(forgedXffAloneHeaders),
        '203.0.113.195',
        'Forged x-forwarded-for alone yields first trimmed IP as last-resort fallback'
    );

    // Single trusted headers extract correctly
    const cfAloneHeaders = new Headers({
        'cf-connecting-ip': ' 192.0.2.1 ',
    });
    assert.strictEqual(getSafeClientIp(cfAloneHeaders), '192.0.2.1', 'Should extract cf-connecting-ip when present alone');

    const xRealIpAloneHeaders = new Headers({
        'x-real-ip': ' 198.51.100.42 ',
    });
    assert.strictEqual(getSafeClientIp(xRealIpAloneHeaders), '198.51.100.42', 'Should extract x-real-ip when present alone');
    console.log('PASS: getSafeClientIp correctly enforces trusted header priority (cf > x-real-ip > x-forwarded-for)');

    console.log('--- 2. Testing Context Cookie Parsing ---');
    const validSessionCookie = encodeSession(42, 'Tester');

    // Anonymous
    const anonReq = new Request('http://localhost:3000/api/trpc');
    const anonCtx = await createContext({ req: anonReq });
    assert.strictEqual(anonCtx.session, null, 'Anon session must be null');
    assert.strictEqual(anonCtx.isGuest, false, 'Anon isGuest must be false');
    assert.strictEqual(anonCtx.clientIp, '127.0.0.1', 'Anon clientIp fallback');

    // Guest mode ('guest=1')
    const guestReq = new Request('http://localhost:3000/api/trpc', {
        headers: { cookie: 'guest=1', 'x-real-ip': '10.0.0.5' },
    });
    const guestCtx = await createContext({ req: guestReq });
    assert.strictEqual(guestCtx.session, null, 'Guest session must be null');
    assert.strictEqual(guestCtx.isGuest, true, 'isGuest must be true for guest=1');
    assert.strictEqual(guestCtx.clientIp, '10.0.0.5', 'Guest IP preserved');

    // Invalid guest value ('guest=0' or 'guest=true')
    const invalidGuestReq = new Request('http://localhost:3000/api/trpc', {
        headers: { cookie: 'guest=0' },
    });
    const invalidGuestCtx = await createContext({ req: invalidGuestReq });
    assert.strictEqual(invalidGuestCtx.isGuest, false, 'isGuest must be false for guest=0');

    // Authenticated
    const authedReq = new Request('http://localhost:3000/api/trpc', {
        headers: { cookie: `auth=${validSessionCookie}`, 'x-forwarded-for': '192.168.1.1' },
    });
    const authedCtx = await createContext({ req: authedReq });
    assert.deepStrictEqual(authedCtx.session, { userId: 42, nickname: 'Tester' }, 'Session must match decoded cookie');
    assert.strictEqual(authedCtx.clientIp, '192.168.1.1', 'Authed IP preserved');
    console.log('PASS: Context correctly differentiates Anonymous, Guest, and Authed');

    console.log('--- 3. Testing guardedProcedure vs authedProcedure Matrix ---');
    const testRouter = router({
        guardedPing: guardedProcedure.query(({ ctx }) => ({
            ok: true,
            isGuest: ctx.isGuest,
            userId: ctx.session?.userId ?? null,
        })),
        authedPing: authedProcedure.query(({ ctx }) => ({
            ok: true,
            userId: ctx.session.userId,
        })),
    });

    const callerAnon = testRouter.createCaller(anonCtx);
    const callerGuest = testRouter.createCaller(guestCtx);
    const callerAuthed = testRouter.createCaller(authedCtx);

    // Matrix Row 1: Anonymous
    await assert.rejects(
        async () => { await callerAnon.guardedPing(); },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
        'Anonymous must receive UNAUTHORIZED (401) on guardedProcedure'
    );
    await assert.rejects(
        async () => { await callerAnon.authedPing(); },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
        'Anonymous must receive UNAUTHORIZED (401) on authedProcedure'
    );

    // Matrix Row 2: Guest
    const guestResult = await callerGuest.guardedPing();
    assert.strictEqual(guestResult.ok, true, 'Guest should pass guardedProcedure');
    assert.strictEqual(guestResult.isGuest, true, 'Guest isGuest should be true');
    assert.strictEqual(guestResult.userId, null, 'Guest userId should be null');

    await assert.rejects(
        async () => { await callerGuest.authedPing(); },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
        'Guest must receive UNAUTHORIZED (401) on authedProcedure'
    );

    // Matrix Row 3: Authed
    const authedGuardedResult = await callerAuthed.guardedPing();
    assert.strictEqual(authedGuardedResult.ok, true, 'Authed should pass guardedProcedure');
    assert.strictEqual(authedGuardedResult.userId, 42, 'Authed userId preserved');

    const authedResult = await callerAuthed.authedPing();
    assert.strictEqual(authedResult.ok, true, 'Authed should pass authedProcedure');
    assert.strictEqual(authedResult.userId, 42, 'Authed userId preserved');

    console.log('PASS: Guarded matrix passed (Anonymous: 401/401, Guest: 200/401, Authed: 200/200)');

    console.log('--- 4. Static Audit: Personal Cloud Routers remain authedProcedure ---');
    const chatContent = fs.readFileSync('lib/trpc/routers/chatConversation.ts', 'utf-8');
    assert(chatContent.includes('getConversation: authedProcedure'), 'chat.getConversation must be authedProcedure');
    assert(chatContent.includes('saveConversation: authedProcedure'), 'chat.saveConversation must be authedProcedure');
    assert(!chatContent.includes('guardedProcedure'), 'chat must not use guardedProcedure');

    const genContent = fs.readFileSync('lib/trpc/routers/generationHistory.ts', 'utf-8');
    assert(genContent.includes('list: authedProcedure'), 'generationHistory.list must be authedProcedure');
    assert(genContent.includes('record: authedProcedure'), 'generationHistory.record must be authedProcedure');
    assert(genContent.includes('remove: authedProcedure'), 'generationHistory.remove must be authedProcedure');
    assert(!genContent.includes('guardedProcedure'), 'generationHistory must not use guardedProcedure');

    const promptContent = fs.readFileSync('lib/trpc/routers/promptHistory.ts', 'utf-8');
    assert(promptContent.includes('list: authedProcedure'), 'promptHistory.list must be authedProcedure');
    assert(promptContent.includes('record: authedProcedure'), 'promptHistory.record must be authedProcedure');
    assert(promptContent.includes('remove: authedProcedure'), 'promptHistory.remove must be authedProcedure');
    assert(!promptContent.includes('guardedProcedure'), 'promptHistory must not use guardedProcedure');

    const configContent = fs.readFileSync('lib/trpc/routers/config.ts', 'utf-8');
    assert(configContent.includes('updateMine: authedProcedure'), 'config.updateMine must be authedProcedure');
    assert(configContent.includes('getMine: authedProcedure'), 'config.getMine must be authedProcedure');
    assert(configContent.includes('get: publicProcedure'), 'config.get must be publicProcedure');

    console.log('PASS: All personal cloud routers strictly stay authedProcedure');
}

const testPromise = runMatrixTests()
    .then(() => {
        console.log('ALL GUARDED MATRIX TESTS PASSED');
    })
    .catch((err) => {
        console.error('Test failed:', err);
        process.exit(1);
    });

export default testPromise;
