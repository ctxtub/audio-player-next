import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：M6-03 MainChrome 集成（L2）：真实 Session/Transport/Config + MainChrome/BottomChrome 渲染。
// 验证统一预留/纯布局键盘隐藏/点击 entry 委托/跨视口/off-by-one/无幽灵空间/M5 owner 边界。
// DB：不触持久化，但按 runner 归类走隔离建库（needs_db=true，由 runner 提供隔离库）。

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
    for (const key of ['HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'SVGElement']) {
        const v = (win as Record<string, unknown>)[key];
        if (v !== undefined) {
            try {
                Object.defineProperty(g, key, { value: v, writable: true, configurable: true });
            } catch {
                g[key] = v;
            }
        }
    }
    g.requestAnimationFrame = (cb: () => void): unknown => setTimeout(cb, 0);
    g.cancelAnimationFrame = (id: unknown): void => {
        clearTimeout(id as NodeJS.Timeout);
    };
    (g as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}

const PARA1 =
    '第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。';
const PARA2 =
    '第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。它还会在洞口铺上柔软的干草。';
const STORY_2 = `${PARA1}\n${PARA2}`;

async function runMainChromeIntegration(): Promise<void> {
    setupJsdom();
    installAssetStubs();

    const cache = (nodeRequire as unknown as { cache: Record<string, NodeModule> }).cache;

    // GlassToast 打桩（避免真实 Toast 触 DOM Root）。
    const glassToastPath = path.resolve(repoRoot, 'components/ui/GlassToast.tsx');
    cache[glassToastPath] = {
        id: glassToastPath,
        filename: glassToastPath,
        loaded: true,
        exports: { default: { show: () => {}, clear: () => {} } },
    } as unknown as NodeModule;

    // Entry facade 打桩：捕获 metadata 点击（push 语义由 L1 纯工厂覆盖，本层只验委托一次）。
    const entryPath = path.resolve(repoRoot, 'components/NowPlaying/useNowPlayingEntry.ts');
    let openDetailsCalls = 0;
    cache[entryPath] = {
        id: entryPath,
        filename: entryPath,
        loaded: true,
        exports: {
            useNowPlayingEntry: () => ({
                openDetails: () => {
                    openDetailsCalls += 1;
                },
                openExpanded: () => {
                    openDetailsCalls += 1;
                },
            }),
        },
    } as unknown as NodeModule;

    // MainTabBar 打桩：隔离 next/navigation 路由上下文，保留 tab 可达性（跨路由存活由 L3 覆盖）。
    const tabBarPath = path.resolve(repoRoot, 'components/MainTabBar/index.tsx');
    const ReactForStub = nodeRequire('react') as typeof React;
    cache[tabBarPath] = {
        id: tabBarPath,
        filename: tabBarPath,
        loaded: true,
        exports: {
            __esModule: true,
            default: () =>
                ReactForStub.createElement(
                    'nav',
                    { 'data-testid': 'main-tabbar-stub' },
                    ReactForStub.createElement('button', { role: 'tab', 'aria-label': '创作' }, '创作'),
                    ReactForStub.createElement('button', { role: 'tab', 'aria-label': '故事库' }, '故事库'),
                    ReactForStub.createElement('button', { role: 'tab', 'aria-label': '设置' }, '设置')
                ),
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
    const ReactMod = nodeRequire('react') as typeof React;
    const rtl = nodeRequire('@testing-library/react') as typeof import('@testing-library/react');
    const { act } = rtl;

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

    const setDesktopPref = (enabled: boolean) => {
        configMod.useConfigStore.setState((prev) => {
            const p = prev as unknown as { apiConfig: Record<string, unknown> };
            return { apiConfig: { ...p.apiConfig, desktopFloatingPlayerEnabled: enabled } };
        });
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
        openDetailsCalls = 0;
        rtl.cleanup();
        // 键盘复位：blur + focusout（fallback 路径 closed）。
        try {
            const active = document.activeElement as unknown as { blur?: () => void } | null;
            active?.blur?.();
            const Evt = (window as unknown as { Event: typeof Event }).Event ?? Event;
            document.dispatchEvent(new Evt('focusout', { bubbles: true } as EventInit) as Event);
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

    const renderChrome = (width: number, pref: boolean, withInput = false) => {
        setViewportWidth(width);
        setDesktopPref(pref);
        const children = withInput
            ? ReactMod.createElement('input', {
                  'data-testid': 'kbd-input',
                  type: 'text',
                  'aria-label': '键盘输入',
              })
            : ReactMod.createElement('div', { 'data-testid': 'page-stub' }, 'page');
        let rendered: ReturnType<typeof rtl.render> | null = null;
        act(() => {
            rendered = rtl.render(ReactMod.createElement(chromeMod.MainChrome, null, children));
        });
        return rendered as unknown as ReturnType<typeof rtl.render>;
    };

    console.log('=== M6-03-I1: 无 session → 无幽灵预留；有 session → docked 预留（验收 A/B）===');
    {
        resetAll();
        const idle = renderChrome(767, true);
        assert.strictEqual(
            idle.getByTestId('main-chrome').getAttribute('data-has-docked-mini'),
            'false',
            '无 session 不得预留幽灵空间'
        );
        assert.strictEqual(
            idle.getByTestId('mini-slot').getAttribute('data-visible'),
            'false',
            '无 session slot 不可见'
        );
        assert.strictEqual(idle.queryByTestId('mini-now-playing'), null, '无 session 不渲染 Mini');
        // TabBar（stub）仍可达，不被遮挡前置。
        assert.ok(idle.getByTestId('main-tabbar-stub'), '无 session TabBar 仍存在');
        idle.unmount();
        rtl.cleanup();

        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        useTransport.setState({ isPlaying: false, currentTime: 0, duration: 0 });
        const docked = renderChrome(767, true);
        const chrome = docked.getByTestId('main-chrome');
        assert.strictEqual(chrome.getAttribute('data-has-docked-mini'), 'true', '767 有 session → 预留');
        assert.strictEqual(chrome.getAttribute('data-layoutmode'), 'compact-docked', '767 必须为 compact-docked');
        assert.strictEqual(docked.getByTestId('mini-slot').getAttribute('data-visible'), 'true');
        assert.ok(docked.getByTestId('mini-now-playing'), 'docked 必须渲染 Mini');
        assert.strictEqual(docked.getByTestId('mini-title').textContent, '月球上的小狐狸');
        // Mini 与 TabBar 同在 BottomChrome 内，TabBar 可达（不被遮挡）。
        assert.ok(docked.getByTestId('main-tabbar-stub'), 'Mini 存在时 TabBar 仍可达');
        // Host 不在 MainChrome 内（唯一 owner 在 layout 平级，L3 验跨路由）。
        assert.strictEqual(docked.container.querySelector('audio'), null, 'MainChrome 内不得自建 audio owner');
        docked.unmount();
        console.log('PASS: M6-03-I1 reservation + slot');
    }

    console.log('=== M6-03-I2: keyboard open → 纯隐藏；close → 恢复且 sessionId 不变（验收 C/D）===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        useTransport.setState({ isPlaying: false, currentTime: 0, duration: 0 });
        const rendered = renderChrome(767, true, true);
        assert.ok(rendered.getByTestId('mini-now-playing'), '键盘前 Mini 可见');
        const sessionIdBefore = useSession.getState().sessionId as string;
        const statusBefore = useSession.getState().status as string;
        const isPlayingBefore = useTransport.getState().isPlaying as boolean;
        assert.ok(typeof sessionIdBefore === 'string' && sessionIdBefore.length > 0, '前置 sessionId 存在');

        // mobile + 可编辑聚焦（jsdom 无 visualViewport，走 fallback open）。
        const input = rendered.getByTestId('kbd-input') as unknown as HTMLInputElement;
        act(() => {
            input.focus();
            const Evt = (window as unknown as { Event: typeof Event }).Event ?? Event;
            document.dispatchEvent(new Evt('focusin', { bubbles: true } as EventInit) as Event);
            window.dispatchEvent(new Evt('resize'));
        });
        assert.strictEqual(
            rendered.getByTestId('mini-slot').getAttribute('data-visible'),
            'false',
            'keyboard open → slot 隐藏'
        );
        assert.strictEqual(rendered.queryByTestId('mini-now-playing'), null, 'keyboard open → Mini 不渲染');
        assert.strictEqual(
            rendered.getByTestId('main-chrome').getAttribute('data-has-docked-mini'),
            'false',
            '隐藏时不预留（Composer 落回）'
        );
        // 纯布局：Session/Transport 不变（不 clear、不 pause、不改 Anchor）。
        assert.strictEqual(useSession.getState().sessionId as string, sessionIdBefore, 'sessionId 不变');
        assert.strictEqual(useSession.getState().status as string, statusBefore, 'status 不变（不 pause）');
        assert.strictEqual(useTransport.getState().isPlaying as boolean, isPlayingBefore, '播放态不变');
        assert.ok((useSession.getState().source as { kind: string }).kind === 'work', 'source 不变');

        // keyboard close → 自动恢复（同一 Session）。
        act(() => {
            input.blur();
            const Evt = (window as unknown as { Event: typeof Event }).Event ?? Event;
            document.dispatchEvent(new Evt('focusout', { bubbles: true } as EventInit) as Event);
            window.dispatchEvent(new Evt('resize'));
        });
        assert.ok(rendered.getByTestId('mini-now-playing'), 'keyboard close → Mini 恢复');
        assert.strictEqual(
            rendered.getByTestId('mini-slot').getAttribute('data-visible'),
            'true',
            '恢复后 slot 可见'
        );
        assert.strictEqual(useSession.getState().sessionId as string, sessionIdBefore, '恢复后 sessionId 仍同一');
        assert.strictEqual(rendered.getByTestId('mini-title').textContent, '月球上的小狐狸');
        rendered.unmount();
        console.log('PASS: M6-03-I2 keyboard pure hide/restore');
    }

    console.log('=== M6-03-I3: 点击 Mini → entry 委托（验收 E；路由 push 由 L1 锁定）===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        useTransport.setState({ isPlaying: false, currentTime: 0, duration: 0 });
        const rendered = renderChrome(767, true);
        assert.strictEqual(openDetailsCalls, 0, '渲染本身不得触发 entry');
        act(() => {
            (rendered.getByTestId('mini-metadata-button') as unknown as HTMLElement).click();
        });
        assert.strictEqual(openDetailsCalls, 1, '点击 metadata 必须委托 openDetails 一次（→/player 由 facade 锁定）');
        // 播放按钮不打开详情（只走 Flow）。
        act(() => {
            (rendered.getByTestId('mini-playback-button') as unknown as HTMLElement).click();
        });
        assert.strictEqual(openDetailsCalls, 1, '播放按钮不得触发 entry');
        rendered.unmount();
        console.log('PASS: M6-03-I3 entry delegation');
    }

    console.log('=== M6-03-I4: 768 off-by-one + floating 不占位（验收 G）===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        useTransport.setState({ isPlaying: false, currentTime: 0, duration: 0 });
        const floating = renderChrome(768, true);
        assert.strictEqual(
            floating.getByTestId('main-chrome').getAttribute('data-layoutmode'),
            'wide-floating',
            '768 + pref true → wide-floating（不进 mobile 分支）'
        );
        assert.ok(floating.getByTestId('mini-now-playing'), 'floating 仍渲染（兼容路径）');
        assert.strictEqual(
            floating.getByTestId('main-chrome').getAttribute('data-has-docked-mini'),
            'false',
            'floating 不占位'
        );
        floating.unmount();
        rtl.cleanup();

        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        useTransport.setState({ isPlaying: false, currentTime: 0, duration: 0 });
        const wideDocked = renderChrome(768, false);
        assert.strictEqual(
            wideDocked.getByTestId('main-chrome').getAttribute('data-layoutmode'),
            'wide-docked',
            '768 + pref false → wide-docked'
        );
        assert.strictEqual(
            wideDocked.getByTestId('main-chrome').getAttribute('data-has-docked-mini'),
            'true',
            'wide-docked 预留'
        );
        // wide 下键盘打开不抑制（物理键盘）。
        act(() => {
            const stub = document.createElement('input');
            stub.setAttribute('type', 'text');
            document.body.appendChild(stub);
            stub.focus();
            const Evt = (window as unknown as { Event: typeof Event }).Event ?? Event;
            document.dispatchEvent(new Evt('focusin', { bubbles: true } as EventInit) as Event);
        });
        assert.ok(wideDocked.getByTestId('mini-now-playing'), 'wide 键盘 open 仍显示');
        wideDocked.unmount();
        console.log('PASS: M6-03-I4 off-by-one + floating');
    }

    resetAll();
    console.log('\nALL MAIN CHROME DOCKED INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runMainChromeIntegration()
    .then(() => {
        console.log('ALL MAIN CHROME DOCKED INTEGRATION TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Main chrome integration test failed:', error);
        process.exit(1);
    });

export default testPromise;
