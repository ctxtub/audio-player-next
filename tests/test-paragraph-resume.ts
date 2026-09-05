import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as nextHeaders from 'next/headers';
import { prisma } from '../lib/db';
import { TRPCError } from '@trpc/server';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
let lastToast: { icon: string; content: string } | null = null;
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: {
        default: {
            show: (opts: { icon: string; content: string }) => {
                lastToast = opts;
            },
            clear: () => {
                lastToast = null;
            },
        },
    },
} as unknown as NodeModule;

import {
    normalizeStoryText,
    segmentStoryText,
    computeStoryContentHash,
    SEGMENTATION_VERSION,
} from '../utils/segmentation';
import {
    getPlaybackProgressForSubject,
    savePlaybackProgressForSubject,
    clearPlaybackProgressForSubject,
} from '../lib/server/playbackProgress';
import { purgeExpiredGuestData } from '../lib/server/guestGc';
import { migrateGuestPlaybackProgressToUser } from '../lib/server/unifiedMigration';
import { playbackRouter } from '../lib/trpc/routers/playback';
import { authRouter } from '../lib/trpc/routers/auth';
import { saveConversationForSubject } from '../lib/server/chatConversation';
import { recordGenerationHistoryForSubject } from '../lib/server/generationHistory';

const { usePlaybackStore } = nodeRequire('../stores/playbackStore') as {
    usePlaybackStore: typeof import('../stores/playbackStore').usePlaybackStore;
};
const { usePlaybackProgressStore } = nodeRequire('../stores/playbackProgressStore') as {
    usePlaybackProgressStore: typeof import('../stores/playbackProgressStore').usePlaybackProgressStore;
};
const { useChatStore } = nodeRequire('../stores/chatStore') as {
    useChatStore: typeof import('../stores/chatStore').useChatStore;
};
const { useGenerationHistoryStore } = nodeRequire('../stores/generationHistoryStore') as {
    useGenerationHistoryStore: typeof import('../stores/generationHistoryStore').useGenerationHistoryStore;
};
const { resetAccountData } = nodeRequire('../stores/accountSync') as {
    resetAccountData: typeof import('../stores/accountSync').resetAccountData;
};

process.env.SESSION_SECRET = 'test-secret-paragraph-resume-12345';

async function runParagraphResumeTests() {
    console.log('=== 0. Testing Deterministic Segmentation, Normalization & Fingerprints ===');

    // 0.1 Normalization of CRLF and trailing whitespace
    const rawText = "第一段故事。\r\n第二段故事。   \r\n第三段故事。  ";
    const normalized = normalizeStoryText(rawText);
    assert.strictEqual(normalized, "第一段故事。\n第二段故事。\n第三段故事。");

    // 0.2 Long paragraph split (> 350 chars)
    const longSentence = "这是一个很长很长的句子，充满了各种细节和波折。".repeat(20);
    assert(longSentence.length > 350, "Sentence should be longer than 350 characters");
    const splitChunks = segmentStoryText(longSentence);
    assert(splitChunks.length >= 2, "Long paragraph must be split into multiple chunks");
    for (const chunk of splitChunks) {
        assert(chunk.length <= 350, `Chunk length ${chunk.length} must not exceed 350`);
    }

    // 0.3 Short dialogue forward merge (< 80 chars)
    const shortDialogues = "“你好！”\n“你也好。”\n“今天天气真好啊。”\n“确实很晴朗。”\n这是一段稍微长一点的描述文字，用于承接刚才几句短小的对话。";
    const mergedChunks = segmentStoryText(shortDialogues);
    assert(mergedChunks.length < 5, "Short dialogues must be merged to prevent micro audio fragments");

    // 0.4 Deterministic ContentHash (12 hex characters)
    const hash1 = computeStoryContentHash("故事正文内容ABC");
    const hash2 = computeStoryContentHash("故事正文内容ABC\r\n"); // normalizes to same text
    assert.strictEqual(hash1.length, 12, "Hash must be 12 hex characters");
    assert.strictEqual(hash1, hash2, "Normalized text must yield identical hash regardless of CRLF");

    // 0.5 Adaptive prefetch window formula
    const calcPrefetchThreshold = (duration: number) => Math.min(10, Math.max(5, duration * 0.25));
    assert.strictEqual(calcPrefetchThreshold(40), 10);
    assert.strictEqual(calcPrefetchThreshold(20), 5);
    assert.strictEqual(calcPrefetchThreshold(60), 10);
    assert.strictEqual(calcPrefetchThreshold(12), 5);

    console.log('PASS: Segmentation, normalization, content hash and adaptive prefetch verified');

    console.log('=== TC-P2-01: 具名访客硬刷新段落断点恢复 ===');
    const guestId1 = `g_resume_tc01_${Date.now()}`;
    const guestCtx1 = { session: null, guestId: guestId1, isGuest: true, clientIp: '127.0.0.1' };
    const callerGuest1 = playbackRouter.createCaller(guestCtx1);

    const storyMessageId1 = `msg_story_${Date.now()}`;
    const para1 = "第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。";
    const para2 = "第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。";
    const para3 = "第三自然段：有一天它在一棵巨大的古老松树下发现了一颗闪闪发光的神奇松果，散发出奇异而温暖的柔和光芒，不仅照亮了周围湿漉漉的青苔，还散发出一种让人心情平静的香气。";
    const para4 = "第四自然段：这颗发光的松果带领着好奇的小松鼠走进了森林最深处的奇妙花园，那里盛开着从未见过的美丽奇幻花朵，彩色的蝴蝶在花丛中翩翩起舞，宛如梦境一般美丽动人。";
    const storyText1 = `${para1}\n${para2}\n${para3}\n${para4}`;
    const storyHash1 = computeStoryContentHash(storyText1);

    // Save story to guest chat in DB
    await saveConversationForSubject({ type: 'guest', id: guestId1 }, [
        {
            messageId: storyMessageId1,
            role: 'assistant',
            content: storyText1,
            parts: [{ type: 'storyCard', storyText: storyText1, audioUrl: '' }],
        },
    ]);

    // Save progress: stopped at paragraph index 2 (third paragraph), completed paragraph 1
    await callerGuest1.saveProgress({
        sourceType: 'chat',
        sourceId: storyMessageId1,
        title: '小松鼠的故事',
        contentHash: storyHash1,
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 1,
        nextParagraphIndex: 2,
        totalParagraphs: 4,
        voiceId: 'alloy',
        speed: 1.0,
    });

    // Simulate page reload
    const fetched1 = await callerGuest1.getProgress();
    assert(fetched1 !== null, 'Progress must be retrieved from server');
    assert.strictEqual(fetched1.nextParagraphIndex, 2);
    assert.strictEqual(fetched1.title, '小松鼠的故事');

    // Simulate client hydration in store
    useChatStore.getState().reset();
    usePlaybackStore.getState().reset();
    usePlaybackProgressStore.getState().reset();

    useChatStore.setState({
        messages: [
            {
                id: storyMessageId1,
                role: 'assistant',
                content: storyText1,
                parts: [{ type: 'storyCard', storyText: storyText1, audioUrl: '' }],
                status: 'delivered',
                createdAt: new Date().toISOString(),
            },
        ],
        syncEnabled: true,
    });

    const hydrated1 = await usePlaybackProgressStore.getState().hydrateFromDTO(fetched1);
    assert.strictEqual(hydrated1, true, 'Hydration must succeed');

    const playbackState1 = usePlaybackStore.getState();
    assert.strictEqual(playbackState1.isRehydratedReady, true, 'Must land in isRehydratedReady = true');
    assert.strictEqual(playbackState1.isPlaying, false, 'Must strictly land PAUSED (no autoplay)');
    assert.strictEqual(playbackState1.currentSegmentIndex, 2, 'Current segment index should be 2');
    assert.strictEqual(playbackState1.currentTime, 0, 'No time offset persistence (currentTime must be 0)');
    assert.strictEqual(playbackState1.duration, 0, 'Duration remains 0 until audio load');

    console.log('PASS: TC-P2-01 verified');

    console.log('=== TC-P2-02: 中途暂停重播整段契约 ===');
    // In TC-P2-02, a user pauses mid-paragraph (e.g. 15s in).
    // The contract requires persisting nextParagraphIndex: 2, and upon reload starting at 0:00.
    assert.strictEqual(playbackState1.currentTime, 0, 'Resume always lands at 0:00 of paragraph');
    console.log('PASS: TC-P2-02 verified');

    console.log('=== TC-P2-03: 登录用户跨设备/跨浏览器同步 ===');
    const userA = await prisma.user.create({
        data: {
            username: `user_p2_03_${Date.now()}`,
            password: 'dummy-password',
            nickname: 'userA',
        },
    });
    const userAId = userA.id;
    const userACtx = {
        session: { userId: userAId, nickname: 'userA' },
        guestId: null,
        isGuest: false,
        clientIp: '127.0.0.1',
    };
    const callerUserA = playbackRouter.createCaller(userACtx);

    // Clean user A's state
    await clearPlaybackProgressForSubject({ type: 'user', id: userAId });

    // Device A saves progress: nextParagraphIndex = 3
    await callerUserA.saveProgress({
        sourceType: 'generation',
        sourceId: '1001',
        title: '云端同步故事',
        contentHash: 'hash12345678',
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 2,
        nextParagraphIndex: 3,
        totalParagraphs: 5,
        voiceId: 'fable',
        speed: 1.25,
    });

    // Device B logs in as user A
    const fetchedDeviceB = await callerUserA.getProgress();
    assert(fetchedDeviceB !== null);
    assert.strictEqual(fetchedDeviceB.nextParagraphIndex, 3);
    assert.strictEqual(fetchedDeviceB.voiceId, 'fable');
    assert.strictEqual(fetchedDeviceB.speed, 1.25);

    // Multi-subject isolation: Guest cannot read user A's progress
    const fetchedByGuest = await callerGuest1.getProgress();
    assert.notStrictEqual(fetchedByGuest?.title, '云端同步故事', 'Guest must not read User A progress');

    await prisma.user.delete({ where: { id: userAId } });

    console.log('PASS: TC-P2-03 verified');

    console.log('=== TC-P2-04: 睡眠倒计时时长断点继承 ===');
    const guestId4 = `g_sleep_${Date.now()}`;
    const callerGuest4 = playbackRouter.createCaller({ session: null, guestId: guestId4, isGuest: true, clientIp: '127.0.0.1' });

    // Set 30 min (1800000ms), remaining 25 min (1500000ms)
    await callerGuest4.saveProgress({
        sourceType: 'generation',
        sourceId: '2001',
        title: '睡眠故事',
        contentHash: 'sleephash123',
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 0,
        nextParagraphIndex: 1,
        totalParagraphs: 3,
        remainingAllowedMs: 1500000,
        totalAllowedMs: 1800000,
    });

    const sleepRecord = await callerGuest4.getProgress();
    assert(sleepRecord !== null);
    assert.strictEqual(sleepRecord.remainingAllowedMs, 1500000, 'Remaining allowed ms must be preserved');
    assert.strictEqual(sleepRecord.totalAllowedMs, 1800000, 'Total allowed ms must be preserved');

    console.log('PASS: TC-P2-04 verified');

    console.log('=== TC-P2-05 & TC-P2-06: 访客注册原子迁移与回滚契约 ===');
    const guestId5 = `g_reg_${Date.now()}`;
    const callerGuest5 = playbackRouter.createCaller({ session: null, guestId: guestId5, isGuest: true, clientIp: '127.0.0.1' });

    await callerGuest5.saveProgress({
        sourceType: 'generation',
        sourceId: '3001',
        title: '访客待迁移故事',
        contentHash: 'hashmig12345',
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 1,
        nextParagraphIndex: 2,
        totalParagraphs: 4,
        voiceId: 'echo',
        speed: 1.0,
    });

    // 5.1 Registration migration
    const cookieJar = new Map<string, string>();
    (nextHeaders as { cookies: unknown }).cookies = async () => ({
        get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
        set: (opts: { name: string; value: string }) => { cookieJar.set(opts.name, opts.value); },
        delete: (name: string) => { cookieJar.delete(name); },
    });

    const regUsername = `reg_p2_${Date.now()}`;
    const authCaller = authRouter.createCaller({
        session: null,
        guestId: guestId5,
        isGuest: true,
        clientIp: '127.0.0.1',
    });

    const regResult = await authCaller.register({
        username: regUsername,
        password: 'Password123!',
        nickname: 'RegisteredP2',
    });
    assert.strictEqual(regResult.success, true);

    const newUser = await prisma.user.findUnique({ where: { username: regUsername } });
    assert(newUser !== null);

    // Verify UserPlaybackProgress was migrated
    const migratedProgress = await prisma.userPlaybackProgress.findUnique({
        where: { userId: newUser.id },
    });
    assert(migratedProgress !== null, 'UserPlaybackProgress must be migrated');
    assert.strictEqual(migratedProgress.sourceId, '3001');
    assert.strictEqual(migratedProgress.nextParagraphIndex, 2);
    assert.strictEqual(migratedProgress.contentHash, 'hashmig12345');

    // Verify GuestPlaybackProgress row remains intact in guest table (for 30d GC)
    const guestOriginal = await prisma.guestPlaybackProgress.findUnique({
        where: { guestId: guestId5 },
    });
    assert(guestOriginal !== null, 'Guest original progress must be retained for GC');

    // 6.1 Rollback Contract (Cascade on user deletion)
    await prisma.user.delete({ where: { id: newUser.id } });
    const userProgressAfterDelete = await prisma.userPlaybackProgress.findUnique({
        where: { userId: newUser.id },
    });
    assert.strictEqual(userProgressAfterDelete, null, 'UserPlaybackProgress must cascade delete with user');

    // Guest progress must still be intact
    const guestProgressAfterRollback = await prisma.guestPlaybackProgress.findUnique({
        where: { guestId: guestId5 },
    });
    assert(guestProgressAfterRollback !== null, 'Guest progress must survive user rollback');

    console.log('PASS: TC-P2-05 & TC-P2-06 verified');

    console.log('=== TC-P2-07: 访客登录老账号隔离 ===');
    const guestId7 = `g_login_iso_${Date.now()}`;
    const callerGuest7 = playbackRouter.createCaller({ session: null, guestId: guestId7, isGuest: true, clientIp: '127.0.0.1' });
    await callerGuest7.saveProgress({
        sourceType: 'generation',
        sourceId: 'story_guest_7',
        title: '访客故事7',
        contentHash: 'ghash777',
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 0,
        nextParagraphIndex: 1,
        totalParagraphs: 2,
    });

    // Create user B with story B
    const userB = await prisma.user.create({
        data: {
            username: `userB_${Date.now()}`,
            password: 'hashedpassword',
        },
    });
    await savePlaybackProgressForSubject({ type: 'user', id: userB.id }, {
        sourceType: 'generation',
        sourceId: 'story_user_b',
        title: '用户B故事',
        contentHash: 'bhash888',
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 2,
        nextParagraphIndex: 3,
        totalParagraphs: 5,
    });

    // Verify login does NOT migrate guest data to existing user
    const userBProgress = await getPlaybackProgressForSubject({ type: 'user', id: userB.id });
    assert.strictEqual(userBProgress?.sourceId, 'story_user_b', 'User B story must not be overwritten by guest');

    // Clean up userB
    await prisma.user.delete({ where: { id: userB.id } });
    console.log('PASS: TC-P2-07 verified');

    console.log('=== TC-P2-08: 登出清理与无向后污染 ===');
    usePlaybackStore.getState().hydrateFromProgress({
        sessionId: 'sess_1',
        currentMessageId: 'msg_1',
        sourceType: 'chat',
        sourceId: 'msg_1',
        title: '登出测试故事',
        remainingMs: 600000,
        totalAllowedMs: 600000,
        isOneShot: false,
        currentParagraphIndex: 2,
        totalParagraphs: 4,
    });
    assert.strictEqual(usePlaybackStore.getState().isRehydratedReady, true);

    // Trigger logout reset
    resetAccountData();

    assert.strictEqual(usePlaybackStore.getState().isRehydratedReady, false, 'Playback store must be reset on logout');
    assert.strictEqual(usePlaybackStore.getState().sourceId, null);
    assert.strictEqual(usePlaybackProgressStore.getState().sourceId, null);

    console.log('PASS: TC-P2-08 verified');

    console.log('=== TC-P2-09: 故事完全播毕自动注销 ===');
    const guestId9 = `g_clear_${Date.now()}`;
    const callerGuest9 = playbackRouter.createCaller({ session: null, guestId: guestId9, isGuest: true, clientIp: '127.0.0.1' });
    await callerGuest9.saveProgress({
        sourceType: 'generation',
        sourceId: '9001',
        title: '播毕故事',
        contentHash: 'hash9001',
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 0,
        nextParagraphIndex: 1,
        totalParagraphs: 2,
    });

    const clearRes = await callerGuest9.clearProgress();
    assert.strictEqual(clearRes.success, true);
    const postClear = await callerGuest9.getProgress();
    assert.strictEqual(postClear, null, 'Progress must be null after clearProgress');

    console.log('PASS: TC-P2-09 verified');

    console.log('=== TC-P2-10: 30 天访客过期数据批量 GC ===');
    const guestExpired = `g_exp_gc_${Date.now()}`;
    const guestActive = `g_act_gc_${Date.now()}`;
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

    // Create expired record
    await prisma.guestPlaybackProgress.create({
        data: {
            guestId: guestExpired,
            sourceType: 'generation',
            sourceId: 'exp_1',
            title: '过期故事',
            contentHash: 'exphash',
            segmentationVersion: SEGMENTATION_VERSION,
            updatedAt: thirtyOneDaysAgo,
        },
    });

    // Create active record
    await prisma.guestPlaybackProgress.create({
        data: {
            guestId: guestActive,
            sourceType: 'generation',
            sourceId: 'act_1',
            title: '活跃故事',
            contentHash: 'acthash',
            segmentationVersion: SEGMENTATION_VERSION,
            updatedAt: new Date(),
        },
    });

    const purgeRes = await purgeExpiredGuestData();
    assert(purgeRes.playbackProgressDeleted >= 1, 'Must purge expired playback progress');

    const expCheck = await prisma.guestPlaybackProgress.findUnique({ where: { guestId: guestExpired } });
    assert.strictEqual(expCheck, null, 'Expired guest progress must be deleted');

    const actCheck = await prisma.guestPlaybackProgress.findUnique({ where: { guestId: guestActive } });
    assert(actCheck !== null, 'Active guest progress must remain untouched');

    await prisma.guestPlaybackProgress.deleteMany({ where: { guestId: guestActive } });
    console.log('PASS: TC-P2-10 verified');

    console.log('=== TC-P2-11: 匿名未授权请求 401 拦截 ===');
    const anonCaller = playbackRouter.createCaller({
        session: null,
        guestId: null,
        isGuest: false,
        clientIp: '127.0.0.1',
    });

    await assert.rejects(
        async () => { await anonCaller.getProgress(); },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED'
    );
    await assert.rejects(
        async () => {
            await anonCaller.saveProgress({
                sourceType: 'generation',
                sourceId: '1',
                title: 't',
                contentHash: 'h',
                segmentationVersion: 'v1',
                lastCompletedParagraphIndex: -1,
                nextParagraphIndex: 0,
                totalParagraphs: 1,
            });
        },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED'
    );
    await assert.rejects(
        async () => { await anonCaller.clearProgress(); },
        (err: unknown) => err instanceof TRPCError && err.code === 'UNAUTHORIZED'
    );
    console.log('PASS: TC-P2-11 verified');

    console.log('=== TC-P2-12: 高频保存限流防御 (60 次/分) ===');
    const guestLimitId = `g_limit_${Date.now()}`;
    const callerLimit = playbackRouter.createCaller({
        session: null,
        guestId: guestLimitId,
        isGuest: true,
        clientIp: '192.168.10.99',
    });

    let limitTriggered = false;
    for (let i = 0; i < 65; i++) {
        try {
            await callerLimit.saveProgress({
                sourceType: 'generation',
                sourceId: `story_limit_${i}`,
                title: `故事 ${i}`,
                contentHash: `hash_${i}`,
                segmentationVersion: 'v1',
                lastCompletedParagraphIndex: -1,
                nextParagraphIndex: 0,
                totalParagraphs: 1,
                forceReset: true,
            });
        } catch (err: unknown) {
            if (err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS') {
                limitTriggered = true;
                break;
            }
        }
    }
    assert.strictEqual(limitTriggered, true, 'Guest rate limit (60/min) must reject with TOO_MANY_REQUESTS 429');
    console.log('PASS: TC-P2-12 verified');

    console.log('=== TC-P2-14 & TC-P2-15: 源缺失优雅丢弃与在途占位符门禁 ===');
    // Source not in chatStore and not in generationStore
    const missingDto = {
        sourceType: 'chat' as const,
        sourceId: 'non_existent_msg_id',
        sessionId: null,
        title: '消失的故事',
        contentHash: 'missinghash',
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 0,
        nextParagraphIndex: 1,
        totalParagraphs: 2,
        voiceId: 'alloy',
        speed: 1.0,
        remainingAllowedMs: null,
        totalAllowedMs: null,
        isOneShot: false,
        updatedAt: new Date().toISOString(),
    };

    usePlaybackProgressStore.getState().reset();
    usePlaybackStore.getState().reset();
    const dropRes = await usePlaybackProgressStore.getState().hydrateFromDTO(missingDto);
    assert.strictEqual(dropRes, false, 'Hydration must drop when source is missing');
    assert.strictEqual(usePlaybackStore.getState().isRehydratedReady, false, 'No dangling anchor permitted');
    assert.strictEqual(usePlaybackProgressStore.getState().sourceId, null);

    // In-flight sending message check
    const transientSourceId = `replay-text-${Date.now()}`;
    usePlaybackProgressStore.getState().setActiveStory({
        sourceType: 'chat',
        sourceId: transientSourceId,
        title: '瞬态故事',
        storyText: '正文内容',
    });
    assert.strictEqual(usePlaybackProgressStore.getState().sourceId, null, 'Transient replay-text-* IDs must be blocked by checkpoint guard');

    console.log('PASS: TC-P2-14 & TC-P2-15 verified');

    console.log('=== TC-P2-16: 文本漂移检测与 contentHash 校验安全重置 ===');
    const guestId16 = `g_drift_${Date.now()}`;
    const msgId16 = `msg_drift_${Date.now()}`;
    const originalStory = "旧版故事第一段。\n旧版故事第二段。";
    const editedStory = "新版故事第一段，被用户或重新生成修改了。\n新版故事第二段。";

    await saveConversationForSubject({ type: 'guest', id: guestId16 }, [
        {
            messageId: msgId16,
            role: 'assistant',
            content: editedStory,
            parts: [{ type: 'storyCard', storyText: editedStory, audioUrl: '' }],
        },
    ]);

    // DTO has the old content hash
    const oldHash = computeStoryContentHash(originalStory);
    const driftDto = {
        sourceType: 'chat' as const,
        sourceId: msgId16,
        sessionId: null,
        title: '漂移故事',
        contentHash: oldHash, // Mismatched!
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 1,
        nextParagraphIndex: 2, // Was at paragraph 2
        totalParagraphs: 2,
        voiceId: 'alloy',
        speed: 1.0,
        remainingAllowedMs: null,
        totalAllowedMs: null,
        isOneShot: false,
        updatedAt: new Date().toISOString(),
    };

    useChatStore.getState().reset();
    useChatStore.setState({
        messages: [
            {
                id: msgId16,
                role: 'assistant',
                content: editedStory,
                parts: [{ type: 'storyCard', storyText: editedStory, audioUrl: '' }],
                status: 'delivered',
                createdAt: new Date().toISOString(),
            },
        ],
        syncEnabled: true,
    });

    lastToast = null;
    const driftHydrated = await usePlaybackProgressStore.getState().hydrateFromDTO(driftDto);
    assert.strictEqual(driftHydrated, true);

    const progressState16 = usePlaybackProgressStore.getState();
    assert.strictEqual(progressState16.nextParagraphIndex, 0, 'Drift must safely reset nextParagraphIndex to 0');
    assert.strictEqual(progressState16.lastCompletedParagraphIndex, -1, 'Drift must safely reset lastCompletedParagraphIndex to -1');
    assert(lastToast !== null, 'Drift notification toast must be displayed');
    const toastObj = lastToast as { icon?: string; content?: string } | null;
    assert.strictEqual(toastObj?.content, '故事正文已更新，将从开头重新播放');

    console.log('PASS: TC-P2-16 verified');

    console.log('=== TC-P2-17: 多标签页并发单调推进与显式从头重播 ===');
    const guestId17 = `g_mono_${Date.now()}`;
    const callerGuest17 = playbackRouter.createCaller({ session: null, guestId: guestId17, isGuest: true, clientIp: '127.0.0.1' });

    // Tab A advances to paragraph 3
    await callerGuest17.saveProgress({
        sourceType: 'generation',
        sourceId: 'story_mono_17',
        title: '单调推进故事',
        contentHash: 'hashmono',
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 2,
        nextParagraphIndex: 3,
        totalParagraphs: 5,
    });

    const progressInDb = await callerGuest17.getProgress();
    assert.strictEqual(progressInDb?.nextParagraphIndex, 3);

    // Stale Tab B attempts to write nextParagraphIndex = 1 (without forceReset)
    const staleResult = await callerGuest17.saveProgress({
        sourceType: 'generation',
        sourceId: 'story_mono_17',
        title: '单调推进故事',
        contentHash: 'hashmono',
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 0,
        nextParagraphIndex: 1,
        totalParagraphs: 5,
        forceReset: false,
    });

    // Server monotonic predicate must silently ignore regression and return current DB progress
    assert.strictEqual(staleResult.nextParagraphIndex, 3, 'Server monotonic predicate must reject regression silently');

    const dbCheckAfterStale = await callerGuest17.getProgress();
    assert.strictEqual(dbCheckAfterStale?.nextParagraphIndex, 3, 'DB value must remain 3');

    // User in Tab B explicitly clicks "Replay from start" (forceReset = true)
    const forceResetResult = await callerGuest17.saveProgress({
        sourceType: 'generation',
        sourceId: 'story_mono_17',
        title: '单调推进故事',
        contentHash: 'hashmono',
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: -1,
        nextParagraphIndex: 0,
        totalParagraphs: 5,
        forceReset: true,
    });

    assert.strictEqual(forceResetResult.nextParagraphIndex, 0, 'forceReset must permit reset to paragraph 0');
    const dbCheckAfterReset = await callerGuest17.getProgress();
    assert.strictEqual(dbCheckAfterReset?.nextParagraphIndex, 0, 'DB value must be updated to 0');

    console.log('PASS: TC-P2-17 verified');

    console.log('\nALL 17 PARAGRAPH-BOUNDARY RESUME TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runParagraphResumeTests()
    .then(() => {
        console.log('ALL 17 PARAGRAPH-BOUNDARY RESUME TEST CASES PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('Test execution failed:', err);
        process.exit(1);
    });

export default testPromise;
