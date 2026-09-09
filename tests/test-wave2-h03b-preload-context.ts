import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

// 中文注释：H-03-b 回归——历史预载指令泡不得污染 LLM 上下文与摘要输入，本轮保留供续写触发。
// 全程内存打桩，不建 socket、不绑端口，不碰 prisma/dev.db。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

// 中文注释：先占桩——GlassToast / 会话落库 / Agent 交互（含 summarize 捕获），必须在 require chatStore 之前占位。
const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
nodeRequire.cache[glassToastPath] = {
    id: glassToastPath,
    filename: glassToastPath,
    loaded: true,
    exports: { default: { show: () => {}, clear: () => {} } },
} as unknown as NodeModule;

const chatConversationPath = path.resolve(process.cwd(), 'lib/client/chatConversation.ts');
nodeRequire.cache[chatConversationPath] = {
    id: chatConversationPath,
    filename: chatConversationPath,
    loaded: true,
    exports: {
        fetchMyConversation: async () => [],
        saveMyConversation: async () => ({ ok: true }),
    },
} as unknown as NodeModule;

// 中文注释：summarize 输入捕获桩——记录每次 summarizeContext 入参，供“不含指令泡”断言；自证拦截有效用调用计数。
let summarizeCalls = 0;
let lastSummarizeInput: Array<{ role: string; content: string }> | null = null;
const agentFlowPath = path.resolve(process.cwd(), 'app/services/agentFlow.ts');
nodeRequire.cache[agentFlowPath] = {
    id: agentFlowPath,
    filename: agentFlowPath,
    loaded: true,
    exports: {
        interactWithAgent: async () => {},
        summarizeContext: async (messages: Array<{ role: string; content: string }>) => {
            summarizeCalls += 1;
            lastSummarizeInput = messages;
            return '探针摘要-H03b';
        },
    },
} as unknown as NodeModule;

const { useChatStore } = nodeRequire('../stores/chatStore') as {
    useChatStore: typeof import('../stores/chatStore').useChatStore;
};
const chatStoreModule = nodeRequire('../stores/chatStore') as Record<string, unknown>;
const { AUTO_CONTINUE_PROMPT } = nodeRequire('../app/services/chatFlow') as {
    AUTO_CONTINUE_PROMPT: string;
};

// 中文注释：自证桩有效——agentFlow 桩必须真实拦截 checkAndSummarize 的动态导入，否则后续断言无意义。
function assertStubEffective(): void {
    assert.strictEqual(
        AUTO_CONTINUE_PROMPT,
        '请继续故事',
        '续写指令常量不得漂移',
    );
    assert.strictEqual(
        typeof chatStoreModule.isPreloadUserMessage,
        'function',
        'chatStore 必须导出 isPreloadUserMessage',
    );
}

function resetBaseline(): void {
    useChatStore.getState().reset();
    useChatStore.setState({ syncEnabled: false });
    summarizeCalls = 0;
    lastSummarizeInput = null;
}

// 中文注释：以 dispatch 直写消息流（origin 标记由 chatStore 负责），finish 置完结便于上下文断言。
function submitManual(content: string): void {
    useChatStore.getState().dispatch({ type: 'user.submit', content } as Parameters<
        ReturnType<typeof useChatStore.getState>['dispatch']
    >[0]);
    useChatStore.getState().dispatch({
        type: 'stream.finish',
        payload: { type: 'done', finishReason: 'stop' },
    } as Parameters<ReturnType<typeof useChatStore.getState>['dispatch']>[0]);
}

function submitPreloadStory(instructionContent: string, storyText: string): void {
    useChatStore.getState().dispatch({
        type: 'user.submit',
        content: instructionContent,
        origin: 'preload',
    } as Parameters<ReturnType<typeof useChatStore.getState>['dispatch']>[0]);
    useChatStore.getState().dispatch({
        type: 'stream.story_finish',
        storyText,
        audioUrl: 'blob:h03b-preload',
    } as Parameters<ReturnType<typeof useChatStore.getState>['dispatch']>[0]);
}

async function runH03bTests(): Promise<void> {
    assertStubEffective();

    console.log('=== H-03-b-01: conversationMessages 排除历史预载指令泡 ===');
    resetBaseline();
    submitManual('手动问题-1');
    submitPreloadStory(AUTO_CONTINUE_PROMPT, '预载故事-H03b-01');
    // 中文注释：本轮为人工提问（dispatch 后 sending 未 finish，复刻 beginChatStream 取上下文时机）。
    useChatStore.getState().dispatch({ type: 'user.submit', content: '手动问题-2' } as Parameters<
        ReturnType<typeof useChatStore.getState>['dispatch']
    >[0]);
    const ctx1 = useChatStore.getState().selectors.conversationMessages();
    const contents1 = ctx1.map((m) => String(m.content));
    assert.ok(contents1.includes('手动问题-1'), '历史人工问题应保留');
    assert.ok(contents1.includes('手动问题-2'), '本轮人工触发应保留');
    assert.ok(contents1.includes('预载故事-H03b-01'), '预载故事助手卡应保留（仅排指令泡）');
    assert.ok(
        !contents1.includes(AUTO_CONTINUE_PROMPT),
        'RED: 历史预载指令泡“请继续故事”不得进入 conversationMessages',
    );
    console.log('PASS: H-03-b-01 history preload excluded');

    console.log('=== H-03-b-02: conversationMessages 本轮预载保留供续写 ===');
    resetBaseline();
    submitManual('手动问题-本轮保留前置');
    // 中文注释：本轮即预载续写（sending 未完结），最后一条 user 为 preload 指令，必须保留供 LLM 见到续写触发。
    useChatStore.getState().dispatch({
        type: 'user.submit',
        content: AUTO_CONTINUE_PROMPT,
        origin: 'preload',
    } as Parameters<ReturnType<typeof useChatStore.getState>['dispatch']>[0]);
    const ctx2 = useChatStore.getState().selectors.conversationMessages();
    const contents2 = ctx2.map((m) => String(m.content));
    assert.ok(
        contents2.includes(AUTO_CONTINUE_PROMPT),
        '本轮预载触发必须保留（否则续写无指令可依）',
    );
    console.log('PASS: H-03-b-02 current preload retained');

    console.log('=== H-03-b-03: checkAndSummarize TRIGGER 计入排除指令泡 ===');
    resetBaseline();
    // 中文注释：精确边界——4 条人工普通 + 1 条指令泡：基线计 5 条误触发（>4），修后计 4 条不触发（<=4）。
    // 直写 store 定长消息，避免 dispatch 附带助手占位干扰计数。
    const nowIso = new Date().toISOString();
    useChatStore.setState({
        messages: [
            { id: 'b-u1', role: 'user', content: '边界-u1', status: 'delivered', createdAt: nowIso },
            { id: 'b-a1', role: 'assistant', content: '边界-a1', status: 'delivered', createdAt: nowIso },
            { id: 'b-u2', role: 'user', content: '边界-u2', status: 'delivered', createdAt: nowIso },
            { id: 'b-a2', role: 'assistant', content: '边界-a2', status: 'delivered', createdAt: nowIso },
            {
                id: 'b-pre-u',
                role: 'user',
                content: AUTO_CONTINUE_PROMPT,
                status: 'delivered',
                createdAt: nowIso,
                metadata: { origin: 'preload' },
            },
        ],
    });
    summarizeCalls = 0;
    await useChatStore.getState().checkAndSummarize();
    assert.strictEqual(
        summarizeCalls,
        0,
        'RED: TRIGGER 计入含指令泡会误触发总结；排除后 4 条普通不得触发',
    );
    console.log('PASS: H-03-b-03 trigger excludes preload');

    console.log('=== H-03-b-04: checkAndSummarize 摘要输入排除指令泡 ===');
    resetBaseline();
    // 中文注释：预载 story 置于归档窗（前部），确保其正文进摘要输入；指令泡全程不得进输入。
    submitPreloadStory(AUTO_CONTINUE_PROMPT, '摘要预载故事');
    submitManual('摘要-u1');
    submitManual('摘要-u2');
    submitManual('摘要-u3');
    summarizeCalls = 0;
    lastSummarizeInput = null;
    await useChatStore.getState().checkAndSummarize();
    assert.ok(summarizeCalls >= 1, '桩必须真实拦截 summarizeContext（自证有效），否则本用例无意义');
    assert.ok(
        lastSummarizeInput !== null &&
            !lastSummarizeInput.some((m) => m.content === AUTO_CONTINUE_PROMPT),
        'RED: 摘要输入不得含“请继续故事”指令泡',
    );
    assert.ok(
        lastSummarizeInput !== null &&
            lastSummarizeInput.some((m) => m.content === '摘要预载故事'),
        '预载故事正文应仍进摘要（仅排指令泡）',
    );
    console.log('PASS: H-03-b-04 summarize input excludes preload');

    console.log('\nALL H-03-b TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runH03bTests()
    .then(() => {
        console.log('ALL H-03-b TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('H-03-b test failed:', error);
        process.exit(1);
    })
    .finally(() => {
        useChatStore.getState().reset();
    });

export default testPromise;
