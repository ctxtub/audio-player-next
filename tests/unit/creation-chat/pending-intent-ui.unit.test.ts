import assert from 'node:assert';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：NodeRequire 兼容取值（jiti 运行器下 require 可能未全局暴露）。
const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
// 中文注释：jsdom 最小形态（无 @types/jsdom，经 require 加载，避免新增类型依赖）。
type JSDOMWindowLike = Record<string, unknown>;
type JSDOMLike = { window: JSDOMWindowLike };
type JSDOMCtorLike = new (html: string, opts?: Record<string, unknown>) => JSDOMLike;
// 中文注释：仓库根目录，用于 inner-jiti 的 alias 解析。
const repoRoot: string = process.cwd();
// 中文注释：inner-jiti 实例与工厂类型（解析真实 .tsx 组件，需 jsx:true）。
type JitiInstance = (id: string) => Record<string, unknown>;
type JitiFactory = (base: string, opts: Record<string, unknown>) => JitiInstance;
// 中文注释：真实 GlassToast 最小形态（spy 包装后仍委托真实渲染）。
type ToastCall = { icon?: string; content?: string };
type RealToast = {
    show: (config: { icon?: string; content: string }) => void;
    clear: () => void;
};
// 中文注释：chatStore 最小形态（仅 consultation 本测试用到的字段与动作）。
type ChatStoreLike = {
    getState: () => {
        messages: Array<{ role: string; content?: string; status?: string }>;
        inputValue: string;
        pendingAutoSend: string | null;
        dispatch: (action: unknown) => void;
        setInputValue: (v: string) => void;
        setPendingAutoSend: (v: string | null) => void;
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
                    // 中文注释：Next StaticImageData 形态（next/image 需 width/height，否则抛缺属性）。
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
    // 中文注释：window 自指需特殊处理，其余按名拷贝。
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

/**
 * 预置网络边界桩（inner-jiti 共享 require.cache，预置后真实 ChatLayout/chatFlow 走桩网络、不触真实后端）。
 * 仅桩边界（agentFlow/chatConversation），组件与 store 均为真实实现。
 */
function stubNetworkBoundary(): void {
    const agentFlowPath = path.resolve(repoRoot, 'app/services/agentFlow.ts');
    const chatConversationPath = path.resolve(repoRoot, 'lib/client/chatConversation.ts');
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
                callbacks.onIntentDetected?.('Chat');
                callbacks.onTextDelta('桩外真实链路问答正文');
                callbacks.onComplete();
            },
            summarizeContext: async () => '桩摘要',
        },
    } as unknown as NodeModule;
    cache[chatConversationPath] = {
        id: chatConversationPath,
        filename: chatConversationPath,
        loaded: true,
        exports: {
            fetchMyConversation: async () => [],
            saveMyConversation: async () => ({ ok: true }),
        },
    } as unknown as NodeModule;
}

async function runPendingIntentUiTests(): Promise<void> {
    setupJsdom();
    installAssetStubs();
    stubNetworkBoundary();
    const factory = nodeRequire('jiti') as unknown as JitiFactory;
    const innerJiti = factory(path.join(repoRoot, 'index.js'), {
        alias: { '@': repoRoot },
        jsx: true,
    });
    // 中文注释：经 inner-jiti 加载真实模块（同一实例，共享同一 Zustand store，避免双实例割裂）。
    const chatStoreMod = innerJiti('./stores/chatStore.ts') as unknown as {
        useChatStore: ChatStoreLike;
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
    const useChatStore = chatStoreMod.useChatStore;
    const GlassToast = toastMod.default;
    const ChatLayout = layoutMod.default;
    // 中文注释：React 运行时（native 与 jiti 产物共享同一实例）。
    const ReactMod = nodeRequire('react') as typeof React;
    const rtl = nodeRequire('@testing-library/react') as typeof import('@testing-library/react');
    // 中文注释：toast 调用观测（包装真实 show，仍走真实 createRoot 渲染，不断言桩）。
    const toastCalls: ToastCall[] = [];
    const originalShow = GlassToast.show.bind(GlassToast);
    GlassToast.show = (config: { icon?: string; content: string }): void => {
        toastCalls.push({ icon: config.icon, content: config.content });
        originalShow(config);
    };
    // 中文注释：注册最小音频控制器（ChatLayout.handleSubmit 先 ensureUnlocked，无控制器则抛错走 toast 分支）。
    playbackMod.usePlaybackStore.getState().registerAudioController({
        unlock: async (): Promise<void> => {},
        play: async (): Promise<void> => {},
        resume: async (): Promise<void> => {},
        pause: (): void => {},
        seek: (): void => {},
        setPlaybackRate: (): void => {},
    });

    /**
     * 重置聊天现场到干净基线（关闭服务端同步，避免防抖落库干扰）。
     */
    function resetBaseline(): void {
        useChatStore.getState().reset();
        useChatStore.setState({ syncEnabled: false });
        toastCalls.length = 0;
    }

    console.log('=== PENDING-00: 发送中点击接线静态锁定（真实 ChatLayout 源码）===');
    {
        // 中文注释：静态接线锁（补充行为覆盖不可达的发送中按钮分支，保留原 W2-01 语义；行为主体由 PENDING-01~03 真实渲染覆盖）。
        const source = readFileSync(path.join(repoRoot, 'app/(main)/chat/components/ChatLayout/index.tsx'), 'utf8');
        assert.ok(source.includes('正在生成，完成后自动发送'), '发送中点击必须 toast 新文案');
        assert.ok(source.includes('setInputValue(value)'), '发送中点击必须预填输入框');
        assert.ok(source.includes('setPendingAutoSend(value)'), '发送中点击必须暂存 pending');
        assert.ok(source.includes('if (isSending)'), '必须具备 isSending 守卫');
    }
    console.log('PASS: PENDING-00 发送中接线锁定');

    console.log('=== PENDING-01: 空闲点击真实推荐按钮直接预填（真实 HeaderArea+ChatLayout 接线）===');
    {
        resetBaseline();
        // 中文注释：空闲基线（无消息，HeaderArea 可见；发送中时 shouldShowHeader=false 隐藏推荐区，
        // 发送中点击经可见按钮不可达——旧仿真忽略可见性属失真，本测试如实覆盖可达路径，发送中排队由 PENDING-02 状态层覆盖）。
        const renderResult = rtl.render(ReactMod.createElement(ChatLayout, {}));
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 400));
        });
        // 中文注释：点击真实「星际冒险」推荐按钮（HeaderArea 经 GlassButton 渲染的真实 DOM）。
        const suggestion = await rtl.screen.findByText('星际冒险');
        await rtl.act(async () => {
            rtl.fireEvent.click(suggestion);
            await new Promise((r) => setTimeout(r, 100));
        });
        assert.strictEqual(
            useChatStore.getState().inputValue,
            '请讲一个温柔的星际冒险睡前故事。',
            '空闲点击必须预填输入框（真实 handleSuggestionSelect 空闲分支）',
        );
        assert.strictEqual(useChatStore.getState().pendingAutoSend, null, '空闲点击不得误设 pending');
        assert.ok(
            !toastCalls.some((c) => c.content === '正在生成，完成后自动发送'),
            '空闲点击不得弹发送中 toast',
        );
        renderResult.unmount();
        resetBaseline();
    }
    console.log('PASS: PENDING-01 真实组件空闲预填');

    console.log('=== PENDING-02: 发送中保留待发 → 生成结束消费（跨页干净会话语义）===');
    {
        resetBaseline();
        // 中文注释：制造发送中现场并到达 pending（跨页/推荐 race 同语义）。方案 A' 裁决：「发送中补发」UI 不可达
        // （推荐区仅 messages.length===0 时渲染，发送中不可见；历史面板为跨页入口无 sending 现场），故删除
        // 「同一挂载会话续聊计数」假设，保留状态机断言（发送中保留→生成结束消费恰一次）+ 跨页干净会话语义断言。
        useChatStore.getState().dispatch({ type: 'user.submit', content: '进行中的提问-重触发' });
        useChatStore.getState().setPendingAutoSend('排队待发-重触发');
        const renderResult = rtl.render(ReactMod.createElement(ChatLayout, {}));
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 500));
        });
        // 中文注释：发送中时 effect 必须跳过（保留待发，不旁路提交）。
        assert.strictEqual(
            useChatStore.getState().pendingAutoSend,
            '排队待发-重触发',
            '发送中时不得消费 pending',
        );
        // 中文注释：结束生成（真实 stream.finish），复刻 isSending 翻转后副作用重跑。
        await rtl.act(async () => {
            useChatStore.getState().dispatch({
                type: 'stream.finish',
                payload: { type: 'done', finishReason: 'stop' },
            });
            // 中文注释：等待真实 effect（含 resetStoryFlow+ensureUnlocked+桩网络 beginChatStream 全链路）。
            await new Promise((r) => setTimeout(r, 1500));
        });
        // 中文注释：PENDING-02 实况探针（方案 A' 收口实测 2026-09-10：消费后 messages 为干净新链
        // [{"role":"user","content":"排队待发-重触发","status":"delivered"},
        //  {"role":"assistant","content":"桩外真实链路问答正文","status":"delivered"}]，pending=null；
        // 旧上下文「进行中的提问-重触发」已被消费 effect 内 resetStoryFlow() 先清空，不再以计数断言续聊）。
        console.log(
            '[PENDING-02-实况]',
            JSON.stringify(
                useChatStore.getState().messages.map((m) => ({ role: m.role, content: m.content, status: m.status })),
            ),
        );
        assert.strictEqual(
            useChatStore.getState().pendingAutoSend,
            null,
            '生成结束后重触发必须消费 pending（仅一次）',
        );
        // 中文注释：跨页干净会话语义——resetStoryFlow 生效，消费后 messages 为干净链路，不含发起前旧上下文。
        assert.ok(
            !useChatStore
                .getState()
                .messages.some((m) => m.content === '进行中的提问-重触发'),
            '消费后 messages 不得含有发起前旧上下文（resetStoryFlow 已清空）',
        );
        // 中文注释：resetChat 清 messages，但 user.submit 新消息在 reset 之后 dispatch，故新 user 消息恰为本次 pending 原文 1 条。
        assert.strictEqual(
            useChatStore
                .getState()
                .messages.filter((m) => m.role === 'user' && m.content === '排队待发-重触发').length,
            1,
            '补发后应含本次提交 user 消息 1 条（reset 之后的新链）',
        );
        renderResult.unmount();
        resetBaseline();
    }
    console.log('PASS: PENDING-02 发送中保留待发→生成结束消费（跨页干净会话语义）');

    console.log('=== PENDING-03: 非发送中 pending 立即自动发送（无回归）===');
    {
        resetBaseline();
        // 中文注释：空闲到达 pending（跨页 HistoryPanel 同语义），挂载后应立即消费补发。
        useChatStore.getState().setPendingAutoSend('空闲待发-立即发送');
        const renderResult = rtl.render(ReactMod.createElement(ChatLayout, {}));
        await rtl.act(async () => {
            await new Promise((r) => setTimeout(r, 1500));
        });
        assert.strictEqual(
            useChatStore.getState().pendingAutoSend,
            null,
            '非发送中 pending 必须正常消费',
        );
        assert.ok(
            useChatStore.getState().messages.some(
                (m) => m.role === 'user' && m.content === '空闲待发-立即发送',
            ),
            '补发内容必须为 pending 原文（真实 handleSubmit 经 beginChatStream 入库）',
        );
        // 中文注释：真实链路经 user.submit 清空输入框（effect 先预填、提交后清空），与仿真桩的“保留预填”不同；
        // 以新用户消息存在 + pending 已消费为补发证据，输入框终态应为空（真实提交语义）。
        assert.strictEqual(
            useChatStore.getState().inputValue,
            '',
            '真实自动发送后输入框应被新提交清空（user.submit 语义）',
        );
        renderResult.unmount();
        resetBaseline();
    }
    console.log('PASS: PENDING-03 空闲自动发送不变');

    console.log('\nALL PENDING INTENT UI TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runPendingIntentUiTests()
    .then(() => {
        console.log('ALL PENDING INTENT UI TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Pending intent ui test failed:', error);
        process.exit(1);
    });

export default testPromise;
