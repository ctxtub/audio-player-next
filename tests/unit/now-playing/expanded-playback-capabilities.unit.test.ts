import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 中文注释：M7-02 P3A Playback Capabilities 单测（L1，纯函数 + 架构守卫，不触库/网络）。
// 锁定验收 2/3/4/5/6/7/9/10 的确定性切面：seek clamp/fail-safe、ARIA slider、
// 七档倍速、ViewModel segment 形态、paragraph badge、无 Prev/Next、
// 无 isRehydratedReady 分支、UI 不碰 identity、Facade 唯一委托 M5。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

const readRepoText = (rel: string): string =>
    fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const loadViaJiti = (rel: string): Record<string, unknown> => {
    const factory = nodeRequire('jiti') as unknown as (
        base: string,
        opts: Record<string, unknown>
    ) => (id: string) => Record<string, unknown>;
    const inner = factory(path.join(process.cwd(), 'index.js'), {
        alias: { '@': process.cwd() },
        jsx: true,
    });
    return inner(rel.startsWith('./') || rel.startsWith('../') ? rel : `./${rel}`);
};

const installUnitStubs = (): void => {
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
    const cache = (nodeRequire as unknown as { cache: Record<string, NodeModule> }).cache;
    const glassToastPath = path.resolve(process.cwd(), 'components/ui/GlassToast.tsx');
    if (!cache[glassToastPath]) {
        cache[glassToastPath] = {
            id: glassToastPath,
            filename: glassToastPath,
            loaded: true,
            exports: { default: { show: () => {}, clear: () => {} } },
        } as unknown as NodeModule;
    }
};

const stripComments = (src: string): string =>
    src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1');

async function runExpandedPlaybackCapabilitiesUnit(): Promise<void> {
    installUnitStubs();

    console.log('=== M7-02-U1: Transport seek clamp + fail-safe（验收 2，spec §17.3） ===');
    {
        const store = loadViaJiti('./stores/playbackStore.ts') as unknown as {
            clampSegmentSeekTarget: (t: number, d: number) => number | null;
        };
        const clamp = store.clampSegmentSeekTarget;
        assert.strictEqual(clamp(50, 100), 50, '段内正常值直通');
        assert.strictEqual(clamp(-5, 100), 0, '负数钳制 0');
        assert.strictEqual(clamp(150, 100), 100, '超 duration 钳制 duration');
        assert.strictEqual(clamp(0, 100), 0, '0 保持');
        assert.strictEqual(clamp(100, 100), 100, 'duration 本身保持');
        assert.strictEqual(clamp(5, 0), null, 'duration=0 fail-safe no-op');
        assert.strictEqual(clamp(5, -1), null, '负 duration fail-safe');
        assert.strictEqual(clamp(Number.NaN, 100), null, 'NaN target fail-safe');
        assert.strictEqual(clamp(5, Number.NaN), null, 'NaN duration fail-safe');
        assert.strictEqual(clamp(5, Number.POSITIVE_INFINITY), null, '无限 duration fail-safe');
        // seekAudio 本体必须经 clamp（源码守卫）。
        const storeSrc = stripComments(readRepoText('stores/playbackStore.ts'));
        assert.ok(storeSrc.includes('clampSegmentSeekTarget'), 'seekAudio 必须经 clamp');
        assert.ok(storeSrc.includes('seekAudio'), 'Transport 保留 seekAudio');
        console.log('PASS: M7-02-U1 clamp fail-safe');
    }

    console.log('=== M7-02-U2: Timeline 点击换算 + 键盘映射（验收 2/3，§17.1/§17.2） ===');
    {
        const tl = loadViaJiti('./components/NowPlaying/PlaybackTimeline.tsx') as unknown as {
            resolveClickSeekTarget: (i: { clientX: number; trackLeft: number; trackWidth: number; duration: number }) => number | null;
            resolveKeyboardSeekTarget: (i: { key: string; currentTime: number; duration: number }) => number | null;
            formatSegmentTime: (s: number) => string;
            EXPANDED_TIMELINE_MODE: string;
            EXPANDED_TIMELINE_KEYBOARD_STEP_SECONDS: number;
        };
        assert.strictEqual(tl.EXPANDED_TIMELINE_MODE, 'segment', 'P3A 恒 segment');
        assert.strictEqual(tl.EXPANDED_TIMELINE_KEYBOARD_STEP_SECONDS, 5, '步进 ±5s');
        assert.strictEqual(tl.resolveClickSeekTarget({ clientX: 50, trackLeft: 0, trackWidth: 100, duration: 100 }), 50, '点击 50% → 50s');
        assert.strictEqual(tl.resolveClickSeekTarget({ clientX: -10, trackLeft: 0, trackWidth: 100, duration: 100 }), 0, '越左钳制 0（Flow 二次 clamp 前）');
        assert.strictEqual(tl.resolveClickSeekTarget({ clientX: 200, trackLeft: 0, trackWidth: 100, duration: 100 }), 100, '越右钳制 duration');
        assert.strictEqual(tl.resolveClickSeekTarget({ clientX: 50, trackLeft: 0, trackWidth: 0, duration: 100 }), null, '零宽 fail-safe');
        assert.strictEqual(tl.resolveClickSeekTarget({ clientX: 50, trackLeft: 0, trackWidth: 100, duration: 0 }), null, '零时长 fail-safe');
        assert.strictEqual(tl.resolveKeyboardSeekTarget({ key: 'ArrowRight', currentTime: 20, duration: 100 }), 25, 'Right +5');
        assert.strictEqual(tl.resolveKeyboardSeekTarget({ key: 'ArrowUp', currentTime: 20, duration: 100 }), 25, 'Up +5');
        assert.strictEqual(tl.resolveKeyboardSeekTarget({ key: 'ArrowLeft', currentTime: 20, duration: 100 }), 15, 'Left -5');
        assert.strictEqual(tl.resolveKeyboardSeekTarget({ key: 'ArrowDown', currentTime: 20, duration: 100 }), 15, 'Down -5');
        assert.strictEqual(tl.resolveKeyboardSeekTarget({ key: 'Home', currentTime: 20, duration: 100 }), 0, 'Home 段首');
        assert.strictEqual(tl.resolveKeyboardSeekTarget({ key: 'End', currentTime: 20, duration: 100 }), 100, 'End 段尾');
        assert.strictEqual(tl.resolveKeyboardSeekTarget({ key: ' ', currentTime: 20, duration: 100 }), null, '未知键忽略（不抢 Space 全局，§41）');
        assert.strictEqual(tl.resolveKeyboardSeekTarget({ key: 'Enter', currentTime: 20, duration: 100 }), null, 'Enter 忽略');
        assert.strictEqual(tl.formatSegmentTime(84), '1:24', '84s → 1:24');
        assert.strictEqual(tl.formatSegmentTime(136), '2:16', '136s → 2:16');
        assert.strictEqual(tl.formatSegmentTime(0), '0:00', '0 → 0:00');
        assert.strictEqual(tl.formatSegmentTime(Number.NaN), '0:00', 'NaN 回退');
        console.log('PASS: M7-02-U2 click keyboard');
    }

    console.log('=== M7-02-U3: ARIA slider 完整 + 本段标签（验收 3，§17.2/§68） ===');
    {
        const src = stripComments(readRepoText('components/NowPlaying/PlaybackTimeline.tsx'));
        for (const token of ['role="slider"', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext', 'aria-label', 'aria-disabled', 'tabIndex']) {
            assert.ok(src.includes(token), `Timeline 必须含 ${token}`);
        }
        assert.ok(src.includes('本段'), '必须明确“本段”（不伪装整篇）');
        assert.ok(!src.includes('整篇'), '不得出现整篇文案');
        assert.ok(src.includes('EXPANDED_TIMELINE_ARIA_LABEL'), 'ARIA 标签须为具名常量');
        // 禁止 story-level 形态混入 P3A。
        assert.ok(!src.includes("mode === 'story'") && !src.includes('mode=\'story\''), 'P3A 不得含 story 形态分支');
        assert.ok(!src.includes('storyTimeline'), 'P3A 不得 import storyTimeline（M8 P3B）');
        console.log('PASS: M7-02-U3 aria segment');
    }

    console.log('=== M7-02-U4: 七档倍速冻结（验收 4/5，§20） ===');
    {
        const rate = loadViaJiti('./components/NowPlaying/PlaybackRateControl.tsx') as unknown as {
            EXPANDED_PLAYBACK_RATES: ReadonlyArray<{ value: number; label: string }>;
            isSupportedPlaybackRate: (r: number) => boolean;
            formatPlaybackRateLabel: (r: number) => string;
        };
        const values = rate.EXPANDED_PLAYBACK_RATES.map((e) => e.value);
        assert.deepStrictEqual(values, [0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.5], '七档与旧 AudioPlayer 一致');
        assert.strictEqual(rate.isSupportedPlaybackRate(1.0), true);
        assert.strictEqual(rate.isSupportedPlaybackRate(2.0), false, '非七档不派发');
        assert.strictEqual(rate.formatPlaybackRateLabel(1.1), '1.1x');
        const src = stripComments(readRepoText('components/NowPlaying/PlaybackRateControl.tsx'));
        assert.ok(src.includes('currentRate'), '受控组件：currentRate prop（无本地 speed state）');
        assert.ok(!src.includes('usePlaybackSessionStore'), 'RateControl 不得直读 Session');
        assert.ok(!src.includes('usePlaybackStore'), 'RateControl 不得直读 Transport');
        assert.ok(!src.includes('useConfigStore'), 'RateControl 不得读 Config');
        assert.ok(!src.includes('useState') || src.includes('showMenu'), '仅允许菜单开关局部 state，不允许 speed state');
        assert.ok(!src.includes('speed)') || src.includes('currentRate') || src.includes('onSelect'), 'sanity');
        // 无本地 speed state：禁止出现 speed useState。
        assert.ok(!/useState\s*\(\s*1(\.0)?\s*\)/.test(src), '禁止 useState(1.0) 本地倍速');
        console.log('PASS: M7-02-U4 seven rates controlled');
    }

    console.log('=== M7-02-U5: 主动作映射 + 无 Prev/Next（验收 9，§40/§41） ===');
    {
        const controls = loadViaJiti('./components/NowPlaying/PlaybackControls.tsx') as unknown as {
            deriveExpandedPlaybackAction: (s: string) => string;
        };
        assert.strictEqual(controls.deriveExpandedPlaybackAction('playing'), 'pause');
        assert.strictEqual(controls.deriveExpandedPlaybackAction('paused'), 'play');
        assert.strictEqual(controls.deriveExpandedPlaybackAction('ready'), 'play');
        assert.strictEqual(controls.deriveExpandedPlaybackAction('ended'), 'restart');
        assert.strictEqual(controls.deriveExpandedPlaybackAction('error'), 'retry');
        assert.strictEqual(controls.deriveExpandedPlaybackAction('synthesizing'), 'disabled');
        assert.strictEqual(controls.deriveExpandedPlaybackAction('hydrating'), 'disabled');
        assert.strictEqual(controls.deriveExpandedPlaybackAction('idle'), 'disabled');
        const src = stripComments(readRepoText('components/NowPlaying/PlaybackControls.tsx'));
        assert.ok(!src.includes('上一段'), '明确不新增上一段');
        assert.ok(!src.includes('下一段'), '明确不新增下一段');
        assert.ok(!src.includes('prev') || src.includes('prevent'), '不得含 prev 段落回调（preventDefault 除外）');
        // next 仅允许 nextParagraphIndex 注释？Controls 自身不得出现段落切换语义。
        assert.ok(!src.includes('nextParagraph'), 'Controls 不得触段落 identity');
        assert.ok(!src.includes('Space'), '不得增加 Space 全局监听（§41）');
        assert.ok(src.includes('后退 5 秒') && src.includes('前进 5 秒'), '±5s 为 Segment seek 按钮（非段落跳转）');
        assert.ok(src.includes('从头播放'), '保留从头播放');
        console.log('PASS: M7-02-U5 action no-prev-next');
    }

    console.log('=== M7-02-U6: ViewModel P3A 增补（验收 7，§14/§39/§68） ===');
    {
        const vm = loadViaJiti('./components/NowPlaying/useExpandedNowPlayingViewModel.ts') as unknown as {
            deriveExpandedTimeline: (c: number, d: number) => { mode: string; currentTime: number; duration: number };
            deriveExpandedPlaybackRate: (s: unknown, t: unknown) => number;
            deriveExpandedCanRestart: (source: unknown, status: string) => boolean;
            deriveExpandedNowPlayingViewModel: (
                s: Record<string, unknown>,
                t: Record<string, unknown>,
                o: Array<{ value: string; label: string }>
            ) => Record<string, unknown>;
        };
        assert.deepStrictEqual(vm.deriveExpandedTimeline(84, 136), { mode: 'segment', currentTime: 84, duration: 136 });
        assert.deepStrictEqual(vm.deriveExpandedTimeline(200, 100), { mode: 'segment', currentTime: 100, duration: 100 }, '越界钳制');
        assert.deepStrictEqual(vm.deriveExpandedTimeline(5, 0), { mode: 'segment', currentTime: 0, duration: 0 }, '未知 fail-safe');
        assert.strictEqual(vm.deriveExpandedPlaybackRate(1.1, 1.0), 1.1, 'Session.speed 优先');
        assert.strictEqual(vm.deriveExpandedPlaybackRate(Number.NaN, 1.5), 1.5, '非法 Session 回退 Transport');
        assert.strictEqual(vm.deriveExpandedPlaybackRate(undefined, undefined), 1.0, '双非法回退 1.0');
        assert.strictEqual(vm.deriveExpandedCanRestart({ kind: 'work', workId: 1 }, 'paused'), true);
        assert.strictEqual(vm.deriveExpandedCanRestart(null, 'paused'), false);
        assert.strictEqual(vm.deriveExpandedCanRestart({ kind: 'work', workId: 1 }, 'idle'), false);
        const full = vm.deriveExpandedNowPlayingViewModel(
            { source: { kind: 'work', workId: 7 }, status: 'paused', title: '故事', voiceId: 'v1', nextParagraphIndex: 3, totalParagraphs: 12, speed: 1.1 },
            { isPlaying: false, currentTime: 84, duration: 136, playbackRate: 1.1 },
            [{ value: 'v1', label: '小雅' }]
        ) as unknown as {
            timeline: { mode: string };
            playbackRate: number;
            primaryAction: string;
            canRestart: boolean;
            isPlaying: boolean;
            title: string;
            voiceLabel: string;
            paragraph: { current: number; total: number };
        };
        assert.strictEqual(full.timeline.mode, 'segment', 'timeline 恒 segment');
        assert.strictEqual(full.playbackRate, 1.1, 'playbackRate 取 Session.speed');
        assert.strictEqual(full.primaryAction, 'play', 'paused → play');
        assert.strictEqual(full.canRestart, true);
        assert.strictEqual(full.title, '故事');
        assert.strictEqual(full.voiceLabel, '小雅');
        assert.deepStrictEqual(full.paragraph, { current: 4, total: 12 }, '第 4/12 段');
        // M7-01 兼容：旧三参调用仍合法（speed 缺省）。
        const legacy = vm.deriveExpandedNowPlayingViewModel(
            { source: { kind: 'work', workId: 7 }, status: 'ended', title: '故事', voiceId: 'v1', nextParagraphIndex: 1, totalParagraphs: 2 },
            { isPlaying: false, currentTime: 0.5, duration: 1 },
            [{ value: 'v1', label: '小雅' }]
        ) as unknown as { playbackRate: number; primaryAction: string };
        assert.strictEqual(legacy.playbackRate, 1.0, '缺省 speed 回退 1.0');
        assert.strictEqual(legacy.primaryAction, 'restart', 'ended → restart');
        const vmSrc = stripComments(readRepoText('components/NowPlaying/useExpandedNowPlayingViewModel.ts'));
        assert.ok(!vmSrc.includes('isRehydratedReady'), '无 isRehydratedReady 特殊分支（§61）');
        assert.ok(!vmSrc.includes('pausePlayback') && !vmSrc.includes('seekCurrentSegment'), 'ViewModel 不得调 Flow（只派生）');
        console.log('PASS: M7-02-U6 viewmodel p3a');
    }

    console.log('=== M7-02-U7: Paragraph badge 纯展示（验收 7，§39） ===');
    {
        const para = loadViaJiti('./components/NowPlaying/ParagraphStatus.tsx') as unknown as {
            formatParagraphStatus: (c: number, t: number) => string;
        };
        assert.strictEqual(para.formatParagraphStatus(4, 12), '第 4 / 12 段');
        const src = stripComments(readRepoText('components/NowPlaying/ParagraphStatus.tsx'));
        assert.ok(src.includes('第'), 'badge 文案');
        assert.ok(!src.includes('上一段') && !src.includes('下一段'), 'badge 不带段落跳转');
        assert.ok(!src.includes('currentTime') && !src.includes('duration'), '只取 Session identity，不取 Transport 段内位置');
        console.log('PASS: M7-02-U7 paragraph badge');
    }

    console.log('=== M7-02-U8: Facade 唯一委托 M5（验收 10，§16） ===');
    {
        const src = stripComments(readRepoText('components/NowPlaying/useExpandedPlaybackControls.ts'));
        assert.ok(src.includes('pausePlayback'), 'facade 委托 pause');
        assert.ok(src.includes('resumePlayback'), 'facade 委托 resume');
        assert.ok(src.includes('restartPlayback'), 'facade 委托 restart');
        assert.ok(src.includes('flowSeekCurrentSegment') || src.includes('seekCurrentSegment'), 'facade 委托 seek');
        assert.ok(src.includes('flowSetPlaybackRate') || src.includes('setPlaybackRate'), 'facade 委托 rate');
        assert.ok(src.includes('playbackSessionFlow'), '只经 Flow');
        assert.ok(!src.includes('usePlaybackSessionStore'), '不得直写 Session');
        assert.ok(!src.includes('usePlaybackStore'), '不得直写 Transport');
        assert.ok(!src.includes('AudioController'), '不得操作 <audio>');
        assert.ok(!src.includes('useConfigStore'), '不得碰 Config');
        assert.ok(!src.includes('ensureSegment') && !src.includes('M8'), 'P3A 不触 M8');
        // Flow 侧所有权：seek 只动 Transport，rate 经 Session，restart 经 store。
        const flowSrc = stripComments(readRepoText('app/services/playbackSessionFlow.ts'));
        assert.ok(flowSrc.includes('seekCurrentSegment'), 'Flow 提供 seekCurrentSegment');
        assert.ok(flowSrc.includes('seekRelative'), 'Flow 提供 seekRelative');
        assert.ok(flowSrc.includes('setPlaybackRate'), 'Flow 提供 setPlaybackRate');
        assert.ok(flowSrc.includes('restartCurrentSession'), 'Flow 统一 restartCurrentSession 命名（§47）');
        console.log('PASS: M7-02-U8 facade ownership');
    }

    console.log('=== M7-02-U9: M5 speed/restart 所有权（验收 4/5/8，§20/§38） ===');
    {
        const sessionSrc = stripComments(readRepoText('stores/playbackSessionStore.ts'));
        assert.ok(sessionSrc.includes('setSpeed'), 'Session 提供 setSpeed additive');
        assert.ok(sessionSrc.includes('setPlaybackRate'), 'setSpeed 同步 Transport.playbackRate');
        assert.ok(sessionSrc.includes('saveCheckpointImmediate'), 'setSpeed 持久化 Anchor');
        assert.ok(!/setSpeed[\s\S]{0,800}useConfigStore/.test(sessionSrc.slice(sessionSrc.indexOf('setSpeed'))), 'setSpeed 不得写回 UserConfig（800 字符窗口内无 Config 写）');
        // 更精确：setSpeed 段内不得出现 configStore update/saveMyConfig。
        const speedSeg = sessionSrc.slice(sessionSrc.indexOf('setSpeed'), sessionSrc.indexOf('setSpeed') + 2000);
        assert.ok(!speedSeg.includes('saveMyConfig') && !speedSeg.includes('apiConfig'), 'setSpeed 段内无 Config 面');
        assert.ok(!speedSeg.includes('fetchAudio'), 'speed 不触发新 TTS（段内无合成）');
        // restart 分支：Work 经 beginPlayback restart（新 UUID），Draft 本地 finite。
        assert.ok(sessionSrc.includes("mode: 'restart'") || sessionSrc.includes('mode:\'restart\''), 'Work restart 经 server restart');
        assert.ok(sessionSrc.includes('beginPlayback'), 'restart 经 beginPlayback');
        const restartSeg = sessionSrc.slice(sessionSrc.indexOf('restart: async'), sessionSrc.indexOf('restart: async') + 2500);
        assert.ok(restartSeg.includes("kind === 'work'"), 'restart 区分 Work/Draft');
        assert.ok(restartSeg.includes('finite'), 'Draft restart 强制 finite（§38.1）');
        assert.ok(!restartSeg.includes('handleNearEnd') && !restartSeg.includes('extendable') , 'Draft restart 路径不触发 AI continuation 判定（段内无续写链）');
        // 注：extendable 字符串仅允许出现在类型定义/注释（已剥离注释），restart 段内不得出现。
        console.log('PASS: M7-02-U9 speed restart ownership');
    }

    console.log('=== M7-02-U10: UI 不碰 identity + 无 rehydrated 分支（验收 6/10） ===');
    {
        const expandedSrc = stripComments(readRepoText('components/NowPlaying/ExpandedNowPlaying.tsx'));
        assert.ok(expandedSrc.includes('PlaybackTimeline'), 'Expanded 挂载 Timeline');
        assert.ok(expandedSrc.includes('PlaybackControls'), 'Expanded 挂载 Controls');
        assert.ok(expandedSrc.includes('PlaybackRateControl'), 'Expanded 挂载 Rate');
        assert.ok(expandedSrc.includes('ParagraphStatus'), 'Expanded 挂载 Paragraph');
        assert.ok(expandedSrc.includes('useExpandedPlaybackControls'), 'Expanded 经 facade（不直调 Flow）');
        assert.ok(!expandedSrc.includes('playbackSessionFlow'), 'Expanded 本文件不直 import Flow（经 facade 间接）');
        assert.ok(!expandedSrc.includes('AudioController'), 'Expanded 不操作 <audio>');
        assert.ok(!expandedSrc.includes('isRehydratedReady'), '无 rehydrated 特殊分支');
        assert.ok(!expandedSrc.includes('StoryWork'), 'UI 不碰 StoryWork');
        assert.ok(!expandedSrc.includes('playbackProgressStore'), 'UI 不碰 legacy progress');
        assert.ok(!expandedSrc.includes('generationHistory'), 'UI 不碰 History');
        assert.ok(!expandedSrc.includes('storyFlow'), 'UI 不拼 continuation Prompt');
        for (const f of ['PlaybackTimeline.tsx', 'PlaybackControls.tsx', 'PlaybackRateControl.tsx', 'ParagraphStatus.tsx', 'useExpandedPlaybackControls.ts']) {
            const s = stripComments(readRepoText(`components/NowPlaying/${f}`));
            assert.ok(!s.includes('isRehydratedReady'), `${f} 无 rehydrated 分支`);
            assert.ok(!s.includes('StoryWork'), `${f} 不碰 StoryWork`);
            assert.ok(!s.includes('playbackProgressStore'), `${f} 不碰 legacy progress`);
        }
        console.log('PASS: M7-02-U10 ui purity');
    }

    console.log('\nALL EXPANDED PLAYBACK CAPABILITIES UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runExpandedPlaybackCapabilitiesUnit()
    .then(() => {
        console.log('ALL EXPANDED PLAYBACK CAPABILITIES UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Expanded playback capabilities unit test failed:', error);
        process.exit(1);
    });

export default testPromise;
