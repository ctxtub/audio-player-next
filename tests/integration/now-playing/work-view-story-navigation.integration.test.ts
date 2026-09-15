import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：M7-04-01 Work 查看正文导航集成（L2）：真实 Session/Transport/UI +
// Expanded ViewModel/decision 穿越明确 seam + Expanded 真实渲染。
// 锁定验收 1/2/3/4/5/6：Work 展示与精确目标、同 Detail 只关、它 Detail 照推、
// 点击关推顺序且播放继续（session/transport 不变）、Draft 隐藏无 fake-id、
// 动作区仅查看正文。DB 不触持久化但按 runner 归类走隔离建库。

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
    // RAC FocusScope 取全局 rAF（非 window. 前缀），此处与 expanded-surface 同口径挂全局。
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
const WORK_SESSION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

async function runWorkViewStoryNavigation(): Promise<void> {
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

    // next/navigation 打桩：隔离路由上下文；push 可观测、pathname 可控
    //（跨路由存活与真实 push 目标由 L3 覆盖，本层只验关推顺序与去重）。
    const pushedUrls: string[] = [];
    const effectOrder: string[] = [];
    let mockPathname: string | null = '/chat';
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
    const expandedVmMod = innerJiti('./components/NowPlaying/useExpandedNowPlayingViewModel.ts') as unknown as {
        deriveExpandedNowPlayingViewModel: (
            s: Record<string, unknown>,
            t: Record<string, unknown>,
            o: Array<{ value: string; label: string }>
        ) => Record<string, unknown>;
    };
    const expandedMod = innerJiti('./components/NowPlaying/ExpandedNowPlaying.tsx') as unknown as {
        ExpandedNowPlaying: React.ComponentType;
    };

    const useSession = sessionMod.usePlaybackSessionStore;
    const useTransport = transportMod.usePlaybackStore;
    const useUi = uiMod.useNowPlayingUiStore;
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
        mockPathname = '/chat';
        try {
            rtl.cleanup();
        } catch {}
        try {
            document.body.innerHTML = '';
        } catch {}
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

    const seedDraftSession = () => {
        useSession.getState().setActiveStory({
            source: { kind: 'draft', messageId: 'msg_view_story_draft_01' },
            sessionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d480',
            title: '草稿故事',
            storyText: STORY_2,
            voiceId: 'alloy',
            speed: 1.0,
        });
        useSession.getState().setStatus('paused');
        useTransport.setState({ isPlaying: false, currentTime: 5, duration: 60, playbackRate: 1.0 });
    };

    const readVm = () => {
        const s = useSession.getState() as unknown as Record<string, unknown>;
        const t = useTransport.getState() as unknown as Record<string, unknown>;
        return expandedVmMod.deriveExpandedNowPlayingViewModel(
            {
                source: s.source,
                status: s.status,
                title: s.title,
                voiceId: s.voiceId,
                nextParagraphIndex: s.nextParagraphIndex,
                totalParagraphs: s.totalParagraphs,
                speed: s.speed,
            },
            { isPlaying: t.isPlaying, currentTime: t.currentTime, duration: t.duration, playbackRate: t.playbackRate },
            [{ value: 'alloy', label: '小雅' }]
        ) as unknown as { canViewStory: boolean; viewStoryTarget: string | null };
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
        isPlaying: useTransport.getState().isPlaying as boolean,
        currentTime: useTransport.getState().currentTime as number,
        audioUrl: useTransport.getState().currentAudioUrl as string | null,
    });

    console.log('=== M7-04-01-I1: Work 展示精确目标，点击先关后导且播放继续（验收 1/2） ===');
    {
        resetAll();
        seedWorkSession();
        const vm = readVm();
        assert.strictEqual(vm.canViewStory, true, 'Work 展示查看正文');
        assert.strictEqual(vm.viewStoryTarget, '/library/481', '目标精确等于当前 workId');
        // close/push 顺序观测：渲染前包装 closeExpanded（组件挂载即捕获探针，无闭包时序）。
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
        const button = rendered.getByTestId('expanded-view-story-button');
        assert.strictEqual(button.textContent?.includes('查看正文'), true, '按钮文案为查看正文');
        assert.ok(rendered.getByTestId('expanded-actions'), '动作区容器存在');
        const before = snapshotPlayback();
        act(() => {
            rendered.getByTestId('expanded-view-story-button').click();
        });
        assert.deepStrictEqual(effectOrder, ['close', 'push'], '顺序固定：close 先于 push');
        assert.deepStrictEqual(pushedUrls, ['/library/481'], 'push 精确目标');
        assert.strictEqual(useUi.getState().isExpanded as boolean, false, 'Expanded 已关闭');
        assert.deepStrictEqual(snapshotPlayback(), before, '播放继续：session/transport 全不变（不 pause）');
        act(() => {
            useUi.setState({ closeExpanded: originalClose });
        });
        rendered.unmount();
        console.log('PASS: M7-04-01-I1 work exact close-then-push');
    }

    console.log('=== M7-04-01-I2: 同 Detail 只关不推（验收 3） ===');
    {
        resetAll();
        seedWorkSession();
        mockPathname = '/library/481';
        const rendered = renderExpanded();
        assert.ok(rendered.getByTestId('expanded-view-story-button'), '同 Detail 仍展示按钮（只关语义）');
        const before = snapshotPlayback();
        act(() => {
            rendered.getByTestId('expanded-view-story-button').click();
        });
        assert.deepStrictEqual(pushedUrls, [], '同 Detail 不重复 push');
        assert.strictEqual(useUi.getState().isExpanded as boolean, false, '只 closeExpanded');
        assert.deepStrictEqual(snapshotPlayback(), before, '播放继续');
        rendered.unmount();
        console.log('PASS: M7-04-01-I2 same-detail close-only');
    }

    console.log('=== M7-04-01-I3: 它 Detail 照推当前 Work（验收 4） ===');
    {
        resetAll();
        seedWorkSession();
        mockPathname = '/library/999';
        const rendered = renderExpanded();
        act(() => {
            rendered.getByTestId('expanded-view-story-button').click();
        });
        assert.deepStrictEqual(pushedUrls, ['/library/481'], '在它 Detail 正常 push 当前 Work id');
        assert.strictEqual(useUi.getState().isExpanded as boolean, false);
        rendered.unmount();
        console.log('PASS: M7-04-01-I3 other-detail push-current');
    }

    console.log('=== M7-04-01-I4: Draft 无 Work 导航且无 fake-id（验收 5；M7-04-02 supersede） ===');
    {
        // M7-04-02 supersede：Draft 查看正文入口已由 02 接管（Actions 内同文案
        // 独立 testid expanded-view-transcript-button，点击切 Expanded 局部 view，
        // 不导航）；本用例锁定 Work 导航口冻结面：Draft 无 Work 导航按钮、
        // 无 Library 导航（更无 /library/fake-id）。Draft Transcript 全量语义
        // 见 draft-transcript 集成（I1-I6）。
        resetAll();
        seedDraftSession();
        const vm = readVm();
        assert.strictEqual(vm.canViewStory, false, 'Draft 不走 Work 导航口');
        assert.strictEqual(vm.viewStoryTarget, null, 'Draft 不生成 Library 目标');
        const rendered = renderExpanded();
        assert.strictEqual(rendered.queryByTestId('expanded-view-story-button'), null, 'Draft 无 Work 查看正文导航按钮');
        assert.ok(rendered.getByTestId('expanded-view-transcript-button'), 'Draft Transcript 口由 02 承接（同文案独立口）');
        assert.deepStrictEqual(pushedUrls, [], '无任何导航（更无 /library/fake-id）');
        const observedUrls: string[] = [...pushedUrls];
        for (const url of observedUrls) {
            assert.ok(!url.includes('fake') && !url.includes('undefined') && !url.includes('null'), `非法目标：${url}`);
        }
        rendered.unmount();
        console.log('PASS: M7-04-01-I4 draft no-work-nav no-fake-id');
    }

    console.log('=== M7-04-01-I5: 动作区仅查看正文（验收 6） ===');
    {
        resetAll();
        seedWorkSession();
        const rendered = renderExpanded();
        const zone = rendered.getByTestId('expanded-actions');
        const buttons = zone.querySelectorAll('button');
        assert.strictEqual(buttons.length, 1, '动作区仅一个按钮');
        assert.strictEqual(buttons[0]?.getAttribute('data-testid'), 'expanded-view-story-button');
        const zoneText = zone.textContent ?? '';
        assert.ok(zoneText.includes('查看正文'), '仅查看正文文案');
        rendered.unmount();
        console.log('PASS: M7-04-01-I5 actions only-view-story');
    }

    resetAll();
    try {
        delete cache[navigationPath];
    } catch {}
    console.log('\nALL WORK VIEW STORY NAVIGATION INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runWorkViewStoryNavigation()
    .then(() => {
        console.log('ALL WORK VIEW STORY NAVIGATION INTEGRATION TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Work view story navigation integration test failed:', error);
        process.exit(1);
    });

export default testPromise;
