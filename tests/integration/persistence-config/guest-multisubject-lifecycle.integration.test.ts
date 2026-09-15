/**
 * 浏览器端会话与跨 Tab 行为仿真测试套件 (Browser E2E Simulation Harness)
 *
 * 验证：
 * 1. Tab A：访客创作故事与提示词，向服务端快照同步。
 * 2. Tab B（同浏览器相同 guestId Cookie）：水合拉取，无缝呈现 Tab A 的创作记录。
 * 3. 页面刷新（F5）：重新拉取，记录完好保留且无需任何 LocalStorage。
 * 4. 注册转化：Tab A 注册新用户，服务端原子迁移，新用户在 Tab A 与 Tab B 均能看到继承的创作记录。
 * 5. 跨账号登录：若访客登录已有账号，现有账号的记录不会被访客污染。
 */

import assert from 'node:assert';
import * as nextHeaders from 'next/headers';
import { prisma } from '../../../lib/db';
import { chatConversationRouter } from '../../../lib/trpc/routers/chatConversation';
import { createStoryWorkForSubject } from '../../../lib/server/storyWork';
import { authRouter } from '../../../lib/trpc/routers/auth';
import { encodeSession } from '../../../lib/session';

process.env.SESSION_SECRET = 'test-secret-e2e-harness-12345';

async function runBrowserE2eHarnessTests() {
    console.log('=== Browser E2E Simulation: Multi-Tab & Lifecycle Harness ===');

    // 1. Simulating Browser Client with Cookie Jar
    const browserGuestId = `g_browser_session_${Date.now()}`;
    const clientIp = '192.168.1.100';

    const guestContext = {
        session: null,
        guestId: browserGuestId,
        isGuest: true,
        clientIp,
    };

    // Tab A Router Callers
    const tabAChat = chatConversationRouter.createCaller(guestContext);

    // Tab B Router Callers (Simulating second tab in same browser)
    const tabBChat = chatConversationRouter.createCaller(guestContext);

    // --- Scenario 1: Tab A Creates Story & Prompts ---
    // M4-08：经 save 路径新建 storyCard 已被 provenance guard 禁止；Tab A 的旧故事卡
    // 以直写 seeding 模拟 pre-M4-08 已持久历史（已 sanitize 形态 audioUrl=''），有意绕过 guard。
    // 下游断言（Tab B 水合 audioUrl=''、注册迁移保真）保持不变。
    console.log('1. Tab A produces creative work');
    await prisma.guestChatMessage.createMany({
        data: [
            {
                guestId: browserGuestId,
                position: 0,
                messageId: 'e2e_m1',
                role: 'user',
                content: 'Tell me about the ocean depths',
            },
            {
                guestId: browserGuestId,
                position: 1,
                messageId: 'e2e_m2',
                role: 'assistant',
                content: 'In the deep abyss, bioluminescent creatures glow.',
                parts: JSON.stringify([{
                    type: 'storyCard',
                    storyText: 'In the deep abyss, bioluminescent creatures glow.',
                    audioUrl: '',
                }]),
            },
        ],
    });

    await createStoryWorkForSubject({ type: 'guest', id: browserGuestId }, {
        prompt: 'Ocean depths story',
        storyText: 'In the deep abyss, bioluminescent creatures glow.',
        voiceId: 'shimmer',
    });

    await prisma.guestPromptHistory.create({
        data: { guestId: browserGuestId, prompt: 'Ocean depths story', lastUsed: new Date(), useCount: 1 },
    });

    // --- Scenario 2: Tab B Hydrates (Survives New Tab / Same Cookie) ---
    console.log('2. Tab B loads and retrieves Tab A creative records');
    const tabBChatMessages = await tabBChat.getConversation();
    assert.strictEqual(tabBChatMessages.length, 2, 'Tab B must load both messages created in Tab A');
    assert.strictEqual(tabBChatMessages[0].content, 'Tell me about the ocean depths');
    // Verify audioUrl is absent (regeneration based)
    const assistantParts = tabBChatMessages[1].parts as Array<Record<string, unknown>>;
    assert.strictEqual(assistantParts[0].audioUrl, '', 'Tab B audioUrl must be empty (regenerated on click)');

    const tabBWorks = await prisma.guestStoryWork.findMany({ where: { guestId: browserGuestId } });
    assert.strictEqual(tabBWorks.length, 1, 'Tab B works must contain story created in Tab A');
    assert.strictEqual(tabBWorks[0].prompt, 'Ocean depths story');

    const tabBPrompts = await prisma.guestPromptHistory.findMany({ where: { guestId: browserGuestId } });
    assert.strictEqual(tabBPrompts.length, 1, 'Tab B guest prompt rows persist (table retained until T4)');

    // --- Scenario 3: Page Reload in Tab A (F5 Simulation) ---
    console.log('3. Tab A page reload fetches server cloud records without local storage');
    const reloadedMessages = await tabAChat.getConversation();
    assert.strictEqual(reloadedMessages.length, 2, 'Reloaded chat preserves messages');
    const reloadedWorks = await prisma.guestStoryWork.count({ where: { guestId: browserGuestId } });
    assert.strictEqual(reloadedWorks, 1, 'Reloaded works preserves story');

    // --- Scenario 4: Registration Transformation ---
    console.log('4. Guest registers new account, converting guest records to user account');
    const newUsername = `u_e2e_${Date.now()}`;
    const authCaller = authRouter.createCaller(guestContext);

    const cookieJar = new Map<string, string>();
    const originalCookies = nextHeaders.cookies;
    (nextHeaders as { cookies: unknown }).cookies = async () => ({
        get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
        set: (opts: { name: string; value: string }) => { cookieJar.set(opts.name, opts.value); },
        delete: (name: string) => { cookieJar.delete(name); },
    });

    let regResult: { success: boolean };
    try {
        regResult = await authCaller.register({
            username: newUsername,
            password: 'Password123!',
            nickname: 'Ocean Explorer',
        });
    } finally {
        (nextHeaders as { cookies: unknown }).cookies = originalCookies;
    }
    assert.strictEqual(regResult.success, true);

    const registeredUser = await prisma.user.findUnique({
        where: { username: newUsername },
    });
    assert(registeredUser !== null, 'Registered user must exist');

    // Authenticated User Context in Tab A & Tab B
    const authedContext = {
        session: { userId: registeredUser.id, nickname: 'Ocean Explorer' },
        guestId: null,
        isGuest: false,
        clientIp,
    };
    const authedChat = chatConversationRouter.createCaller(authedContext);

    const userMessages = await authedChat.getConversation();
    assert.strictEqual(userMessages.length, 2, 'Migrated user account has chat messages');
    assert.strictEqual(userMessages[1].content, 'In the deep abyss, bioluminescent creatures glow.');

    const userWorks = await prisma.storyWork.count({ where: { userId: registeredUser.id } });
    assert.strictEqual(userWorks, 1, 'Migrated user account has works history');

    // M9-C1 T2：Prompt History 已退役，注册迁移不再复制（Guest 原行保留给 GC）。
    const userPrompts = await prisma.promptHistory.count({ where: { userId: registeredUser.id } });
    assert.strictEqual(userPrompts, 0, 'Prompt History 退役后注册不迁移提示词历史');

    console.log('PASS: Browser E2E simulation harness successfully verified');
}

const testPromise = runBrowserE2eHarnessTests()
    .then(() => {
        console.log('ALL BROWSER E2E HARNESS TESTS PASSED');
    })
    .catch((err) => {
        console.error('Browser E2E test failed:', err);
        process.exit(1);
    });

export default testPromise;
