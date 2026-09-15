import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：M6-02 Mini 会话集成（L2）：真实 PlaybackSessionStore + Transport + Flow + Mini 渲染。
// 验证派生显隐/标题/动作委托/进度联动/会话切换/配置独立/DOM 无预算字段/兼容可编译。
// DB：本套件不触持久化，但按 runner 归类需走隔离建库（needs_db=true，由 runner 提供隔离库）。

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
const PARA3 =
    '第三自然段：有一天它在一棵巨大的古老松树下发现了一颗闪闪发光的神奇松果，散发出奇异而温暖的柔和光芒，不仅照亮了周围湿漉漉的青苔，还散发出一种让人心情平静的香气。';
const PARA4 =
    '第四自然段：这颗发光的松果带领着好奇的小松鼠走进了森林最深处的奇妙花园，那里盛开着从未见过的美丽奇幻花朵，彩色的蝴蝶在花丛中翩翩起舞，宛如梦境一般美丽动人。小松鼠决定把这份喜悦分享给森林里的每一位朋友。';
const STORY_4 = `${PARA1}\n${PARA2}\n${PARA3}\n${PARA4}`;

async function runMiniSessionIntegration(): Promise<void> {
    setupJsdom();
    installAssetStubs();

    // GlassToast 打桩（避免真实 Toast 触 DOM Root）。
    const glassToastPath = path.resolve(repoRoot, 'components/ui/GlassToast.tsx');
    const cache = (nodeRequire as unknown as { cache: Record<string, NodeModule> }).cache;
    cache[glassToastPath] = {
        id: glassToastPath,
        filename: glassToastPath,
        loaded: true,
        exports: { default: { show: () => {}, clear: () => {} } },
    } as unknown as NodeModule;

    // Entry facade 打桩（Mini 渲染不依赖 Next 路由真实上下文；push 语义由 L1 纯工厂覆盖）。
    const entryPath = path.resolve(repoRoot, 'components/NowPlaying/useNowPlayingEntry.ts');
    let lastOpened = 0;
    cache[entryPath] = {
        id: entryPath,
        filename: entryPath,
        loaded: true,
        exports: {
            useNowPlayingEntry: () => ({
                openDetails: () => {
                    lastOpened += 1;
                },
                openExpanded: () => {
                    lastOpened += 1;
                },
            }),
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
    const deriveMod = innerJiti('./components/NowPlaying/deriveMiniNowPlayingViewModel.ts') as unknown as {
        deriveMiniNowPlayingViewModel: (
            s: Record<string, unknown>,
            t: Record<string, unknown>,
            m: string
        ) => Record<string, unknown>;
    };
    const flowMod = innerJiti('./app/services/playbackSessionFlow.ts') as unknown as {
        pausePlayback: () => void;
        resumePlayback: () => Promise<void>;
        restartPlayback: () => Promise<void>;
    };
    const miniMod = innerJiti('./components/NowPlaying/MiniNowPlaying.tsx') as unknown as {
        MiniNowPlaying: React.ComponentType;
        default: React.ComponentType;
    };

    const useSession = sessionMod.usePlaybackSessionStore;
    const useTransport = transportMod.usePlaybackStore;
    const derive = deriveMod.deriveMiniNowPlayingViewModel;
    const ReactMod = nodeRequire('react') as typeof React;
    const rtl = nodeRequire('@testing-library/react') as typeof import('@testing-library/react');

    // TTS + 控制器 mock（resume/restart 真实走合成与出声）。
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        const item = {
            result: { data: { json: { audioBase64: 'AA==', contentType: 'audio/mpeg' } } },
        };
        return new Response(JSON.stringify(item), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;
    const urlStatics = URL as unknown as { createObjectURL?: (obj: object) => string };
    const originalCreateObjectURL = urlStatics.createObjectURL;
    urlStatics.createObjectURL = () => `blob:mock-mini-${Date.now()}`;
    let playCalls = 0;
    const installController = () => {
        playCalls = 0;
        const transport = useTransport.getState() as unknown as {
            registerAudioController: (c: unknown) => void;
        };
        transport.registerAudioController({
            unlock: async () => {},
            play: async () => {
                playCalls += 1;
            },
            resume: async () => {
                playCalls += 1;
            },
            pause: () => {},
            seek: () => {},
            setPlaybackRate: () => {},
        } as never);
    };

    const resetAll = () => {
        try {
            sessionMod.__resetPlaybackSessionTestHooks();
        } catch {
            // ignore
        }
        try {
            useSession.getState().reset();
        } catch {
            // ignore
        }
        try {
            useTransport.getState().reset();
        } catch {
            // ignore
        }
        try {
            useTransport.setState({ _tickIntervalId: null, _lastTickAt: null });
        } catch {
            // ignore
        }
        rtl.cleanup();
    };

    const seedWorkSession = (title: string, status: string) => {
        useSession.getState().setActiveStory({
            source: { kind: 'work', workId: 481 },
            sessionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            title,
            storyText: STORY_4,
            voiceId: 'alloy',
            speed: 1.0,
        });
        if (status !== 'playing') {
            useSession.getState().setStatus(status);
        }
    };

    const readViewModel = (layoutMode = 'compact-docked') => {
        const s = useSession.getState() as unknown as Record<string, unknown>;
        const t = useTransport.getState() as unknown as Record<string, unknown>;
        return derive(
            {
                source: s.source,
                status: s.status,
                title: s.title,
                lastCompletedParagraphIndex: s.lastCompletedParagraphIndex,
                nextParagraphIndex: s.nextParagraphIndex,
                totalParagraphs: s.totalParagraphs,
            },
            { isPlaying: t.isPlaying, currentTime: t.currentTime, duration: t.duration },
            layoutMode
        ) as {
            visible: boolean;
            title: string;
            status: string;
            secondaryLabel: string | null;
            coarseProgress: number | null;
            primaryAction: string;
            layoutMode: string;
        };
    };

    console.log('=== M6-02-I1: 无 session → Mini 不渲染；有 session → 渲染标题 ===');
    {
        resetAll();
        const idleRender = rtl.render(ReactMod.createElement(miniMod.MiniNowPlaying));
        assert.strictEqual(
            idleRender.queryByTestId('mini-now-playing'),
            null,
            'idle 无 session 必须返回 null（不渲染）'
        );
        idleRender.unmount();

        seedWorkSession('月球上的小狐狸', 'ready');
        useTransport.setState({ isPlaying: false, currentTime: 0, duration: 0 });
        const vm = readViewModel();
        assert.strictEqual(vm.visible, true, 'ready session 必须可见');
        assert.strictEqual(vm.title, '月球上的小狐狸', '标题必须取 Session.title');
        const rendered = rtl.render(ReactMod.createElement(miniMod.MiniNowPlaying));
        const root = rendered.getByTestId('mini-now-playing');
        assert.ok(root, 'ready 必须渲染 Mini 根节点');
        assert.strictEqual(rendered.getByTestId('mini-title').textContent, '月球上的小狐狸');
        // 预算字段不得出现在 DOM。
        assert.ok(!rendered.container.textContent?.includes('remainingMs'), 'DOM 不得含预算字段名');
        rendered.unmount();
        console.log('PASS: M6-02-I1 visibility + title');
    }

    console.log('=== M6-02-I2: transport pause/play 即时反映 + Flow 委托 ===');
    {
        resetAll();
        configMod.useConfigStore.setState((prev) => {
            const p = prev as unknown as { apiConfig: Record<string, unknown> };
            return { apiConfig: { ...p.apiConfig, playDuration: 30, voiceId: 'alloy', speed: 1.0 } };
        });
        installController();
        seedWorkSession('月球上的小狐狸', 'playing');
        useTransport.setState({ isPlaying: true, currentTime: 5, duration: 100 });
        let rendered = rtl.render(ReactMod.createElement(miniMod.MiniNowPlaying));
        assert.strictEqual(
            rendered.getByTestId('mini-playback-button').getAttribute('aria-label'),
            '暂停播放',
            'playing 必须为 Pause'
        );
        rendered.unmount();

        // Flow pause：transport + session 联动。
        flowMod.pausePlayback();
        const pausedVm = readViewModel();
        assert.strictEqual(useTransport.getState().isPlaying as boolean, false, 'pause 后 transport 停');
        assert.strictEqual(useSession.getState().status as string, 'paused', 'pause 后 session paused');
        assert.strictEqual(pausedVm.primaryAction, 'play', 'paused 动作切 Play');
        rendered = rtl.render(ReactMod.createElement(miniMod.MiniNowPlaying));
        assert.strictEqual(
            rendered.getByTestId('mini-playback-button').getAttribute('aria-label'),
            '播放',
            'transport 暂停后按钮即时切 Play'
        );
        rendered.unmount();

        // Flow resume：paused → playing（真实合成 + 出声）。
        await flowMod.resumePlayback();
        assert.strictEqual(useSession.getState().status as string, 'playing', 'resume 后 session playing');
        assert.ok(playCalls >= 1, 'resume 必须触发 controller 出声');
        const resumedVm = readViewModel();
        assert.strictEqual(resumedVm.primaryAction, 'pause', 'resume 后动作切 Pause');
        console.log('PASS: M6-02-I2 transport + flow');
    }

    console.log('=== M6-02-I3: 段落/transport 进度联动 + 会话切换即时跟随 ===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'playing');
        useTransport.setState({ isPlaying: true, currentTime: 25, duration: 100 });
        const s = useSession.getState() as unknown as {
            lastCompletedParagraphIndex: number;
            nextParagraphIndex: number;
            totalParagraphs: number;
        };
        // 多段会话：次级文案为段落；粗进度随 currentTime 联动。
        const vmBefore = readViewModel();
        assert.ok(
            typeof vmBefore.secondaryLabel === 'string' && vmBefore.secondaryLabel.includes('/'),
            '多段必须展示段落文案'
        );
        const coarseBefore = vmBefore.coarseProgress as number;
        useTransport.setState({ currentTime: 75 });
        const vmAfter = readViewModel();
        assert.ok(
            (vmAfter.coarseProgress as number) > coarseBefore,
            'transport currentTime 推进必须增大 rail'
        );
        // 会话切换 A→B：标题/动作立即跟随 B（不被旧音频 timeupdate 拖回 A）。
        void s;
        seedWorkSession('深海探险家', 'paused');
        useTransport.setState({ isPlaying: false, currentTime: 0, duration: 0 });
        const switched = readViewModel();
        assert.strictEqual(switched.title, '深海探险家', '切换后标题立即为 B');
        assert.strictEqual(switched.primaryAction, 'play', '切换后动作归属 B');
        const rendered = rtl.render(ReactMod.createElement(miniMod.MiniNowPlaying));
        assert.strictEqual(rendered.getByTestId('mini-title').textContent, '深海探险家');
        rendered.unmount();
        console.log('PASS: M6-02-I3 progress + switch');
    }

    console.log('=== M6-02-I4: ended/error 展示 + restart/retry 委托 ===');
    {
        resetAll();
        configMod.useConfigStore.setState((prev) => {
            const p = prev as unknown as { apiConfig: Record<string, unknown> };
            return { apiConfig: { ...p.apiConfig, playDuration: 30, voiceId: 'alloy', speed: 1.0 } };
        });
        installController();
        seedWorkSession('月球上的小狐狸', 'playing');
        // 置 ended 尾锚。
        const total = (useSession.getState() as unknown as { totalParagraphs: number }).totalParagraphs;
        useSession.setState({
            status: 'ended',
            lastCompletedParagraphIndex: total - 1,
            nextParagraphIndex: total,
        });
        const endedVm = readViewModel();
        assert.strictEqual(endedVm.secondaryLabel, '播放完成');
        assert.strictEqual(endedVm.primaryAction, 'restart');
        let rendered = rtl.render(ReactMod.createElement(miniMod.MiniNowPlaying));
        assert.strictEqual(
            rendered.getByTestId('mini-playback-button').getAttribute('aria-label'),
            '重新播放'
        );
        rendered.unmount();
        // M7-02 fixup 后 restart 走 server-authoritative beginPlayback（Blocking 1）：
        // 本测试无 server，注入桩模拟 server restart（新 UUID + position 0）成功。
        const originalBegin = useSession.getState().beginPlayback as (p: Record<string, unknown>) => Promise<void>;
        useSession.setState({
            beginPlayback: async (params: Record<string, unknown>) => {
                useSession.setState({
                    sessionId: 'b47ac10b-58cc-4372-a567-0e02b2c3d482',
                    source: params.source,
                    nextParagraphIndex: 0,
                    lastCompletedParagraphIndex: -1,
                    status: 'ready',
                });
            },
        });
        await flowMod.restartPlayback();
        assert.strictEqual(useSession.getState().status as string, 'playing', 'restart 后回到 playing');
        assert.ok(playCalls >= 1, 'restart 必须出声');
        useSession.setState({ beginPlayback: originalBegin });

        // error → retry。
        resetAll();
        installController();
        seedWorkSession('月球上的小狐狸', 'playing');
        useSession.getState().setStatus('error');
        const errorVm = readViewModel();
        assert.strictEqual(errorVm.secondaryLabel, '播放遇到问题');
        assert.strictEqual(errorVm.primaryAction, 'retry');
        rendered = rtl.render(ReactMod.createElement(miniMod.MiniNowPlaying));
        assert.strictEqual(
            rendered.getByTestId('mini-playback-button').getAttribute('aria-label'),
            '重试播放'
        );
        // progressbar 可达且标注段落进度；metadata 与播放为独立按钮。
        const rail = rendered.getByTestId('mini-progress-rail');
        assert.strictEqual(rail.getAttribute('role'), 'progressbar');
        assert.strictEqual(rail.getAttribute('aria-label'), '故事段落进度');
        assert.ok(rendered.getByTestId('mini-metadata-button'), 'metadata 独立按钮存在');
        assert.ok(!rendered.container.querySelector('button button'), '禁止 button 嵌套 button');
        assert.strictEqual(lastOpened, 0, '渲染本身不得触发 entry');
        rendered.unmount();
        console.log('PASS: M6-02-I4 ended/error');
    }

    console.log('=== M9-03: 配置独立 + 兼容 shim 已删除 ===');
    {
        resetAll();
        seedWorkSession('月球上的小狐狸', 'paused');
        const visDocked = readViewModel('wide-docked');
        const visFloating = readViewModel('wide-floating');
        assert.strictEqual(visDocked.visible, true);
        assert.strictEqual(visFloating.visible, true, '偏好只换形态，不换存在性');
        const fsMod = nodeRequire('node:fs') as typeof import('node:fs');
        // M9-03：兼容期结束，shim 物理删除；正式命名唯一。
        assert.strictEqual(
            fsMod.existsSync(path.join(repoRoot, 'components', 'FloatingPlayer', 'index.tsx')),
            false,
            'M9-03 必须删除 FloatingPlayer deprecated 兼容 shim'
        );
        assert.strictEqual(
            fsMod.existsSync(path.join(repoRoot, 'components', 'FloatingPlayer')),
            false,
            'M9-03 必须删除 FloatingPlayer 兼容目录'
        );
        assert.strictEqual(miniMod.MiniNowPlaying, miniMod.default, '正式命名默认/具名一致');
        console.log('PASS: M9-03 config + shim-removed');
    }

    resetAll();
    globalThis.fetch = originalFetch;
    if (originalCreateObjectURL) {
        urlStatics.createObjectURL = originalCreateObjectURL;
    } else {
        delete urlStatics.createObjectURL;
    }
    console.log('\nALL MINI NOW PLAYING SESSION INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runMiniSessionIntegration()
    .then(() => {
        console.log('ALL MINI NOW PLAYING SESSION INTEGRATION TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Mini session integration test failed:', error);
        process.exit(1);
    });

export default testPromise;
