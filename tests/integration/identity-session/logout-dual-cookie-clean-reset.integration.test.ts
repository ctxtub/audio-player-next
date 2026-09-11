import assert from 'node:assert';
import * as nextHeaders from 'next/headers';
import { authRouter } from '../../../lib/trpc/routers/auth';

process.env.SESSION_SECRET = 'test-secret-logout-dual-cookie-12345';

/**
 * E2E-05-04 登出双凭证清理与状态重置（L2 网络面，真实 authRouter.logout）。
 *
 * oracle（spec 05-04 + catalog dual-cookie-cleared[network]）：
 * auth.logout 响应同时删除 SESSION(auth) 与 GUEST(guest) 双 cookie，
 * jar 双空。
 * UI 四块清空与 middleware 重定向链属 L3，本轮未覆盖（见 handover 未覆盖项）。
 */
async function runLogoutDualCookieTests() {
    // 登录态 jar：双 cookie 均在（值内容不敏感，仅占位不断言值）
    const cookieJar = new Map<string, string>([
        ['auth', 'probe-session-placeholder'],
        ['guest', 'probe-guest-placeholder'],
    ]);
    const deleted: string[] = [];
    const originalCookies = nextHeaders.cookies;
    (nextHeaders as { cookies: unknown }).cookies = async () => ({
        get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
        set: (opts: { name: string; value: string }) => { cookieJar.set(opts.name, opts.value); },
        delete: (name: string | { name: string }) => {
            const k = typeof name === 'string' ? name : name.name;
            deleted.push(k);
            cookieJar.delete(k);
        },
    });
    let result: { success: boolean };
    try {
        const caller = authRouter.createCaller({
            session: { userId: 999999, nickname: 'LogoutDualCookieProbe' },
            guestId: null,
            isGuest: false,
            clientIp: '127.0.0.1',
        });
        result = await caller.logout();
    } finally {
        (nextHeaders as { cookies: unknown }).cookies = originalCookies;
    }
    assert.strictEqual(result.success, true, 'logout 应成功');

    // 核心：双删（auth + guest 缺一不可）
    assert(deleted.includes('auth'), '必须删除 SESSION(auth) cookie');
    assert(deleted.includes('guest'), '必须删除 GUEST(guest) cookie');
    assert(!cookieJar.has('auth'), 'jar 中 auth 应已清除');
    assert(!cookieJar.has('guest'), 'jar 中 guest 应已清除');
    console.log(`PASS: dual-cookie-cleared (deleted=[${deleted.join(', ')}])`);

    console.log('ALL LOGOUT DUAL-COOKIE TESTS PASSED SUCCESSFULLY');
}

const testPromise = runLogoutDualCookieTests()
    .then(() => {
        console.log('ALL LOGOUT DUAL-COOKIE TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('Test failed:', err);
        process.exit(1);
    });

export default testPromise;
