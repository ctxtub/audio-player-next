import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const cwd = process.cwd();

/**
 * E2E-02-04 生成中清空防止孤儿播放（L2，真实 beginChatStream + 真实 resetStoryFlow）。
 *
 * oracle（spec 02-04 + catalog no-orphan-after-clear[audio]）：
 * D2：慢流 + 流式中清空 + 完成到达 → 断言无孤儿播放（正式 begin 未发生、play 未调用）、
 * 聊天保持空（无诈尸卡片）、无浮窗、无在播轨道。
 * D1 阳性对照：不清空时完成回调必须建立 1 次正式 Draft Session（begin=1）并播放 1 次
 * （证明是清空导致的不播，排除探针本身播不出来的假阴性；M9-F01 后 autoplay 经
 * PlaybackSessionFlow，Legacy 整篇 blob 不再直接进 Transport）。
 *
 * 手法与探针蓝本一致：require.cache 桩掉 @/lib/trpc/client + M9-F01 client 边界
 * （playbackSession/ttsGenerate/storyAudio/chatConversation），返回可控慢流
 * meta(Story)→token×2→[门控]→audio_start→audio→complete。
 */

// ---- GlassToast 桩（与既有 L2 同手法，accountSync 间接依赖）----
const glassToastPath = path.resolve(cwd, 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

// ---- tRPC client 桩：可控慢流 ----
let releaseGate: (() => void) | null = null;
let fakeUsed = false;
const fakeTrpc = {
    agent: {
        interact: {
            mutate: async () => {
                fakeUsed = true;
                async function* gen() {
                    yield { type: 'meta', intent: 'Story' };
                    yield { type: 'token', content: '从前有座' };
                    yield { type: 'token', content: '山' };
                    await new Promise<void>((r) => {
                        releaseGate = r;
                    });
                    // M9-F01：autoplay 经正式 Draft Session 后，hydrate 依赖已 finalized 的
                    // storyArtifact；真实协议在 audio 前发 story_complete，桩流必须同构。
                    yield { type: 'story_complete', content: '从前有座山。' };
                    yield { type: 'audio_start' };
                    yield { type: 'audio', content: 'eA==' };
                }
                return gen();
            },
        },
        summarize: {
            mutate: async () => {
                throw new Error('should-not-summarize');
            },
        },
    },
};
for (const key of [path.resolve(cwd, 'lib/trpc/client.ts'), path.resolve(cwd, 'lib/trpc/client')]) {
    nodeRequire.cache[key] = {
        id: key,
        filename: key,
        loaded: true,
        exports: { trpc: fakeTrpc },
    } as unknown as NodeModule;
}

// ---- M9-F01 client 桩：autoplay 经正式 Draft Session；只探到「begin 是否发生」门 ----
let beginCount = 0;
const M9F01_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const playbackSessionClientPath = path.resolve(cwd, 'lib/client/playbackSession.ts');
nodeRequire.cache[playbackSessionClientPath] = {
    id: playbackSessionClientPath,
    filename: playbackSessionClientPath,
    loaded: true,
    exports: {
        getPlaybackAnchor: async () => null,
        beginPlaybackSession: async (input: {
            sessionId: string;
            source: unknown;
            speed?: number;
            draftSnapshot?: { title: string; contentHash: string; totalParagraphs: number; voiceId: string };
        }) => {
            beginCount += 1;
            return {
                sessionId: input.sessionId ?? M9F01_SESSION_ID,
                source: input.source,
                state: 'ready',
                title: input.draftSnapshot?.title ?? '测试故事',
                contentHash: input.draftSnapshot?.contentHash ?? 'hash',
                segmentationVersion: 'v1',
                lastCompletedParagraphIndex: -1,
                nextParagraphIndex: 0,
                totalParagraphs: input.draftSnapshot?.totalParagraphs ?? 1,
                voiceId: input.draftSnapshot?.voiceId ?? 'onyx',
                speed: input.speed ?? 1,
                remainingAllowedMs: null,
                totalAllowedMs: null,
                sleepTimerMode: 'off',
                updatedAt: new Date().toISOString(),
            };
        },
        savePlaybackCheckpoint: async () => ({ accepted: false, reason: 'STALE_SESSION' }),
        completePlaybackSession: async () => null,
        clearPlaybackAnchor: async () => ({ cleared: false }),
        promoteDraftPlaybackToWork: async () => {
            throw new Error('not-used');
        },
        setSleepTimer: async () => ({ accepted: false, reason: 'STALE_SESSION' }),
        getWorkPlaybackProgressBatch: async () => ({}),
    },
} as unknown as NodeModule;
const ttsClientPath = path.resolve(cwd, 'lib/client/ttsGenerate.ts');
nodeRequire.cache[ttsClientPath] = {
    id: ttsClientPath,
    filename: ttsClientPath,
    loaded: true,
    exports: { fetchAudio: async () => 'blob:m9f01-orphan-probe' },
} as unknown as NodeModule;
const storyAudioClientPath = path.resolve(cwd, 'lib/client/storyAudio.ts');
nodeRequire.cache[storyAudioClientPath] = {
    id: storyAudioClientPath,
    filename: storyAudioClientPath,
    loaded: true,
    exports: {
        getPlaybackManifest: async () => null,
        ensureSegment: async () => {
            throw new Error('not-used');
        },
        shouldUseCanonicalAudio: () => false,
        isCanonicalPlaybackUrl: () => false,
        selectWorkParagraphs: (localParagraphs: string[]) => localParagraphs,
    },
} as unknown as NodeModule;
const chatConversationClientPath = path.resolve(cwd, 'lib/client/chatConversation.ts');
nodeRequire.cache[chatConversationClientPath] = {
    id: chatConversationClientPath,
    filename: chatConversationClientPath,
    loaded: true,
    exports: {
        fetchMyConversation: async () => [],
        saveMyConversation: async () => ({ ok: true }),
    },
} as unknown as NodeModule;

const { useChatStore } = nodeRequire(path.resolve(cwd, 'stores/chatStore')) as {
    useChatStore: typeof import('../../../stores/chatStore').useChatStore;
};
const { usePlaybackStore } = nodeRequire(path.resolve(cwd, 'stores/playbackStore')) as {
    usePlaybackStore: typeof import('../../../stores/playbackStore').usePlaybackStore;
};
const { useConfigStore } = nodeRequire(path.resolve(cwd, 'stores/configStore')) as {
    useConfigStore: typeof import('../../../stores/configStore').useConfigStore;
};
const { beginChatStream } = nodeRequire(path.resolve(cwd, 'app/services/chatFlow')) as {
    beginChatStream: typeof import('../../../app/services/chatFlow').beginChatStream;
};
const { resetStoryFlow } = nodeRequire(path.resolve(cwd, 'app/services/storyFlow')) as {
    resetStoryFlow: typeof import('../../../app/services/storyFlow').resetStoryFlow;
};

const tick = async (n = 10) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function freshController(spy: { play: number; pause: number }) {
    return {
        unlock: async () => {},
        play: async () => {
            spy.play += 1;
        },
        resume: async () => {},
        pause: () => {
            spy.pause += 1;
        },
        seek: () => {},
        setPlaybackRate: () => {},
    };
}

function resetAll() {
    (useChatStore.getState() as { reset: () => void }).reset();
    // 真实浏览器会话中 initForUser 早已完成（syncEnabled=true），autoplay 的
    // ensureChatLoaded 因此不再走服务端拉取/覆盖本地 draft；桩环境按此忠实水合，
    // 否则 fetchMyConversation 桩返回空会把刚生成的 draft 消息冲掉（假阴性）。
    useChatStore.setState({ syncEnabled: true });
    usePlaybackStore.getState().reset();
    usePlaybackStore.getState().registerAudioController(null);
    beginCount = 0;
    // 真实会话中配置早已水合（默认 30 分钟）：node 默认 playDuration=0 会误触 H-08 预算守卫，
    // 此处按浏览器真实态水合，避免假阴性。
    useConfigStore.setState((s) => ({
        apiConfig: { ...s.apiConfig, playDuration: 30, voiceId: 'onyx', speed: 1 },
    }));
}

/** 等 autoplay 异步链（flush → begin → hydrate → provider → play）落到稳定态。 */
async function settleAutoplay(): Promise<void> {
    for (let i = 0; i < 80 && beginCount === 0; i += 1) {
        await new Promise((r) => setImmediate(r));
    }
    await tick(20);
}

/** D1 阳性对照：不清空时完成回调必须尝试正式 autoplay（begin=1 → 合成 → play=1）。 */
async function scenarioNoClear(): Promise<void> {
    console.log('--- D1: 阳性对照（不清，流完成应自动播放）---');
    resetAll();
    const spy = { play: 0, pause: 0 };
    usePlaybackStore.getState().registerAudioController(freshController(spy) as never);
    const p = beginChatStream('讲个睡前故事');
    await tick();
    releaseGate?.();
    const result = await p;
    await settleAutoplay();
    assert(fakeUsed, '必须走到桩流（否则测试无效）');
    assert(result.audioUrl.startsWith('blob:'), '应产出音频 URL');
    assert.strictEqual(beginCount, 1, '阳性对照：不清时完成回调必须建立 1 次正式 Draft Session');
    assert.strictEqual(spy.play, 1, '阳性对照：正式 Session 建立后必须播放 1 次');
    // M9-F01：旧整篇 blob 不得作为音源（无 segment identity），实际音源来自 provider。
    assert.notStrictEqual(
        usePlaybackStore.getState().currentAudioUrl,
        result.audioUrl,
        'Legacy 整篇 audioUrl 不得直接进 Transport',
    );
    assert.ok(
        String(usePlaybackStore.getState().currentAudioUrl ?? '').startsWith('blob:'),
        '在播轨道应为 provider 合成产物',
    );
    assert.ok(!('isFloatingVisible' in usePlaybackStore.getState()), 'M6-04：Transport 不得再持有显隐标记');
    console.log(`PASS: D1 positive control (begin=${beginCount}, play=${spy.play}, audio url set)`);
}

/** D2 oracle 竞态：流式中清空 → 完成到达 → 不得孤儿播放。 */
async function scenarioClearMidStream(): Promise<void> {
    console.log('--- D2: oracle 竞态（流式中清空 → 完成到达）---');
    resetAll();
    const spy = { play: 0, pause: 0 };
    usePlaybackStore.getState().registerAudioController(freshController(spy) as never);
    const p = beginChatStream('讲个睡前故事');
    await tick();
    // 前置：流在途（sending 助手消息已建、内容已累积）
    const sending = useChatStore
        .getState()
        .messages.find((m) => m.role === 'assistant' && m.status === 'sending');
    assert(sending, '前置：流应在途（sending 助手消息存在）');

    // 真实清空路径（ChatLayout.handleClear 同款）
    resetStoryFlow();
    assert.strictEqual(useChatStore.getState().messages.length, 0, '清空后聊天应为空');

    // 放行完成（含 audio_complete + onComplete）
    releaseGate?.();
    const result = await p;
    await settleAutoplay();
    assert(result.audioUrl.startsWith('blob:'), '流本身应完整到达（含音频）');

    assert.strictEqual(beginCount, 0, '核心断言：清空后完成到达不得建立正式 Session（no-orphan-after-clear）');
    assert.strictEqual(spy.play, 0, '核心断言：清空后完成到达不得触发播放（no-orphan-after-clear）');
    assert.strictEqual(useChatStore.getState().messages.length, 0, '清空后聊天应保持为空（无诈尸卡片）');
    assert.ok(!('isFloatingVisible' in usePlaybackStore.getState()), 'M6-04：Transport 不得再持有显隐标记');
    assert.strictEqual(usePlaybackStore.getState().currentAudioUrl, null, '无在播轨道');
    console.log('PASS: D2 no orphan playback after mid-stream clear');
}

async function runOrphanRaceTests() {
    await scenarioNoClear();
    await scenarioClearMidStream();
    console.log('ALL ORPHAN RACE TESTS PASSED SUCCESSFULLY');
}

const testPromise = runOrphanRaceTests()
    .then(() => {
        console.log('ALL ORPHAN RACE TESTS PASSED SUCCESSFULLY');
    })
    .catch((err) => {
        console.error('Test failed:', err);
        process.exit(1);
    });

export default testPromise;
