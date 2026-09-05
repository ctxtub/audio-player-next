import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import * as nextHeaders from 'next/headers';

// Configure test SQLite database
const testDbPath = path.resolve(process.cwd(), 'prisma/test-orphan.db');
process.env.DATABASE_URL = `file:${testDbPath}`;

async function runOrphanTests() {
    // Clean up prior test DB if exists
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    const { execSync } = await import('node:child_process');
    execSync(`DATABASE_URL="file:${testDbPath}" ./node_modules/.bin/prisma migrate deploy`, {
        stdio: 'pipe',
    });

    const { prisma } = await import('../lib/db');
    const { assertSessionSecret } = await import('../lib/session');
    const { authRouter } = await import('../lib/trpc/routers/auth');

    console.log('--- 1. Testing Fail-Fast SESSION_SECRET Check ---');
    delete process.env.SESSION_SECRET;
    assert.throws(
        () => assertSessionSecret(),
        (err: unknown) => err instanceof Error && err.message.includes('SESSION_SECRET'),
        'assertSessionSecret must throw when SESSION_SECRET is not set'
    );

    process.env.SESSION_SECRET = 'valid-test-secret-12345';
    assert.strictEqual(assertSessionSecret(), 'valid-test-secret-12345', 'Should return secret when set');
    console.log('PASS: Fail-fast SESSION_SECRET check verified');

    console.log('--- 2. Testing Pre-Validation (No DB User Created if Secret Missing) ---');
    delete process.env.SESSION_SECRET;
    const testUsernamePre = 'preval_user_' + Date.now();
    
    const callerAnon = authRouter.createCaller({
        session: null,
        isGuest: false,
        clientIp: '127.0.0.1',
    });

    await assert.rejects(
        async () => {
            await callerAnon.register({
                username: testUsernamePre,
                password: 'Password123!',
            });
        },
        (err: unknown) => err instanceof Error && err.message.includes('SESSION_SECRET'),
        'Register must throw error during pre-validation when SESSION_SECRET is missing'
    );

    const dbUserAfterPre = await prisma.user.findUnique({
        where: { username: testUsernamePre },
    });
    assert.strictEqual(dbUserAfterPre, null, 'User must NOT be created in database when pre-validation fails');
    console.log('PASS: Pre-validation prevented orphaned user in database');

    console.log('--- 3. Testing Rollback on Session Signing / Cookie Setting Failure ---');
    process.env.SESSION_SECRET = 'valid-test-secret-12345';
    const testUsernameRollback = 'rollback_user_' + Date.now();

    // Mock nextHeaders.cookies to throw an error during setAuthCookie
    const originalCookies = nextHeaders.cookies;
    (nextHeaders as { cookies: unknown }).cookies = async () => ({
        get: () => undefined,
        set: () => {
            throw new Error('Simulated session signing / cookie persistence failure');
        },
        delete: () => {},
    });

    try {
        await assert.rejects(
            async () => {
                await callerAnon.register({
                    username: testUsernameRollback,
                    password: 'Password123!',
                });
            },
            (err: unknown) => {
                // Should return INTERNAL_SERVER_ERROR
                return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'INTERNAL_SERVER_ERROR';
            },
            'Register should fail with INTERNAL_SERVER_ERROR when cookie setting fails'
        );

        // Verify the created user was rolled back (deleted)
        const dbUserAfterRollback = await prisma.user.findUnique({
            where: { username: testUsernameRollback },
        });
        assert.strictEqual(dbUserAfterRollback, null, 'User must be rolled back (deleted) from database');
    } finally {
        (nextHeaders as { cookies: unknown }).cookies = originalCookies;
    }

    console.log('PASS: Rollback successfully cleaned up orphaned user upon signing/cookie failure');

    console.log('--- 4. Testing Re-Registration after Rollback (No CONFLICT) ---');
    // Now mock cookies to succeed
    const cookieJar = new Map<string, string>();
    (nextHeaders as { cookies: unknown }).cookies = async () => ({
        get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
        set: (opts: { name: string; value: string }) => {
            cookieJar.set(opts.name, opts.value);
        },
        delete: (name: string) => {
            cookieJar.delete(name);
        },
    });

    try {
        // Re-register with the exact same username that had previously failed
        const regResult = await callerAnon.register({
            username: testUsernameRollback,
            password: 'Password123!',
            nickname: 'ReRegistered',
        });

        assert.strictEqual(regResult.success, true, 'Re-registration should succeed');
        assert.strictEqual(regResult.user.username, testUsernameRollback);
        assert(cookieJar.has('auth'), 'Auth cookie should have been set');

        const dbUserFinal = await prisma.user.findUnique({
            where: { username: testUsernameRollback },
        });
        assert.notStrictEqual(dbUserFinal, null, 'User should exist now');
        assert.strictEqual(dbUserFinal?.nickname, 'ReRegistered');

        // Subsequent registration with same username now yields CONFLICT (as expected)
        await assert.rejects(
            async () => {
                await callerAnon.register({
                    username: testUsernameRollback,
                    password: 'Password123!',
                });
            },
            (err: unknown) => {
                return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'CONFLICT';
            },
            'Subsequent registration with existing user must report CONFLICT'
        );
    } finally {
        (nextHeaders as { cookies: unknown }).cookies = originalCookies;
        await prisma.$disconnect();
        // Clean up test DB file
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
        const journalPath = `${testDbPath}-journal`;
        if (fs.existsSync(journalPath)) fs.unlinkSync(journalPath);
    }

    console.log('PASS: Successful registration and re-registration verification complete');
}

const testPromise = runOrphanTests()
    .then(() => {
        console.log('ALL ORPHAN PREVENTION TESTS PASSED');
    })
    .catch((err) => {
        console.error('Test failed:', err);
        process.exit(1);
    });

export default testPromise;
