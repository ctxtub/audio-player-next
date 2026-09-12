import assert from 'node:assert';
import { createRequire } from 'node:module';
import * as nextHeaders from 'next/headers';
import { prisma } from '../../../lib/db';
import {
    getConversationForSubject,
    saveConversationForSubject,
} from '../../../lib/server/chatConversation';
import { recordGenerationHistoryForSubject } from '../../../lib/server/generationHistory';
import { recordPromptHistoryForSubject } from '../../../lib/server/promptHistory';
import { authRouter } from '../../../lib/trpc/routers/auth';
import { encodeGuestId } from '../../../lib/session';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const bcrypt = nodeRequire('bcryptjs') as typeof import('bcryptjs');

process.env.SESSION_SECRET = 'test-secret-login-existing-no-leak-12345';

/**
 * E2E-05-03 登录既有账号无数据渗漏（L2，真实 authRouter.login）。
 *
 * oracle（spec 05-03 + catalog no-leak-on-login[db]）：
 * 1. 带活跃访客 cookie 登录既有账号后只显示 A 的数据，访客独有内容不得出现；
 * 2. 登录不触发迁移：用户侧 DB 逐字节不变、访客侧 DB 逐字节不变、用户计数不变；
 * 3. SESSION 签发且 guest 保留、零删除。
 * store 跃迁（resetAccountData 后无旧音频残留）属浏览器面，本轮未覆盖（见 handover 未覆盖项）。
 */
async function runLoginNoLeakTests() {
    const tag = Date.now();
    const username = `login_noleak_${tag}`;
    const password = 'Password123!';

    // ---- 1. 老用户 A 造数（服务端四块：配置/聊天/生成/提示词/进度）----
    const hashed = await bcrypt.hash(password, 10);
    const userA = await prisma.user.create({
        data: { username, password: hashed, nickname: 'LoginNoLeakUserA' },
    });
    await prisma.userConfig.create({
        data: { userId: userA.id, playDurationMinutes: 60, themeMode: 'light' },
    });
    await saveConversationForSubject({ type: 'user', id: userA.id }, [
        { messageId: 'ua_1', role: 'user', content: 'USER-A-OWN-CONTENT-独有' },
        { messageId: 'ua_2', role: 'assistant', content: 'USER-A-REPLY-独有' },
    ]);
    await recordGenerationHistoryForSubject({ type: 'user', id: userA.id }, {
        prompt: 'USER-A-PROMPT',
        storyText: 'USER-A-STORY',
        voiceId: 'alloy',
    });
    await recordPromptHistoryForSubject({ type: 'user', id: userA.id }, 'USER-A-PROMPT-HIST');
    await prisma.userPlaybackProgress.create({
        data: {
            userId: userA.id,
            sourceType: 'chat',
            sourceId: 'ua_2',
            sessionId: 'ua_2',
            title: 'A',
            contentHash: 'a-hash-noleak',
            lastCompletedParagraphIndex: 0,
            nextParagraphIndex: 1,
            totalParagraphs: 3,
        },
    });

    // ---- 2. 活跃访客造数（与 A 完全不同的独有内容）----
    const guestId = `g_login_noleak_${tag}`;
    await prisma.guestConfig.create({ data: { guestId, playDurationMinutes: 20 } });
    await saveConversationForSubject({ type: 'guest', id: guestId }, [
        { messageId: 'gq_1', role: 'user', content: 'GUEST-DRAFT-访客草稿独有' },
    ]);
    await recordGenerationHistoryForSubject({ type: 'guest', id: guestId }, {
        prompt: 'GUEST-PROMPT',
        storyText: 'GUEST-STORY',
    });
    await recordPromptHistoryForSubject({ type: 'guest', id: guestId }, 'GUEST-PROMPT-HIST');
    await prisma.guestPlaybackProgress.create({
        data: { guestId, sourceType: 'chat', sourceId: 'gq_1', sessionId: 'gq_1', title: 'G' },
    });

    // 登录前全量快照
    const snap = {
        userChat: await getConversationForSubject({ type: 'user', id: userA.id }),
        guestChat: await getConversationForSubject({ type: 'guest', id: guestId }),
        userGen: (await prisma.storyWork.findMany({ where: { userId: userA.id } })).length,
        userPrompt: (await prisma.promptHistory.findMany({ where: { userId: userA.id } })).length,
        userProg: await prisma.userPlaybackProgress.findUnique({ where: { userId: userA.id } }),
        guestGen: await prisma.guestStoryWork.count({ where: { guestId } }),
        guestPrompt: await prisma.guestPromptHistory.count({ where: { guestId } }),
        guestProg: await prisma.guestPlaybackProgress.findUnique({ where: { guestId } }),
        guestCfg: await prisma.guestConfig.findUnique({ where: { guestId } }),
        userCount: await prisma.user.count(),
    };

    // ---- 3. 调真实 login（jar 预置签名 guest cookie，模拟"带访客身登录"）----
    // encodeGuestId 内嵌秒级 exp，两次调用可能跨秒不一致，故只签发一次并复用。
    const guestCookieValue = encodeGuestId(guestId);
    const cookieJar = new Map<string, string>([['guest', guestCookieValue]]);
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
    let loginResult: { success: boolean };
    try {
        const caller = authRouter.createCaller({
            session: null,
            guestId,
            isGuest: true,
            clientIp: '127.0.0.1',
        });
        loginResult = await caller.login({ username, password });
    } finally {
        (nextHeaders as { cookies: unknown }).cookies = originalCookies;
    }
    assert.strictEqual(loginResult.success, true, 'login 应成功');

    // ---- 4.1 cookie 三断言：SESSION 签发且 guest 保留、零删除 ----
    assert(cookieJar.has('auth'), 'SESSION(auth) cookie 应被签发');
    assert(cookieJar.has('guest'), 'guest cookie 应被保留（供后续登出回访客）');
    assert.strictEqual(cookieJar.get('guest'), guestCookieValue, 'guest cookie 值应原样不变');
    assert.deepStrictEqual(deleted, [], 'login 不得删除任何 cookie');
    console.log('PASS: cookies (SESSION issued, guest kept, no delete)');

    // ---- 4.2 用户侧逐字节不变（无渗漏核心） ----
    const userChatAfter = await getConversationForSubject({ type: 'user', id: userA.id });
    assert.deepStrictEqual(userChatAfter, snap.userChat, '用户聊天应原样不变');
    assert(!JSON.stringify(userChatAfter).includes('GUEST-DRAFT'), '访客独有内容不得出现在用户侧');
    assert.strictEqual(
        (await prisma.storyWork.findMany({ where: { userId: userA.id } })).length,
        snap.userGen,
        '用户生成历史计数不变',
    );
    assert.strictEqual(
        (await prisma.promptHistory.findMany({ where: { userId: userA.id } })).length,
        snap.userPrompt,
        '用户提示词历史计数不变',
    );
    const userProgAfter = await prisma.userPlaybackProgress.findUnique({ where: { userId: userA.id } });
    assert.strictEqual(userProgAfter?.nextParagraphIndex, snap.userProg?.nextParagraphIndex, '用户进度行不变');
    assert.strictEqual(await prisma.user.count(), snap.userCount, '不得产生新用户行');
    console.log('PASS: user side unchanged (no leak into A)');

    // ---- 4.3 访客侧逐字节不变（登录不触发迁移/删除） ----
    const guestChatAfter = await getConversationForSubject({ type: 'guest', id: guestId });
    assert.deepStrictEqual(guestChatAfter, snap.guestChat, '访客聊天应原样保留');
    assert.strictEqual(
        await prisma.guestStoryWork.count({ where: { guestId } }),
        snap.guestGen,
        '访客生成历史计数不变',
    );
    assert.strictEqual(
        await prisma.guestPromptHistory.count({ where: { guestId } }),
        snap.guestPrompt,
        '访客提示词历史计数不变',
    );
    assert.deepStrictEqual(
        await prisma.guestPlaybackProgress.findUnique({ where: { guestId } }),
        snap.guestProg,
        '访客进度行原样保留',
    );
    assert.deepStrictEqual(
        await prisma.guestConfig.findUnique({ where: { guestId } }),
        snap.guestCfg,
        '访客配置行原样保留',
    );
    console.log('PASS: guest side unchanged (no migration on login)');

    console.log('ALL LOGIN NO-LEAK TESTS PASSED SUCCESSFULLY');
}

const testPromise = runLoginNoLeakTests()
    .then(() => {
        console.log('ALL LOGIN NO-LEAK TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('Test failed:', err);
        process.exit(1);
    });

export default testPromise;
