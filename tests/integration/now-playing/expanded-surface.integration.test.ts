import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：M7-01 Expanded Surface 集成（L2）：真实 Session/Transport/Config/UI + MainChrome/Layer/Expanded 渲染。
// 锁定验收 1-10 的穿越切面：点击开/URL 不变/开关不改播放/suppress 恢复/导航保持/清空自关/ended 完成态/
// 响应式 resize 不重置/关闭后继续/焦点返回//player 物理保留。DB 不触持久化但按 runner 归类走隔离建库。

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

function setupJsdom(): void {
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
    try {
        Object.defineProperty(g, 'window', { value: win, writable: true, configurable: true });
    } catch {
        g.window = win;
    }
    try {
        Object.defineProperty(g, 'document', { value: win.document, writable: true, configurable: true });
    } catch {
        g.document = win.document;
    }
    try {
        Object.defineProperty(g, 'navigator', { value: win.navigator, writable: true, configurable: true });
    } catch {
        g.navigator = win.navigator;
    }
    for (const key of ['HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'SVGElement', 'FocusEvent', 'PointerEvent', 'NodeFilter', 'TreeWalker', 'Range', 'Selection', 'MutationObserver', 'DocumentFragment', 'HTMLDivElement', 'HTMLButtonElement']) {
        const v = (win as Record<string, unknown>)[key];
        if (v !== undefined) {
            try {
                Object.defineProperty(g, key, { value: v, writable: true, configurable: true });
            } catch {
                g[key] = v;
            }
        }
    }
    // RAC ariaHideOutside 需要全局 NodeFilter（jsdom 仅挂 window）。
    try {
        const nf = (win as Record<string, unknown>).NodeFilter;
        if (nf !== undefined && (g as Record<string, unknown>).NodeFilter === undefined) {
            (g as Record<string, unknown>).NodeFilter = nf;
        }
    } catch {}
    try {
        const doc = win.document as unknown as Document;
        if (typeof (g as Record<string, unknown>).getSelection === 'undefined') {
            (g as Record<string, unknown>).getSelection = () =>
                (doc as unknown as { getSelection?: () => unknown }).getSelection?.() ?? null;
        }
    } catch {}
    // RAC / drag 所需最小浏览器面（jsdom 缺省补齐，不抛错即可）。
    if (typeof (win as Record<string, unknown>).matchMedia === 'undefined') {
        (win as Record<string, unknown>).matchMedia = () => ({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
        });
    }
    if (typeof (win as Record<string, unknown>).requestAnimationFrame === 'undefined') {
        (win as Record<string, unknown>).requestAnimationFrame = (cb: () => void): unknown =>
            setTimeout(cb, 0);
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
    // getComputedStyle / scrollIntoView / ResizeObserver 最小桩（RAC focus scope 不崩）。
    try {
        const doc = win.document as unknown as Document;
        const winTyped = win as unknown as Window & Record<string, unknown>;
        if (typeof winTyped.getComputedStyle === 'undefined') {
            (win as Record<string, unknown>).getComputedStyle = () => ({
                getPropertyValue: () => '',
            });
        }
        if (typeof winTyped.ResizeObserver === 'undefined') {
            (win as Record<string, unknown>).ResizeObserver = class {
                observe(): void {}
                unobserve(): void {}
                disconnect(): void {}
            };
        }
        void doc;
    } catch {
        // ignore
    }
}

const PARA1 =
    '第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。';
const PARA2 =
    '第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。它还会在洞口铺上柔软的干草。';
const STORY_2 = `${PARA1}\n${PARA2}`;

async function runExpandedSurfaceIntegration(): Promise<void> {
    setupJsdom();
    installAssetStubs();

    const cache = (nodeRequire as unknown as { cache: Record<string, NodeModule> }).cache;

    const glassToastPath = path.resolve(repoRoot, 'components/ui/GlassToast.tsx');
    cache[glassToastPath] = {
        id: glassToastPath,
        filename: glassToastPath,
        loaded: true,
        exports: { default: { show: () => {}, clear: () => {} } },
    } as unknown as NodeModule;

    // MainTabBar 打桩：隔离 next/navigation，保留可达性（跨路由存活由 L3 覆盖）。
    const tabBarPath = path.resolve(repoRoot, 'components/MainTabBar/index.tsx');
    const ReactForStub = nodeRequire('react') as typeof React;
    cache[tabBarPath] = {
        id: tabBarPath,
        filename: tabBarPath,
        loaded: true,
        exports: {
            __esModule: true,
            default: () =>
                ReactForStub.createElement('nav', { 'data-testid': 'main-tabbar-stub' }, 'tabbar'),
        },
    } as unknown as NodeModule;

    // M7-04-01 next/navigation 打桩：Expanded 查看正文经 useRouter/usePathname
    //（L2 隔离路由上下文，useRouter 在无 Provider 时抛错；跨路由与 push 目标由 L3 覆盖）。
    const navigationPath = (nodeRequire as unknown as { resolve: (id: string) => string }).resolve('next/navigation');
    cache[navigationPath] = {
        id: navigationPath,
        filename: navigationPath,
        loaded: true,
        exports: {
            __esModule: true,
            useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
            usePathname: () => null,
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
    const configMod = innerJiti('./stores/configStore.ts') as unknown as {
        useConfigStore: {
            setState: (p: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>)) => void;
            getState: () => Record<string, unknown>;
        };
    };
    const chromeMod = innerJiti('./components/MainChrome/index.tsx') as unknown as {
        MainChrome: React.ComponentType<{ children?: React.ReactNode }>;
        default: React.ComponentType<{ children?: React.ReactNode }>;
    };

    const useSession = sessionMod.usePlaybackSessionStore;
    const useTransport = transportMod.usePlaybackStore;
    const useUi = uiMod.useNowPlayingUiStore;
    const ReactMod = nodeRequire('react') as typeof React;
    const rtl = nodeRequire('@testing-library/react') as typeof import('@testing-library/react');
    const { act } = rtl;
    const fireEvent = rtl.fireEvent;

    const setViewportWidth = (width: number) => {
        const w = window as unknown as Window & Record<string, unknown>;
        try {
            Object.defineProperty(w, 'innerWidth', { value: width, writable: true, configurable: true });
        } catch {
            (w as Record<string, unknown>).innerWidth = width;
        }
        const Evt = (window as unknown as { Event: typeof Event }).Event ?? Event;
        window.dispatchEvent(new Evt('resize'));
    };

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
        rtl.cleanup();
        try {
            document.body.innerHTML = '';
        } catch {}
    };

    const seedWorkSession = (title: string, status: string) => {
        useSession.getState().setActiveStory({
            source: { kind: 'work', workId: 481 },
            sessionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            title,
            storyText: STORY_2,
            voiceId: 'alloy',
            speed: 1.0,
        });
        if (status !== 'playing') {
            useSession.getState().setStatus(status);
        }
    };

    const renderChrome = (width: number, pageLabel = 'page') => {
        setViewportWidth(width);
        let rendered: ReturnType<typeof rtl.render> | null = null;
        act(() => {
            rendered = rtl.render(
                ReactMod.createElement(
                    chromeMod.MainChrome,
                    null,
                    ReactMod.createElement('div', { 'data-testid': 'page-stub' }, pageLabel)
                )
            );
        });
        return rendered as unknown as ReturnType<typeof rtl.render>;
    };

    const snapshotSession = () => ({
        sessionId: useSession.getState().sessionId as string | null,
        source: useSession.getState().source as unknown,
        status: useSession.getState().status as string,
        isPlaying: useTransport.getState().isPlaying as boolean,
        currentTime: useTransport.getState().currentTime as number,
        audioUrl: useTransport.getState().currentAudioUrl as string | null,
    });

    console.log('=== M7-01-I1: Mini click → Expanded，URL 不变（验收 1）===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        useTransport.setState({ isPlaying: false, currentTime: 1, duration: 10 });
        const urlBefore = window.location.href;
        const rendered = renderChrome(390);
        assert.ok(rendered.getByTestId('mini-now-playing'), 'Mini 应渲染');
        assert.strictEqual(rendered.queryByTestId('expanded-now-playing'), null, '初始 Expanded 关闭');
        assert.strictEqual(
            rendered.getByTestId('now-playing-layer').getAttribute('data-expanded'),
            'false'
        );
        act(() => {
            fireEvent.click(rendered.getByTestId('mini-metadata-button'));
        });
        assert.strictEqual(useUi.getState().isExpanded as boolean, true, '点击 Mini → isExpanded');
        assert.ok(rendered.getByTestId('expanded-now-playing'), 'Expanded 应挂载');
        assert.ok(rendered.getByTestId('expanded-close-button'), '关闭按钮应存在');
        assert.ok(rendered.getByTestId('expanded-drag-handle'), 'Handle 应存在');
        assert.strictEqual(window.location.href, urlBefore, 'URL 必须不变（Expanded 非 route）');
        assert.ok(
            !window.location.pathname.includes('/player') || window.location.pathname === '/',
            '不得 push /player'
        );
        rendered.unmount();
        console.log('PASS: M7-01-I1 click opens without navigation');
    }

    console.log('=== M7-01-I2: open/close 不触发 play/pause/new Session（验收 2/8）===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        useTransport.setState({ isPlaying: false, currentTime: 2, duration: 10 });
        const rendered = renderChrome(390);
        const before = snapshotSession();
        act(() => {
            fireEvent.click(rendered.getByTestId('mini-metadata-button'));
        });
        const afterOpen = snapshotSession();
        assert.deepStrictEqual(afterOpen, before, 'open 不得改变 Session/Transport');
        act(() => {
            fireEvent.click(rendered.getByTestId('expanded-close-button'));
        });
        // focus return 为 rAF 异步，等待一帧后再断言终态。
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        assert.strictEqual(useUi.getState().isExpanded as boolean, false, 'close 后应关闭');
        const afterClose = snapshotSession();
        assert.deepStrictEqual(afterClose, before, 'close 不得暂停/新建 Session（播放继续）');
        rendered.unmount();
        console.log('PASS: M7-01-I2 open/close pure');
    }

    console.log('=== M7-01-I3: Expanded open → Mini suppressed；close → 恢复（验收 3）===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        const rendered = renderChrome(390);
        assert.ok(rendered.getByTestId('mini-now-playing'), 'open 前 Mini 可见');
        act(() => {
            fireEvent.click(rendered.getByTestId('mini-metadata-button'));
        });
        assert.strictEqual(
            rendered.queryByTestId('mini-now-playing'),
            null,
            'open 后 Mini suppressed（presentation 隐藏）'
        );
        assert.strictEqual(
            rendered.getByTestId('main-chrome').getAttribute('data-mini-visible'),
            'false'
        );
        // Session 仍在（suppress 不改变 Session）。
        assert.ok((useSession.getState().source as unknown) !== null, 'suppress 后 source 仍在');
        act(() => {
            fireEvent.click(rendered.getByTestId('expanded-close-button'));
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        assert.ok(rendered.getByTestId('mini-now-playing'), 'close 后 Mini 恢复');
        assert.strictEqual(
            rendered.getByTestId('main-chrome').getAttribute('data-mini-visible'),
            'true'
        );
        rendered.unmount();
        console.log('PASS: M7-01-I3 suppress/restore');
    }

    console.log('=== M7-01-I4: 普通导航后仍 open（验收 4，spec §44）===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        const rendered = renderChrome(390, 'chat-page');
        act(() => {
            fireEvent.click(rendered.getByTestId('mini-metadata-button'));
        });
        assert.ok(rendered.getByTestId('expanded-now-playing'), '导航前 open');
        // 模拟 /chat → /library：同一 MainChrome 重渲染不同 children（Global Layer 不卸载）。
        act(() => {
            rendered.rerender(
                ReactMod.createElement(
                    chromeMod.MainChrome,
                    null,
                    ReactMod.createElement('div', { 'data-testid': 'page-stub' }, 'library-page')
                )
            );
        });
        assert.ok(
            rendered.getByTestId('expanded-now-playing'),
            '普通导航后 Expanded 仍 open（不属于 route）'
        );
        assert.strictEqual(useUi.getState().isExpanded as boolean, true);
        rendered.unmount();
        console.log('PASS: M7-01-I4 navigation persists');
    }

    console.log('=== M7-01-I5: Session clear → 自动关闭；ended 保持完成态（验收 5/6）===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        let rendered = renderChrome(390);
        act(() => {
            fireEvent.click(rendered.getByTestId('mini-metadata-button'));
        });
        assert.ok(rendered.getByTestId('expanded-now-playing'), 'clear 前 open');
        await act(async () => {
            useSession.getState().reset();
        });
        // Layer effect 为 useEffect，等待提交。
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        assert.strictEqual(
            useUi.getState().isExpanded as boolean,
            false,
            'source null + idle → 自动关闭'
        );
        rendered.unmount();

        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        // 置 ended 尾锚（与 M6-02-I4 同口径）。
        const total = (useSession.getState() as unknown as { totalParagraphs: number }).totalParagraphs;
        act(() => {
            useSession.setState({
                status: 'ended',
                lastCompletedParagraphIndex: total - 1,
                nextParagraphIndex: total,
            });
        });
        rendered = renderChrome(390);
        act(() => {
            fireEvent.click(rendered.getByTestId('mini-metadata-button'));
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
        assert.strictEqual(useUi.getState().isExpanded as boolean, true, 'ended 不自动关闭');
        assert.ok(rendered.getByTestId('expanded-now-playing'), 'ended 仍挂载');
        assert.ok(rendered.getByTestId('expanded-ended-badge'), 'ended 显示完成态徽标');
        assert.strictEqual(
            rendered.getByTestId('expanded-now-playing').getAttribute('data-ended'),
            'true'
        );
        rendered.unmount();
        console.log('PASS: M7-01-I5 auto-close + ended');
    }

    console.log('=== M7-01-I6: resize 时 isExpanded 不变（验收 7）===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        const rendered = renderChrome(390);
        act(() => {
            fireEvent.click(rendered.getByTestId('mini-metadata-button'));
        });
        assert.strictEqual(useUi.getState().isExpanded as boolean, true, '390 open');
        act(() => {
            setViewportWidth(900);
        });
        assert.strictEqual(useUi.getState().isExpanded as boolean, true, 'resize 900 仍 open');
        assert.ok(rendered.getByTestId('expanded-now-playing'), 'resize 后仍挂载（CSS 切 Sheet/Panel）');
        act(() => {
            setViewportWidth(390);
        });
        assert.strictEqual(useUi.getState().isExpanded as boolean, true, '回 390 仍 open');
        rendered.unmount();
        console.log('PASS: M7-01-I6 resize persists');
    }

    console.log('=== M7-01-I7: 焦点返回 + /player 物理保留（验收 9/10）===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        const rendered = renderChrome(390);
        const trigger = rendered.getByTestId('mini-metadata-button') as unknown as HTMLElement;
        act(() => {
            trigger.focus();
        });
        assert.strictEqual(document.activeElement, trigger, '前置：trigger 聚焦');
        act(() => {
            fireEvent.click(trigger);
        });
        // 打开后焦点应进 Expanded（关闭按钮 autoFocus；RAC focus scope 可能异步，宽松断言）。
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
        });
        const activeAfterOpen = document.activeElement as unknown as HTMLElement | null;
        const withinExpanded =
            activeAfterOpen !== null &&
            (activeAfterOpen.getAttribute?.('data-testid') === 'expanded-close-button' ||
                (activeAfterOpen.closest?.('[data-testid="expanded-now-playing"]') as unknown) !== null);
        assert.ok(withinExpanded, '打开后焦点应进 Expanded（关闭按钮或其内）');
        act(() => {
            fireEvent.click(rendered.getByTestId('expanded-close-button'));
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
        });
        // 关闭后焦点返回 Mini trigger（或其重挂载实例）。
        const activeAfterClose = document.activeElement as unknown as HTMLElement | null;
        const returnedToMini =
            activeAfterClose !== null &&
            (activeAfterClose.getAttribute?.('data-testid') === 'mini-metadata-button' ||
                (activeAfterClose.closest?.('[data-testid="mini-now-playing"]') as unknown) !== null);
        assert.ok(returnedToMini, '关闭后焦点应返回 Mini trigger');
        const fsMod = nodeRequire('node:fs') as typeof import('node:fs');
        assert.strictEqual(
            fsMod.existsSync(path.join(repoRoot, 'app', '(main)', 'player', 'index.tsx')),
            true,
            '/player 文件仍存在（M9 前不删除）'
        );
        rendered.unmount();
        console.log('PASS: M7-01-I7 focus return + compat file');
    }

    resetAll();
    console.log('\nALL EXPANDED SURFACE INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runExpandedSurfaceIntegration()
    .then(() => {
        console.log('ALL EXPANDED SURFACE INTEGRATION TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Expanded surface integration test failed:', error);
        process.exit(1);
    });

export default testPromise;
