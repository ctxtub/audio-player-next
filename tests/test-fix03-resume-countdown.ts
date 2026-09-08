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

const { usePlaybackStore } = nodeRequire('../stores/playbackStore') as {
    usePlaybackStore: typeof import('../stores/playbackStore').usePlaybackStore;
};
const { usePlaybackProgressStore } = nodeRequire('../stores/playbackProgressStore') as {
    usePlaybackProgressStore: typeof import('../stores/playbackProgressStore').usePlaybackProgressStore;
};
const { useChatStore } = nodeRequire('../stores/chatStore') as {
    useChatStore: typeof import('../stores/chatStore').useChatStore;
};
const { useConfigStore } = nodeRequire('../stores/configStore') as {
    useConfigStore: typeof import('../stores/configStore').useConfigStore;
};
const { segmentStoryText, computeStoryContentHash, normalizeStoryText } = nodeRequire(
    '../utils/segmentation',
) as typeof import('../utils/segmentation');
const { playStoryText } = nodeRequire('../app/services/storyFlow') as {
    playStoryText: typeof import('../app/services/storyFlow').playStoryText;
};
const { SEGMENTATION_VERSION } = nodeRequire('../utils/segmentation') as {
    SEGMENTATION_VERSION: string;
};

// 中文注释：四段式故事正文，每段足够长以避免短段合并，保证切分为 4 段。
const PARA1 =
    '第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。';
const PARA2 =
    '第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。它还会在洞口铺上柔软的干草。';
const PARA3 =
    '第三自然段：有一天它在一棵巨大的古老松树下发现了一颗闪闪发光的神奇松果，散发出奇异而温暖的柔和光芒，不仅照亮了周围湿漉漉的青苔，还散发出一种让人心情平静的香气。';
const PARA4 =
    '第四自然段：这颗发光的松果带领着好奇的小松鼠走进了森林最深处的奇妙花园，那里盛开着从未见过的美丽奇幻花朵，彩色的蝴蝶在花丛中翩翩起舞，宛如梦境一般美丽动人。小松鼠决定把这份喜悦分享给森林里的每一位朋友。';
const STORY_TEXT = `${PARA1}\n${PARA2}\n${PARA3}\n${PARA4}`;
const MESSAGE_ID = 'msg_fix03_resume';

// 中文注释：拦截 tRPC 批量请求的合成文本；与模块加载顺序无关，调用时解析。
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

// 中文注释：node 22 自带 navigator 但 onLine 为 undefined，先保存原始引用以便测试后恢复。
const originalNavigator = globalThis.navigator;

async function runFix03Tests(): Promise<void> {
    console.log('=== FIX-03: 恢复态重合成必须进入活跃播放并可预载下一段 ===');

    // 中文注释：注册仿浏览器 AudioControllerHost 的音频控制器，play 成功后同步调用 start() 进入活跃态。
    usePlaybackStore.getState().registerAudioController({
        unlock: async () => {},
        play: async () => {
            // 中文注释：忠实模拟 AudioControllerHost.handlePlay 成功分支的 handlePlaybackStart() 调用。
            usePlaybackStore.getState().start();
        },
        resume: async () => {},
        pause: () => {},
        seek: () => {},
        setPlaybackRate: () => {},
    });
    // 中文注释：时长预算来源为用户配置的播放时长（默认 30 分钟），与 startStoryPlayback 同源。
    useConfigStore.setState((state) => ({
        apiConfig: { ...state.apiConfig, playDuration: 30, voiceId: 'alloy', speed: 1.0 },
    }));

    const expectedParagraphs = segmentStoryText(STORY_TEXT);
    assert.strictEqual(expectedParagraphs.length, 4, '故事正文必须切分为 4 段');

    // 中文注释：构造恢复态现场——chat 侧 delivered 卡片 + 服务端 DTO（null 预算、next=2、hash 匹配）。
    useChatStore.getState().reset();
    usePlaybackStore.getState().reset();
    usePlaybackProgressStore.getState().reset();
    useChatStore.setState({
        messages: [
            {
                id: MESSAGE_ID,
                role: 'assistant',
                content: STORY_TEXT,
                parts: [{ type: 'storyCard', storyText: STORY_TEXT, audioUrl: '' }],
                status: 'delivered',
                createdAt: new Date().toISOString(),
            },
        ],
        syncEnabled: true,
    });
    const normalized = normalizeStoryText(STORY_TEXT);
    const contentHash = computeStoryContentHash(normalized);
    const hydrated = await usePlaybackProgressStore.getState().hydrateFromDTO({
        sourceType: 'chat',
        sourceId: MESSAGE_ID,
        sessionId: MESSAGE_ID,
        title: '音频故事',
        contentHash,
        segmentationVersion: SEGMENTATION_VERSION,
        lastCompletedParagraphIndex: 1,
        nextParagraphIndex: 2,
        totalParagraphs: 4,
        voiceId: 'alloy',
        speed: 1.0,
        remainingAllowedMs: null,
        totalAllowedMs: null,
        isOneShot: true,
        updatedAt: new Date().toISOString(),
    });
    assert.strictEqual(hydrated, true, '恢复态水合必须成功');
    assert.strictEqual(
        usePlaybackStore.getState().isRehydratedReady,
        true,
        '水合后应停驻就绪态等待用户手势',
    );

    synthRequests.length = 0;

    // 中文注释：恢复态点击“从第 3 段继续”，必须重合成第 3 段并进入活跃播放。
    await playStoryText(STORY_TEXT, MESSAGE_ID);

    assert.strictEqual(synthRequests.length, 1, '恢复播放应恰好合成一次');
    assert.strictEqual(synthRequests[0], expectedParagraphs[2], '恢复播放必须合成第 3 段（next=2）');
    const playbackAfterResume = usePlaybackStore.getState();
    // 中文注释：活跃播放断言——remainingMs 必须为有限正数预算，不得为 null/无限/耗尽。
    assert.notStrictEqual(playbackAfterResume.remainingMs, null, '恢复态起播后 remainingMs 不得为 null');
    const remainingMs = playbackAfterResume.remainingMs;
    assert.strictEqual(typeof remainingMs, 'number', 'remainingMs 必须为数值预算');
    assert.ok(Number.isFinite(remainingMs), 'remainingMs 不得为无限');
    assert.ok((remainingMs as number) > 0, 'remainingMs 必须为正数（非耗尽态）');
    assert.strictEqual(playbackAfterResume.isPlaying, true, '恢复态起播后必须进入 isPlaying=true');

    // 中文注释：node 22 自带 navigator 但 onLine 为 undefined，会触发离线门禁；此处模拟浏览器在线态。
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: { ...originalNavigator, onLine: true },
        configurable: true,
        writable: true,
      });
    } catch {
      // 中文注释：若运行环境禁止重定义，则保持原状（浏览器 E2E 侧在线态天然成立）。
    }
    synthRequests.length = 0;
    await usePlaybackProgressStore.getState().prefetchNextParagraph(3);
    const progressAfterPrefetch = usePlaybackProgressStore.getState();
    const prefetchHit =
        synthRequests.includes(expectedParagraphs[3]) ||
        progressAfterPrefetch.prefetchedAudioUrl !== null ||
        progressAfterPrefetch.prefetchingIndex === 3;
    assert.strictEqual(prefetchHit, true, '播放中下一段预载必须触发合成或落缓存');
    // 中文注释：预载后 ended 链仍可用——直接推进下一段不得抛错。
    await usePlaybackProgressStore.getState().handleParagraphEnded();

    console.log('PASS: FIX-03 resume-active-countdown-and-prefetch verified');

    // 中文注释：非恢复负例——无断点的新故事仍从第 1 段起播（防过拟合与防自动续写回归）。
    usePlaybackStore.getState().reset();
    usePlaybackProgressStore.getState().reset();
    synthRequests.length = 0;
    const freshId = 'msg_fix03_fresh';
    useChatStore.setState({
        messages: [
            {
                id: freshId,
                role: 'assistant',
                content: STORY_TEXT,
                parts: [{ type: 'storyCard', storyText: STORY_TEXT, audioUrl: '' }],
                status: 'delivered',
                createdAt: new Date().toISOString(),
            },
        ],
        syncEnabled: true,
    });
    await playStoryText(STORY_TEXT, freshId);
    assert.strictEqual(synthRequests.length, 1, '新故事应恰好合成一次');
    assert.strictEqual(synthRequests[0], expectedParagraphs[0], '无断点时必须从第 1 段起播');

    console.log('\nALL FIX-03 RESUME TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runFix03Tests()
    .then(() => {
        console.log('ALL FIX-03 RESUME TEST CASES PASSED SUCCESSFULLY!');
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
