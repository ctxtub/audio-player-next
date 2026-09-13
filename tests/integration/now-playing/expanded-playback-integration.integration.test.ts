import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

// 中文注释：M7-02 P3A 集成（L2）：真实 Session/Transport/Flow + Expanded ViewModel/Controls 穿越明确 seam。
// 锁定验收 1/2/4/5/6/7/8/10：seek 不变 session、clamp/fail-safe、speed 三同步且不写 Config
// 且不触发 TTS、rehydrate 无特殊分支、paragraph badge、Draft restart 无 continuation、
// Mini/Expanded 同源即时同步、UI 不碰 identity。DB 不触持久化但按 runner 归类走隔离建库。

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
    for (const key of ['HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent']) {
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
    (g as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}

const PARA1 =
    '第一自然段：很久很久以前，在宁静的大森林深处住着一只聪明活泼的小松鼠，它有一条蓬松的大尾巴，每天清晨都在高高的树梢间欢快地跳来跳去，寻找新鲜的坚果与甘甜的露水。';
const PARA2 =
    '第二自然段：小松鼠每天早晨迎着金色的朝阳出门收集松果，仔细辨别每一颗果实是否饱满香甜，并将它们整齐地存放在自己温暖干燥的树洞深处，准备迎接即将到来的寒冷冬天。它还会在洞口铺上柔软的干草。';
const STORY_2 = `${PARA1}\n${PARA2}`;
const WORK_SESSION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

async function runExpandedPlaybackIntegration(): Promise<void> {
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
                setSpeed: (r: number) => Promise<void>;
                restart: () => Promise<void>;
                hydrateFromAnchor: (a: Record<string, unknown>, d?: Record<string, unknown>) => Promise<boolean>;
                reset: () => void;
                beginPlayback: (p: Record<string, unknown>) => Promise<void>;
            };
            setState: (p: Record<string, unknown>) => void;
        };
        __resetPlaybackSessionTestHooks: () => void;
    };
    const transportMod = innerJiti('./stores/playbackStore.ts') as unknown as {
        usePlaybackStore: {
            getState: () => Record<string, unknown> & {
                reset: () => void;
                seekAudio: (t: number) => void;
                setPlaybackRate: (r: number) => void;
                registerAudioController: (c: unknown) => void;
            };
            setState: (p: Record<string, unknown>) => void;
        };
    };
    const flowMod = innerJiti('./app/services/playbackSessionFlow.ts') as unknown as {
        pausePlayback: () => void;
        resumePlayback: () => Promise<void>;
        restartPlayback: () => Promise<void>;
        seekCurrentSegment: (t: number) => boolean;
        seekRelative: (d: number) => boolean;
        setPlaybackRate: (r: number) => Promise<void>;
        shouldAllowAiContinuation: (m: string) => boolean;
    };
    const expandedVmMod = innerJiti('./components/NowPlaying/useExpandedNowPlayingViewModel.ts') as unknown as {
        deriveExpandedNowPlayingViewModel: (
            s: Record<string, unknown>,
            t: Record<string, unknown>,
            o: Array<{ value: string; label: string }>
        ) => Record<string, unknown>;
    };
    const miniDeriveMod = innerJiti('./components/NowPlaying/deriveMiniNowPlayingViewModel.ts') as unknown as {
        deriveMiniNowPlayingViewModel: (
            s: Record<string, unknown>,
            t: Record<string, unknown>,
            m: string
        ) => Record<string, unknown>;
    };
    const configMod = innerJiti('./stores/configStore.ts') as unknown as {
        useConfigStore: {
            setState: (p: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>)) => void;
            getState: () => Record<string, unknown> & { apiConfig: Record<string, unknown> };
        };
    };

    const useSession = sessionMod.usePlaybackSessionStore;
    const useTransport = transportMod.usePlaybackStore;
    const rtl = nodeRequire('@testing-library/react') as typeof import('@testing-library/react');

    // TTS + checkpoint fetch 统一 mock：TTS 计数，checkpoint 捕获 speed。
    let ttsSynthCount = 0;
    const checkpointSpeeds: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
        try {
            const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? input);
            const body = typeof init?.body === 'string' ? init.body : '';
            if (typeof url === 'string' && (url.includes('synthesize') || url.includes('tts'))) {
                // 仅当 body 含 text 字段才计为 TTS（checkpoint 无 text，不误计，验收 5）。
                if (body.includes('"text"')) {
                    ttsSynthCount += 1;
                }
            }
            if (typeof url === 'string' && url.includes('saveCheckpoint') && body.length > 0) {
                try {
                    const parsed = JSON.parse(body) as Record<string, { json?: { speed?: unknown } }>;
                    for (const key of Object.keys(parsed)) {
                        const speed = parsed[key]?.json?.speed;
                        if (typeof speed === 'number') {
                            checkpointSpeeds.push(speed);
                        }
                    }
                } catch {}
            }
        } catch {}
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
    urlStatics.createObjectURL = () => `blob:mock-expanded-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    // 控制器 mock：捕获 seek/rate。
    const seekCalls: number[] = [];
    const rateCalls: number[] = [];
    let playCalls = 0;
    const installController = () => {
        seekCalls.length = 0;
        rateCalls.length = 0;
        playCalls = 0;
        useTransport.getState().registerAudioController({
            unlock: async () => {},
            play: async () => {
                playCalls += 1;
            },
            resume: async () => {
                playCalls += 1;
            },
            pause: () => {},
            seek: (t: number) => {
                seekCalls.push(t);
            },
            setPlaybackRate: (r: number) => {
                rateCalls.push(r);
            },
        } as never);
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
        ttsSynthCount = 0;
        checkpointSpeeds.length = 0;
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
        installController();
    };

    const readExpanded = () => {
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
        ) as unknown as {
            title: string;
            voiceLabel: string;
            paragraph: { current: number; total: number };
            timeline: { mode: string; currentTime: number; duration: number };
            playbackRate: number;
            primaryAction: string;
            sessionStatus: string;
        };
    };

    const readMini = () => {
        const s = useSession.getState() as unknown as Record<string, unknown>;
        const t = useTransport.getState() as unknown as Record<string, unknown>;
        return miniDeriveMod.deriveMiniNowPlayingViewModel(
            {
                source: s.source,
                status: s.status,
                title: s.title,
                lastCompletedParagraphIndex: s.lastCompletedParagraphIndex,
                nextParagraphIndex: s.nextParagraphIndex,
                totalParagraphs: s.totalParagraphs,
            },
            { isPlaying: t.isPlaying, currentTime: t.currentTime, duration: t.duration },
            'compact-docked'
        ) as unknown as { title: string; status: string };
    };

    console.log('=== M7-02-I1: seek 前后 sessionId/source 不变 + 不误写段落（验收 1/10） ===');
    {
        resetAll();
        seedWorkSession();
        const before = {
            sessionId: useSession.getState().sessionId as string | null,
            source: JSON.stringify(useSession.getState().source),
            next: useSession.getState().nextParagraphIndex as number,
            total: useSession.getState().totalParagraphs as number,
            hash: useSession.getState().contentHash as string,
            paragraphs: JSON.stringify(useSession.getState().paragraphs),
        };
        const ok = flowMod.seekCurrentSegment(50);
        assert.strictEqual(ok, true, '合法 seek 应返回 true');
        assert.deepStrictEqual(seekCalls, [50], 'controller.seek 精确 50');
        const after = {
            sessionId: useSession.getState().sessionId as string | null,
            source: JSON.stringify(useSession.getState().source),
            next: useSession.getState().nextParagraphIndex as number,
            total: useSession.getState().totalParagraphs as number,
            hash: useSession.getState().contentHash as string,
            paragraphs: JSON.stringify(useSession.getState().paragraphs),
        };
        assert.deepStrictEqual(after, before, 'seek 不得改变 sessionId/source/段落 identity（验收 1/10）');
        // 相对 seek 同样不改变。
        seekCalls.length = 0;
        const okRel = flowMod.seekRelative(5);
        assert.strictEqual(okRel, true);
        assert.deepStrictEqual(seekCalls, [25], '20+5 → 25（当前 Transport currentTime 仍为 20，因 mock seek 不回写，需手动同步？此处 Flow 读 20）');
        const afterRel = {
            sessionId: useSession.getState().sessionId as string | null,
            source: JSON.stringify(useSession.getState().source),
        };
        assert.strictEqual(afterRel.sessionId, before.sessionId);
        assert.strictEqual(afterRel.source, before.source);
        console.log('PASS: M7-02-I1 seek purity');
    }

    console.log('=== M7-02-I2: seek 全 clamp + fail-safe（验收 2） ===');
    {
        resetAll();
        seedWorkSession();
        seekCalls.length = 0;
        // 越界钳制。
        assert.strictEqual(flowMod.seekCurrentSegment(150), true);
        assert.deepStrictEqual(seekCalls, [100], '150 → clamp 100');
        seekCalls.length = 0;
        assert.strictEqual(flowMod.seekCurrentSegment(-20), true);
        assert.deepStrictEqual(seekCalls, [0], '-20 → clamp 0');
        // fail-safe：duration=0 时 no-op，不触 controller。
        useTransport.setState({ duration: 0, currentTime: 0 });
        seekCalls.length = 0;
        assert.strictEqual(flowMod.seekCurrentSegment(10), false, 'duration=0 应 no-op');
        assert.deepStrictEqual(seekCalls, [], 'fail-safe 不触 controller');
        assert.strictEqual(flowMod.seekRelative(5), false, '相对 seek 同样 fail-safe');
        // 非法输入 no-op。
        useTransport.setState({ duration: 100, currentTime: 20 });
        seekCalls.length = 0;
        assert.strictEqual(flowMod.seekCurrentSegment(Number.NaN), false);
        assert.deepStrictEqual(seekCalls, [], 'NaN no-op');
        console.log('PASS: M7-02-I2 clamp fail-safe');
    }

    console.log('=== M7-02-I3: speed 三同步 + 不写回 UserConfig + 不触发 TTS（验收 4/5） ===');
    {
        resetAll();
        seedWorkSession();
        configMod.useConfigStore.setState((prev) => {
            const p = prev as unknown as { apiConfig: Record<string, unknown> };
            return { apiConfig: { ...p.apiConfig, playDuration: 30, voiceId: 'alloy', speed: 1.0 } };
        });
        const configBefore = JSON.stringify((configMod.useConfigStore.getState() as unknown as { apiConfig: unknown }).apiConfig);
        ttsSynthCount = 0;
        rateCalls.length = 0;
        await flowMod.setPlaybackRate(1.5);
        assert.strictEqual(useSession.getState().speed as number, 1.5, 'Session.speed 同步');
        assert.strictEqual(useTransport.getState().playbackRate as number, 1.5, 'Transport.playbackRate 同步');
        assert.ok(rateCalls.includes(1.5), 'controller.setPlaybackRate 触达（立即作用 <audio>）');
        const configAfter = JSON.stringify((configMod.useConfigStore.getState() as unknown as { apiConfig: unknown }).apiConfig);
        assert.strictEqual(configAfter, configBefore, '不得写回 UserConfig 默认 speed（验收 4）');
        assert.strictEqual(ttsSynthCount, 0, 'speed 不触发新 TTS（验收 5）');
        // ViewModel 即时反映。
        const vm = readExpanded();
        assert.strictEqual(vm.playbackRate, 1.5, 'Expanded 即时显示 1.5x');
        // 非法值 no-op。
        await flowMod.setPlaybackRate(9.9);
        assert.strictEqual(useSession.getState().speed as number, 1.5, '非法值忽略');
        console.log('PASS: M7-02-I3 speed sync');
    }

    console.log('=== M7-02-I3b: speed checkpoint 去重修正（同 paragraph 改 speed 必须真实落盘；Blocking 2） ===');
    {
        resetAll();
        seedWorkSession();
        installController();
        useSession.getState().setStatus('paused');
        // 1) 首次 normal checkpoint 落盘（同 paragraph 位置）。
        checkpointSpeeds.length = 0;
        await useSession.getState().saveCheckpointImmediate({ forceReset: false });
        const savesAfterFirst = checkpointSpeeds.length;
        assert.ok(savesAfterFirst >= 1, '首次 checkpoint 必须落盘');
        assert.strictEqual(checkpointSpeeds[checkpointSpeeds.length - 1], 1.0, '首保携带初始 speed');
        // 2) 同 paragraph 内改 speed：dedupe key 若不含 speed 会被误去重（Blocking 2 场景）。
        await flowMod.setPlaybackRate(1.5);
        assert.ok(
            checkpointSpeeds.length > savesAfterFirst,
            '同 paragraph 改 speed 必须触发新落盘（不得被 position-only dedupe 吞掉）'
        );
        assert.strictEqual(checkpointSpeeds[checkpointSpeeds.length - 1], 1.5, '落盘携带新 speed（server Anchor 即时更新）');
        // 3) 同段落同 speed 重复保存：正常去重（不重复落盘）。
        const savesAfterSpeed = checkpointSpeeds.length;
        await useSession.getState().saveCheckpointImmediate({ forceReset: false });
        assert.strictEqual(checkpointSpeeds.length, savesAfterSpeed, '同位置同 speed 仍去重');
        // 4) rehydrate 复读：以 server 侧新值（speed 1.5）水合后，本地即新 speed（刷新不回退）。
        const ok = await useSession.getState().hydrateFromAnchor(
            {
                sessionId: WORK_SESSION_ID,
                source: { kind: 'work', workId: 481 },
                state: 'ready',
                title: '月球上的小狐狸',
                contentHash: 'hash-seed',
                segmentationVersion: 'v1',
                lastCompletedParagraphIndex: 0,
                nextParagraphIndex: 1,
                totalParagraphs: 4,
                voiceId: 'alloy',
                speed: 1.5,
                remainingAllowedMs: null,
                totalAllowedMs: null,
                updatedAt: new Date().toISOString(),
            } as Record<string, unknown>,
            {
                getWork: async () => ({
                    title: '月球上的小狐狸',
                    storyText: STORY_2,
                    voiceId: 'alloy',
                    contentHash: 'hash-seed',
                }),
                ensureChatLoaded: async () => {},
            }
        );
        assert.strictEqual(ok, true, 'rehydrate 成功');
        assert.strictEqual(useSession.getState().speed as number, 1.5, 'rehydrate 后仍为新 speed（刷新不回退）');
        assert.strictEqual(useTransport.getState().playbackRate as number, 1.5, 'rehydrate 同步 Transport');
        console.log('PASS: M7-02-I3b speed checkpoint dedupe');
    }

    console.log('=== M7-02-I4: rehydrate 无特殊分支 + rate/badge 即时（验收 6/7） ===');
    {
        resetAll();
        installController();
        // 经 hydrateFromAnchor 水合 paused + speed 1.1 + paragraph 4/12 形态（注入 fake work）。
        const anchor = {
            sessionId: WORK_SESSION_ID,
            source: { kind: 'work', workId: 999 },
            state: 'ready',
            title: '水合故事',
            contentHash: 'hash-x',
            segmentationVersion: 'v1',
            lastCompletedParagraphIndex: 2,
            nextParagraphIndex: 3,
            totalParagraphs: 12,
            voiceId: 'alloy',
            speed: 1.1,
            remainingAllowedMs: null,
            totalAllowedMs: null,
            updatedAt: new Date().toISOString(),
        };
        const ok = await useSession.getState().hydrateFromAnchor(anchor, {
            getWork: async () => ({
                title: '水合故事',
                storyText: STORY_2,
                voiceId: 'alloy',
                contentHash: 'hash-x',
            }),
        } as unknown as Record<string, unknown>);
        // STORY_2 仅 2 段，totalParagraphs 将按真实切分重算（>=1），不强断 12；关键断言 rate/status/无分支。
        assert.strictEqual(ok, true, '水合应成功');
        assert.strictEqual(useSession.getState().status as string, 'ready', '水合后 ready（无特殊分支）');
        assert.strictEqual(useTransport.getState().playbackRate as number, 1.1, 'rehydrate 即时同步 Transport rate（§61）');
        const vm = readExpanded();
        assert.strictEqual(vm.playbackRate, 1.1, 'Expanded 显示 1.1x');
        assert.strictEqual(vm.voiceLabel, '小雅', 'voice 经 Session.voiceId lookup');
        assert.strictEqual(vm.sessionStatus, 'ready');
        assert.strictEqual(vm.primaryAction, 'play', 'ready → play（无需 isRehydratedReady 分支）');
        // 源码级：ViewModel/Expanded 不读 isRehydratedReady（验收 6）。
        const vmSrc = (await import('node:fs')).readFileSync(path.join(repoRoot, 'components/NowPlaying/useExpandedNowPlayingViewModel.ts'), 'utf8');
        assert.ok(!vmSrc.includes('isRehydratedReady'), 'ViewModel 无 rehydrated 分支');
        console.log('PASS: M7-02-I4 rehydrate');
    }

    console.log('=== M7-02-I5: Draft restart 新 UUID + finite + 到结尾不续写（验收 8；Blocking 1 契约） ===');
    {
        resetAll();
        // Draft 会话：显式 extendable 起播，restart 后必须走 server 新 UUID 并强制 finite。
        useSession.getState().setActiveStory({
            source: { kind: 'draft', messageId: 'msg_draft_restart_01' },
            sessionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d480',
            title: '草稿故事',
            storyText: STORY_2,
            voiceId: 'alloy',
            speed: 1.0,
            continuationMode: 'extendable',
        });
        useSession.getState().setStatus('paused');
        installController();
        ttsSynthCount = 0;
        const sessionBefore = useSession.getState().sessionId as string;
        // 桩 beginPlayback：模拟 server draft restart（新 UUID + position 0；canonical snapshot 随行）。
        let beginArgs: Record<string, unknown> | null = null;
        const originalBegin = useSession.getState().beginPlayback;
        (useSession as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
            beginPlayback: async (params: Record<string, unknown>) => {
                beginArgs = params as Record<string, unknown>;
                assert.strictEqual((params.source as { kind: string }).kind, 'draft', 'Draft restart 源为 draft');
                assert.strictEqual(params.mode, 'restart', 'Draft restart 必须 mode=restart（新 UUID）');
                const snap = params.draftSnapshot as Record<string, unknown> | undefined;
                assert.ok(snap && typeof snap.contentHash === 'string' && snap.contentHash.length > 0, 'Draft restart 携带 canonical snapshot');
                useSession.setState({
                    sessionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d489',
                    source: params.source,
                    nextParagraphIndex: 0,
                    lastCompletedParagraphIndex: -1,
                    status: 'ready',
                });
            },
        });
        await useSession.getState().restart();
        assert.ok(beginArgs !== null, 'Draft restart 必须经 beginPlayback（server-authoritative，Blocking 1）');
        assert.notStrictEqual(useSession.getState().sessionId as string, sessionBefore, 'Draft restart 新 UUID（Blocking 1 契约）');
        assert.strictEqual(useSession.getState().nextParagraphIndex as number, 0, 'Draft restart 回 0');
        assert.strictEqual(useSession.getState().continuationMode as string, 'finite', 'Draft restart 强制 finite（§38.1）');
        assert.ok(playCalls >= 1, 'restart 必须出声（首段合成）');
        // 到结尾不触发 AI continuation：finite 唯一门关闭。
        assert.strictEqual(flowMod.shouldAllowAiContinuation('finite'), false, 'finite 禁止 continuation');
        assert.strictEqual(flowMod.shouldAllowAiContinuation('extendable'), true, 'sanity：extendable 才允许');
        (useSession as unknown as { setState: (p: Record<string, unknown>) => void }).setState({ beginPlayback: originalBegin });
        console.log('PASS: M7-02-I5 draft restart new uuid finite');
    }

    console.log('=== M7-02-I6: Work restart 新 UUID + position 0（验收 1/8，§38/§73） ===');
    {
        resetAll();
        seedWorkSession();
        const oldId = useSession.getState().sessionId as string;
        // 桩 beginPlayback：模拟 server restart（新 UUID + position 0 + completedAt 保留由 server 持有）。
        let beginArgs: Record<string, unknown> | null = null;
        const originalBegin = useSession.getState().beginPlayback;
        (useSession as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
            beginPlayback: async (params: Record<string, unknown>) => {
                beginArgs = params as Record<string, unknown>;
                assert.strictEqual((params.source as { kind: string }).kind, 'work', 'Work restart 源不变');
                assert.strictEqual(params.mode, 'restart', '必须 mode=restart（新 UUID）');
                // 模拟 server 返回新 Anchor：新 UUID + position 0。
                const newId = 'a47ac10b-58cc-4372-a567-0e02b2c3d481';
                useSession.setState({
                    sessionId: newId,
                    source: params.source,
                    nextParagraphIndex: 0,
                    lastCompletedParagraphIndex: -1,
                    status: 'ready',
                });
            },
        });
        installController();
        ttsSynthCount = 0;
        await useSession.getState().restart();
        assert.ok(beginArgs !== null, 'Work restart 必须经 beginPlayback');
        assert.strictEqual((beginArgs as unknown as { mode: string }).mode, 'restart');
        const newId = useSession.getState().sessionId as string;
        assert.notStrictEqual(newId, oldId, 'Work restart 新 UUID（验收 8/§73）');
        assert.strictEqual(useSession.getState().nextParagraphIndex as number, 0, 'position 0');
        // 恢复原方法，避免污染后续。
        (useSession as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
            beginPlayback: originalBegin,
        });
        console.log('PASS: M7-02-I6 work restart new uuid');
    }

    console.log('=== M7-02-I6b: Work restart server 失败 → 保持旧 session + error surfaced（Blocking 1 验收） ===');
    {
        resetAll();
        seedWorkSession();
        const oldId = useSession.getState().sessionId as string;
        const originalBegin = useSession.getState().beginPlayback;
        (useSession as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
            beginPlayback: async () => {
                throw new Error('server unavailable');
            },
        });
        let threw = false;
        try {
            await useSession.getState().restart();
        } catch {
            threw = true;
        }
        assert.strictEqual(threw, true, 'Work restart 失败必须向上抛错（error surfaced）');
        assert.strictEqual(useSession.getState().sessionId as string, oldId, '失败保持旧 sessionId（绝不本地伪造 Session）');
        assert.ok(useSession.getState().source !== null, 'source 保持原样');
        (useSession as unknown as { setState: (p: Record<string, unknown>) => void }).setState({ beginPlayback: originalBegin });
        console.log('PASS: M7-02-I6b work restart fail-closed');
    }

    console.log('=== M7-02-I7: Mini/Expanded 同源即时同步（验收 9 变体：同 Session/Transport） ===');
    {
        resetAll();
        seedWorkSession();
        // 一边操作 Transport，另一边 ViewModel 即时反映。
        useTransport.setState({ currentTime: 75 });
        const mini = readMini();
        const expanded = readExpanded();
        assert.strictEqual(mini.title, '月球上的小狐狸', 'Mini 标题同源');
        assert.strictEqual(expanded.title, '月球上的小狐狸', 'Expanded 标题同源（Title 走 M5）');
        assert.strictEqual(expanded.timeline.currentTime, 75, 'Expanded timeline 即时跟随 Transport');
        assert.strictEqual(expanded.timeline.mode, 'segment', '恒 segment（不伪装整篇）');
        assert.strictEqual(expanded.paragraph.current, 1, '段落 identity 来自 Session（未被 Transport 污染）');
        // speed 一边改，两边同 Session。
        await flowMod.setPlaybackRate(1.1);
        assert.strictEqual(readExpanded().playbackRate, 1.1, 'Expanded 跟随 Session.speed');
        assert.strictEqual(useSession.getState().speed as number, 1.1, 'Session 单一事实源');
        // pause 一边停，两边状态一致。
        flowMod.pausePlayback();
        assert.strictEqual(useSession.getState().status as string, 'paused');
        assert.strictEqual(readExpanded().sessionStatus, 'paused');
        assert.strictEqual(readMini().status, 'paused');
        console.log('PASS: M7-02-I7 mini expanded sync');
    }

    globalThis.fetch = originalFetch;
    urlStatics.createObjectURL = originalCreateObjectURL;
    resetAll();
    console.log('\nALL EXPANDED PLAYBACK CAPABILITIES INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runExpandedPlaybackIntegration()
    .then(() => {
        console.log('ALL EXPANDED PLAYBACK CAPABILITIES INTEGRATION TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Expanded playback capabilities integration test failed:', error);
        process.exit(1);
    });

export default testPromise;
