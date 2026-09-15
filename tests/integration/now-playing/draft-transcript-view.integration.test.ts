import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：M7-04-02 Draft Transcript 集成（L2）：真实 Session/Transport/UI +
// Expanded ViewModel/decision 穿越明确 seam + Expanded 真实渲染。
// 锁定验收 1/2/3/4/5/6：Draft 查看正文入口与 Expanded 内打开（route 不变）、
// 内容 = Session.storyText 只读、返回控制 Session/Transport/Audio 零变化、
// 全程无 /library/fake-id、开合不写 global UI Store（isExpanded 全程 true）、
// promotion 保持打开 + 打开作品详情复用同一出口、fail-closed、Work 回归。

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
const DRAFT_SESSION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d481';
const DRAFT_MESSAGE_ID = 'msg_draft_transcript_02_01';

async function runDraftTranscriptIntegration(): Promise<void> {
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

    // next/navigation 打桩：transcript 全程不得导航（push 必须保持 0）；
    // promotion 后打开作品详情复用同一出口（精确目标断言）。
    const pushedUrls: string[] = [];
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
            sessionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            title: '月球上的小狐狸',
            storyText: STORY_2,
            voiceId: 'alloy',
            speed: 1.0,
        });
        useSession.getState().setStatus('paused');
        useTransport.setState({ isPlaying: false, currentTime: 20, duration: 100, playbackRate: 1.0 });
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
                storyText: s.storyText,
                sessionId: s.sessionId,
            },
            { isPlaying: t.isPlaying, currentTime: t.currentTime, duration: t.duration, playbackRate: t.playbackRate },
            [{ value: 'alloy', label: '小雅' }]
        ) as unknown as { canViewTranscript: boolean; transcriptText: string | null; canViewStory: boolean; viewStoryTarget: string | null; sessionId: string | null };
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

    console.log('=== M7-04-02-I1: Draft 查看正文入口 → Expanded 内打开（验收 1，route 不变） ===');
    {
        resetAll();
        seedDraftSession();
        const vm = readVm();
        assert.strictEqual(vm.canViewTranscript, true, 'Draft + 正文即展示查看正文');
        assert.strictEqual(vm.transcriptText, STORY_2, 'ViewModel 正文 = Session.storyText 原文');
        assert.strictEqual(vm.canViewStory, false, 'Draft 不走 Work 导航口');
        assert.strictEqual(vm.viewStoryTarget, null, 'Draft 无 Library 目标');
        const rendered = renderExpanded();
        // Draft 口：同文案、独立 testid；Work 口 absent。
        const transcriptButton = rendered.getByTestId('expanded-view-transcript-button');
        assert.strictEqual(transcriptButton.textContent?.includes('查看正文'), true, 'Draft 口文案为查看正文');
        assert.strictEqual(rendered.queryByTestId('expanded-view-story-button'), null, 'Draft 无 Work 导航按钮');
        assert.ok(rendered.getByTestId('expanded-actions'), '动作区容器存在');
        assert.strictEqual(rendered.queryByTestId('expanded-transcript'), null, '点击前 transcript 未打开');
        const before = snapshotPlayback();
        act(() => {
            transcriptButton.click();
        });
        // Expanded 内打开：面板保持打开（isExpanded 全程 true），route 零导航。
        assert.strictEqual(useUi.getState().isExpanded as boolean, true, 'transcript 打开不关闭 Expanded（局部切换）');
        assert.deepStrictEqual(pushedUrls, [], 'transcript 打开不导航（route 不变）');
        const transcript = rendered.getByTestId('expanded-transcript');
        assert.ok(transcript, 'TranscriptView 已打开');
        assert.strictEqual(rendered.getByTestId('expanded-now-playing').getAttribute('data-view'), 'transcript', '局部 view = transcript');
        // §35/§72 互斥：transcript open 时 controls 元素完全不渲染。
        assert.strictEqual(rendered.queryByTestId('expanded-playback-controls'), null, '互斥：transcript 下无播放控制');
        assert.strictEqual(rendered.queryByTestId('expanded-timeline'), null, '互斥：transcript 下无时间轴');
        assert.strictEqual(rendered.queryByTestId('expanded-actions'), null, '互斥：transcript 下无动作区');
        assert.deepStrictEqual(snapshotPlayback(), before, '打开不改变 Session/Transport');
        // 返回后 controls 重新出现（仍是同一 Expanded，会话不变）。
        act(() => {
            rendered.getByTestId('expanded-transcript-back-button').click();
        });
        assert.strictEqual(rendered.queryByTestId('expanded-transcript'), null, '返回后 transcript 收起');
        assert.ok(rendered.getByTestId('expanded-playback-controls'), '返回后播放控制重新出现');
        assert.ok(rendered.getByTestId('expanded-timeline'), '返回后时间轴重新出现');
        assert.ok(rendered.getByTestId('expanded-actions'), '返回后动作区重新出现');
        assert.ok(rendered.getByTestId('expanded-view-transcript-button'), '返回后 Draft 查看正文重新出现');
        assert.deepStrictEqual(snapshotPlayback(), before, '往返不改变 Session/Transport');
        rendered.unmount();
        console.log('PASS: M7-04-02-I1 draft open in-expanded no-nav');
    }

    console.log('=== M7-04-02-I2: Transcript 只读原文（验收 2，无编辑面） ===');
    {
        resetAll();
        seedDraftSession();
        const rendered = renderExpanded();
        act(() => {
            rendered.getByTestId('expanded-view-transcript-button').click();
        });
        const textEl = rendered.getByTestId('expanded-transcript-text');
        assert.strictEqual(textEl.textContent, STORY_2, '内容逐字等于 Session.storyText');
        // 无编辑面：transcript  subtree 内无可编辑元素。
        const editable = rendered.getByTestId('expanded-transcript').querySelectorAll(
            'textarea, input, [contenteditable="true"], [contenteditable=""]'
        );
        assert.strictEqual(editable.length, 0, '只读，无编辑面');
        assert.strictEqual(rendered.queryByTestId('expanded-transcript-empty'), null, '有正文时无空态');
        rendered.unmount();
        console.log('PASS: M7-04-02-I2 readonly exact storyText');
    }

    console.log('=== M7-04-02-I3: 返回控制 Session/Transport/Audio 零变化（验收 3） ===');
    {
        resetAll();
        seedDraftSession();
        const rendered = renderExpanded();
        act(() => {
            rendered.getByTestId('expanded-view-transcript-button').click();
        });
        assert.ok(rendered.getByTestId('expanded-transcript'), 'transcript 已打开');
        const audioCountBefore = document.querySelectorAll('audio').length;
        const before = snapshotPlayback();
        const uiBefore = { ...(useUi.getState() as unknown as Record<string, unknown>) };
        act(() => {
            rendered.getByTestId('expanded-transcript-back-button').click();
        });
        assert.strictEqual(rendered.queryByTestId('expanded-transcript'), null, 'transcript 已收起');
        assert.strictEqual(rendered.getByTestId('expanded-now-playing').getAttribute('data-view'), 'controls', '局部 view 回到 controls');
        assert.strictEqual(useUi.getState().isExpanded as boolean, true, '返回控制不关闭 Expanded');
        assert.deepStrictEqual(pushedUrls, [], '返回控制不导航');
        assert.deepStrictEqual(snapshotPlayback(), before, '返回控制不改变 Session（sessionId 不变、不 pause）');
        assert.strictEqual(document.querySelectorAll('audio').length, audioCountBefore, 'Host 不 remount');
        // 开合不写 global UI Store：除 isExpanded/returnFocusTarget 外无 transcript 字段。
        const uiAfter = useUi.getState() as unknown as Record<string, unknown>;
        assert.strictEqual(uiAfter.isExpanded, uiBefore.isExpanded);
        assert.ok(!('transcript' in uiAfter) && !('expandedView' in uiAfter) && !('localView' in uiAfter), 'global UI Store 无 transcript 字段');
        rendered.unmount();
        console.log('PASS: M7-04-02-I3 back zero-change');
    }

    console.log('=== M7-04-02-I4: 全程无 fake-id 导航（验收 4） ===');
    {
        resetAll();
        seedDraftSession();
        const rendered = renderExpanded();
        act(() => {
            rendered.getByTestId('expanded-view-transcript-button').click();
        });
        act(() => {
            rendered.getByTestId('expanded-transcript-back-button').click();
        });
        assert.deepStrictEqual(pushedUrls, [], 'Draft 全程零导航（更无 /library/fake-id）');
        // deepStrictEqual 断言签名会把 pushedUrls 收窄为 never[]；循环先经显式 string[] 拷贝（与 01 同式）。
        const observedUrls: string[] = [...pushedUrls];
        for (const url of observedUrls) {
            assert.ok(!url.includes('fake') && !url.includes('undefined') && !url.includes('null') && !url.includes('/library/'), `非法目标：${url}`);
        }
        rendered.unmount();
        console.log('PASS: M7-04-02-I4 no-fake-id');
    }

    console.log('=== M7-04-02-I5a: promotion 保持打开 + 单 CTA + 返回 Work controls（验收 5，§35.1） ===');
    {
        resetAll();
        seedDraftSession();
        const rendered = renderExpanded();
        act(() => {
            rendered.getByTestId('expanded-view-transcript-button').click();
        });
        assert.ok(rendered.getByTestId('expanded-transcript'), 'transcript 已打开');
        assert.strictEqual(rendered.queryByTestId('expanded-open-work-detail-button'), null, 'promotion 前无打开作品详情入口（不越界）');
        // 模拟 promotion 本地 effect：sessionId 不变、source 切 work（server 已切，M4 触发面在外）。
        const sessionIdBefore = useSession.getState().sessionId as string;
        act(() => {
            useSession.setState({ source: { kind: 'work', workId: 481 } });
        });
        // transcript 保持打开（不强制关闭）。
        assert.ok(rendered.getByTestId('expanded-transcript'), 'promotion 成功不强制关闭 transcript');
        assert.strictEqual(rendered.getByTestId('expanded-now-playing').getAttribute('data-view'), 'transcript', '局部 view 保持 transcript');
        assert.strictEqual(rendered.getByTestId('expanded-transcript-text').textContent, STORY_2, 'promotion 后仍展示同一 storyText');
        // promotion 后出现打开作品详情入口（复用 Work 先关后导 handler）。
        const openDetail = rendered.getByTestId('expanded-open-work-detail-button');
        assert.strictEqual(openDetail.textContent?.includes('打开作品详情'), true);
        // §35.1 单 CTA 不变量：同一 Work Detail 不得双入口并存。
        assert.strictEqual(rendered.queryByTestId('expanded-view-story-button'), null, 'promotion 后 transcript 内无 Work 查看正文（单 CTA）');
        assert.strictEqual(rendered.queryByTestId('expanded-actions'), null, 'promotion 后 transcript 内无动作区（互斥）');
        assert.strictEqual(rendered.queryByTestId('expanded-playback-controls'), null, 'promotion 后 transcript 内无播放控制（互斥）');
        // 返回控制 → 进入 Work controls view → Work 查看正文正常出现。
        act(() => {
            rendered.getByTestId('expanded-transcript-back-button').click();
        });
        assert.strictEqual(rendered.queryByTestId('expanded-transcript'), null, '返回后 transcript 收起');
        assert.strictEqual(rendered.getByTestId('expanded-now-playing').getAttribute('data-view'), 'controls', '返回后局部 view = controls');
        assert.strictEqual(useUi.getState().isExpanded as boolean, true, '返回控制不关闭 Expanded');
        assert.ok(rendered.getByTestId('expanded-view-story-button'), '返回后 Work 查看正文出现');
        assert.deepStrictEqual(pushedUrls, [], '返回控制不导航');
        assert.strictEqual((useSession.getState().sessionId as string), sessionIdBefore, '返回控制 sessionId 不变');
        rendered.unmount();
        console.log('PASS: M7-04-02-I5a promote keep-open single-cta back-to-work');
    }

    console.log('=== M7-04-02-I5b: 打开作品详情 push 精确目标（§35.1 同一路由出口） ===');
    {
        resetAll();
        seedDraftSession();
        const rendered = renderExpanded();
        act(() => {
            rendered.getByTestId('expanded-view-transcript-button').click();
        });
        const sessionIdBefore = useSession.getState().sessionId as string;
        act(() => {
            useSession.setState({ source: { kind: 'work', workId: 481 } });
        });
        const openDetail = rendered.getByTestId('expanded-open-work-detail-button');
        const before = snapshotPlayback();
        assert.strictEqual(before.sessionId, sessionIdBefore, 'promotion 模拟 sessionId 不变');
        act(() => {
            openDetail.click();
        });
        assert.deepStrictEqual(pushedUrls, ['/library/481'], '打开作品详情 push 精确目标（同一路由出口）');
        assert.strictEqual(useUi.getState().isExpanded as boolean, false, '打开详情先关 Expanded');
        assert.strictEqual((useSession.getState().sessionId as string), sessionIdBefore, '打开详情不改变 Session');
        rendered.unmount();
        console.log('PASS: M7-04-02-I5b open-detail exact push');
    }

    console.log('=== M7-04-02-I6: fail-closed（验收 6：无正文/idle 不展示或空态） ===');
    {
        resetAll();
        seedDraftSession('');
        const vmEmpty = readVm();
        assert.strictEqual(vmEmpty.canViewTranscript, false, '空正文不展示入口');
        assert.strictEqual(vmEmpty.transcriptText, null);
        const renderedEmpty = renderExpanded();
        assert.strictEqual(renderedEmpty.queryByTestId('expanded-view-transcript-button'), null, '空正文无查看正文按钮');
        assert.strictEqual(renderedEmpty.queryByTestId('expanded-view-story-button'), null, '空 Draft 亦无 Work 按钮');
        assert.deepStrictEqual(pushedUrls, [], '空态零导航');
        renderedEmpty.unmount();

        resetAll();
        seedDraftSession();
        act(() => {
            useSession.getState().setStatus('idle');
        });
        const vmIdle = readVm();
        assert.strictEqual(vmIdle.canViewTranscript, false, 'idle 不展示');
        renderedEmpty.unmount();
        console.log('PASS: M7-04-02-I6 fail-closed');
    }

    console.log('=== M7-04-02-I7: Work 面回归（01 冻结，验收 6） ===');
    {
        resetAll();
        seedWorkSession();
        const vm = readVm();
        assert.strictEqual(vm.canViewStory, true, 'Work 导航口不变');
        assert.strictEqual(vm.viewStoryTarget, '/library/481');
        assert.strictEqual(vm.canViewTranscript, false, 'Work 不走 transcript 入口');
        const rendered = renderExpanded();
        assert.ok(rendered.getByTestId('expanded-view-story-button'), 'Work 查看正文按钮回归');
        assert.strictEqual(rendered.queryByTestId('expanded-view-transcript-button'), null, 'Work 无 transcript 口');
        const before = snapshotPlayback();
        act(() => {
            rendered.getByTestId('expanded-view-story-button').click();
        });
        assert.deepStrictEqual(pushedUrls, ['/library/481'], 'Work 先关后导精确目标');
        assert.deepStrictEqual(snapshotPlayback(), before, 'Work 导航播放继续');
        rendered.unmount();
        console.log('PASS: M7-04-02-I7 work regression');
    }

    resetAll();
    try {
        delete cache[navigationPath];
    } catch {}
    console.log('\nALL DRAFT TRANSCRIPT INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runDraftTranscriptIntegration()
    .then(() => {
        console.log('ALL DRAFT TRANSCRIPT INTEGRATION TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Draft transcript integration test failed:', error);
        process.exit(1);
    });

export default testPromise;
