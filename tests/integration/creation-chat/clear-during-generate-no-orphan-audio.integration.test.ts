import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const cwd = process.cwd();

/**
 * E2E-02-04 生成中清空防止孤儿播放（L2，真实 beginChatStream + 真实 resetStoryFlow）。
 *
 * oracle（spec 02-04 + catalog no-orphan-after-clear[audio]）：
 * D2：慢流 + 流式中清空 + 完成到达 → 断言无孤儿播放（play 未调用）、
 * 聊天保持空（无诈尸卡片）、无浮窗、无在播轨道。
 * D1 阳性对照：不清空时完成回调必须触发 1 次 play（证明是清空导致的不播，
 * 排除探针本身播不出来的假阴性）。
 *
 * 手法与探针蓝本一致：require.cache 桩掉 @/lib/trpc/client（与既有 GlassToast 桩同手法），
 * 返回可控慢流 meta(Story)→token×2→[门控]→audio_start→audio→complete。
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

const { useChatStore } = nodeRequire(path.resolve(cwd, 'stores/chatStore')) as {
    useChatStore: typeof import('../../../stores/chatStore').useChatStore;
};
const { usePlaybackStore } = nodeRequire(path.resolve(cwd, 'stores/playbackStore')) as {
    usePlaybackStore: typeof import('../../../stores/playbackStore').usePlaybackStore;
};
const { useGenerationHistoryStore } = nodeRequire(path.resolve(cwd, 'stores/generationHistoryStore')) as {
    useGenerationHistoryStore: typeof import('../../../stores/generationHistoryStore').useGenerationHistoryStore;
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
    usePlaybackStore.getState().reset();
    usePlaybackStore.getState().registerAudioController(null);
    useGenerationHistoryStore.getState().reset?.();
    // 真实会话中配置早已水合（默认 30 分钟）：node 默认 playDuration=0 会误触 H-08 预算守卫，
    // 此处按浏览器真实态水合，避免假阴性。
    useConfigStore.setState((s) => ({
        apiConfig: { ...s.apiConfig, playDuration: 30, voiceId: 'onyx', speed: 1 },
    }));
}

/** D1 阳性对照：不清，流完成应自动播放（play=1，浮窗出现）。 */
async function scenarioNoClear(): Promise<void> {
    console.log('--- D1: 阳性对照（不清，流完成应自动播放）---');
    resetAll();
    const spy = { play: 0, pause: 0 };
    usePlaybackStore.getState().registerAudioController(freshController(spy) as never);
    const p = beginChatStream('讲个睡前故事');
    await tick();
    releaseGate?.();
    const result = await p;
    assert(fakeUsed, '必须走到桩流（否则测试无效）');
    assert(result.audioUrl.startsWith('blob:'), '应产出音频 URL');
    assert.strictEqual(spy.play, 1, '阳性对照：不清时完成回调必须触发 1 次 play');
    assert.strictEqual(usePlaybackStore.getState().currentAudioUrl, result.audioUrl);
    assert.strictEqual(usePlaybackStore.getState().isFloatingVisible, true, '浮窗应出现（对照组）');
    console.log(`PASS: D1 positive control (play=${spy.play}, floating visible)`);
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
    await tick(5);
    assert(result.audioUrl.startsWith('blob:'), '流本身应完整到达（含音频）');

    assert.strictEqual(spy.play, 0, '核心断言：清空后完成到达不得触发播放（no-orphan-after-clear）');
    assert.strictEqual(useChatStore.getState().messages.length, 0, '清空后聊天应保持为空（无诈尸卡片）');
    assert.strictEqual(usePlaybackStore.getState().isFloatingVisible, false, '浮窗不应凭空出现');
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
