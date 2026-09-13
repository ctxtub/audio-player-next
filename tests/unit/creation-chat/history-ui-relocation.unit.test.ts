import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：M4-07 History UI Relocation / Chat-owned History Surface 回归（E2E-08-07）。
// History = UI relocation，不是 migration：提示词历史 / 生成历史从 /player 搬回 Chat，
// 数据源（promptHistoryStore / generationHistoryStore）、记录格式、排序/删除/重新创作与
// legacy replay 语义原样保留；零数据迁移、零 Artifact recovery 改动、零 Legacy cutover。
// 全程内存渲染（jsdom + 真实组件 + 真实 store）与静态 ownership 断言，不建 socket、
// 不绑端口，不碰 prisma/dev.db。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
type JSDOMWindowLike = Record<string, unknown>;
type JSDOMLike = { window: JSDOMWindowLike };
type JSDOMCtorLike = new (html: string, opts?: Record<string, unknown>) => JSDOMLike;
const repoRoot: string = process.cwd();
type JitiInstance = (id: string) => Record<string, unknown>;
type JitiFactory = (base: string, opts: Record<string, unknown>) => JitiInstance;
type ToastCall = { icon?: string; content?: string };
type RealToast = {
    show: (config: { icon?: string; content: string }) => void;
    clear: () => void;
};
type ChatMessageLike = {
    id: string;
    role: string;
    content: string;
    status?: string;
    createdAt: string;
    parts?: Array<Record<string, unknown>>;
};
type ChatStoreLike = {
    getState: () => {
        messages: ChatMessageLike[];
        inputValue: string;
        pendingAutoSend: string | null;
        dispatch: (action: unknown) => void;
        setInputValue: (v: string) => void;
        setPendingAutoSend: (v: string | null) => void;
        reset: () => void;
    };
    setState: (p: Record<string, unknown>) => void;
};
type PromptStoreLike = {
    getState: () => {
        recordsMap: Record<string, { prompt: string; lastUsed: string; useCount: number }>;
        sortMode: string;
        syncEnabled: boolean;
        setSortMode: (m: string) => void;
        remove: (p: string) => void;
        reset: () => void;
    };
    setState: (p: Record<string, unknown>) => void;
};
type GenerationStoreLike = {
    getState: () => {
        records: Array<{ id: number; prompt: string; storyText: string; voiceId: string; createdAt: string }>;
        syncEnabled: boolean;
        remove: (id: number) => void;
        reset: () => void;
    };
    setState: (p: Record<string, unknown>) => void;
};

/**
 * 安装样式与静态资源内存桩（仅拦截样式/图片后缀，不触业务逻辑）。
 */
function installAssetStubs(): void {
    const extTable = (
        nodeRequire as unknown as {
            extensions: Record<string, (m: NodeModule, f: string) => void>;
        }
    ).extensions;
    if (extTable && !extTable['.scss']) {
        const scssStub = (m: NodeModule): void => {
            const proxy = new Proxy(
                {},
                {
                    get: (_t: object, p: string | symbol): unknown => {
                        if (p === '__esModule') {
                            return true;
                        }
                        return String(p);
                    },
                },
            );
            (m as unknown as { exports: unknown }).exports = proxy;
        };
        extTable['.scss'] = scssStub as (m: NodeModule, f: string) => void;
        extTable['.css'] = scssStub as (m: NodeModule, f: string) => void;
    }
    if (extTable) {
        for (const ext of ['.jpeg', '.jpg', '.png', '.svg', '.webp', '.gif', '.avif', '.ico']) {
            if (!extTable[ext]) {
                extTable[ext] = ((m: NodeModule, f: string): void => {
                    const mockImage = { src: f, width: 64, height: 64 };
                    (m as unknown as { exports: unknown }).exports = mockImage;
                }) as (m: NodeModule, f: string) => void;
            }
        }
    }
}

/**
 * 搭建 jsdom 完整全局（含 react-aria 所需的 NodeFilter/SVGElement 等）。
 * @returns jsdom 实例。
 */
function setupJsdom(): JSDOMLike {
    const { JSDOM } = nodeRequire('jsdom') as unknown as { JSDOM: JSDOMCtorLike };
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://localhost/',
        pretendToBeVisual: true,
    });
    const win = dom.window as unknown as Record<string, unknown>;
    const g = globalThis as unknown as Record<string, unknown>;
    const copyKeys = [
        'window',
        'document',
        'navigator',
        'HTMLElement',
        'HTMLTextAreaElement',
        'HTMLInputElement',
        'HTMLButtonElement',
        'Element',
        'Node',
        'Text',
        'DocumentFragment',
        'Event',
        'CustomEvent',
        'MouseEvent',
        'KeyboardEvent',
        'FocusEvent',
        'SVGElement',
        'NodeFilter',
        'NodeList',
        'MutationObserver',
        'getComputedStyle',
        'localStorage',
        'React',
    ];
    const winAsRec = win as Record<string, unknown>;
    try {
        Object.defineProperty(g, 'window', { value: win, writable: true, configurable: true });
    } catch {
        g.window = win;
    }
    for (const key of copyKeys) {
        if (key === 'window') {
            continue;
        }
        let value: unknown = key === 'React' ? React : winAsRec[key];
        if (key === 'getComputedStyle' && typeof value === 'function') {
            value = (value as (e: unknown) => unknown).bind(win);
        }
        if (value === undefined) {
            continue;
        }
        try {
            Object.defineProperty(g, key, { value, writable: true, configurable: true });
        } catch {
            g[key] = value;
        }
    }
    if (!g.NodeFilter) {
        g.NodeFilter = { SHOW_ALL: 4294967295, SHOW_ELEMENT: 1 };
    }
    if (!g.SVGElement) {
        g.SVGElement = (winAsRec.SVGElement ?? class {}) as unknown;
    }
    const matchMediaStub = (): unknown => ({
        matches: false,
        addListener: (): void => {},
        removeListener: (): void => {},
        addEventListener: (): void => {},
        removeEventListener: (): void => {},
    });
    try {
        Object.defineProperty(win, 'matchMedia', { value: matchMediaStub, writable: true, configurable: true });
    } catch {
        win.matchMedia = matchMediaStub;
    }
    (g as Record<string, unknown>).matchMedia = matchMediaStub;
    if (!win.ResizeObserver) {
        const RO = class {
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        };
        try {
            Object.defineProperty(win, 'ResizeObserver', { value: RO, writable: true, configurable: true });
        } catch {
            win.ResizeObserver = RO;
        }
        g.ResizeObserver = RO;
    }
    g.requestAnimationFrame = (cb: () => void): unknown => setTimeout(cb, 0);
    g.cancelAnimationFrame = (id: unknown): void => {
        clearTimeout(id as NodeJS.Timeout);
    };
    g.IS_REACT_ACT_ENVIRONMENT = true;
    const proto = (winAsRec.Element as unknown as { prototype: Record<string, unknown> })?.prototype;
    if (proto && !proto.scrollIntoView) {
        proto.scrollIntoView = (): void => {};
    }
    return dom;
}

// 中文注释：网络/持久化边界计数桩（inner-jiti 共享 require.cache，预置后真实组件走桩边界、不触真实后端）。
let agentInteractCalls = 0;
let chatFetchCount = 0;
let chatSaveCount = 0;
let promptFetchCount = 0;
let promptRecordCount = 0;
let promptRemoveCount = 0;
let generationFetchCount = 0;
let generationRecordCount = 0;
let generationRemoveCount = 0;

/**
 * 预置网络边界桩（仅桩边界，组件与 store 均为真实实现）。
 */
function stubNetworkBoundary(): void {
    const agentFlowPath = path.resolve(repoRoot, 'app/services/agentFlow.ts');
    const chatConversationPath = path.resolve(repoRoot, 'lib/client/chatConversation.ts');
    const promptHistoryPath = path.resolve(repoRoot, 'lib/client/promptHistory.ts');
    const generationHistoryPath = path.resolve(repoRoot, 'lib/client/generationHistory.ts');
    const cache = (nodeRequire as unknown as { cache: Record<string, NodeModule> }).cache;
    cache[agentFlowPath] = {
        id: agentFlowPath,
        filename: agentFlowPath,
        loaded: true,
        exports: {
            interactWithAgent: async (
                _messages: unknown,
                callbacks: {
                    onTextDelta: (d: string) => void;
                    onIntentDetected?: (i: string) => void;
                    onAudioComplete?: (u: string) => void;
                    onComplete: () => void;
                    onError: (e: Error) => void;
                },
            ) => {
                agentInteractCalls += 1;
                callbacks.onIntentDetected?.('Chat');
                callbacks.onTextDelta('桩外真实链路问答正文-M407');
                callbacks.onComplete();
            },
            summarizeContext: async () => '桩摘要-M407',
        },
    } as unknown as NodeModule;
    cache[chatConversationPath] = {
        id: chatConversationPath,
        filename: chatConversationPath,
        loaded: true,
        exports: {
            fetchMyConversation: async () => {
                chatFetchCount += 1;
                return [];
            },
            saveMyConversation: async () => {
                chatSaveCount += 1;
                return { ok: true };
            },
        },
    } as unknown as NodeModule;
    cache[promptHistoryPath] = {
        id: promptHistoryPath,
        filename: promptHistoryPath,
        loaded: true,
        exports: {
            fetchMyPromptHistory: async () => {
                promptFetchCount += 1;
                return [];
            },
            recordMyPrompt: async () => {
                promptRecordCount += 1;
                return { ok: true };
            },
            removeMyPrompt: async () => {
                promptRemoveCount += 1;
                return { ok: true };
            },
        },
    } as unknown as NodeModule;
    cache[generationHistoryPath] = {
        id: generationHistoryPath,
        filename: generationHistoryPath,
        loaded: true,
        exports: {
            fetchMyGenerations: async () => {
                generationFetchCount += 1;
                return [];
            },
            recordMyGeneration: async (input: { prompt: string; storyText: string }) => {
                generationRecordCount += 1;
                return { id: 9999, prompt: input.prompt, storyText: input.storyText, voiceId: '', createdAt: NOW };
            },
            removeMyGeneration: async () => {
                generationRemoveCount += 1;
                return { ok: true };
            },
        },
    } as unknown as NodeModule;
}

const NOW = '2026-09-12T10:00:00.000Z';

const PROMPT_FIXTURES = [
    { prompt: '提示词-高频-M407', lastUsed: '2026-09-10T10:00:00.000Z', useCount: 10 },
    { prompt: '提示词-最新-M407', lastUsed: '2026-09-12T10:00:00.000Z', useCount: 5 },
    { prompt: '提示词-低频旧-M407', lastUsed: '2026-09-08T10:00:00.000Z', useCount: 1 },
];

const GENERATION_FIXTURES = [
    {
        id: 701,
        prompt: '生成-G1-M407',
        storyText: '生成正文-G1-M407：从前有一座会发光的灯塔，照亮了整片夜海。',
        voiceId: 'voice-07',
        createdAt: '2026-09-11T10:00:00.000Z',
    },
];

/**
 * 读取源码文本（静态 ownership 断言用）。
 * @param rel 仓库相对路径。
 * @returns 文件文本。
 */
function readSource(rel: string): string {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

async function runHistoryUiRelocationTests(): Promise<void> {
    setupJsdom();
    installAssetStubs();
    stubNetworkBoundary();
    const factory = nodeRequire('jiti') as unknown as JitiFactory;
    const innerJiti = factory(path.join(repoRoot, 'index.js'), {
        alias: { '@': repoRoot },
        jsx: true,
    });
    const chatStoreMod = innerJiti('./stores/chatStore.ts') as unknown as { useChatStore: ChatStoreLike };
    const promptStoreMod = innerJiti('./stores/promptHistoryStore.ts') as unknown as {
        usePromptHistoryStore: PromptStoreLike;
    };
    const generationStoreMod = innerJiti('./stores/generationHistoryStore.ts') as unknown as {
        useGenerationHistoryStore: GenerationStoreLike;
    };
    const playbackMod = innerJiti('./stores/playbackStore.ts') as unknown as {
        usePlaybackStore: {
            getState: () => { registerAudioController: (c: unknown) => void };
        };
    };
    const toastMod = innerJiti('./components/ui/GlassToast.tsx') as unknown as { default: RealToast };
    const layoutMod = innerJiti('./app/(main)/chat/components/ChatLayout/index.tsx') as unknown as {
        default: React.ComponentType;
    };
    const historyPanelMod = innerJiti('./app/(main)/chat/components/HistoryPanel/index.tsx') as unknown as {
        default: React.ComponentType<{ onSelectPrompt: (p: string) => void; onClose: () => void }>;
    };
    const useChatStore = chatStoreMod.useChatStore;
    const usePromptHistoryStore = promptStoreMod.usePromptHistoryStore;
    const useGenerationHistoryStore = generationStoreMod.useGenerationHistoryStore;
    const GlassToast = toastMod.default;
    const ChatLayout = layoutMod.default;
    const HistoryPanel = historyPanelMod.default;
    const ReactMod = nodeRequire('react') as typeof React;
    const rtl = nodeRequire('@testing-library/react') as typeof import('@testing-library/react');
    const toastCalls: ToastCall[] = [];
    const originalShow = GlassToast.show.bind(GlassToast);
    GlassToast.show = (config: { icon?: string; content: string }): void => {
        toastCalls.push({ icon: config.icon, content: config.content });
        originalShow(config);
    };
    playbackMod.usePlaybackStore.getState().registerAudioController({
        unlock: async (): Promise<void> => {},
        play: async (): Promise<void> => {},
        resume: async (): Promise<void> => {},
        pause: (): void => {},
        seek: (): void => {},
        setPlaybackRate: (): void => {},
    });

    /**
     * 重置三 store 到干净基线（关闭服务端同步，避免防抖落库干扰；计数器清零）。
     */
    function resetBaseline(): void {
        useChatStore.getState().reset();
        useChatStore.setState({ syncEnabled: false });
        usePromptHistoryStore.getState().reset();
        usePromptHistoryStore.setState({ syncEnabled: false, initialized: false });
        usePromptHistoryStore.getState().setSortMode('frequency');
        useGenerationHistoryStore.getState().reset();
        useGenerationHistoryStore.setState({ syncEnabled: false });
        agentInteractCalls = 0;
        chatFetchCount = 0;
        chatSaveCount = 0;
        promptFetchCount = 0;
        promptRecordCount = 0;
        promptRemoveCount = 0;
        generationFetchCount = 0;
        generationRecordCount = 0;
        generationRemoveCount = 0;
        toastCalls.length = 0;
    }

    /**
     * 以 Map 形态 seeded 提示词 fixtures（真实 promptHistoryStore）。
     */
    function seedPromptFixtures(): void {
        const recordsMap: Record<string, { prompt: string; lastUsed: string; useCount: number }> = {};
        for (const f of PROMPT_FIXTURES) {
            recordsMap[f.prompt] = { ...f };
        }
        usePromptHistoryStore.setState({ recordsMap, syncEnabled: false, initialized: true });
    }

    /**
     * seeded 生成历史 fixtures（真实 generationHistoryStore）。
     */
    function seedGenerationFixtures(): void {
        useGenerationHistoryStore.setState({
            records: GENERATION_FIXTURES.map((r) => ({ ...r })),
            syncEnabled: false,
        });
    }

    /**
     * 关闭首访引导弹窗（若存在）：OnboardingModal 打开期间会 aria-hide 背景，
     * 需先以真实用户路径关闭，後續 role 查询才是诚实的前景断言；仅写 localStorage，不触 store/计数器。
     */
    async function dismissOnboardingIfPresent(): Promise<void> {
        const confirm = rtl.screen.queryByRole('button', { name: '开始体验' });
        if (confirm) {
            await rtl.act(async () => {
                rtl.fireEvent.click(confirm);
                await new Promise((r) => setTimeout(r, 200));
            });
        }
    }

    /**
     * 打开 Chat History（点击 Composer 唯一历史入口）。
     */
    async function openHistory(): Promise<void> {
        const trigger = rtl.screen.getByRole('button', { name: '打开历史' });
        await rtl.act(async () => {
            rtl.fireEvent.click(trigger);
            await new Promise((r) => setTimeout(r, 100));
        });
    }

    /**
     * 关闭 Chat History（点击面板明确关闭入口）。
     */
    async function closeHistory(): Promise<void> {
        const closeBtn = rtl.screen.getByRole('button', { name: '关闭历史' });
        await rtl.act(async () => {
            rtl.fireEvent.click(closeBtn);
            await new Promise((r) => setTimeout(r, 100));
        });
    }

    console.log('=== M4-07-01: Player no longer owns History ===');
    {
        resetBaseline();
        const playerSource = readSource('app/(main)/player/index.tsx');
        assert.ok(!playerSource.includes('HistoryPanel'), 'player 不得再渲染 HistoryPanel');
        assert.ok(!playerSource.includes('提示词历史'), 'player 不得再含提示词历史');
        assert.ok(!playerSource.includes('生成历史'), 'player 不得再含生成历史 panel');
        assert.ok(playerSource.includes('PlaybackStatusBoard'), 'Player 主体 PlaybackStatusBoard 仍存在');
        assert.ok(playerSource.includes('GenerationPreview'), 'Player 主体 GenerationPreview 仍存在');
        assert.ok(playerSource.includes('AudioPlayer'), 'Player 主体 AudioPlayer 仍存在');
        assert.ok(
            playerSource.includes('纯 playback') || playerSource.includes('compatibility'),
            'Player 注释必须同步为纯 playback/compatibility surface',
        );
        assert.ok(fs.existsSync(path.join(repoRoot, 'app/(main)/player/page.tsx')), '不得删除 /player route');
        assert.ok(
            !fs.existsSync(path.join(repoRoot, 'app/(main)/player/components/HistoryPanel')),
            'player 不得保留 HistoryPanel 实现',
        );
        assert.ok(
            !fs.existsSync(path.join(repoRoot, 'app/(main)/player/components/HistoryRecords')),
            'player 不得保留 HistoryRecords 实现',
        );
        assert.ok(
            !fs.existsSync(path.join(repoRoot, 'app/(main)/player/components/GenerationHistory')),
            'player 不得保留 GenerationHistory 实现',
        );
        assert.ok(
            !fs.existsSync(path.join(repoRoot, 'app/(main)/player/components/HistoryList')),
            'player 不得保留 HistoryList 实现',
        );
        assert.ok(
            fs.existsSync(path.join(repoRoot, 'app/(main)/chat/components/HistoryPanel/index.tsx')),
            'HistoryPanel 必须物理归位 Chat',
        );
        assert.ok(
            fs.existsSync(path.join(repoRoot, 'app/(main)/chat/components/HistoryRecords/index.tsx')),
            'HistoryRecords 必须物理归位 Chat',
        );
        assert.ok(
            fs.existsSync(path.join(repoRoot, 'app/(main)/chat/components/GenerationHistory/index.tsx')),
            'GenerationHistory 必须物理归位 Chat',
        );
        assert.ok(
            fs.existsSync(path.join(repoRoot, 'app/(main)/chat/components/HistoryList/index.tsx')),
            'HistoryList 必须物理归位 Chat',
        );
    }
    console.log('PASS: M4-07-01 Player no longer owns History');

    console.log('=== M4-07-02: Chat History trigger open/close is data-pure ===');
    {
        resetBaseline();
        const hrefBefore = (globalThis as unknown as { window: { location: { href: string } } }).window.location.href;
        const renderResult = rtl.render(ReactMod.createElement(ChatLayout, {}));
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 400));
        });
        await dismissOnboardingIfPresent();
        // 唯一历史入口：Composer leftSlot 恰一个“打开历史”按钮。
        assert.strictEqual(
            rtl.screen.getAllByRole('button', { name: '打开历史' }).length,
            1,
            'Chat Composer 必须存在唯一历史入口',
        );
        assert.strictEqual(rtl.screen.queryByRole('dialog'), null, '初始必须 closed');
        const messagesBefore = JSON.stringify(useChatStore.getState().messages);
        const inputBefore = useChatStore.getState().inputValue;
        await openHistory();
        const dialog = rtl.screen.getByRole('dialog');
        assert.ok(dialog, '点击后必须 open（bounded overlay dialog）');
        assert.strictEqual(
            (globalThis as unknown as { window: { location: { href: string } } }).window.location.href,
            hrefBefore,
            '打开 History 不得改变 URL（不建新 route）',
        );
        assert.strictEqual(JSON.stringify(useChatStore.getState().messages), messagesBefore, '打开不得改 messages');
        assert.strictEqual(useChatStore.getState().inputValue, inputBefore, '打开不得改写 inputValue');
        await closeHistory();
        assert.strictEqual(rtl.screen.queryByRole('dialog'), null, '关闭后必须 closed');
        assert.strictEqual(
            (globalThis as unknown as { window: { location: { href: string } } }).window.location.href,
            hrefBefore,
            '关闭不得改变 URL',
        );
        assert.strictEqual(JSON.stringify(useChatStore.getState().messages), messagesBefore, '关闭不得改 messages');
        assert.strictEqual(useChatStore.getState().inputValue, inputBefore, '关闭不得改写 inputValue');
        assert.strictEqual(useChatStore.getState().pendingAutoSend, null, '开关不得误设 pending');
        assert.strictEqual(agentInteractCalls, 0, '开关不得触 generation');
        assert.strictEqual(chatFetchCount + chatSaveCount, 0, '开关不得触 conversation 持久化');
        assert.strictEqual(promptFetchCount + promptRecordCount + promptRemoveCount, 0, '开关不得写 prompt 历史');
        assert.strictEqual(generationFetchCount + generationRecordCount + generationRemoveCount, 0, '开关不得写 generation 历史');
        renderResult.unmount();
        resetBaseline();
    }
    console.log('PASS: M4-07-02 trigger + data-pure open/close');

    console.log('=== M4-07-03: Two-tab parity ===');
    {
        resetBaseline();
        seedPromptFixtures();
        seedGenerationFixtures();
        const renderResult = rtl.render(ReactMod.createElement(ChatLayout, {}));
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 400));
        });
        await dismissOnboardingIfPresent();
        await openHistory();
        // 两个 tab 都存在，默认 prompt。
        rtl.screen.getByRole('tab', { name: '提示词历史' });
        rtl.screen.getByRole('tab', { name: '生成历史' });
        assert.ok(rtl.screen.getByText('提示词-高频-M407'), '默认必须为 prompt tab');
        assert.strictEqual(rtl.screen.queryByText('生成-G1-M407'), null, '默认不得同时渲染生成列表');
        await rtl.act(async () => {
            rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: '生成历史' }));
            await new Promise((r) => setTimeout(r, 100));
        });
        assert.ok(rtl.screen.getByText('生成-G1-M407'), '切换后生成内容正确');
        assert.strictEqual(rtl.screen.queryByText('提示词-高频-M407'), null, '切换后不得同时渲染提示词列表');
        await rtl.act(async () => {
            rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: '提示词历史' }));
            await new Promise((r) => setTimeout(r, 100));
        });
        assert.ok(rtl.screen.getByText('提示词-最新-M407'), '切回 prompt tab 内容正确');
        renderResult.unmount();
        resetBaseline();
    }
    console.log('PASS: M4-07-03 two-tab parity');

    console.log('=== M4-07-04: Prompt History parity (sort/delete/reselect, real store) ===');
    {
        resetBaseline();
        seedPromptFixtures();
        const selected: string[] = [];
        let closed = 0;
        const renderResult = rtl.render(
            ReactMod.createElement(HistoryPanel, {
                onSelectPrompt: (p: string) => {
                    selected.push(p);
                },
                onClose: () => {
                    closed += 1;
                },
            }),
        );
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 300));
        });
        const bodyText = (): string => (document.body.textContent ?? '');
        // frequency 默认：高频(10) > 最新(5) > 低频旧(1)。
        assert.ok(
            bodyText().indexOf('提示词-高频-M407') < bodyText().indexOf('提示词-最新-M407') &&
                bodyText().indexOf('提示词-最新-M407') < bodyText().indexOf('提示词-低频旧-M407'),
            'frequency 排序必须按 useCount 降序',
        );
        assert.ok(bodyText().includes('使用次数'), '必须展示 useCount');
        assert.ok(bodyText().includes('最后使用'), '必须展示 lastUsed');
        // 切到 recent：最新 > 高频 > 低频旧。
        await rtl.act(async () => {
            rtl.fireEvent.click(rtl.screen.getByRole('button', { name: '按频率排序' }));
            await new Promise((r) => setTimeout(r, 100));
        });
        const recentText = bodyText();
        assert.ok(
            recentText.indexOf('提示词-最新-M407') < recentText.indexOf('提示词-高频-M407') &&
                recentText.indexOf('提示词-高频-M407') < recentText.indexOf('提示词-低频旧-M407'),
            'recent 排序必须按 lastUsed 降序',
        );
        // 删除：删第一条（最新），真实 store 驱动 UI。
        const deleteButtons = rtl.screen.getAllByRole('button', { name: '删除此提示词' });
        assert.strictEqual(deleteButtons.length, 3, '三条 fixture 必须有三个删除入口');
        await rtl.act(async () => {
            rtl.fireEvent.click(deleteButtons[0]);
            await new Promise((r) => setTimeout(r, 100));
        });
        assert.strictEqual(
            usePromptHistoryStore.getState().recordsMap['提示词-最新-M407'],
            undefined,
            '删除必须落到真实 promptHistoryStore',
        );
        assert.strictEqual(rtl.screen.queryByText('提示词-最新-M407'), null, '删除后 UI 不得再展示该条');
        assert.strictEqual(
            rtl.screen.getAllByRole('button', { name: '删除此提示词' }).length,
            2,
            '删除后剩余两条',
        );
        // 重新创作：回调拿到 prompt 原文（受控组件不自己提交）。
        await rtl.act(async () => {
            rtl.fireEvent.click(rtl.screen.getAllByRole('button', { name: '用此提示词重新创作' })[0]);
            await new Promise((r) => setTimeout(r, 100));
        });
        assert.strictEqual(selected.length, 1, '重新创作必须恰好回调一次');
        assert.strictEqual(selected[0], '提示词-高频-M407', '回调必须为所选 prompt 原文');
        assert.strictEqual(closed, 0, 'HistoryPanel 自身不得擅自关闭（关闭由 ChatLayout 适配器决定）');
        assert.strictEqual(agentInteractCalls, 0, 'HistoryPanel 不得直接触 generation');
        renderResult.unmount();
        resetBaseline();
    }
    console.log('PASS: M4-07-04 prompt parity');

    console.log('=== M4-07-05: Idle prompt selection exactly once ===');
    {
        resetBaseline();
        seedPromptFixtures();
        // 旧 Chat 现场：一条已送达旧上下文（验证 clean-creation reset 语义）。
        useChatStore.setState({
            messages: [
                { id: 'old-user-05', role: 'user', content: '旧上下文-M407', status: 'delivered', createdAt: NOW },
                { id: 'old-asst-05', role: 'assistant', content: '旧回答-M407', status: 'delivered', createdAt: NOW },
            ] as ChatMessageLike[],
        });
        const renderResult = rtl.render(ReactMod.createElement(ChatLayout, {}));
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 400));
        });
        await dismissOnboardingIfPresent();
        await openHistory();
        const reselectButtons = rtl.screen.getAllByRole('button', { name: '用此提示词重新创作' });
        await rtl.act(async () => {
            // frequency 默认首条为高频 fixture。
            rtl.fireEvent.click(reselectButtons[0]);
            await new Promise((r) => setTimeout(r, 1800));
        });
        assert.strictEqual(rtl.screen.queryByRole('dialog'), null, '选择后 History 必须关闭');
        assert.strictEqual(useChatStore.getState().pendingAutoSend, null, 'pending 必须被消费');
        const messages = useChatStore.getState().messages;
        assert.ok(!messages.some((m) => m.content === '旧上下文-M407'), '旧 Chat 必须按 clean-creation reset');
        const userAttempts = messages.filter((m) => m.role === 'user' && m.content === '提示词-高频-M407');
        assert.strictEqual(userAttempts.length, 1, 'P 只提交一次（1 个新 user attempt）');
        const assistantAttempts = messages.filter((m) => m.role === 'assistant');
        assert.strictEqual(assistantAttempts.length, 1, '只产生 1 个新 assistant attempt');
        assert.strictEqual(agentInteractCalls, 1, 'generation request 必须恰为 1（非 inputValue 断言）');
        renderResult.unmount();
        resetBaseline();
    }
    console.log('PASS: M4-07-05 idle exactly-once');

    console.log('=== M4-07-06: Sending-time prompt queue (blocking) ===');
    {
        resetBaseline();
        seedPromptFixtures();
        useChatStore.getState().dispatch({ type: 'user.submit', content: '进行中-A-M407' });
        const renderResult = rtl.render(ReactMod.createElement(ChatLayout, {}));
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 500));
        });
        const attemptA = useChatStore.getState().messages.find((m) => m.content === '进行中-A-M407');
        assert.ok(attemptA, 'Attempt A 必须存在');
        // 先选 A fixture 再选高频 fixture：单 slot 覆盖语义。
        await openHistory();
        const reselect = (): Element[] =>
            rtl.screen.getAllByRole('button', { name: '用此提示词重新创作' });
        await rtl.act(async () => {
            rtl.fireEvent.click(reselect()[2]);
            await new Promise((r) => setTimeout(r, 100));
        });
        assert.strictEqual(useChatStore.getState().pendingAutoSend, '提示词-低频旧-M407', '首次选择进入 pending');
        await openHistory();
        await rtl.act(async () => {
            rtl.fireEvent.click(
                rtl.screen.getAllByRole('button', { name: '用此提示词重新创作' })[0],
            );
            await new Promise((r) => setTimeout(r, 100));
        });
        // 选择瞬间断言：A 不 abort、不 reset；B 未发送。
        const during = useChatStore.getState().messages;
        assert.ok(during.some((m) => m.content === '进行中-A-M407'), 'A 仍存在（不 reset）');
        assert.ok(
            during.some((m) => m.role === 'assistant' && m.status === 'sending'),
            'A 仍为 sending（不 abort）',
        );
        assert.strictEqual(agentInteractCalls, 0, 'B 未发送');
        assert.strictEqual(useChatStore.getState().pendingAutoSend, '提示词-高频-M407', '最后一个选择覆盖（pending=B）');
        // A 正常 terminal。
        await rtl.act(async () => {
            useChatStore.getState().dispatch({
                type: 'stream.finish',
                payload: { type: 'done', finishReason: 'stop' },
            });
            await new Promise((r) => setTimeout(r, 1800));
        });
        assert.strictEqual(useChatStore.getState().pendingAutoSend, null, 'terminal 后 B 消费一次');
        const after = useChatStore.getState().messages;
        assert.ok(!after.some((m) => m.content === '进行中-A-M407'), '消费时 clean creation 开始（旧链已 reset）');
        assert.strictEqual(
            after.filter((m) => m.role === 'user' && m.content === '提示词-高频-M407').length,
            1,
            'B 恰好提交一次',
        );
        assert.strictEqual(agentInteractCalls, 1, 'B 的 generation request 恰为 1');
        renderResult.unmount();
        resetBaseline();
    }
    console.log('PASS: M4-07-06 sending queue');

    console.log('=== M4-07-07: Same-page consumer regression (no router) ===');
    {
        resetBaseline();
        for (const rel of [
            'app/(main)/chat/components/HistoryPanel/index.tsx',
            'app/(main)/chat/components/HistoryRecords/index.tsx',
            'app/(main)/chat/components/GenerationHistory/index.tsx',
            'app/(main)/chat/components/HistoryList/index.tsx',
        ]) {
            const source = readSource(rel);
            assert.ok(!source.includes('useRouter'), `${rel} 不得 import useRouter`);
            assert.ok(!source.includes('next/navigation'), `${rel} 不得 import next/navigation`);
            assert.ok(!source.includes("router.push('/chat')"), `${rel} 不得 router.push('/chat')`);
        }
        const layoutSource = readSource('app/(main)/chat/components/ChatLayout/index.tsx');
        assert.ok(layoutSource.includes('pendingAutoSend'), 'ChatLayout 必须显式订阅 pendingAutoSend');
        // 当前已在 /chat：直接 setPendingAutoSend 仍自动触发（不依赖 router 再挂载）。
        const renderResult = rtl.render(ReactMod.createElement(ChatLayout, {}));
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 400));
        });
        await dismissOnboardingIfPresent();
        await rtl.act(async () => {
            useChatStore.getState().setPendingAutoSend('同页消费-P-M407');
            await new Promise((r) => setTimeout(r, 1800));
        });
        assert.strictEqual(useChatStore.getState().pendingAutoSend, null, '同页 pending 必须被消费');
        assert.ok(
            useChatStore.getState().messages.some((m) => m.role === 'user' && m.content === '同页消费-P-M407'),
            '同页消费必须产生新 user attempt',
        );
        assert.strictEqual(agentInteractCalls, 1, '同页消费 generation 恰一次');
        renderResult.unmount();
        resetBaseline();
    }
    console.log('PASS: M4-07-07 same-page consumer');

    console.log('=== M4-07-08: Generation History parity (legacy replay untouched) ===');
    {
        resetBaseline();
        seedGenerationFixtures();
        const generationSource = readSource('app/(main)/chat/components/GenerationHistory/index.tsx');
        assert.ok(generationSource.includes('replayGeneration(record)'), '回放必须仍只调用现有 replayGeneration(record)');
        assert.ok(generationSource.includes('useGenerationHistoryStore'), '数据源必须仍为 useGenerationHistoryStore');
        const renderResult = rtl.render(ReactMod.createElement(ChatLayout, {}));
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 400));
        });
        await dismissOnboardingIfPresent();
        await openHistory();
        await rtl.act(async () => {
            rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: '生成历史' }));
            await new Promise((r) => setTimeout(r, 100));
        });
        // prompt / excerpt / date 展示。
        assert.ok(rtl.screen.getByText('生成-G1-M407'), '必须展示 prompt');
        assert.ok(
            rtl.screen.getByText(/生成正文-G1-M407/),
            '必须展示 excerpt',
        );
        const expectedDate = new Date('2026-09-11T10:00:00.000Z').toLocaleDateString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
        assert.ok(rtl.screen.getByText(expectedDate), '必须展示 createdAt 日期');
        const messagesBefore = JSON.stringify(useChatStore.getState().messages);
        // 删除仍调用现有 remove（syncEnabled=false 时本地乐观删 + 桩服务端）。
        await rtl.act(async () => {
            rtl.fireEvent.click(rtl.screen.getByRole('button', { name: '删除此历史' }));
            await new Promise((r) => setTimeout(r, 100));
        });
        assert.strictEqual(useGenerationHistoryStore.getState().records.length, 0, '删除必须落到真实 store');
        assert.strictEqual(generationRemoveCount, 1, '删除仍调用现有 remove 穿透');
        assert.strictEqual(JSON.stringify(useChatStore.getState().messages), messagesBefore, '不得改变 chatStore.messages');
        assert.strictEqual(agentInteractCalls, 0, '不得产生 generation');
        assert.strictEqual(generationRecordCount, 0, '不得产生新生成记录');
        renderResult.unmount();
        resetBaseline();
    }
    console.log('PASS: M4-07-08 generation parity');

    console.log('=== M4-07-09: Open/close is data-pure (no self init) ===');
    {
        resetBaseline();
        seedPromptFixtures();
        seedGenerationFixtures();
        for (const rel of [
            'app/(main)/chat/components/HistoryPanel/index.tsx',
            'app/(main)/chat/components/HistoryRecords/index.tsx',
            'app/(main)/chat/components/GenerationHistory/index.tsx',
            'app/(main)/chat/components/HistoryList/index.tsx',
            'app/(main)/chat/components/ChatLayout/index.tsx',
            'app/(main)/chat/components/ChatLayout/InputArea.tsx',
        ]) {
            const source = readSource(rel);
            assert.ok(!source.includes('initForUser'), `${rel} 禁止自初始化 initForUser`);
            assert.ok(!source.includes('fetchMyPromptHistory'), `${rel} 禁止直调 fetchMyPromptHistory`);
            assert.ok(!source.includes('fetchMyGenerations'), `${rel} 禁止直调 fetchMyGenerations`);
            assert.ok(!source.includes('fetchMyConversation'), `${rel} 禁止直调 fetchMyConversation`);
            assert.ok(!source.includes('saveMyConversation'), `${rel} 禁止直调 saveMyConversation`);
        }
        const renderResult = rtl.render(ReactMod.createElement(ChatLayout, {}));
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 400));
        });
        await dismissOnboardingIfPresent();
        const messagesBefore = JSON.stringify(useChatStore.getState().messages);
        // open → tab switch → close → reopen 序列。
        await openHistory();
        await rtl.act(async () => {
            rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: '生成历史' }));
            await new Promise((r) => setTimeout(r, 100));
        });
        await rtl.act(async () => {
            rtl.fireEvent.click(rtl.screen.getByRole('tab', { name: '提示词历史' }));
            await new Promise((r) => setTimeout(r, 100));
        });
        await closeHistory();
        await openHistory();
        await closeHistory();
        assert.strictEqual(chatFetchCount, 0, '不得 fetchMyConversation');
        assert.strictEqual(chatSaveCount, 0, '不得 saveMyConversation');
        assert.strictEqual(promptFetchCount, 0, '不得 fetchMyPromptHistory');
        assert.strictEqual(generationFetchCount, 0, '不得 fetchMyGenerations');
        assert.strictEqual(generationRecordCount, 0, '不得 library.create 系写入');
        assert.strictEqual(agentInteractCalls, 0, '不得 generation request');
        assert.strictEqual(promptRecordCount + promptRemoveCount, 0, '开关不得写 prompt 历史');
        assert.strictEqual(JSON.stringify(useChatStore.getState().messages), messagesBefore, '序列不得改 messages');
        renderResult.unmount();
        resetBaseline();
    }
    console.log('PASS: M4-07-09 data-pure');

    console.log('=== M4-07-10: M4-06 codec integrity ===');
    {
        resetBaseline();
        for (const rel of [
            'app/(main)/chat/components/HistoryPanel/index.tsx',
            'app/(main)/chat/components/HistoryRecords/index.tsx',
            'app/(main)/chat/components/GenerationHistory/index.tsx',
            'app/(main)/chat/components/HistoryList/index.tsx',
            'app/(main)/chat/components/ChatLayout/index.tsx',
            'app/(main)/chat/components/ChatLayout/InputArea.tsx',
        ]) {
            const source = readSource(rel);
            assert.ok(!source.includes('chatArtifactHistory'), `${rel} 不得 import chatArtifactHistory`);
            assert.ok(!source.includes('rehydrateServerMessages'), `${rel} 不得碰 rehydrateServerMessages`);
            assert.ok(!source.includes('serializePartsForHistory'), `${rel} 不得碰 serializePartsForHistory`);
            assert.ok(!source.includes('fetchMyConversation'), `${rel} 不得碰 fetchMyConversation`);
            assert.ok(!source.includes('saveMyConversation'), `${rel} 不得碰 saveMyConversation`);
        }
        // M4-06 codec 行为子集（静态守卫之外，证明冻结语义原样成立）。
        const historyModule = nodeRequire('../../../lib/client/chatArtifactHistory') as {
            rehydrateMessageFromHistory: (dto: unknown) => {
                parts?: Array<{ type: string; artifact?: { status: string } }>;
            };
        };
        const rehydrate = historyModule.rehydrateMessageFromHistory;
        const artifactDto = (messageId: string, artifact: Record<string, unknown>): unknown => ({
            messageId,
            role: 'assistant',
            content: String(artifact.storyText ?? ''),
            parts: [{ type: 'storyArtifact', artifact: JSON.parse(JSON.stringify(artifact)) }],
            createdAt: NOW,
        });
        const statusOf = (dto: unknown): string | undefined => {
            const msg = rehydrate(dto);
            return msg.parts?.find((p) => p.type === 'storyArtifact')?.artifact?.status;
        };
        const base = (status: string): Record<string, unknown> => ({
            id: 'artifact-x',
            artifactType: 'story',
            status,
            sourceMessageId: 'assistant-x',
            storyText: '正文-M407',
            title: '标题',
            prompt: 'prompt',
            voiceId: 'voice',
            createdAt: NOW,
            updatedAt: NOW,
        });
        assert.strictEqual(
            statusOf(artifactDto('assistant-x', { ...base('promoting'), id: 'artifact-assistant-x' })),
            'promotion_failed',
            'M4-06 冻结：promoting reload → promotion_failed',
        );
        assert.strictEqual(
            statusOf(artifactDto('assistant-x', { ...base('complete'), id: 'artifact-assistant-x' })),
            'promotion_failed',
            'M4-06 冻结：complete reload → promotion_failed',
        );
        assert.strictEqual(
            statusOf(artifactDto('assistant-x', { ...base('draft'), id: 'artifact-assistant-x' })),
            'interrupted',
            'M4-06 冻结：draft reload → interrupted',
        );
        assert.ok(
            fs.existsSync(path.join(repoRoot, 'tests/unit/creation-chat/artifact-history-rehydration.unit.test.ts')),
            'M4-06 targeted suite 必须保留（全门原样通过）',
        );
    }
    console.log('PASS: M4-07-10 codec integrity');

    console.log('=== M4-07-11: Legacy / ownership purity ===');
    {
        resetBaseline();
        const generationSource = readSource('app/(main)/chat/components/GenerationHistory/index.tsx');
        assert.ok(!generationSource.includes('StoryWork'), 'GenerationHistory 不得碰 StoryWork');
        assert.ok(!generationSource.includes('storyArtifact'), 'GenerationHistory record 不得转 StoryArtifact');
        assert.ok(!generationSource.includes('library'), 'GenerationHistory 不得碰 library');
        const recordsSource = readSource('app/(main)/chat/components/HistoryRecords/index.tsx');
        assert.ok(!recordsSource.includes('ChatMessage'), 'prompt record 不得转 ChatMessage');
        assert.ok(!recordsSource.includes('storyArtifact'), 'prompt record 不得碰 StoryArtifact');
        assert.ok(!recordsSource.includes('StoryWork'), 'prompt record 不得碰 StoryWork');
        assert.ok(
            fs.existsSync(path.join(repoRoot, 'app/(main)/chat/components/MessageParts/StoryCardPart.tsx')),
            'storyCard renderer 必须保留（relocation 不授予 deletion 权）',
        );
        const messagePartsSource = readSource('app/(main)/chat/components/MessageParts/index.tsx');
        assert.ok(messagePartsSource.includes('storyCard'), 'storyCard 分发分支必须保留');
        assert.ok(messagePartsSource.includes('storyArtifact'), 'StoryArtifact 分支必须保留且与 storyCard 分家');
    }
    console.log('PASS: M4-07-11 ownership purity');

    console.log('=== M4-07-12: Architecture + ownership guards ===');
    {
        resetBaseline();
        const playerSource = readSource('app/(main)/player/index.tsx');
        for (const owned of ['HistoryPanel', 'HistoryRecords', 'GenerationHistory', 'HistoryList']) {
            assert.ok(!playerSource.includes(owned), `Player 不得拥有 ${owned} implementation`);
        }
        for (const rel of [
            'app/(main)/chat/components/HistoryPanel/index.tsx',
            'app/(main)/chat/components/HistoryRecords/index.tsx',
            'app/(main)/chat/components/GenerationHistory/index.tsx',
            'app/(main)/chat/components/HistoryList/index.tsx',
        ]) {
            const source = readSource(rel);
            for (const forbidden of [
                'libraryClient',
                'chatArtifactHistory',
                'storyArtifactPromotion',
                'chatPromotionOrchestration',
                'chatConversation',
                'prisma',
                'lib/server',
                'lib/db',
            ]) {
                assert.ok(!source.includes(forbidden), `${rel} 不得出现 ${forbidden}`);
            }
        }
        const panelSource = readSource('app/(main)/chat/components/HistoryPanel/index.tsx');
        assert.ok(panelSource.includes('onSelectPrompt'), 'HistoryPanel 契约必须含 onSelectPrompt');
        assert.ok(panelSource.includes('onClose'), 'HistoryPanel 契约必须含 onClose');
        assert.ok(!panelSource.includes('beginChatStream'), 'HistoryPanel 不得 direct beginChatStream');
        assert.ok(!panelSource.includes('resetStoryFlow'), 'HistoryPanel 不得 direct resetStoryFlow');
        assert.ok(!panelSource.includes('handleSubmit'), 'HistoryPanel 不得直接 handleSubmit（防双发）');
        assert.ok(!panelSource.includes('useChatStore'), 'HistoryPanel 不得直连 chatStore（pending 写由适配器接管）');
        assert.ok(!panelSource.includes('.setPendingAutoSend('), 'HistoryPanel 不得调用 setPendingAutoSend');
        assert.ok(!panelSource.includes("router.push"), 'HistoryPanel 不得 router.push');
        const layoutSource = readSource('app/(main)/chat/components/ChatLayout/index.tsx');
        assert.ok(layoutSource.includes('setPendingAutoSend'), 'ChatLayout 适配器必须写 pending');
        assert.ok(layoutSource.includes('historyOpen'), 'ChatLayout 必须持有 historyOpen 纯 UI state');
        assert.ok(layoutSource.includes('useState(false)'), 'historyOpen 必须为 useState 纯 UI state');
        assert.ok(!layoutSource.includes('useRouter'), 'ChatLayout History 接线不得依赖 router 回 Chat');
        assert.ok(layoutSource.includes('leftSlot'), 'History trigger 必须走 Composer leftSlot');
        const composerSource = readSource('app/(main)/chat/components/Composer/Composer.tsx');
        assert.ok(composerSource.includes('leftSlot'), 'Composer leftSlot 契约保持（本项不改 Composer）');
        const { resolveMainTabKey } = nodeRequire('../../../lib/navigation/mainNavigation') as {
            resolveMainTabKey: (p: string) => string;
        };
        assert.strictEqual(resolveMainTabKey('/player'), 'library', 'M1 compatibility mapping 不改');
    }
    console.log('PASS: M4-07-12 architecture guards');

    console.log('\nALL HISTORY UI RELOCATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runHistoryUiRelocationTests()
    .then(() => {
        console.log('ALL HISTORY UI RELOCATION TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('History UI relocation test failed:', error);
        process.exit(1);
    });

export default testPromise;
