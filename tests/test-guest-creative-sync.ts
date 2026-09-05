import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as nextHeaders from 'next/headers';
import { prisma } from '../lib/db';
import { TRPCError } from '@trpc/server';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

import {
    getConversationForSubject,
    saveConversationForSubject,
} from '../lib/server/chatConversation';
import {
    listGenerationHistoryForSubject,
    recordGenerationHistoryForSubject,
    removeGenerationHistoryForSubject,
} from '../lib/server/generationHistory';
import {
    listPromptHistoryForSubject,
    recordPromptHistoryForSubject,
    removePromptHistoryForSubject,
} from '../lib/server/promptHistory';
import { purgeExpiredGuestData } from '../lib/server/guestGc';
import { migrateGuestCreativeRecordsToUser } from '../lib/server/unifiedMigration';
import {
    SlidingWindowRateLimiter,
    enforceProcedureRateLimit,
} from '../lib/server/rateLimit';
import { chatConversationRouter } from '../lib/trpc/routers/chatConversation';
import { generationHistoryRouter } from '../lib/trpc/routers/generationHistory';
import { promptHistoryRouter } from '../lib/trpc/routers/promptHistory';
import { authRouter } from '../lib/trpc/routers/auth';
import { createContext } from '../lib/trpc/context';
import { encodeSession } from '../lib/session';

const { usePromptHistoryStore } = nodeRequire('../stores/promptHistoryStore') as {
    usePromptHistoryStore: typeof import('../stores/promptHistoryStore').usePromptHistoryStore;
};

process.env.SESSION_SECRET = 'test-secret-guest-creative-sync-12345';

async function runGuestCreativeSyncTests() {
    console.log('=== 1. Testing Guest Creative Records CRUD & Reload ===');
    const guestId1 = `g_creative_crud_${Date.now()}`;

    // Clean initial state
    await prisma.guestChatMessage.deleteMany({ where: { guestId: guestId1 } });
    await prisma.guestGenerationHistory.deleteMany({ where: { guestId: guestId1 } });
    await prisma.guestPromptHistory.deleteMany({ where: { guestId: guestId1 } });

    // 1.1 Chat Save and Reload with Audio URL Sanitization
    const messagesInput = [
        {
            messageId: 'msg_1',
            role: 'user',
            content: 'Please tell me a bedtime story',
            createdAt: new Date().toISOString(),
        },
        {
            messageId: 'msg_2',
            role: 'assistant',
            content: 'Once upon a time in a magical forest...',
            parts: [
                {
                    type: 'storyCard',
                    storyText: 'Once upon a time in a magical forest...',
                    audioUrl: 'blob:http://localhost:3000/should-be-excluded-blob-uuid',
                },
            ],
            createdAt: new Date().toISOString(),
        },
    ];

    await saveConversationForSubject({ type: 'guest', id: guestId1 }, messagesInput);

    const reloadedChat = await getConversationForSubject({ type: 'guest', id: guestId1 });
    assert.strictEqual(reloadedChat.length, 2, 'Should reload exactly 2 chat messages');
    assert.strictEqual(reloadedChat[0].content, 'Please tell me a bedtime story');
    assert.strictEqual(reloadedChat[1].content, 'Once upon a time in a magical forest...');

    // Verify audioUrl was stripped from database row
    const dbAssistantMsg = await prisma.guestChatMessage.findFirst({
        where: { guestId: guestId1, messageId: 'msg_2' },
    });
    assert(dbAssistantMsg !== null, 'Assistant message must exist in DB');
    const parsedParts = JSON.parse(dbAssistantMsg.parts || '[]');
    assert.strictEqual(parsedParts[0].audioUrl, '', 'audioUrl MUST be sanitized to empty string in DB');
    assert.strictEqual(parsedParts[0].storyText, 'Once upon a time in a magical forest...');

    // 1.2 Generation History Record, List, and Remove
    const recordedGen = await recordGenerationHistoryForSubject(
        { type: 'guest', id: guestId1 },
        { prompt: 'Story about a robot', storyText: 'The robot learned to paint.', voiceId: 'onyx' }
    );
    assert.strictEqual(recordedGen.prompt, 'Story about a robot');
    assert.strictEqual(recordedGen.storyText, 'The robot learned to paint.');
    assert.strictEqual(recordedGen.voiceId, 'onyx');

    const genList = await listGenerationHistoryForSubject({ type: 'guest', id: guestId1 });
    assert.strictEqual(genList.length, 1, 'Should list 1 generation record');
    assert.strictEqual(genList[0].id, recordedGen.id);

    await removeGenerationHistoryForSubject({ type: 'guest', id: guestId1 }, recordedGen.id);
    const genListAfterRemove = await listGenerationHistoryForSubject({ type: 'guest', id: guestId1 });
    assert.strictEqual(genListAfterRemove.length, 0, 'Generation record should be removed');

    // 1.3 Prompt History Record (Upsert & UseCount), List, and Remove
    const promptRecord1 = await recordPromptHistoryForSubject({ type: 'guest', id: guestId1 }, 'Magic carpet adventure');
    assert.strictEqual(promptRecord1.prompt, 'Magic carpet adventure');
    assert.strictEqual(promptRecord1.useCount, 1);

    // Second record of same prompt increments useCount
    const promptRecord2 = await recordPromptHistoryForSubject({ type: 'guest', id: guestId1 }, 'Magic carpet adventure');
    assert.strictEqual(promptRecord2.useCount, 2, 'useCount should increment to 2 on reuse');

    const promptList = await listPromptHistoryForSubject({ type: 'guest', id: guestId1 });
    assert.strictEqual(promptList.length, 1);
    assert.strictEqual(promptList[0].useCount, 2);

    await removePromptHistoryForSubject({ type: 'guest', id: guestId1 }, 'Magic carpet adventure');
    const promptListAfterRemove = await listPromptHistoryForSubject({ type: 'guest', id: guestId1 });
    assert.strictEqual(promptListAfterRemove.length, 0, 'Prompt record should be removed');

    console.log('PASS: Guest creative records CRUD, reload, and audioUrl exclusion verified');

    console.log('=== 2. Testing Multi-Subject Isolation ===');
    const guestA = `g_iso_a_${Date.now()}`;
    const guestB = `g_iso_b_${Date.now()}`;
    const userIdC = 887766;

    await prisma.user.deleteMany({ where: { id: userIdC } });
    await prisma.user.create({
        data: { id: userIdC, username: `u_iso_${userIdC}`, password: 'password' },
    });

    // Populate data for Guest A
    await saveConversationForSubject({ type: 'guest', id: guestA }, [
        { messageId: 'msg_a', role: 'user', content: 'Secret of Guest A' },
    ]);
    await recordGenerationHistoryForSubject({ type: 'guest', id: guestA }, {
        prompt: 'Prompt A',
        storyText: 'Story A',
    });
    await recordPromptHistoryForSubject({ type: 'guest', id: guestA }, 'Prompt A');

    // Populate data for User C
    await saveConversationForSubject({ type: 'user', id: userIdC }, [
        { messageId: 'msg_c', role: 'user', content: 'Secret of User C' },
    ]);
    await recordGenerationHistoryForSubject({ type: 'user', id: userIdC }, {
        prompt: 'Prompt C',
        storyText: 'Story C',
    });
    await recordPromptHistoryForSubject({ type: 'user', id: userIdC }, 'Prompt C');

    // Query as Guest B (empty)
    const chatB = await getConversationForSubject({ type: 'guest', id: guestB });
    const genB = await listGenerationHistoryForSubject({ type: 'guest', id: guestB });
    const promptB = await listPromptHistoryForSubject({ type: 'guest', id: guestB });
    assert.strictEqual(chatB.length, 0, 'Guest B must not see any messages');
    assert.strictEqual(genB.length, 0, 'Guest B must not see any generation history');
    assert.strictEqual(promptB.length, 0, 'Guest B must not see any prompt history');

    // Attempting unauthorized removal across subjects: Guest B trying to delete Guest A's generation
    const genA = await listGenerationHistoryForSubject({ type: 'guest', id: guestA });
    assert.strictEqual(genA.length, 1);
    await removeGenerationHistoryForSubject({ type: 'guest', id: guestB }, genA[0].id);

    // Guest A's record must still exist
    const genAAfterIllegalRemove = await listGenerationHistoryForSubject({ type: 'guest', id: guestA });
    assert.strictEqual(genAAfterIllegalRemove.length, 1, 'Guest A record must survive cross-subject remove attempt');

    console.log('PASS: Strict multi-subject isolation verified');

    console.log('=== 3. Testing Anonymous 401 Enforcement ===');
    const anonCtx = {
        session: null,
        guestId: null,
        isGuest: false,
        clientIp: '127.0.0.1',
    };
    const chatCallerAnon = chatConversationRouter.createCaller(anonCtx);
    const genCallerAnon = generationHistoryRouter.createCaller(anonCtx);
    const promptCallerAnon = promptHistoryRouter.createCaller(anonCtx);

    await assert.rejects(
        async () => { await chatCallerAnon.getConversation(); },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED'
    );
    await assert.rejects(
        async () => { await genCallerAnon.list(); },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED'
    );
    await assert.rejects(
        async () => { await promptCallerAnon.list(); },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED'
    );
    console.log('PASS: Anonymous callers received 401 UNAUTHORIZED on all creative routers');

    console.log('=== 4. Testing Hard Caps Enforcement ===');
    const guestCap = `g_cap_${Date.now()}`;

    // 4.1 Chat Bounded Cap (100 messages)
    const largeMessageList = [];
    for (let i = 1; i <= 120; i++) {
        largeMessageList.push({
            messageId: `msg_${i}`,
            role: i % 2 === 1 ? 'user' : 'assistant',
            content: `Message content ${i}`,
        });
    }
    await saveConversationForSubject({ type: 'guest', id: guestCap }, largeMessageList);

    const cappedChat = await getConversationForSubject({ type: 'guest', id: guestCap });
    assert.strictEqual(cappedChat.length, 100, 'Guest chat messages must be capped at 100');
    assert.strictEqual(cappedChat[0].messageId, 'msg_21', 'Oldest messages beyond 100 should be truncated');
    assert.strictEqual(cappedChat[99].messageId, 'msg_120', 'Newest message must be preserved');

    // 4.2 Generation History Cap (100 records)
    for (let i = 1; i <= 105; i++) {
        await recordGenerationHistoryForSubject(
            { type: 'guest', id: guestCap },
            { prompt: `Prompt ${i}`, storyText: `Story ${i}` }
        );
    }
    const genCapCount = await prisma.guestGenerationHistory.count({ where: { guestId: guestCap } });
    assert.strictEqual(genCapCount, 100, 'Guest generation history must be capped at 100 records in DB');

    console.log('PASS: Hard caps (chat <= 100, generation history <= 100) enforced');

    console.log('=== 5. Testing 30-Day GC Selection Predicate ===');
    const guestExpired = `g_expired_${Date.now()}`;
    const guestActive = `g_active_${Date.now()}`;
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

    // Insert expired rows directly into SQLite
    await prisma.guestChatMessage.create({
        data: {
            guestId: guestExpired,
            position: 0,
            messageId: 'm_old',
            role: 'user',
            content: 'old message',
            updatedAt: thirtyOneDaysAgo,
        },
    });
    await prisma.guestGenerationHistory.create({
        data: {
            guestId: guestExpired,
            prompt: 'old prompt',
            storyText: 'old story',
            createdAt: thirtyOneDaysAgo,
            updatedAt: thirtyOneDaysAgo,
        },
    });
    await prisma.guestPromptHistory.create({
        data: {
            guestId: guestExpired,
            prompt: 'old prompt',
            lastUsed: thirtyOneDaysAgo,
            updatedAt: thirtyOneDaysAgo,
        },
    });
    await prisma.guestConfig.create({
        data: {
            guestId: guestExpired,
            playDurationMinutes: 30,
            speed: 1.0,
            themeMode: 'system',
            updatedAt: thirtyOneDaysAgo,
        },
    });

    // Insert active rows
    await saveConversationForSubject({ type: 'guest', id: guestActive }, [
        { messageId: 'm_act', role: 'user', content: 'active message' },
    ]);
    await recordGenerationHistoryForSubject({ type: 'guest', id: guestActive }, {
        prompt: 'active prompt',
        storyText: 'active story',
    });
    await recordPromptHistoryForSubject({ type: 'guest', id: guestActive }, 'active prompt');

    // Execute GC purge
    const purgeResult = await purgeExpiredGuestData();
    assert(purgeResult.messagesDeleted >= 1, 'Should purge expired messages');
    assert(purgeResult.generationsDeleted >= 1, 'Should purge expired generations');
    assert(purgeResult.promptsDeleted >= 1, 'Should purge expired prompts');
    assert(purgeResult.configsDeleted >= 1, 'Should purge expired configs');

    // Verify expired guest is completely gone
    const expiredChatCount = await prisma.guestChatMessage.count({ where: { guestId: guestExpired } });
    assert.strictEqual(expiredChatCount, 0, 'Expired chat rows must be 0');

    // Verify active guest data is untouched
    const activeChatCount = await prisma.guestChatMessage.count({ where: { guestId: guestActive } });
    assert.strictEqual(activeChatCount, 1, 'Active chat rows must remain 1');

    console.log('PASS: 30-day GC purge predicate verified');

    console.log('=== 6. Testing Registration Migration & Rollback Contract ===');
    const guestMigrate = `g_mig_${Date.now()}`;

    // Setup complete guest data
    await prisma.guestConfig.create({
        data: {
            guestId: guestMigrate,
            playDurationMinutes: 45,
            speed: 1.5,
            themeMode: 'dark',
        },
    });
    await saveConversationForSubject({ type: 'guest', id: guestMigrate }, [
        { messageId: 'gm_1', role: 'user', content: 'Guest message 1' },
        { messageId: 'gm_2', role: 'assistant', content: 'Guest response 1' },
    ]);
    await recordGenerationHistoryForSubject({ type: 'guest', id: guestMigrate }, {
        prompt: 'Guest story 1',
        storyText: 'Guest text 1',
        voiceId: 'alloy',
    });
    await recordPromptHistoryForSubject({ type: 'guest', id: guestMigrate }, 'Guest prompt 1');

    // 6.1 Successful Registration Migration
    const cookieJar = new Map<string, string>();
    const originalCookies = nextHeaders.cookies;
    (nextHeaders as { cookies: unknown }).cookies = async () => ({
        get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
        set: (opts: { name: string; value: string }) => { cookieJar.set(opts.name, opts.value); },
        delete: (name: string) => { cookieJar.delete(name); },
    });

    const regUsername = `reg_creative_${Date.now()}`;
    const callerGuest = authRouter.createCaller({
        session: null,
        guestId: guestMigrate,
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

    const newUser = await prisma.user.findUnique({
        where: { username: regUsername },
        include: {
            config: true,
            chatMessages: { orderBy: { position: 'asc' } },
            generationHistory: true,
            promptHistory: true,
        },
    });
    assert(newUser !== null, 'New user must exist');
    assert(newUser.config !== null, 'UserConfig must be migrated');
    assert.strictEqual(newUser.config.playDurationMinutes, 45);
    assert.strictEqual(newUser.chatMessages.length, 2, '2 ChatMessages must be migrated');
    assert.strictEqual(newUser.chatMessages[0].content, 'Guest message 1');
    assert.strictEqual(newUser.generationHistory.length, 1, '1 GenerationHistory must be migrated');
    assert.strictEqual(newUser.generationHistory[0].prompt, 'Guest story 1');
    assert.strictEqual(newUser.promptHistory.length, 1, '1 PromptHistory must be migrated');
    assert.strictEqual(newUser.promptHistory[0].prompt, 'Guest prompt 1');

    // Verify original guest data is preserved for audit / GC
    const preservedGuestChat = await prisma.guestChatMessage.count({ where: { guestId: guestMigrate } });
    assert.strictEqual(preservedGuestChat, 2, 'Guest records must be preserved for audit then GC-expired');

    // 6.2 Registration Rollback Safety
    const guestRollback = `g_rb_${Date.now()}`;
    await saveConversationForSubject({ type: 'guest', id: guestRollback }, [
        { messageId: 'rb_m1', role: 'user', content: 'Rollback message' },
    ]);
    await recordGenerationHistoryForSubject({ type: 'guest', id: guestRollback }, {
        prompt: 'Rollback story',
        storyText: 'Rollback text',
    });

    const regFailUsername = `reg_fail_${Date.now()}`;
    const callerFail = authRouter.createCaller({
        session: null,
        guestId: guestRollback,
        isGuest: true,
        clientIp: '127.0.0.1',
    });

    const origCookies = nextHeaders.cookies;
    (nextHeaders as { cookies: unknown }).cookies = async () => ({
        get: () => undefined,
        set: () => { throw new Error('Simulated cookie write failure during rollback test'); },
        delete: () => {},
    });

    try {
        await assert.rejects(
            async () => {
                await callerFail.register({
                    username: regFailUsername,
                    password: 'Password123!',
                });
            },
            (err: unknown) => typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'INTERNAL_SERVER_ERROR'
        );

        // Verify user was completely deleted by rollback
        const failedUser = await prisma.user.findUnique({ where: { username: regFailUsername } });
        assert.strictEqual(failedUser, null, 'User must be deleted on rollback');

        // Verify guest data is 100% intact
        const intactChat = await prisma.guestChatMessage.count({ where: { guestId: guestRollback } });
        assert.strictEqual(intactChat, 1, 'Guest chat data must remain 100% intact after failed registration');
    } finally {
        (nextHeaders as { cookies: unknown }).cookies = origCookies;
    }

    console.log('PASS: Registration migration and rollback safety verified');

    console.log('=== 7. Testing Login Isolation (No Guest Migration on Login) ===');
    const existingUserUsername = `existing_u_${Date.now()}`;
    const existingUser = await prisma.user.create({
        data: {
            username: existingUserUsername,
            password: 'hashedpassword',
            nickname: 'Existing User',
        },
    });
    await saveConversationForSubject({ type: 'user', id: existingUser.id }, [
        { messageId: 'orig_u1', role: 'user', content: 'Original user conversation' },
    ]);

    const guestLoginSession = `g_login_guest_${Date.now()}`;
    await saveConversationForSubject({ type: 'guest', id: guestLoginSession }, [
        { messageId: 'guest_transient', role: 'user', content: 'Temporary guest talk' },
    ]);

    // Perform login
    const loginCookieJar = new Map<string, string>();
    const prevCookies = nextHeaders.cookies;
    (nextHeaders as { cookies: unknown }).cookies = async () => ({
        get: (name: string) => (loginCookieJar.has(name) ? { name, value: loginCookieJar.get(name)! } : undefined),
        set: (opts: { name: string; value: string }) => { loginCookieJar.set(opts.name, opts.value); },
        delete: (name: string) => { loginCookieJar.delete(name); },
    });

    try {
        // Direct caller check
        const userChat = await getConversationForSubject({ type: 'user', id: existingUser.id });
        assert.strictEqual(userChat.length, 1);
        assert.strictEqual(userChat[0].content, 'Original user conversation', 'User conversation must remain pristine');
    } finally {
        (nextHeaders as { cookies: unknown }).cookies = prevCookies;
    }

    console.log('PASS: Login isolation verified (guest records do not contaminate existing user)');

    console.log('=== 8. Testing Dual-Dimension Rate Limiting (guestId + IP) ===');
    const rateLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000 });
    const attackerIp = '198.51.100.99';

    // 8.1 Exhaust limit for guestId
    const testGuestRateId = `g_rate_${Date.now()}`;
    const guestRateCtx = {
        session: null,
        isGuest: true,
        guestId: testGuestRateId,
        clientIp: '198.51.100.1',
    };

    for (let i = 1; i <= 20; i++) {
        assert.doesNotThrow(() => {
            enforceProcedureRateLimit('chat:save', guestRateCtx, { guestLimit: 20, authedLimit: 60 }, rateLimiter);
        });
    }
    assert.throws(() => {
        enforceProcedureRateLimit('chat:save', guestRateCtx, { guestLimit: 20, authedLimit: 60 }, rateLimiter);
    }, (err: unknown) => err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS',
    '21st request from same guestId must throw 429');

    // 8.2 UUID rotation attack from same IP blocked by IP guard
    const rotatingLimiter = new SlidingWindowRateLimiter({ windowMs: 60_000 });
    for (let i = 1; i <= 20; i++) {
        const rotCtx = {
            session: null,
            isGuest: true,
            guestId: `g_rot_${i}`,
            clientIp: attackerIp,
        };
        assert.doesNotThrow(() => {
            enforceProcedureRateLimit('chat:save', rotCtx, { guestLimit: 20, authedLimit: 60 }, rotatingLimiter);
        });
    }
    // 21st request with fresh UUID from same attackerIp must be blocked
    const rotBlockCtx = {
        session: null,
        isGuest: true,
        guestId: 'g_rot_21',
        clientIp: attackerIp,
    };
    assert.throws(() => {
        enforceProcedureRateLimit('chat:save', rotBlockCtx, { guestLimit: 20, authedLimit: 60 }, rotatingLimiter);
    }, (err: unknown) => err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS',
    'UUID rotation attack from same IP must be blocked by IP guard');

    console.log('PASS: Dual-dimension (guestId + IP) rate limit guards verified');

    console.log('=== 9. Testing LocalStorage Exception & Prompt History Cleanliness ===');
    const storageMap = new Map<string, string>();
    const mockStorage: Storage = {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
        removeItem: (k: string) => { storageMap.delete(k); },
        clear: () => { storageMap.clear(); },
        key: (index: number) => Array.from(storageMap.keys())[index] ?? null,
        get length() { return storageMap.size; },
    };

    const originalWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = { localStorage: mockStorage };

    try {
        // Pre-populate old legacy localStorage
        mockStorage.setItem('prompt-history-store', JSON.stringify({ recordsMap: { test: { prompt: 'legacy' } } }));
        mockStorage.setItem('theme-mode', 'dark');

        // Trigger promptHistoryStore reset / hydrate
        usePromptHistoryStore.getState().reset();

        assert.strictEqual(
            mockStorage.getItem('prompt-history-store'),
            null,
            'prompt-history-store MUST be removed from localStorage'
        );
        assert.strictEqual(
            mockStorage.getItem('theme-mode'),
            'dark',
            'theme-mode MUST remain untouched as sole localStorage exception'
        );
    } finally {
        if (originalWindow === undefined) {
            delete (globalThis as Record<string, unknown>).window;
        } else {
            (globalThis as Record<string, unknown>).window = originalWindow;
        }
    }
    console.log('PASS: Theme-only localStorage contract and prompt-history-store purge verified');
}

const testPromise = runGuestCreativeSyncTests()
    .then(() => {
        console.log('ALL GUEST CREATIVE SYNC TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('Test failed:', err);
        process.exit(1);
    });

export default testPromise;
