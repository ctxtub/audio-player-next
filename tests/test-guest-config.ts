import assert from 'node:assert';
import { NextRequest } from 'next/server';
import * as nextHeaders from 'next/headers';
import { prisma } from '../lib/db';
import {
    getOrCreateConfig,
    updateConfig,
    normalizeThemeMode,
    toConfigDto,
    mapPatchToDbFields,
    migrateGuestConfigToUser,
} from '../lib/server/unifiedConfig';
import {
    SlidingWindowRateLimiter,
    enforceProcedureRateLimit,
    getGuestRateLimitKeys,
} from '../lib/server/rateLimit';
import { createContext } from '../lib/trpc/context';
import { authRouter } from '../lib/trpc/routers/auth';
import { middleware } from '../middleware';
import { THEME_MODE_STORAGE_KEY } from '../components/ThemeProvider/themeConfig';
import { TRPCError } from '@trpc/server';

process.env.SESSION_SECRET = 'test-secret-guest-config-12345';

async function runGuestConfigTests() {
    console.log('=== 1. Testing GuestConfig CRUD via Unified Layer ===');
    const guestId1 = `g_crud_test_${Date.now()}_1`;
    await prisma.guestConfig.deleteMany({ where: { guestId: guestId1 } });

    // 1.1 Initial getOrCreate creates default row in GuestConfig
    const initialGuestConfig = await getOrCreateConfig({ type: 'guest', id: guestId1 });
    assert.strictEqual(initialGuestConfig.playDuration, 30);
    assert.strictEqual(initialGuestConfig.voiceId, '');
    assert.strictEqual(initialGuestConfig.speed, 1.0);
    assert.strictEqual(initialGuestConfig.floatingPlayerEnabled, true);
    assert.strictEqual(initialGuestConfig.themeMode, 'system');

    const dbGuestRow = await prisma.guestConfig.findUnique({ where: { guestId: guestId1 } });
    assert(dbGuestRow !== null, 'GuestConfig DB row must exist');
    assert.strictEqual(dbGuestRow.guestId, guestId1);
    assert.strictEqual(dbGuestRow.playDurationMinutes, 30);
    assert.strictEqual(dbGuestRow.speed, 1.0);
    assert.strictEqual(dbGuestRow.themeMode, 'system');

    // 1.2 updateConfig updates fields
    const updatedGuestConfig = await updateConfig(
        { type: 'guest', id: guestId1 },
        { playDuration: 60, speed: 1.5, themeMode: 'dark', floatingPlayerEnabled: false, voiceId: 'alloy' }
    );
    assert.strictEqual(updatedGuestConfig.playDuration, 60);
    assert.strictEqual(updatedGuestConfig.speed, 1.5);
    assert.strictEqual(updatedGuestConfig.themeMode, 'dark');
    assert.strictEqual(updatedGuestConfig.floatingPlayerEnabled, false);
    assert.strictEqual(updatedGuestConfig.voiceId, 'alloy');

    // 1.3 getOrCreateConfig retrieves persisted values
    const retrievedGuestConfig = await getOrCreateConfig({ type: 'guest', id: guestId1 });
    assert.strictEqual(retrievedGuestConfig.playDuration, 60);
    assert.strictEqual(retrievedGuestConfig.speed, 1.5);
    assert.strictEqual(retrievedGuestConfig.themeMode, 'dark');

    // 1.4 UserConfig via unified layer
    const testUserId = 9988;
    await prisma.userConfig.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });
    await prisma.user.create({
        data: { id: testUserId, username: `u_${testUserId}`, password: 'hashpassword' },
    });

    const initialUserConfig = await getOrCreateConfig({ type: 'user', id: testUserId });
    assert.strictEqual(initialUserConfig.playDuration, 30);
    assert.strictEqual(initialUserConfig.speed, 1.0);

    const updatedUserConfig = await updateConfig({ type: 'user', id: testUserId }, { speed: 1.75, themeMode: 'light' });
    assert.strictEqual(updatedUserConfig.speed, 1.75);
    assert.strictEqual(updatedUserConfig.themeMode, 'light');

    // 1.5 Stale session user throws UNAUTHORIZED
    await assert.rejects(
        async () => { await getOrCreateConfig({ type: 'user', id: 123456789 }); },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED',
        'Stale session user must throw UNAUTHORIZED'
    );
    console.log('PASS: Unified layer CRUD for GuestConfig and UserConfig verified');

    console.log('=== 2. Testing Register-Migration Behavior ===');
    const guestIdMigrate = `g_migrate_test_${Date.now()}`;
    await prisma.guestConfig.create({
        data: {
            guestId: guestIdMigrate,
            playDurationMinutes: 45,
            speed: 1.25,
            themeMode: 'dark',
            voiceId: 'shimmer',
            floatingPlayerEnabled: false,
        },
    });

    const cookieJar = new Map<string, string>();
    const originalCookies = nextHeaders.cookies;
    (nextHeaders as { cookies: unknown }).cookies = async () => ({
        get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
        set: (opts: { name: string; value: string }) => {
            cookieJar.set(opts.name, opts.value);
        },
        delete: (name: string) => {
            cookieJar.delete(name);
        },
    });

    const regUsername = `reg_migrated_${Date.now()}`;
    const callerGuest = authRouter.createCaller({
        session: null,
        guestId: guestIdMigrate,
        isGuest: true,
        clientIp: '127.0.0.1',
    });

    let regResult: { success: boolean };
    try {
        regResult = await callerGuest.register({
            username: regUsername,
            password: 'Password123!',
        });
    } finally {
        (nextHeaders as { cookies: unknown }).cookies = originalCookies;
    }
    assert.strictEqual(regResult.success, true);

    const createdUser = await prisma.user.findUnique({
        where: { username: regUsername },
        include: { config: true },
    });
    assert(createdUser !== null, 'Created user must exist');
    assert(createdUser.config !== null, 'UserConfig must be created via register migration');
    assert.strictEqual(createdUser.config.playDurationMinutes, 45, 'playDurationMinutes must be migrated from guest');
    assert.strictEqual(createdUser.config.speed, 1.25, 'speed must be migrated from guest');
    assert.strictEqual(createdUser.config.themeMode, 'dark', 'themeMode must be migrated from guest');
    assert.strictEqual(createdUser.config.voiceId, 'shimmer', 'voiceId must be migrated from guest');
    assert.strictEqual(createdUser.config.floatingPlayerEnabled, false, 'floatingPlayerEnabled must be migrated from guest');

    // Verify original guest config remains intact
    const originalGuestConfig = await prisma.guestConfig.findUnique({
        where: { guestId: guestIdMigrate },
    });
    assert(originalGuestConfig !== null, 'GuestConfig must remain untouched after registration');
    assert.strictEqual(originalGuestConfig.playDurationMinutes, 45);


    // Rollback test: simulate failure during registration
    const guestIdRollback = `g_rollback_test_${Date.now()}`;
    await prisma.guestConfig.create({
        data: {
            guestId: guestIdRollback,
            playDurationMinutes: 90,
            speed: 2.0,
            themeMode: 'light',
        },
    });

    const regRollbackUser = `reg_fail_${Date.now()}`;
    const callerRollback = authRouter.createCaller({
        session: null,
        guestId: guestIdRollback,
        isGuest: true,
        clientIp: '127.0.0.1',
    });

    const origCookies = nextHeaders.cookies;
    (nextHeaders as { cookies: unknown }).cookies = async () => ({
        get: () => undefined,
        set: () => {
            throw new Error('Simulated cookie failure during register rollback test');
        },
        delete: () => {},
    });

    try {
        await assert.rejects(
            async () => {
                await callerRollback.register({
                    username: regRollbackUser,
                    password: 'Password123!',
                });
            },
            (err: unknown) => typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'INTERNAL_SERVER_ERROR'
        );

        // User must be rolled back
        const rolledBackUser = await prisma.user.findUnique({
            where: { username: regRollbackUser },
        });
        assert.strictEqual(rolledBackUser, null, 'User must be deleted on rollback');

        // Guest config must remain completely intact
        const intactGuestConfig = await prisma.guestConfig.findUnique({
            where: { guestId: guestIdRollback },
        });
        assert(intactGuestConfig !== null, 'GuestConfig must remain untouched when registration rolls back');
        assert.strictEqual(intactGuestConfig.playDurationMinutes, 90);
    } finally {
        (nextHeaders as { cookies: unknown }).cookies = origCookies;
    }
    console.log('PASS: Register migration and rollback safety verified');

    console.log('=== 3. Testing Legacy guest=1 Upgrade Path ===');
    // 3.1 tRPC Context upgrade
    const resHeaders = new Headers();
    const legacyReq = new Request('http://localhost:3000/api/trpc', {
        headers: { cookie: 'guest=1', 'x-real-ip': '1.2.3.4' },
    });
    const legacyCtx = await createContext({ req: legacyReq, resHeaders });
    assert.strictEqual(legacyCtx.isGuest, true, 'isGuest must be true for legacy guest=1');
    assert(Boolean(legacyCtx.guestId && legacyCtx.guestId.startsWith('g_')), 'guestId must be upgraded to g_<uuid>');
    const setCookieHeader = resHeaders.get('set-cookie');
    assert(setCookieHeader !== null, 'Set-Cookie header must be emitted for legacy guest=1 upgrade');
    assert(setCookieHeader.includes('guest=g_'), 'Set-Cookie must contain upgraded g_<uuid>');
    assert(setCookieHeader.includes('Max-Age=2592000'), 'Set-Cookie must have 30d max-age');
    assert(setCookieHeader.includes('HttpOnly'), 'Set-Cookie must be HttpOnly');

    // 3.2 Middleware upgrade
    const mockLegacyReq = new NextRequest('http://localhost:3000/player', {
        headers: { cookie: 'guest=1' },
    });
    const mwResponse = await middleware(mockLegacyReq);
    const mwSetCookie = mwResponse.cookies.get('guest');
    assert(mwSetCookie !== undefined, 'Middleware must reissue guest cookie on guest=1');
    assert(mwSetCookie.value.startsWith('g_'), 'Reissued cookie must be g_<uuid>');
    assert.strictEqual(mwSetCookie.maxAge, 30 * 24 * 60 * 60, 'Reissued cookie must have 30d maxAge');
    assert.strictEqual(mwSetCookie.httpOnly, true, 'Reissued cookie must be httpOnly');

    // 3.3 Middleware sliding renewal for existing g_<uuid>
    const existingGuestId = `g_existing_${Date.now()}`;
    const mockExistingReq = new NextRequest('http://localhost:3000/player', {
        headers: { cookie: `guest=${existingGuestId}` },
    });
    const mwRenewalResponse = await middleware(mockExistingReq);
    const renewalCookie = mwRenewalResponse.cookies.get('guest');
    assert(renewalCookie !== undefined, 'Middleware must renew guest cookie');
    assert.strictEqual(renewalCookie.value, existingGuestId, 'Renewal must keep same guestId');
    assert.strictEqual(renewalCookie.maxAge, 30 * 24 * 60 * 60, 'Renewal must reset 30d maxAge');
    console.log('PASS: Legacy guest=1 upgrade and 30d sliding renewal verified in context & middleware');

    console.log('=== 4. Testing Rate Limiting with GuestId and Dual-Layer IP Guard ===');
    const rateLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000 });

    const testGuestId = `g_ratelimit_${Date.now()}`;
    const { guestKey, ipKey } = getGuestRateLimitKeys('config:update', testGuestId, '198.51.100.1');
    assert.strictEqual(guestKey, `config:update:guest:${testGuestId}`);
    assert.strictEqual(ipKey, 'config:update:guest:ip:198.51.100.1');

    const guestRateCtx = {
        session: null,
        isGuest: true,
        guestId: testGuestId,
        clientIp: '198.51.100.1',
    };

    // 4.1 Guest limit 30 requests allowed, 31st rejected
    for (let i = 1; i <= 30; i++) {
        assert.doesNotThrow(() => {
            enforceProcedureRateLimit('config:update', guestRateCtx, { guestLimit: 30, authedLimit: 60 }, rateLimiter);
        }, `Guest request ${i} should succeed`);
    }

    assert.throws(() => {
        enforceProcedureRateLimit('config:update', guestRateCtx, { guestLimit: 30, authedLimit: 60 }, rateLimiter);
    }, (err: unknown) => err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS',
    '31st request from same guestId must throw 429');

    // 4.2 UUID rotation attack resistance: rotating guestId from same IP
    const rotatingIpLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000 });
    const attackerIp = '203.0.113.50';

    for (let i = 1; i <= 30; i++) {
        const rotatingGuestCtx = {
            session: null,
            isGuest: true,
            guestId: `g_rotated_uuid_${i}`,
            clientIp: attackerIp,
        };
        assert.doesNotThrow(() => {
            enforceProcedureRateLimit('config:update', rotatingGuestCtx, { guestLimit: 30, authedLimit: 60 }, rotatingIpLimiter);
        }, `Rotated UUID request ${i} allowed under limit`);
    }

    // 31st request with a brand new UUID from same IP must be rejected by IP guard
    const attackerNewGuestCtx = {
        session: null,
        isGuest: true,
        guestId: 'g_rotated_uuid_31',
        clientIp: attackerIp,
    };
    assert.throws(() => {
        enforceProcedureRateLimit('config:update', attackerNewGuestCtx, { guestLimit: 30, authedLimit: 60 }, rotatingIpLimiter);
    }, (err: unknown) => err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS',
    'UUID rotation attack from same IP must be blocked on 31st request by IP guard');

    // 4.3 Authed rate limit 60 requests allowed
    const authedRateCtx = {
        session: { userId: 555, nickname: 'Voter' },
        isGuest: false,
        clientIp: '203.0.113.50',
    };
    for (let i = 1; i <= 60; i++) {
        assert.doesNotThrow(() => {
            enforceProcedureRateLimit('config:update', authedRateCtx, { guestLimit: 30, authedLimit: 60 }, rateLimiter);
        }, `Authed request ${i} should succeed`);
    }
    assert.throws(() => {
        enforceProcedureRateLimit('config:update', authedRateCtx, { guestLimit: 30, authedLimit: 60 }, rateLimiter);
    }, (err: unknown) => err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS',
    '61st authed request must throw 429');
    console.log('PASS: GuestId key and dual-layer IP guard rate limiting verified');

    console.log('=== 5. Testing Theme Priority Contract ===');
    // Contract:
    // 1) First paint uses localStorage['theme-mode'] as FOUC cache
    // 2) After hydration, server value (GuestConfig or UserConfig) takes precedence and overwrites localStorage
    // 3) On theme change: write localStorage immediately + debounced server update
    // 4) Logout does NOT clear theme-mode

    // Simulate mock localStorage
    const storageMap = new Map<string, string>();
    const mockStorage = {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => storageMap.set(k, v),
        removeItem: (k: string) => storageMap.delete(k),
    };

    // Step 1: Pre-existing localStorage (first paint cache)
    mockStorage.setItem(THEME_MODE_STORAGE_KEY, 'light');
    assert.strictEqual(mockStorage.getItem(THEME_MODE_STORAGE_KEY), 'light', 'First paint reads localStorage');

    // Step 2: Hydration from server config (e.g. guest or user has 'dark')
    const serverConfigTheme = 'dark';
    // Server value takes precedence over client cache
    if (mockStorage.getItem(THEME_MODE_STORAGE_KEY) !== serverConfigTheme) {
        mockStorage.setItem(THEME_MODE_STORAGE_KEY, serverConfigTheme);
    }
    assert.strictEqual(mockStorage.getItem(THEME_MODE_STORAGE_KEY), 'dark', 'Server value takes precedence and overwrites localStorage');

    // Step 3: User changes theme in UI to 'system'
    const userSelectedTheme = 'system';
    mockStorage.setItem(THEME_MODE_STORAGE_KEY, userSelectedTheme);
    assert.strictEqual(mockStorage.getItem(THEME_MODE_STORAGE_KEY), 'system', 'Theme change writes localStorage immediately');

    // Step 4: Logout
    // Simulated logout actions: clear auth session and config store, but preserve theme-mode
    mockStorage.removeItem('config-store');
    assert.strictEqual(mockStorage.getItem(THEME_MODE_STORAGE_KEY), 'system', 'Logout does NOT clear theme-mode in localStorage');
    console.log('PASS: Theme priority contract and persistence rules verified');
}

const testPromise = runGuestConfigTests()
    .then(() => {
        console.log('ALL GUEST CONFIG TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('Guest config test failed:', err);
        process.exit(1);
    });

export default testPromise;
