import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

// 中文注释：H-03 预载隔离回归——预载续写不得以用户身份污染聊天流，且人工草稿不得被清空。
// 覆盖：无可见「请继续故事」用户气泡 / 快照落库排除续写指令 / 草稿保留 / 生成历史不新增。
// 全程内存打桩，不建 socket、不绑端口，不碰 prisma/dev.db 与既有 .e2e-runtime 资产。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：预置 GlassToast 打桩，避免 store 失败路径触真实 UI 依赖。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

// 中文注释：会话落库捕获桩——拦截 tRPC 快照保存，记录每次 payload 供“不落库”断言。
const chatConversationPath = path.resolve(process.cwd(), 'lib/client/chatConversation.ts');
type ChatMessageInputLike = { messageId: string; role: string; content: string };
const savedSnapshots: ChatMessageInputLike[][] = [];
nodeRequire.cache[chatConversationPath] = {
    id: chatConversationPath,
    filename: chatConversationPath,
    loaded: true,
    exports: {
        fetchMyConversation: async () => [],
        saveMyConversation: async (messages: ChatMessageInputLike[]) => {
            savedSnapshots.push(messages);
            return { ok: true };
        },
    },
} as unknown as NodeModule;

// 中文注释：Agent 交互可控桩——成功态模拟 Story 意图 + 文本增量 + 音频 + 完成；失败态走 onError。
import { TRPCError } from '../lib/trpc/init';
let stubMode: 'success' | 'fail' = 'success';
const PRELOAD_STORY_TEXT = '预载故事正文-隔离测试';
const PRELOAD_AUDIO_URL = 'blob:mock-preload-audio';
const agentFlowPath = path.resolve(process.cwd(), 'app/services/agentFlow.ts');
nodeRequire.cache[agentFlowPath] = {
    id: agentFlowPath,
    filename: agentFlowPath,
    loaded: true,
    exports: {
        interactWithAgent: async (
            _messages: unknown,
            callbacks: {
                onTextDelta: (delta: string) => void;
                onIntentDetected?: (intent: 'Story' | 'Chat' | 'Guidance') => void;
                onAudioStart?: () => void;
                onAudioComplete?: (url: string) => void;
                onComplete: () => void;
                onError: (error: Error) => void;
            },
        ) => {
            if (stubMode === 'fail') {
                callbacks.onError(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '探针模拟失败' }));
                return;
            }
            callbacks.onIntentDetected?.('Story');
            callbacks.onTextDelta(PRELOAD_STORY_TEXT);
            callbacks.onAudioComplete?.(PRELOAD_AUDIO_URL);
            callbacks.onComplete();
        },
        summarizeContext: async () => '探针摘要',
    },
} as unknown as NodeModule;

const { useChatStore } = nodeRequire('../stores/chatStore') as {
    useChatStore: typeof import('../stores/chatStore').useChatStore;
} & Record<string, unknown>;
const { usePreloadStore } = nodeRequire('../stores/preloadStore') as {
    usePreloadStore: typeof import('../stores/preloadStore').usePreloadStore;
};
const { useGenerationHistoryStore } = nodeRequire('../stores/generationHistoryStore') as {
    useGenerationHistoryStore: typeof import('../stores/generationHistoryStore').useGenerationHistoryStore;
};
const { usePromptHistoryStore } = nodeRequire('../stores/promptHistoryStore') as {
    usePromptHistoryStore: typeof import('../stores/promptHistoryStore').usePromptHistoryStore;
};
const { AUTO_CONTINUE_PROMPT } = nodeRequire('../app/services/chatFlow') as {
    AUTO_CONTINUE_PROMPT: string;
};

// 中文注释：重置聊天与预载 store 到干净基线，并开启会话同步以便落库断言。
function resetBaseline(): void {
    useChatStore.getState().reset();
    usePreloadStore.getState().reset();
    useGenerationHistoryStore.getState().reset();
    usePromptHistoryStore.getState().reset();
    savedSnapshots.length = 0;
    stubMode = 'success';
}

// 中文注释：预置一条已完结故事卡，避免预载完成触发首 story 自动播放（需真实音频控制器）。
function seedPriorStory(): void {
    useChatStore.setState({
        messages: [
            {
                id: 'seed-story-h03',
                role: 'assistant',
                content: '种子故事正文',
                parts: [{ type: 'storyCard', storyText: '种子故事正文', audioUrl: 'blob:seed-audio' }],
                status: 'delivered',
                createdAt: new Date().toISOString(),
            },
        ],
        syncEnabled: true,
    });
}

// 中文注释：生成历史调用计数器——包装 record/addOrUpdate 以证明预载不新增记录。
function installHistoryCounters(): { generations: () => number; prompts: () => number; restore: () => void } {
    let generationCalls = 0;
    let promptCalls = 0;
    const generationState = useGenerationHistoryStore.getState();
    const promptState = usePromptHistoryStore.getState();
    const originalRecord = generationState.record;
    const originalAddOrUpdate = promptState.addOrUpdate;
    useGenerationHistoryStore.setState({
        record: ((...args: Parameters<typeof originalRecord>) => {
            generationCalls += 1;
            return (originalRecord as (...a: unknown[]) => unknown)(...args);
        }) as typeof originalRecord,
    });
    usePromptHistoryStore.setState({
        addOrUpdate: ((...args: Parameters<typeof originalAddOrUpdate>) => {
            promptCalls += 1;
            return (originalAddOrUpdate as (...a: unknown[]) => unknown)(...args);
        }) as typeof originalAddOrUpdate,
    });
    return {
        generations: () => generationCalls,
        prompts: () => promptCalls,
        restore: () => {
            useGenerationHistoryStore.setState({ record: originalRecord });
            usePromptHistoryStore.setState({ addOrUpdate: originalAddOrUpdate });
        },
    };
}

async function runH03Tests(): Promise<void> {
    assert.strictEqual(AUTO_CONTINUE_PROMPT, '请继续故事', '续写指令常量不得漂移');

    console.log('=== H-03-01: 预载保留人工草稿（不清空 inputValue）===');
    resetBaseline();
    seedPriorStory();
    useChatStore.getState().setInputValue('人工草稿-不得清空');
    const preloadResult = await usePreloadStore.getState().requestPreload();
    assert.strictEqual(preloadResult.segment, PRELOAD_STORY_TEXT, '预载应返回桩故事正文');
    assert.strictEqual(preloadResult.audioUrl, PRELOAD_AUDIO_URL, '预载应返回桩音频地址');
    assert.strictEqual(
        useChatStore.getState().inputValue,
        '人工草稿-不得清空',
        'RED: 预载走 user.submit 清空了人工草稿',
    );
    console.log('PASS: H-03-01 draft preserved');

    console.log('=== H-03-02: 预载不产生可见用户气泡 ===');
    const chatStoreModule = nodeRequire('../stores/chatStore') as Record<string, unknown>;
    assert.strictEqual(
        typeof chatStoreModule.isPreloadUserMessage,
        'function',
        'RED: chatStore 必须导出 isPreloadUserMessage 供渲染区过滤',
    );
    const isPreloadUserMessage = chatStoreModule.isPreloadUserMessage as (message: {
        role: string;
        content: string;
        metadata?: unknown;
    }) => boolean;
    const messages = useChatStore.getState().messages;
    const visibleMessages = messages.filter((message) => !isPreloadUserMessage(message));
    assert.ok(
        !visibleMessages.some(
            (message) => message.role === 'user' && message.content === AUTO_CONTINUE_PROMPT,
        ),
        'RED: 可见聊天流出现「请继续故事」用户气泡',
    );
    // 中文注释：保守语义——仅隐藏续写指令用户泡，预载故事助手卡仍可见、可播。
    assert.ok(
        visibleMessages.some(
            (message) => message.role === 'assistant' && message.content === PRELOAD_STORY_TEXT,
        ),
        '预载故事助手卡应仍可见（仅隐藏指令泡为保守语义）',
    );
    console.log('PASS: H-03-02 no visible preload user bubble');

    console.log('=== H-03-03: 快照落库排除续写指令 ===');
    savedSnapshots.length = 0;
    // 中文注释：等待 1s 防抖落库触发，断言每一次快照均不含续写指令。
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.ok(savedSnapshots.length >= 1, '登录态下预载完成后应触发至少一次快照保存');
    for (const snapshot of savedSnapshots) {
        assert.ok(
            !snapshot.some(
                (message) => message.role === 'user' && message.content === AUTO_CONTINUE_PROMPT,
            ),
            'RED: 快照把「请继续故事」持久化了',
        );
    }
    assert.ok(
        savedSnapshots[savedSnapshots.length - 1].some(
            (message) => message.role === 'assistant' && message.content === PRELOAD_STORY_TEXT,
        ),
        '预载故事正文应仍可持久化（仅排除指令泡）',
    );
    console.log('PASS: H-03-03 snapshot excludes preload prompt');

    console.log('=== H-03-04: 预载不新增生成历史与提示词历史 ===');
    resetBaseline();
    seedPriorStory();
    const counters = installHistoryCounters();
    try {
        await usePreloadStore.getState().requestPreload();
        // 中文注释：record 为异步落库后入列，等待一拍以防误判。
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.strictEqual(counters.generations(), 0, '预载不得调用生成历史 record');
        assert.strictEqual(counters.prompts(), 0, '预载不得调用提示词历史 addOrUpdate');
    } finally {
        counters.restore();
    }
    console.log('PASS: H-03-04 history untouched');

    console.log('=== H-03-05: 普通用户提交仍清空输入框（无回归）===');
    resetBaseline();
    useChatStore.setState({ syncEnabled: false });
    useChatStore.getState().setInputValue('普通草稿');
    useChatStore.getState().dispatch({ type: 'user.submit', content: '普通问题' } as Parameters<
        ReturnType<typeof useChatStore.getState>['dispatch']
    >[0]);
    assert.strictEqual(useChatStore.getState().inputValue, '', '普通提交必须仍清空输入框');
    useChatStore.getState().reset();
    console.log('PASS: H-03-05 normal submit clears draft');

    console.log('=== H-03-06: 预载失败仍保留草稿（TRPCError 路径）===');
    resetBaseline();
    seedPriorStory();
    useChatStore.getState().setInputValue('失败路径草稿');
    stubMode = 'fail';
    await assert.rejects(
        usePreloadStore.getState().requestPreload(),
        (error: unknown) =>
            error instanceof Error && (error instanceof TRPCError || /探针模拟失败|聊天请求失败/.test(error.message)),
        '预载失败应向上抛出',
    );
    assert.strictEqual(
        useChatStore.getState().inputValue,
        '失败路径草稿',
        '预载失败也不得清空人工草稿',
    );
    console.log('PASS: H-03-06 draft preserved on failure');

    console.log('\nALL H-03 PRELOAD ISOLATION TEST CASES PASSED SUCCESSFULLY!');
}

const testPromise = runH03Tests()
    .then(() => {
        console.log('ALL H-03 PRELOAD ISOLATION TEST CASES PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Test execution failed:', error);
        process.exit(1);
    })
    .finally(() => {
        useChatStore.getState().reset();
        usePreloadStore.getState().reset();
    });

export default testPromise;
