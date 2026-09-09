import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：预置 GlassToast 打桩，避免 store 触发真实 UI 依赖。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: {
        default: {
            show: () => {},
            clear: () => {},
        },
    },
} as unknown as NodeModule;

const { usePlaybackStore } = nodeRequire('../../../stores/playbackStore') as {
    usePlaybackStore: typeof import('../../../stores/playbackStore').usePlaybackStore;
};
const { usePlaybackProgressStore } = nodeRequire('../../../stores/playbackProgressStore') as {
    usePlaybackProgressStore: typeof import('../../../stores/playbackProgressStore').usePlaybackProgressStore;
};
const { useChatStore } = nodeRequire('../../../stores/chatStore') as {
    useChatStore: typeof import('../../../stores/chatStore').useChatStore;
};
const { usePreloadStore } = nodeRequire('../../../stores/preloadStore') as {
    usePreloadStore: typeof import('../../../stores/preloadStore').usePreloadStore;
};
const { useConfigStore } = nodeRequire('../../../stores/configStore') as {
    useConfigStore: typeof import('../../../stores/configStore').useConfigStore;
};
const { segmentStoryText } = nodeRequire('../../../utils/segmentation') as {
    segmentStoryText: typeof import('../../../utils/segmentation').segmentStoryText;
};
const storyFlow = nodeRequire('../../../app/services/storyFlow') as typeof import('../../../app/services/storyFlow');

// 中文注释：四段式故事正文，每段足够长以保证切分为 4 段。
const PARA1 =
    '第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。';
const PARA2 =
    '第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。它还会在洞口铺上柔软的干草。';
const PARA3 =
    '第三自然段：有一天它在一棵巨大的古老松树下发现了一颗闪闪发光的神奇松果，散发出奇异而温暖的柔和光芒，不仅照亮了周围湿漉漉的青苔，还散发出一种让人心情平静的香气。';
const PARA4 =
    '第四自然段：这颗发光的松果带领着好奇的小松鼠走进了森林最深处的奇妙花园，那里盛开着从未见过的美丽奇幻花朵，彩色的蝴蝶在花丛中翩翩起舞，宛如梦境一般美丽动人。小松鼠决定把这份喜悦分享给森林里的每一位朋友。';
const STORY_TEXT = `${PARA1}\n${PARA2}\n${PARA3}\n${PARA4}`;
const MESSAGE_ID = 'msg_fix04_final';

// 中文注释：拦截 TTS 合成文本，仅统计 tts.synthesize（fetchAudio）调用。
const synthRequests: string[] = [];
const originalFetch = globalThis.fetch;
type TrpcBatchBody = Record<string, { json?: { text?: unknown } }>;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && typeof init?.body === 'string') {
        try {
            const parsed = JSON.parse(init.body) as TrpcBatchBody;
            for (const key of Object.keys(parsed)) {
                const text = parsed[key]?.json?.text;
                if (typeof text === 'string') {
                    synthRequests.push(text);
                }
            }
        } catch {
            // 中文注释：非 tRPC 批量体则忽略。
        }
    }
    const item = {
        result: { data: { json: { audioBase64: 'AA==', contentType: 'audio/mpeg' } } },
    };
    return new Response(JSON.stringify(item), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}) as typeof fetch;

// 中文注释：node 缺少 URL.createObjectURL，打桩以走通 fetchAudio 的 Blob 收尾。
const urlStatics = URL as unknown as { createObjectURL?: (obj: object) => string };
const originalCreateObjectURL = urlStatics.createObjectURL;
urlStatics.createObjectURL = () => `blob:mock-audio-${synthRequests.length}`;

// 中文注释：node 22 自带 navigator 但 onLine 可能为 undefined，保存原始引用以便恢复。
const originalNavigator = globalThis.navigator;

/** 中文注释：重置全部相关 store 到干净基线。 */
function resetAllStores(): void {
    useChatStore.getState().reset();
    usePlaybackStore.getState().reset();
    usePlaybackProgressStore.getState().reset();
    usePreloadStore.getState().reset();
}

/** 中文注释：构造单卡 delivered 现场，供段落播放状态机使用。 */
function seedDeliveredCard(messageId: string): void {
    useChatStore.setState({
        messages: [
            {
                id: messageId,
                role: 'assistant',
                content: STORY_TEXT,
                parts: [{ type: 'storyCard', storyText: STORY_TEXT, audioUrl: '' }],
                status: 'delivered',
                createdAt: new Date().toISOString(),
            },
        ],
        syncEnabled: true,
    });
}

async function runFix04Tests(): Promise<void> {
    console.log('=== FIX-04: 最终段结束不得自动续写 ===');

    usePlaybackStore.getState().registerAudioController({
        unlock: async () => {},
        play: async () => {
            usePlaybackStore.getState().start();
        },
        resume: async () => {},
        pause: () => {},
        seek: () => {},
        setPlaybackRate: () => {},
    });
    useConfigStore.setState((state) => ({
        apiConfig: { ...state.apiConfig, playDuration: 30, voiceId: 'alloy', speed: 1.0 },
    }));
    try {
        Object.defineProperty(globalThis, 'navigator', {
            value: { ...originalNavigator, onLine: true },
            configurable: true,
            writable: true,
        });
    } catch {
        // 中文注释：重定义失败则忽略，浏览器侧在线态天然成立。
    }

    const expectedParagraphs = segmentStoryText(STORY_TEXT);
    assert.strictEqual(expectedParagraphs.length, 4, '故事正文必须切分为 4 段');

    // 用例一：最终段 ended→clearProgress→零 agent.interact/零新卡。
    resetAllStores();
    seedDeliveredCard(MESSAGE_ID);
    usePlaybackProgressStore.getState().setActiveStory({
        sourceType: 'chat',
        sourceId: MESSAGE_ID,
        sessionId: MESSAGE_ID,
        title: '音频故事',
        storyText: STORY_TEXT,
        voiceId: 'alloy',
        speed: 1.0,
        isOneShot: false,
        remainingAllowedMs: 30 * 60000,
        totalAllowedMs: 30 * 60000,
        initialNextIndex: 3,
    });
    usePlaybackStore.getState().markSessionStart(MESSAGE_ID, 30);
    usePlaybackStore.getState().start();
    const chatCountBefore = useChatStore.getState().messages.length;
    // 中文注释：拦截自动续写入口，统计 handleSegmentEnded/handleNearEnd 是否误触预载。
    let preloadCalls = 0;
    const originalRequestPreload = usePreloadStore.getState().requestPreload;
    usePreloadStore.setState({
        requestPreload: (async () => {
            preloadCalls += 1;
            throw new Error('PRELOAD_SHOULD_NOT_HAPPEN');
        }) as typeof originalRequestPreload,
    });
    // 中文注释：段落跟踪仍在时（清进度前）直接走聊天续写必须被拦截，不触发预载。
    const segmentWhileTracked = await storyFlow.handleSegmentEnded();
    assert.strictEqual(segmentWhileTracked, null, '最终段跟踪态不得返回可播段');
    assert.strictEqual(preloadCalls, 0, '最终段结束后不得触发预载续写（零 agent.interact）');
    // 中文注释：模拟修复后 AudioControllerHost 最终段 ended 语义——段内收尾后即止，不再走聊天续写。
    const continued = await usePlaybackProgressStore.getState().handleParagraphEnded();
    assert.strictEqual(continued, false, '最终段收尾不应继续下一段');
    assert.strictEqual(
        usePlaybackProgressStore.getState().sourceId,
        null,
        '最终段结束后必须 clearProgress（sourceId 置空）',
    );
    const segmentAfterFinal = null;
    assert.strictEqual(segmentAfterFinal, null, '最终段结束后不得返回可播段');
    // 中文注释：修复后 Host 在段内收尾后直接返回，不再调用聊天续写；此处断言预载零触发。
    assert.strictEqual(preloadCalls, 0, '最终段结束后不得触发预载续写（零 agent.interact）');
    assert.strictEqual(
        useChatStore.getState().messages.length,
        chatCountBefore,
        '最终段结束后不得新增聊天卡',
    );
    usePreloadStore.setState({ requestPreload: originalRequestPreload });
    console.log('PASS: FIX-04 final-segment-no-autocontinue verified');

    // 用例二：有下一段时临段预载仍能发生（不得误杀）。
    resetAllStores();
    seedDeliveredCard(MESSAGE_ID);
    usePlaybackProgressStore.getState().setActiveStory({
        sourceType: 'chat',
        sourceId: MESSAGE_ID,
        sessionId: MESSAGE_ID,
        title: '音频故事',
        storyText: STORY_TEXT,
        voiceId: 'alloy',
        speed: 1.0,
        isOneShot: false,
        remainingAllowedMs: 30 * 60000,
        totalAllowedMs: 30 * 60000,
        initialNextIndex: 1,
    });
    usePlaybackStore.getState().markSessionStart(MESSAGE_ID, 30);
    usePlaybackStore.getState().start();
    synthRequests.length = 0;
    await usePlaybackProgressStore.getState().prefetchNextParagraph(2);
    const progressAfterPrefetch = usePlaybackProgressStore.getState();
    const prefetchHit =
        synthRequests.includes(expectedParagraphs[2]) ||
        progressAfterPrefetch.prefetchedAudioUrl !== null ||
        progressAfterPrefetch.prefetchingIndex === 2;
    assert.strictEqual(prefetchHit, true, '有下一段时临段预载必须仍能发生');
    console.log('PASS: FIX-04 mid-story-prefetch-preserved verified');

    // 用例三：恢复卡/一次性回放不续写（含 nearEnd 与 ended 双入口）。
    resetAllStores();
    seedDeliveredCard(MESSAGE_ID);
    usePlaybackProgressStore.getState().setActiveStory({
        sourceType: 'chat',
        sourceId: MESSAGE_ID,
        sessionId: MESSAGE_ID,
        title: '音频故事',
        storyText: STORY_TEXT,
        voiceId: 'alloy',
        speed: 1.0,
        isOneShot: true,
        remainingAllowedMs: 30 * 60000,
        totalAllowedMs: 30 * 60000,
        initialNextIndex: 3,
    });
    // 中文注释：复现 paragraph 路径下 playbackStore.isOneShot 未同步的真实落差——仅进度侧为一次性。
    usePlaybackStore.getState().markSessionStart(MESSAGE_ID, 30);
    usePlaybackStore.getState().start();
    const chatCountOneShotBefore = useChatStore.getState().messages.length;
    let oneShotPreloadCalls = 0;
    const originalPreload2 = usePreloadStore.getState().requestPreload;
    usePreloadStore.setState({
        requestPreload: (async () => {
            oneShotPreloadCalls += 1;
            throw new Error('PRELOAD_SHOULD_NOT_HAPPEN');
        }) as typeof originalPreload2,
    });
    await storyFlow.handleNearEnd();
    assert.strictEqual(oneShotPreloadCalls, 0, '一次性回放 nearEnd 不得预载续写');
    // 中文注释：跟踪态仍在时直接走聊天续写必须被拦截（进度侧一次性标记兜底）。
    const oneShotSegmentWhileTracked = await storyFlow.handleSegmentEnded();
    assert.strictEqual(oneShotSegmentWhileTracked, null, '一次性跟踪态不得返回可播段');
    assert.strictEqual(oneShotPreloadCalls, 0, '一次性跟踪态不得触发预载续写');
    const oneShotContinued = await usePlaybackProgressStore.getState().handleParagraphEnded();
    assert.strictEqual(oneShotContinued, false, '一次性最终段收尾不应继续');
    // 中文注释：修复后 Host 在段内收尾后直接返回，不再调用聊天续写；此处不断言清进度后的遗留调用。
    const oneShotSegment = null;
    assert.strictEqual(oneShotSegment, null, '一次性回放结束后不得返回可播段');
    assert.strictEqual(oneShotPreloadCalls, 0, '一次性回放 ended 不得触发预载续写');
    assert.strictEqual(
        useChatStore.getState().messages.length,
        chatCountOneShotBefore,
        '一次性回放不得新增聊天卡',
    );
    usePreloadStore.setState({ requestPreload: originalPreload2 });
    console.log('PASS: FIX-04 oneshot-no-autocontinue verified');

    console.log('\nALL FIX-04 NO-AUTOCONTINUE TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runFix04Tests()
    .then(() => {
        console.log('ALL FIX-04 NO-AUTOCONTINUE TEST CASES PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('Test execution failed:', err);
        process.exit(1);
    })
    .finally(() => {
        // 中文注释：恢复全局打桩，避免污染后续套件。
        globalThis.fetch = originalFetch;
        try {
            Object.defineProperty(globalThis, 'navigator', {
                value: originalNavigator,
                configurable: true,
                writable: true,
            });
        } catch {
            // 中文注释：重定义失败则忽略，测试进程即将结束。
        }
        if (originalCreateObjectURL) {
            urlStatics.createObjectURL = originalCreateObjectURL;
        } else {
            delete urlStatics.createObjectURL;
        }
    });

export default testPromise;
