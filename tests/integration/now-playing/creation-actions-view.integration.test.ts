import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：M7-04-03 Creation Actions Boundary 集成（L2）：真实 Session/Transport/UI +
// Expanded 真实渲染。锁定 spec §37/§36.2：Draft 返回创作点击先关后导 /chat 且
// Session/Transport/Audio 同一性（不暂停播放）+ 零自动发送证据；Work 面继续创作
// 不存在且返回创作不存在；空态 fail-closed。DB 不触持久化但按 runner 归类走隔离建库。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
const repoRoot: string = process.cwd();

type JitiInstance = (id: string) => Record<string, unknown>;
type JitiFactory = (base: string, opts: Record<string, unknown>) => JitiInstance;

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
                }
            );
            (m as unknown as { exports: unknown }).exports = proxy;
        };
        extTable['.scss'] = scssStub as (m: NodeModule, f: string) => void;
        extTable['.css'] = scssStub as (m: NodeModule, f: string) => void;
    }
}

function setupJsdomIfNeeded(): void {
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        return;
    }
    const { JSDOM } = nodeRequire('jsdom') as unknown as {
        JSDOM: new (html: string, opts?: Record<string, unknown>) => { window: Record<string, unknown> };
    };
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://localhost/',
        pretendToBeVisual: true,
    });
    const win = dom.window as unknown as Record<string, unknown>;
    const g = globalThis as unknown as Record<string, unknown>;
    for (const key of ['window', 'document', 'navigator']) {
        try {
            Object.defineProperty(g, key, { value: win[key === 'window' ? 'window' : key] ?? win, writable: true, configurable: true });
        } catch {
            g[key] = win;
        }
    }
    g.window = win;
    g.document = win.document;
    g.navigator = win.navigator;
    for (const key of ['HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'SVGElement', 'FocusEvent', 'PointerEvent', 'NodeFilter', 'DocumentFragment', 'HTMLDivElement', 'HTMLButtonElement', 'MutationObserver', 'Range', 'Selection', 'getComputedStyle']) {
        const v = (win as Record<string, unknown>)[key];
        if (v !== undefined) {
            try {
                Object.defineProperty(g, key, { value: v, writable: true, configurable: true });
            } catch {
                g[key] = v;
            }
        }
    }
    if (typeof (win as Record<string, unknown>).matchMedia === 'undefined') {
        (win as Record<string, unknown>).matchMedia = () => ({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
        });
    }
    if (typeof (win as Record<string, unknown>).requestAnimationFrame === 'undefined') {
        (win as Record<string, unknown>).requestAnimationFrame = (cb: () => void): unknown => setTimeout(cb, 0);
        (win as Record<string, unknown>).cancelAnimationFrame = (id: unknown): void => {
            clearTimeout(id as NodeJS.Timeout);
        };
    }
    g.requestAnimationFrame = (win as Record<string, unknown>).requestAnimationFrame as (
        cb: () => void
    ) => unknown;
    g.cancelAnimationFrame = (win as Record<string, unknown>).cancelAnimationFrame as (
        id: unknown
    ) => void;
    (g as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    try {
        const winTyped = win as unknown as Window & Record<string, unknown>;
        if (typeof winTyped.ResizeObserver === 'undefined') {
            (win as Record<string, unknown>).ResizeObserver = class {
                observe(): void {}
                unobserve(): void {}
                disconnect(): void {}
            };
        }
    } catch {}
}

const PARA1 =
    '第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。';
const PARA2 =
    '第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。它还会在洞口铺上柔软的干草。';
const STORY_2 = `${PARA1}\n${PARA2}`;
const DRAFT_SESSION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d482';
const DRAFT_MESSAGE_ID = 'msg_creation_actions_03_01';
const WORK_SESSION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

async function runCreationActionsIntegration(): Promise<void> {
    setupJsdomIfNeeded();
    installAssetStubs();

    const cache = (nodeRequire as unknown as { cache: Record<string, NodeModule> }).cache;
    const glassToastPath = path.resolve(repoRoot, 'components/ui/GlassToast.tsx');
    cache[glassToastPath] = {
        id: glassToastPath,
        filename: glassToastPath,
        loaded: true,
        exports: { default: { show: () => {}, clear: () => {} } },
    } as unknown as NodeModule;

    // next/navigation 打桩：返回创作 push 可观测（精确 /chat），其余导航同口径记录。
    const pushedUrls: string[] = [];
    const effectOrder: string[] = [];
    const mockPathname: string | null = '/chat';
    const navigationPath = (nodeRequire as unknown as { resolve: (id: string) => string }).resolve('next/navigation');
    cache[navigationPath] = {
        id: navigationPath,
        filename: navigationPath,
        loaded: true,
        exports: {
            __esModule: true,
            useRouter: () => ({
                push: (url: string) => {
                    effectOrder.push('push');
                    pushedUrls.push(url);
                },
                replace: () => {},
                prefetch: () => {},
            }),
            usePathname: () => mockPathname,
            useSearchParams: () => null,
        },
    } as unknown as NodeModule;

    const factory = nodeRequire('jiti') as unknown as JitiFactory;
    const innerJiti = factory(path.join(repoRoot, 'index.js'), {
        alias: { '@': repoRoot },
        jsx: true,
    });

    const sessionMod = innerJiti('./stores/playbackSessionStore.ts') as unknown as {
        usePlaybackSessionStore: {
            getState: () => Record<string, unknown> & {
                setActiveStory: (p: Record<string, unknown>) => void;
                setStatus: (s: string) => void;
                reset: () => void;
            };
            setState: (p: Record<string, unknown>) => void;
        };
        __resetPlaybackSessionTestHooks: () => void;
    };
    const transportMod = innerJiti('./stores/playbackStore.ts') as unknown as {
        usePlaybackStore: {
            getState: () => Record<string, unknown> & { reset: () => void };
            setState: (p: Record<string, unknown>) => void;
        };
    };
    const uiMod = innerJiti('./stores/nowPlayingUiStore.ts') as unknown as {
        useNowPlayingUiStore: {
            getState: () => Record<string, unknown> & {
                isExpanded: boolean;
                openExpanded: (t?: unknown) => void;
                closeExpanded: () => void;
            };
            setState: (p: Record<string, unknown>) => void;
        };
        __resetNowPlayingUiForTest: () => void;
    };
    const chatMod = innerJiti('./stores/chatStore.ts') as unknown as {
        useChatStore: {
            getState: () => Record<string, unknown>;
        };
    };
    const expandedMod = innerJiti('./components/NowPlaying/ExpandedNowPlaying.tsx') as unknown as {
        ExpandedNowPlaying: React.ComponentType;
    };

    const useSession = sessionMod.usePlaybackSessionStore;
    const useTransport = transportMod.usePlaybackStore;
    const useUi = uiMod.useNowPlayingUiStore;
    const useChat = chatMod.useChatStore;
    const rtl = nodeRequire('@testing-library/react') as typeof import('@testing-library/react');
    const { act } = rtl;

    const resetAll = () => {
        try {
            sessionMod.__resetPlaybackSessionTestHooks();
        } catch {}
        try {
            useSession.getState().reset();
        } catch {}
        try {
            useTransport.getState().reset();
        } catch {}
        try {
            useTransport.setState({ _tickIntervalId: null, _lastTickAt: null });
        } catch {}
        try {
            uiMod.__resetNowPlayingUiForTest();
        } catch {
            try {
                useUi.setState({ isExpanded: false, returnFocusTarget: null });
            } catch {}
        }
        pushedUrls.length = 0;
        effectOrder.length = 0;
        try {
            rtl.cleanup();
        } catch {}
        try {
            document.body.innerHTML = '';
        } catch {}
    };

    const seedDraftSession = (storyText: string = STORY_2) => {
        useSession.getState().setActiveStory({
            source: { kind: 'draft', messageId: DRAFT_MESSAGE_ID },
            sessionId: DRAFT_SESSION_ID,
            title: '草稿故事',
            storyText,
            voiceId: 'alloy',
            speed: 1.0,
        });
        useSession.getState().setStatus('paused');
        useTransport.setState({ isPlaying: false, currentTime: 5, duration: 60, playbackRate: 1.0 });
    };

    const seedWorkSession = () => {
        useSession.getState().setActiveStory({
            source: { kind: 'work', workId: 481 },
            sessionId: WORK_SESSION_ID,
            title: '月球上的小狐狸',
            storyText: STORY_2,
            voiceId: 'alloy',
            speed: 1.0,
        });
        useSession.getState().setStatus('paused');
        useTransport.setState({ isPlaying: false, currentTime: 20, duration: 100, playbackRate: 1.0 });
    };

    const renderExpanded = () => {
        let rendered: ReturnType<typeof rtl.render> | null = null;
        act(() => {
            useUi.setState({ isExpanded: true, returnFocusTarget: null });
        });
        act(() => {
            rendered = rtl.render(React.createElement(expandedMod.ExpandedNowPlaying));
        });
        return rendered as unknown as ReturnType<typeof rtl.render>;
    };

    const snapshotPlayback = () => ({
        sessionId: useSession.getState().sessionId as string | null,
        source: JSON.stringify(useSession.getState().source),
        status: useSession.getState().status as string,
        storyText: useSession.getState().storyText as string,
        isPlaying: useTransport.getState().isPlaying as boolean,
        currentTime: useTransport.getState().currentTime as number,
        audioUrl: useTransport.getState().currentAudioUrl as string | null,
    });

    const snapshotChat = () => {
        try {
            const s = useChat.getState() as unknown as Record<string, unknown>;
            const messages = s.messages as Array<unknown> | undefined;
            return {
                messageCount: Array.isArray(messages) ? messages.length : -1,
                messageJson: JSON.stringify(messages ?? null),
                inputValue: (s.inputValue as string | undefined) ?? null,
                pendingAutoSend: (s.pendingAutoSend as string | null | undefined) ?? null,
            };
        } catch {
            return { messageCount: -2, messageJson: 'unreadable', inputValue: null, pendingAutoSend: null };
        }
    };

    console.log('=== M7-04-03-I1: Draft 返回创作 → 先关后导 /chat + 播放同一性 + 零自动发送（§37） ===');
    {
        resetAll();
        seedDraftSession();
        const originalClose = useUi.getState().closeExpanded;
        act(() => {
            useUi.setState({
                closeExpanded: () => {
                    effectOrder.push('close');
                    originalClose();
                },
            });
        });
        const rendered = renderExpanded();
        // 与查看正文并存（同容器双按钮，各自独立 testid/文案）。
        const backButton = rendered.getByTestId('expanded-back-to-creation-button');
        assert.strictEqual(backButton.textContent?.includes('返回创作'), true, '返回创作文案精确');
        assert.strictEqual(rendered.getByTestId('expanded-view-transcript-button').textContent?.includes('查看正文'), true, '查看正文并存');
        assert.ok(rendered.getByTestId('expanded-actions'), '动作区容器存在');
        assert.strictEqual(rendered.queryByTestId('expanded-continue-creation-button'), null, 'Draft 面无继续创作');
        const before = snapshotPlayback();
        const audioCountBefore = document.querySelectorAll('audio').length;
        const chatBefore = snapshotChat();
        act(() => {
            backButton.click();
        });
        assert.deepStrictEqual(effectOrder, ['close', 'push'], '顺序固定：close 先于 push（§44）');
        assert.deepStrictEqual(pushedUrls, ['/chat'], 'push 精确 /chat（唯一导航）');
        assert.strictEqual(useUi.getState().isExpanded as boolean, false, 'Expanded 已关闭');
        assert.deepStrictEqual(snapshotPlayback(), before, '播放继续：Session/Transport/Audio 同一性（不暂停）');
        assert.strictEqual(document.querySelectorAll('audio').length, audioCountBefore, 'Host 不重挂');
        // 零自动发送证据：chat 消息/输入/预填全不变 + 无额外导航。
        assert.deepStrictEqual(snapshotChat(), chatBefore, '零自动发送：chatStore 消息/输入/pendingAutoSend 全不变');
        const observedUrls: string[] = [...pushedUrls];
        assert.strictEqual(observedUrls.length, 1, '仅一次导航（无预填即发式二次导航）');
        for (const url of observedUrls) {
            assert.ok(!url.includes('fake') && !url.includes('undefined') && !url.includes('null'), `非法目标：${url}`);
        }
        act(() => {
            useUi.setState({ closeExpanded: originalClose });
        });
        rendered.unmount();
        console.log('PASS: M7-04-03-I1 draft back-to-creation close-push-chat');
    }

    console.log('=== M7-04-03-I2: Work 面继续创作不存在 + 返回创作不存在（§36.2 fail-closed） ===');
    {
        resetAll();
        seedWorkSession();
        const rendered = renderExpanded();
        assert.ok(rendered.getByTestId('expanded-view-story-button'), 'Work 查看正文回归存在');
        assert.strictEqual(rendered.queryByTestId('expanded-continue-creation-button'), null, 'Work 继续创作 CTA 隐藏（fail-closed）');
        assert.strictEqual(rendered.queryByTestId('expanded-back-to-creation-button'), null, 'Work 面无返回创作（Draft 专属）');
        const zone = rendered.getByTestId('expanded-actions');
        const buttons = zone.querySelectorAll('button');
        assert.strictEqual(buttons.length, 1, 'Work 动作区仅查看正文一个按钮（继续隐藏不占位）');
        assert.strictEqual(buttons[0]?.getAttribute('data-testid'), 'expanded-view-story-button');
        // Work 查看正文仍先关后导精确目标（01 冻结回归），且不误导 /chat。
        const before = snapshotPlayback();
        act(() => {
            rendered.getByTestId('expanded-view-story-button').click();
        });
        assert.deepStrictEqual(pushedUrls, ['/library/481'], 'Work 导航仍精确（未被创作面污染）');
        assert.strictEqual(useUi.getState().isExpanded as boolean, false);
        assert.deepStrictEqual(snapshotPlayback(), before, 'Work 导航播放继续');
        rendered.unmount();
        console.log('PASS: M7-04-03-I2 work continue hidden');
    }

    console.log('=== M7-04-03-I3: 空正文 Draft 仍可返回创作（与 Transcript 口解耦） ===');
    {
        resetAll();
        seedDraftSession('');
        const rendered = renderExpanded();
        // 空正文时 Transcript 口隐藏，但返回创作仍展示（返回创作不依赖 storyText）。
        assert.strictEqual(rendered.queryByTestId('expanded-view-transcript-button'), null, '空正文无查看正文（02 fail-closed 保留）');
        const backButton = rendered.getByTestId('expanded-back-to-creation-button');
        assert.strictEqual(backButton.textContent?.includes('返回创作'), true, '空正文仍可返回创作');
        const before = snapshotPlayback();
        const chatBefore = snapshotChat();
        act(() => {
            backButton.click();
        });
        assert.deepStrictEqual(pushedUrls, ['/chat'], '空正文返回创作同样先关后导 /chat');
        assert.strictEqual(useUi.getState().isExpanded as boolean, false);
        assert.deepStrictEqual(snapshotPlayback(), before, '播放同一性');
        assert.deepStrictEqual(snapshotChat(), chatBefore, '零自动发送');
        rendered.unmount();
        console.log('PASS: M7-04-03-I3 empty-draft back decouples transcript');
    }

    console.log('=== M7-04-03-I4: idle/空会话 fail-closed（无创作 CTA、无导航） ===');
    {
        resetAll();
        seedDraftSession();
        act(() => {
            useSession.getState().setStatus('idle');
        });
        const rendered = renderExpanded();
        assert.strictEqual(rendered.queryByTestId('expanded-back-to-creation-button'), null, 'idle 无返回创作');
        assert.strictEqual(rendered.queryByTestId('expanded-continue-creation-button'), null, 'idle 无继续创作');
        assert.deepStrictEqual(pushedUrls, [], 'idle 零导航');
        rendered.unmount();
        console.log('PASS: M7-04-03-I4 idle fail-closed');
    }

    resetAll();
    try {
        delete cache[navigationPath];
    } catch {}
    console.log('\nALL CREATION ACTIONS INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runCreationActionsIntegration()
    .then(() => {
        console.log('ALL CREATION ACTIONS INTEGRATION TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Creation actions integration test failed:', error);
        process.exit(1);
    });

export default testPromise;
