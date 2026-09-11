import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import * as nextHeaders from 'next/headers';
import { router, guardedProcedure, TRPCError } from '../../../lib/trpc/init';
import {
    createContext,
    buildGuestCookieHeader,
    GUEST_COOKIE,
    GUEST_COOKIE_MAX_AGE,
} from '../../../lib/trpc/context';
import { encodeGuestId, decodeGuestCookie } from '../../../lib/session';
import { authRouter } from '../../../lib/trpc/routers/auth';

process.env.SESSION_SECRET = 'test-secret-signed-guest-fix02-12345';

const testRouter = router({
    guardedPing: guardedProcedure.query(() => ({ ok: true as const })),
});

async function runSignedGuestCookieTests() {
    console.log('--- 1. 无 cookie → 匿名，guardedProcedure 401 ---');
    const anonCtx = await createContext({
        req: new Request('http://localhost:3000/api/trpc'),
    });
    assert.strictEqual(anonCtx.session, null);
    assert.strictEqual(anonCtx.isGuest, false);
    assert.strictEqual(anonCtx.guestId, null);
    await assert.rejects(
        async () => {
            await testRouter.createCaller(anonCtx).guardedPing();
        },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
        '无 cookie 必须 401'
    );

    console.log('--- 2. 旧 guest=1 → 严格 401，且无 Set-Cookie ---');
    const legacyHeaders = new Headers();
    const legacyCtx = await createContext({
        req: new Request('http://localhost:3000/api/trpc', {
            headers: { cookie: 'guest=1' },
        }),
        resHeaders: legacyHeaders,
    });
    assert.strictEqual(legacyCtx.isGuest, false, 'guest=1 不得被视为访客');
    assert.strictEqual(legacyCtx.guestId, null);
    assert.strictEqual(
        legacyHeaders.get('set-cookie'),
        null,
        'guest=1 不得下发升级 cookie'
    );
    await assert.rejects(
        async () => {
            await testRouter.createCaller(legacyCtx).guardedPing();
        },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
        'guest=1 必须 401'
    );

    console.log('--- 3. 裸 g_<uuid> / 伪造结构 → 401 ---');
    for (const raw of [
        `g_${randomUUID()}`,
        'g_00000000-1111-4222-8333-444455556666',
        'g_not-a-uuid',
        'forged.payload.sig',
        'a.b.c',
        'g_',
    ]) {
        const resHeaders = new Headers();
        const ctx = await createContext({
            req: new Request('http://localhost:3000/api/trpc', {
                headers: { cookie: `guest=${raw}` },
            }),
            resHeaders,
        });
        assert.strictEqual(ctx.isGuest, false, `裸/伪造值必须匿名: ${raw}`);
        assert.strictEqual(ctx.guestId, null);
        assert.strictEqual(resHeaders.get('set-cookie'), null, '伪造值不得下发 cookie');
        await assert.rejects(
            async () => {
                await testRouter.createCaller(ctx).guardedPing();
            },
            (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
            `裸/伪造值必须 401: ${raw}`
        );
    }

    console.log('--- 4. 合法签名 guest cookie → guardedProcedure 放行 ---');
    const gid = `g_${randomUUID()}`;
    const signed = encodeGuestId(gid);
    assert.notStrictEqual(signed, gid, '签名值不得是明文 guestId');
    assert.ok(signed.includes('.'), '签名值须为 payload.signature 结构');
    const validCtx = await createContext({
        req: new Request('http://localhost:3000/api/trpc', {
            headers: { cookie: `guest=${signed}` },
        }),
    });
    assert.strictEqual(validCtx.isGuest, true);
    assert.strictEqual(validCtx.guestId, gid);
    const ping = await testRouter.createCaller(validCtx).guardedPing();
    assert.strictEqual(ping.ok, true);

    console.log('--- 5. payload 篡改 / 签名篡改 / 异密钥伪造 / 过期 → 401 ---');
    const [payloadB64, sig] = signed.split('.');
    const tamperedPayload =
        payloadB64.slice(0, -1) + (payloadB64.endsWith('A') ? 'B' : 'A');
    assert.strictEqual(decodeGuestCookie(`${tamperedPayload}.${sig}`), null);
    const tamperedSig = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    assert.strictEqual(decodeGuestCookie(`${payloadB64}.${tamperedSig}`), null);

    const savedSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'totally-different-secret-99999';
    const forgedByOtherSecret = encodeGuestId(`g_${randomUUID()}`);
    process.env.SESSION_SECRET = savedSecret;
    assert.strictEqual(decodeGuestCookie(forgedByOtherSecret), null, '异密钥伪造必须失败');

    const expired = encodeGuestId(`g_${randomUUID()}`, -1);
    assert.strictEqual(decodeGuestCookie(expired), null, '过期签名必须失败');

    for (const bad of [
        `${tamperedPayload}.${sig}`,
        `${payloadB64}.${tamperedSig}`,
        forgedByOtherSecret,
        expired,
    ]) {
        const ctx = await createContext({
            req: new Request('http://localhost:3000/api/trpc', {
                headers: { cookie: `guest=${bad}` },
            }),
        });
        assert.strictEqual(ctx.isGuest, false, '篡改/伪造/过期必须匿名');
        await assert.rejects(
            async () => {
                await testRouter.createCaller(ctx).guardedPing();
            },
            (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
            '篡改/伪造/过期必须 401'
        );
    }

    console.log('--- 6. 签发格式：HttpOnly + SameSite + 30d + 可验签 ---');
    const freshGid = `g_${randomUUID()}`;
    const freshSigned = encodeGuestId(freshGid);
    assert.strictEqual(decodeGuestCookie(freshSigned), freshGid, '签发后必须可验签还原');
    const setCookie = buildGuestCookieHeader(freshSigned);
    assert.ok(setCookie.startsWith('guest='), '须写入 guest cookie');
    assert.ok(setCookie.includes('HttpOnly'), '须 HttpOnly');
    assert.ok(setCookie.includes('SameSite=Lax'), '须 SameSite=Lax');
    assert.ok(
        setCookie.includes(`Max-Age=${GUEST_COOKIE_MAX_AGE}`),
        '须 30 天 Max-Age'
    );
    assert.ok(!setCookie.includes(freshGid), 'Set-Cookie 不得泄露明文 guestId');

    console.log('--- 7. 密钥缺失 → fail-closed（匿名，不抛错） ---');
    process.env.SESSION_SECRET = savedSecret;
    const goodToken = encodeGuestId(`g_${randomUUID()}`);
    delete process.env.SESSION_SECRET;
    assert.strictEqual(decodeGuestCookie(goodToken), null, '无密钥时验签必须失败');
    const noSecretCtx = await createContext({
        req: new Request('http://localhost:3000/api/trpc', {
            headers: { cookie: `guest=${goodToken}` },
        }),
    });
    assert.strictEqual(noSecretCtx.isGuest, false, '无密钥时必须匿名');
    process.env.SESSION_SECRET = savedSecret;

    console.log('--- 8. enterGuestMode fail-closed：无密钥受控失败零 Cookie 零 GC，有密钥正常签发 ---');
    {
        const savedSecret8 = process.env.SESSION_SECRET;
        const originalCookies = nextHeaders.cookies;
        const originalRandom = Math.random;
        const setCalls: Array<{
            name: string;
            value: string;
            httpOnly?: boolean;
            sameSite?: string;
            path?: string;
            maxAge?: number;
        }> = [];
        let randomCalls = 0;
        (nextHeaders as { cookies: unknown }).cookies = async () => ({
            get: () => undefined,
            set: (opts: {
                name: string;
                value: string;
                httpOnly?: boolean;
                sameSite?: string;
                path?: string;
                maxAge?: number;
            }) => {
                setCalls.push({ ...opts });
            },
            delete: () => {},
        });
        try {
            // 8a. 有密钥 → 正常签发：成功、可验签、HttpOnly/SameSite/maxAge、GC 门仍被评估
            process.env.SESSION_SECRET = savedSecret8;
            setCalls.length = 0;
            randomCalls = 0;
            Math.random = () => {
                randomCalls += 1;
                return 0.99;
            };
            const callerWithSecret = authRouter.createCaller({
                session: null,
                isGuest: false,
                clientIp: '127.0.0.1',
            });
            const issued = await callerWithSecret.enterGuestMode();
            assert.strictEqual(issued.success, true, '有密钥时签发必须成功');
            assert.strictEqual(setCalls.length, 1, '有密钥时必须写入一条 Cookie');
            assert.strictEqual(setCalls[0]?.name, GUEST_COOKIE, '须写入 guest Cookie');
            const issuedValue = setCalls[0]?.value ?? '';
            assert.ok(issuedValue.includes('.'), '签发值须为 payload.signature 结构');
            const restoredGid = decodeGuestCookie(issuedValue);
            assert.ok(
                restoredGid !== null && restoredGid.startsWith('g_'),
                '签发值必须可验签还原出访客 gid'
            );
            assert.notStrictEqual(issuedValue, restoredGid, '签发值不得是明文 guestId');
            assert.strictEqual(setCalls[0]?.httpOnly, true, '须 HttpOnly');
            assert.strictEqual(setCalls[0]?.sameSite, 'lax', '须 SameSite=Lax');
            assert.strictEqual(setCalls[0]?.path, '/', '须 Path=/');
            assert.strictEqual(setCalls[0]?.maxAge, GUEST_COOKIE_MAX_AGE, '须 30 天 Max-Age');
            assert.strictEqual(randomCalls, 1, '正常签发须评估 GC 概率门（保持现有 GC 语义）');

            // 8b. 无密钥 → 受控失败：稳定脱敏 INTERNAL_SERVER_ERROR、零 Cookie、零 GC
            delete process.env.SESSION_SECRET;
            setCalls.length = 0;
            randomCalls = 0;
            Math.random = () => {
                randomCalls += 1;
                return 0;
            };
            const callerNoSecret = authRouter.createCaller({
                session: null,
                isGuest: false,
                clientIp: '127.0.0.1',
            });
            await assert.rejects(
                async () => {
                    await callerNoSecret.enterGuestMode();
                },
                (err: unknown) => {
                    if (!(err instanceof TRPCError)) return false;
                    if (err.code !== 'INTERNAL_SERVER_ERROR') return false;
                    if (err.message !== '访客模式暂不可用，请稍后重试') return false;
                    if (err.message.includes('SESSION_SECRET')) return false;
                    return true;
                },
                '无密钥时必须以稳定脱敏 INTERNAL_SERVER_ERROR 受控失败'
            );
            assert.strictEqual(setCalls.length, 0, '无密钥时不得写入任何 Cookie');
            assert.strictEqual(randomCalls, 0, '无密钥时不得评估 GC 概率门（零 GC）');
        } finally {
            if (savedSecret8 === undefined) {
                delete process.env.SESSION_SECRET;
            } else {
                process.env.SESSION_SECRET = savedSecret8;
            }
            (nextHeaders as { cookies: unknown }).cookies = originalCookies;
            Math.random = originalRandom;
        }
    }

    console.log('ALL SIGNED GUEST COOKIE TESTS PASSED');
}

const testPromise = runSignedGuestCookieTests()
    .then(() => {
        console.log('ALL SIGNED GUEST COOKIE TESTS PASSED (done)');
    })
    .catch((err) => {
        console.error('Test failed:', err);
        process.exit(1);
    });

export default testPromise;
