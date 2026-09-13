import assert from 'node:assert';
import { createRequire } from 'node:module';
import {
    createToastCapture,
    installGlassToastStub,
} from '../../support/mocks/ui-state.mock';
import {
    SEGMENTATION_VERSION,
    computeStoryContentHash,
    normalizeStoryText,
    segmentStoryText,
} from '../../../utils/segmentation';
import { makeGuestId, makeMessageId } from '../../support/builders/auth-subject.builder';
import { setupIsolatedDb } from '../../support/db/isolated-db.helper';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const toastCapture = createToastCapture();
installGlassToastStub(toastCapture);

const getSessionStore = () => {
    const mod = nodeRequire('../../../stores/playbackSessionStore') as typeof import('../../../stores/playbackSessionStore');
    return mod.usePlaybackSessionStore;
};
const getTransportStore = () => {
    const mod = nodeRequire('../../../stores/playbackStore') as typeof import('../../../stores/playbackStore');
    return mod.usePlaybackStore;
};
const getHistoryStore = () => {
    const mod = nodeRequire('../../../stores/generationHistoryStore') as typeof import('../../../stores/generationHistoryStore');
    return mod.useGenerationHistoryStore;
};

process.env.SESSION_SECRET = 'test-secret-m509-rehydrate-12345';

/**
 * M5-09 Client Session Rehydrate 集成测试（L2，§25 双路径本范围部分）。
 * 全程隔离库（runner 注入 DATABASE_URL），不碰 dev.db/app.db。
 * 以真实 server（getAnchor/beginSession + StoryWork/ChatMessage 落库）为 SSOT，
 * store hydrate 经注入 deps 调用真实 server resolvers（模拟生产 library.get 精确
 * resolve 与 ChatStore 初始化），不断言网络，只断言：
 * 1. Work 精确 resolve（远页 Anchor 不依赖 history store）；
 * 2. Draft 成功 + dangling fail-closed（server Anchor 被清）；
 * 3. hash 漂移 reset 0；
 * 4. title rename 更新 title 不重置；
 * 5. transport idle + status ready + continuation finite。
 */

const newSessionId = (): string => crypto.randomUUID();

const makeStoryText = (paras: number): string => {
    const parts: string[] = [];
    for (let i = 1; i <= paras; i += 1) {
        parts.push(
            `第${i}章：故事段落内容填充足够长度以避免前向合并策略将其合并到相邻段落之中保持独立成段${'内容'.repeat(30)}尾${i}`,
        );
    }
    return parts.join('\n');
};

async function runPlaybackSessionRehydrateIntegrationTests(): Promise<void> {
    const { dbPath, prisma } = await setupIsolatedDb('playback-session-rehydrate');
    console.log(`=== DB: isolated ${dbPath} ===`);
    const { getPlaybackAnchorForSubject, beginPlaybackSessionForSubject } = await import(
        '../../../lib/server/playbackSession'
    );
    const { createStoryWorkForSubject, getStoryWorkForSubject } = await import(
        '../../../lib/server/storyWork'
    );
    const { isRehydrateTransportIdle } = await import('../../../lib/playback/rehydrate');
    console.log('=== M5-09: Client Session Rehydrate (integration) ===');

    const resetStores = () => {
        const useSession = getSessionStore();
        const useTransport = getTransportStore();
        const mod = nodeRequire('../../../stores/playbackSessionStore') as typeof import('../../../stores/playbackSessionStore');
        mod.__resetPlaybackSessionTestHooks();
        useSession.getState().reset();
        useTransport.getState().reset();
    };

    // —— 1. Work 精确 resolve（Anchor 指向远页，不依赖 history store） ——
    console.log('--- Work precise resolve (far-page anchor) ---');
    resetStores();
    const guestWork = { type: 'guest', id: makeGuestId('m509_work') } as const;
    const text5 = makeStoryText(5);
    assert.strictEqual(Math.max(1, segmentStoryText(normalizeStoryText(text5)).length), 5);
    const work = await createStoryWorkForSubject(guestWork, {
        prompt: 'm509 work 提示词足够长度以通过校验',
        storyText: text5,
    });
    const sessionId = newSessionId();
    const anchor = await beginPlaybackSessionForSubject(guestWork, {
        sessionId,
        source: { kind: 'work', workId: work.id },
        mode: 'resume',
        speed: 1.0,
    });
    // 推进到中间断点：经 checkpoint 保存 next=2（由 server CAS 持有）。
    const { savePlaybackCheckpointForSubject } = await import('../../../lib/server/playbackSession');
    await savePlaybackCheckpointForSubject(guestWork, {
        sessionId,
        contentHash: work.contentHash,
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 1,
        nextParagraphIndex: 2,
        totalParagraphs: 5,
        speed: 1.0,
    });
    const savedAnchor = await getPlaybackAnchorForSubject(guestWork);
    assert(savedAnchor !== null);
    assert.strictEqual(savedAnchor.nextParagraphIndex, 2);

    // legacy 残留：history store 仅有第一页无关记录，Anchor 指向远页 work.id。
    // 用远离自增序列的大 ID 模拟“第一页”，避免与真实 work.id 碰撞导致预置失败。
    const useHistory = getHistoryStore();
    useHistory.setState({
        records: [
            { id: 99991, prompt: 'p1', storyText: 't1', voiceId: '', title: 't1', excerpt: '', contentHash: '', sourceMessageId: null, favoritedAt: null, deletedAt: null, createdAt: '', updatedAt: '' },
            { id: 99992, prompt: 'p2', storyText: 't2', voiceId: '', title: 't2', excerpt: '', contentHash: '', sourceMessageId: null, favoritedAt: null, deletedAt: null, createdAt: '', updatedAt: '' },
        ] as never,
        syncEnabled: true,
    });
    assert(
        !useHistory.getState().records.some((r) => r.id === work.id),
        '预置条件：history store 不含目标 work（模拟分页远页）',
    );

    const useSession = getSessionStore();
    const useTransport = getTransportStore();
    const ok = await useSession.getState().hydrateFromAnchor(savedAnchor, {
        getWork: async (workId: number) => {
            assert.strictEqual(workId, work.id);
            const detail = await getStoryWorkForSubject(guestWork, workId);
            return { title: detail.title, storyText: detail.storyText, voiceId: detail.voiceId, contentHash: detail.contentHash };
        },
        clearAnchor: async () => {
            assert.fail('成功水合不得清 Anchor');
        },
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(useSession.getState().status, 'ready');
    assert.deepStrictEqual(useSession.getState().source, { kind: 'work', workId: work.id });
    assert.strictEqual(useSession.getState().nextParagraphIndex, 2, 'hash 一致须保留断点');
    assert.strictEqual(useSession.getState().continuationMode, 'finite');
    const t = useTransport.getState();
    assert.strictEqual(
        isRehydrateTransportIdle({ isPlaying: t.isPlaying, audioUrl: t.currentAudioUrl, currentTime: t.currentTime, duration: t.duration }),
        true,
        '§25.5 transport 必须 idle',
    );
    console.log('PASS: Work precise resolve verified');

    // —— 2. hash 漂移 reset 0（正文变更后重水合） ——
    console.log('--- hash drift resets to 0 ---');
    resetStores();
    const driftText = `${text5}\n全新尾声段落${'内容'.repeat(40)}`;
    const driftHash = computeStoryContentHash(normalizeStoryText(driftText));
    assert.notStrictEqual(driftHash, work.contentHash);
    // 直接更新 Work 正文+hash（模拟内容变更；title 保持以隔离 hash 变量）。
    if (guestWork.type === 'guest') {
        await prisma.guestStoryWork.update({
            where: { id: work.id },
            data: { storyText: driftText, contentHash: driftHash },
        });
    }
    const driftedAnchor = await getPlaybackAnchorForSubject(guestWork);
    assert(driftedAnchor !== null);
    let driftToast = 0;
    const okDrift = await getSessionStore().getState().hydrateFromAnchor(driftedAnchor, {
        getWork: async (workId: number) => {
            const detail = await getStoryWorkForSubject(guestWork, workId);
            return { title: detail.title, storyText: detail.storyText, voiceId: detail.voiceId, contentHash: detail.contentHash };
        },
        clearAnchor: async () => {
            assert.fail('漂移仍应成功水合（reset 0），不得清 Anchor');
        },
        notifyDrift: () => {
            driftToast += 1;
        },
    });
    assert.strictEqual(okDrift, true);
    assert.strictEqual(driftToast, 1);
    assert.strictEqual(getSessionStore().getState().nextParagraphIndex, 0);
    assert.strictEqual(getSessionStore().getState().lastCompletedParagraphIndex, -1);
    console.log('PASS: hash drift verified');

    // —— 3. title rename 更新 title 不重置（独立 work，隔离 hash 变量） ——
    console.log('--- title rename keeps position ---');
    resetStores();
    const guestRename = { type: 'guest', id: makeGuestId('m509_rename') } as const;
    const workRename = await createStoryWorkForSubject(guestRename, {
        prompt: 'm509 rename 提示词足够长度以通过校验',
        storyText: text5,
    });
    const renameSession = newSessionId();
    await beginPlaybackSessionForSubject(guestRename, {
        sessionId: renameSession,
        source: { kind: 'work', workId: workRename.id },
        mode: 'resume',
        speed: 1.0,
    });
    await savePlaybackCheckpointForSubject(guestRename, {
        sessionId: renameSession,
        contentHash: workRename.contentHash,
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 1,
        nextParagraphIndex: 2,
        totalParagraphs: 5,
        speed: 1.0,
    });
    const anchorForRename = await getPlaybackAnchorForSubject(guestRename);
    assert(anchorForRename !== null);
    assert.strictEqual(anchorForRename.nextParagraphIndex, 2);
    const renamedTitle = `重命名标题_${Date.now()}`;
    await prisma.guestStoryWork.update({ where: { id: workRename.id }, data: { title: renamedTitle } });
    const anchorRenamed = await getPlaybackAnchorForSubject(guestRename);
    assert(anchorRenamed !== null);
    assert.notStrictEqual(anchorRenamed.title, renamedTitle, '预置：Anchor 快照仍为旧 title');
    let renameDrift = 0;
    const okRename = await getSessionStore().getState().hydrateFromAnchor(anchorRenamed, {
        getWork: async (workId: number) => {
            const detail = await getStoryWorkForSubject(guestRename, workId);
            return { title: detail.title, storyText: detail.storyText, voiceId: detail.voiceId, contentHash: detail.contentHash };
        },
        clearAnchor: async () => {
            assert.fail('title 变化不得清 Anchor');
        },
        notifyDrift: () => {
            renameDrift += 1;
        },
    });
    assert.strictEqual(okRename, true);
    assert.strictEqual(renameDrift, 0, 'title 变化不得触发漂移');
    assert.strictEqual(getSessionStore().getState().title, renamedTitle);
    assert.strictEqual(getSessionStore().getState().nextParagraphIndex, 2, 'title 变化不得重置 progress（§25.4）');
    console.log('PASS: title rename verified');

    // —— 4. Draft 成功 + dangling fail-closed ——
    console.log('--- Draft rehydrate + dangling ---');
    resetStores();
    const guestDraft = { type: 'guest', id: makeGuestId('m509_draft') } as const;
    const draftMsg = makeMessageId('m509_draft_msg');
    const draftText = makeStoryText(4);
    const draftHash = computeStoryContentHash(normalizeStoryText(draftText));
    await prisma.guestChatMessage.create({
        data: {
            guestId: guestDraft.id,
            position: 0,
            messageId: draftMsg,
            role: 'assistant',
            content: draftText,
            parts: JSON.stringify([{ type: 'storyCard', storyText: draftText, audioUrl: '' }]),
        },
    });
    const draftSession = newSessionId();
    const { beginPlaybackSessionForSubject: beginForDraft } = await import('../../../lib/server/playbackSession');
    // Draft begin 需要 draftSnapshot（server 不信任 Work 快照但信任 Draft 快照）。
    const draftTotal = Math.max(1, segmentStoryText(normalizeStoryText(draftText)).length);
    await beginForDraft(guestDraft, {
        sessionId: draftSession,
        source: { kind: 'draft', messageId: draftMsg },
        mode: 'resume',
        speed: 1.0,
        draftSnapshot: { title: '草稿故事', contentHash: draftHash, totalParagraphs: draftTotal, voiceId: '' },
    });
    const draftAnchor = await getPlaybackAnchorForSubject(guestDraft);
    assert(draftAnchor !== null);
    assert.deepStrictEqual(draftAnchor.source, { kind: 'draft', messageId: draftMsg });
    const okDraft = await getSessionStore().getState().hydrateFromAnchor(draftAnchor, {
        ensureChatLoaded: async () => {},
        findDraftStoryText: () => draftText,
        clearAnchor: async () => {
            assert.fail('成功水合不得清 Anchor');
        },
    });
    assert.strictEqual(okDraft, true);
    assert.deepStrictEqual(getSessionStore().getState().source, { kind: 'draft', messageId: draftMsg });
    assert.strictEqual(getSessionStore().getState().continuationMode, 'finite');

    // dangling：正文缺失 → 本地复位 + server Anchor 被清。
    resetStores();
    let clearedSid: string[] = [];
    const okDangling = await getSessionStore().getState().hydrateFromAnchor(draftAnchor, {
        ensureChatLoaded: async () => {},
        findDraftStoryText: () => null,
        clearAnchor: async (sid: string) => {
            clearedSid.push(sid);
            const { clearPlaybackAnchorForSubject } = await import('../../../lib/server/playbackSession');
            await clearPlaybackAnchorForSubject(guestDraft, { sessionId: sid });
        },
    });
    assert.strictEqual(okDangling, false);
    assert.deepStrictEqual(clearedSid, [draftSession]);
    assert.strictEqual(await getPlaybackAnchorForSubject(guestDraft), null, 'dangling 必须清 server Anchor');
    assert.strictEqual(getSessionStore().getState().source, null);
    console.log('PASS: Draft rehydrate verified');

    console.log('\nALL M5-09 REHYDRATE INTEGRATION TESTS PASSED!');
}

const testPromise = runPlaybackSessionRehydrateIntegrationTests()
    .then(() => {
        console.log('ALL M5-09 REHYDRATE INTEGRATION TESTS PASSED!');
    })
    .catch((err) => {
        console.error('Test execution failed:', err);
        process.exit(1);
    });

export default testPromise;
