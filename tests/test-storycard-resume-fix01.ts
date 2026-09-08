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
const { segmentStoryText } = nodeRequire('../utils/segmentation') as {
    segmentStoryText: typeof import('../utils/segmentation').segmentStoryText;
};
const { playStoryText } = nodeRequire('../app/services/storyFlow') as {
    playStoryText: typeof import('../app/services/storyFlow').playStoryText;
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
const MESSAGE_ID = 'msg_fix01_resume';

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

async function runFix01Tests() {
    console.log('=== FIX-01: 断点恢复必须按真实 nextIndex 续播 ===');

    // 中文注释：注册假音频控制器，使 playAudio/ensureUnlocked 可在 node 侧执行。
    usePlaybackStore.getState().registerAudioController({
        unlock: async () => {},
        play: async () => {},
        resume: async () => {},
        pause: () => {},
        seek: () => {},
        setPlaybackRate: () => {},
    });
    useConfigStore.setState((state) => ({
        apiConfig: { ...state.apiConfig, voiceId: 'alloy', speed: 1.0 },
    }));

    const expectedParagraphs = segmentStoryText(STORY_TEXT);
    assert.strictEqual(expectedParagraphs.length, 4, '故事正文必须切分为 4 段');

    // 中文注释：构造断点现场——chat 侧 delivered 卡片 + 进度侧停在 next=2（按钮文案“从第 3 段继续收听”同源）。
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
    usePlaybackProgressStore.getState().setActiveStory({
        sourceType: 'chat',
        sourceId: MESSAGE_ID,
        sessionId: MESSAGE_ID,
        title: '音频故事',
        storyText: STORY_TEXT,
        voiceId: 'alloy',
        speed: 1.0,
        isOneShot: true,
        initialNextIndex: 2,
    });
    // 中文注释：按钮文案来源与断点一致性前置断言。
    assert.strictEqual(
        usePlaybackProgressStore.getState().nextParagraphIndex,
        2,
        '断点 nextIndex 应为 2（按钮文案“从第 3 段继续收听”来源）',
    );

    synthRequests.length = 0;

    // 中文注释：恢复态点击行为——必须合成第 3 段，而非第 1 段。
    await playStoryText(STORY_TEXT, MESSAGE_ID);

    assert.strictEqual(synthRequests.length, 1, '恢复播放应恰好合成一次');
    assert.strictEqual(
        synthRequests[0],
        expectedParagraphs[2],
        `恢复播放必须合成第 3 段（next=2），实际合成文本与第 3 段不符则为缺陷 #1`,
    );
    assert.strictEqual(
        usePlaybackProgressStore.getState().nextParagraphIndex,
        2,
        '播放起点必须与按钮文案同源（next=2）',
    );

    console.log('PASS: FIX-01 resume-from-breakpoint verified');

    // 中文注释：无断点新故事仍应从第 1 段起播（防过拟合）。
    usePlaybackStore.getState().reset();
    usePlaybackProgressStore.getState().reset();
    synthRequests.length = 0;
    const freshId = 'msg_fix01_fresh';
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
    console.log('PASS: FIX-01 fresh-story-from-start verified');

    console.log('\nALL FIX-01 RESUME TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runFix01Tests()
    .then(() => {
        console.log('ALL FIX-01 RESUME TEST CASES PASSED SUCCESSFULLY!');
    })
    .catch((err) => {
        console.error('Test execution failed:', err);
        process.exit(1);
    })
    .finally(() => {
        // 中文注释：恢复全局打桩，避免污染后续套件。
        globalThis.fetch = originalFetch;
        if (originalCreateObjectURL) {
            urlStatics.createObjectURL = originalCreateObjectURL;
        } else {
            delete urlStatics.createObjectURL;
        }
    });

export default testPromise;
