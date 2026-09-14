import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// 中文注释：M6-02 MiniNowPlaying Semantic Core 单测（L1，纯函数 + 源码架构守卫，不触库/网络/DOM）。
// 覆盖任务验收 1-10（DOM 渲染核验归 L2 集成，本项断言 ViewModel + 源码执行面）。
import {
    deriveMiniCoarseProgress,
    deriveMiniNowPlayingViewModel,
    deriveMiniPlaybackAction,
    deriveMiniSecondaryLabel,
    deriveMiniTitle,
    hasMiniNowPlaying,
    mapSessionStatusToMiniStatus,
} from '../../../components/NowPlaying/deriveMiniNowPlayingViewModel';
import {
    NOW_PLAYING_COMPAT_ROUTE,
    createNowPlayingEntryController,
    shouldSuppressNowPlayingEntry,
} from '../../../components/NowPlaying/useNowPlayingEntry';
import { MINI_NOW_PLAYING_FALLBACK_TITLE } from '../../../components/NowPlaying/types';

const draftSource = { kind: 'draft' } as const;
const workSource = { kind: 'work' } as const;

const baseSession = {
    source: draftSource,
    status: 'ready' as const,
    title: '月球上的小狐狸',
    lastCompletedParagraphIndex: -1,
    nextParagraphIndex: 0,
    totalParagraphs: 1,
};

const baseTransport = { isPlaying: false, currentTime: 0, duration: 0 };

const readRepoText = (rel: string): string =>
    fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

async function runMiniSemanticTests(): Promise<void> {
    console.log('=== M6-02-01: 无 current session → 不可见（派生显隐）===');
    assert.strictEqual(
        hasMiniNowPlaying({ ...baseSession, source: null, status: 'idle' }),
        false,
        'source null + idle → hidden'
    );
    assert.strictEqual(
        hasMiniNowPlaying({ ...baseSession, source: null, status: 'ready' }),
        false,
        'source null 即使 ready → hidden（不得以 transport 有轨为由显示）'
    );
    assert.strictEqual(
        hasMiniNowPlaying({ ...baseSession, source: draftSource, status: 'idle' }),
        false,
        'idle 即使 source 非空 → hidden'
    );
    assert.strictEqual(hasMiniNowPlaying({ ...baseSession }), true, 'ready + source → visible');
    assert.strictEqual(
        hasMiniNowPlaying({ ...baseSession, status: 'playing' }),
        true,
        'playing → visible'
    );
    assert.strictEqual(
        hasMiniNowPlaying({ ...baseSession, status: 'hydrating' }),
        true,
        'hydrating（水合中）→ visible（loading 态）'
    );
    const idleVm = deriveMiniNowPlayingViewModel(
        { ...baseSession, source: null, status: 'idle' },
        baseTransport,
        'compact-docked'
    );
    assert.strictEqual(idleVm.visible, false, 'ViewModel idle → visible=false');
    assert.strictEqual(idleVm.coarseProgress, null, '不可见时 coarse=null');
    console.log('PASS: M6-02-01 derived visibility');

    console.log('=== M6-02-02: ready/playing/paused/ended 合法 Session 对应展示 ===');
    {
        const ready = deriveMiniNowPlayingViewModel(
            {
                ...baseSession,
                source: workSource,
                status: 'ready',
                lastCompletedParagraphIndex: 2,
                nextParagraphIndex: 3,
                totalParagraphs: 12,
            },
            baseTransport,
            'compact-docked'
        );
        assert.strictEqual(ready.visible, true);
        assert.strictEqual(ready.status, 'ready');
        assert.strictEqual(ready.secondaryLabel, '第 4 / 12 段');
        assert.strictEqual(ready.primaryAction, 'play');
    }
    {
        const playing = deriveMiniNowPlayingViewModel(
            {
                ...baseSession,
                status: 'playing',
                lastCompletedParagraphIndex: 2,
                nextParagraphIndex: 3,
                totalParagraphs: 12,
            },
            { isPlaying: true, currentTime: 10, duration: 100 },
            'compact-docked'
        );
        assert.strictEqual(playing.status, 'playing');
        assert.strictEqual(playing.secondaryLabel, '第 4 / 12 段');
        assert.strictEqual(playing.primaryAction, 'pause');
    }
    {
        const paused = deriveMiniNowPlayingViewModel(
            {
                ...baseSession,
                status: 'paused',
                lastCompletedParagraphIndex: 2,
                nextParagraphIndex: 3,
                totalParagraphs: 12,
            },
            baseTransport,
            'compact-docked'
        );
        assert.strictEqual(paused.status, 'paused');
        assert.strictEqual(paused.secondaryLabel, '第 4 / 12 段');
        assert.strictEqual(paused.primaryAction, 'play');
    }
    {
        const ended = deriveMiniNowPlayingViewModel(
            {
                ...baseSession,
                status: 'ended',
                lastCompletedParagraphIndex: 11,
                nextParagraphIndex: 12,
                totalParagraphs: 12,
            },
            baseTransport,
            'compact-docked'
        );
        assert.strictEqual(ended.status, 'ended');
        assert.strictEqual(ended.secondaryLabel, '播放完成');
        assert.strictEqual(ended.primaryAction, 'restart');
    }
    {
        const synth = deriveMiniNowPlayingViewModel(
            { ...baseSession, status: 'synthesizing' },
            baseTransport,
            'compact-docked'
        );
        assert.strictEqual(synth.status, 'synthesizing');
        assert.strictEqual(synth.secondaryLabel, '正在准备语音');
        assert.strictEqual(synth.primaryAction, 'disabled');
    }
    {
        const hydrating = deriveMiniNowPlayingViewModel(
            { ...baseSession, status: 'hydrating' },
            baseTransport,
            'compact-docked'
        );
        assert.strictEqual(hydrating.status, 'synthesizing', 'hydrating 映射 synthesizing');
        assert.strictEqual(hydrating.secondaryLabel, '正在准备语音');
        assert.strictEqual(hydrating.primaryAction, 'disabled');
    }
    {
        const error = deriveMiniNowPlayingViewModel(
            { ...baseSession, status: 'error' },
            baseTransport,
            'compact-docked'
        );
        assert.strictEqual(error.status, 'error');
        assert.strictEqual(error.secondaryLabel, '播放遇到问题');
        assert.strictEqual(error.primaryAction, 'retry');
    }
    // 单段 playing/paused/ready 分叉（spec §6）。
    assert.strictEqual(
        deriveMiniSecondaryLabel({ ...baseSession, status: 'playing', totalParagraphs: 1 }),
        '正在播放'
    );
    assert.strictEqual(
        deriveMiniSecondaryLabel({ ...baseSession, status: 'paused', totalParagraphs: 1 }),
        '已暂停'
    );
    assert.strictEqual(
        deriveMiniSecondaryLabel({ ...baseSession, status: 'ready', totalParagraphs: 1 }),
        '已暂停'
    );
    // Draft / Work 不分叉（§33）：同 position 同文案。
    assert.strictEqual(
        deriveMiniSecondaryLabel({
            ...baseSession,
            source: draftSource,
            status: 'playing',
            nextParagraphIndex: 1,
            totalParagraphs: 4,
        }),
        deriveMiniSecondaryLabel({
            ...baseSession,
            source: workSource,
            status: 'playing',
            nextParagraphIndex: 1,
            totalParagraphs: 4,
        })
    );
    // PrimaryAction 全矩阵。
    assert.strictEqual(deriveMiniPlaybackAction('playing'), 'pause');
    assert.strictEqual(deriveMiniPlaybackAction('ready'), 'play');
    assert.strictEqual(deriveMiniPlaybackAction('paused'), 'play');
    assert.strictEqual(deriveMiniPlaybackAction('ended'), 'restart');
    assert.strictEqual(deriveMiniPlaybackAction('error'), 'retry');
    assert.strictEqual(deriveMiniPlaybackAction('synthesizing'), 'disabled');
    assert.strictEqual(deriveMiniPlaybackAction('hydrating'), 'disabled');
    assert.strictEqual(deriveMiniPlaybackAction('idle'), 'disabled');
    assert.strictEqual(mapSessionStatusToMiniStatus('hydrating'), 'synthesizing');
    console.log('PASS: M6-02-02 status matrix');

    console.log('=== M6-02-03: title 仅取 Session.title ===');
    assert.strictEqual(deriveMiniTitle({ ...baseSession, title: '月球上的小狐狸' }), '月球上的小狐狸');
    assert.strictEqual(
        deriveMiniTitle({ ...baseSession, title: '' }),
        MINI_NOW_PLAYING_FALLBACK_TITLE,
        '空标题回退正在播放'
    );
    assert.strictEqual(
        deriveMiniTitle({ ...baseSession, title: '   ' }),
        MINI_NOW_PLAYING_FALLBACK_TITLE,
        '全空白回退正在播放'
    );
    assert.strictEqual(MINI_NOW_PLAYING_FALLBACK_TITLE, '正在播放');
    {
        const vm = deriveMiniNowPlayingViewModel(
            { ...baseSession, title: '月球上的小狐狸' },
            baseTransport,
            'compact-docked'
        );
        assert.strictEqual(vm.title, '月球上的小狐狸', 'ViewModel title 透传 Session.title');
        assert.ok(!vm.title.includes('剩余') && !vm.title.includes('断点就绪'), '标题不得为倒计时/段落文案');
    }
    {
        const miniSrc = readRepoText('components/NowPlaying/MiniNowPlaying.tsx');
        assert.ok(!miniSrc.includes('prompt.slice'), 'Mini 不得自行 prompt.slice 推导标题');
        assert.ok(!miniSrc.includes('from genotype') && !miniSrc.includes('chatStore'), 'Mini 不得读 M2/Chat 推导标题');
    }
    console.log('PASS: M6-02-03 title frozen');

    console.log('=== M6-02-04: transport 变化即时反映（订阅面 + 粗进度联动）===');
    {
        const miniSrc = readRepoText('components/NowPlaying/MiniNowPlaying.tsx');
        assert.ok(miniSrc.includes('state.isPlaying'), 'Mini 必须订阅 transport isPlaying');
        assert.ok(miniSrc.includes('state.currentTime'), 'Mini 必须订阅 transport currentTime');
        assert.ok(miniSrc.includes('state.duration'), 'Mini 必须订阅 transport duration');
        // 粗进度随 transport 变化。
        const before = deriveMiniCoarseProgress(
            { ...baseSession, lastCompletedParagraphIndex: 0, nextParagraphIndex: 1, totalParagraphs: 4 },
            { isPlaying: true, currentTime: 0, duration: 100 }
        );
        const after = deriveMiniCoarseProgress(
            { ...baseSession, lastCompletedParagraphIndex: 0, nextParagraphIndex: 1, totalParagraphs: 4 },
            { isPlaying: true, currentTime: 50, duration: 100 }
        );
        assert.ok(
            typeof before === 'number' && typeof after === 'number' && after > before,
            'currentTime 推进必须增大 coarseProgress'
        );
    }
    console.log('PASS: M6-02-04 transport reflect');

    console.log('=== M6-02-05: paragraph/transport progress 来源正确（§8.1 公式）===');
    {
        // lastCompleted=2 next=3 total=12 duration=100 currentTime=25 → (3+0.25)/12.
        const v = deriveMiniCoarseProgress(
            {
                ...baseSession,
                lastCompletedParagraphIndex: 2,
                nextParagraphIndex: 3,
                totalParagraphs: 12,
            },
            { isPlaying: true, currentTime: 25, duration: 100 }
        );
        assert.ok(v !== null && Math.abs(v - (3.25 / 12)) < 1e-9, `公式 (3+0.25)/12，实际 ${v}`);
        // duration=0 → fraction=0 → (3+0)/12.
        const noDur = deriveMiniCoarseProgress(
            {
                ...baseSession,
                lastCompletedParagraphIndex: 2,
                nextParagraphIndex: 3,
                totalParagraphs: 12,
            },
            { isPlaying: false, currentTime: 0, duration: 0 }
        );
        assert.ok(noDur !== null && Math.abs(noDur - 3 / 12) < 1e-9, '未知时长 fraction=0');
        // 单段：completed=0 fraction=0.5 → 0.5.
        const single = deriveMiniCoarseProgress(
            { ...baseSession, lastCompletedParagraphIndex: -1, nextParagraphIndex: 0, totalParagraphs: 1 },
            { isPlaying: true, currentTime: 50, duration: 100 }
        );
        assert.ok(single !== null && Math.abs(single - 0.5) < 1e-9, '单段进度=段时间分数');
        // 钳制：超界 currentTime 不得超 1。
        const clamped = deriveMiniCoarseProgress(
            { ...baseSession, lastCompletedParagraphIndex: 11, nextParagraphIndex: 12, totalParagraphs: 12 },
            { isPlaying: false, currentTime: 9999, duration: 10 }
        );
        assert.ok(clamped !== null && clamped <= 1, 'coarse 钳制 0..1');
    }
    console.log('PASS: M6-02-05 coarse formula');

    console.log('=== M6-02-06: Mini DOM/ViewModel 不出现预算字段 ===');
    {
        const vm = deriveMiniNowPlayingViewModel(
            {
                ...baseSession,
                status: 'playing',
                lastCompletedParagraphIndex: 0,
                nextParagraphIndex: 1,
                totalParagraphs: 4,
            },
            { isPlaying: true, currentTime: 10, duration: 100 },
            'compact-docked'
        );
        const keys = Object.keys(vm).sort();
        assert.deepStrictEqual(keys, [
            'coarseProgress',
            'layoutMode',
            'primaryAction',
            'secondaryLabel',
            'status',
            'title',
            'visible',
        ]);
        assert.ok(!('remainingMs' in (vm as Record<string, unknown>)), 'ViewModel 不得含 remainingMs');
        assert.ok(!JSON.stringify(vm).includes('remainingMs'), 'ViewModel 序列化不得含 remainingMs');
        for (const rel of [
            'components/NowPlaying/MiniNowPlaying.tsx',
            'components/NowPlaying/presentation.tsx',
        ]) {
            const src = readRepoText(rel);
            assert.ok(!src.includes('state.remainingMs'), `${rel} 不得读取 transport 预算字段`);
            assert.ok(!src.includes('remainingMs:'), `${rel} 不得构造预算字段`);
        }
        const deriveSrc = readRepoText('components/NowPlaying/deriveMiniNowPlayingViewModel.ts');
        // derive 允许在注释中声明排除，但执行面不得出现预算标识读取。
        assert.ok(!deriveSrc.includes('transport.remainingMs'), 'derive 不得读取 transport 预算');
        assert.ok(!deriveSrc.includes('session.remainingMs'), 'derive 不得读取 session 预算');
    }
    console.log('PASS: M6-02-06 no budget in Mini');

    console.log('=== M6-02-07: config 不影响 Mini 存在性（只影响 layoutMode）===');
    {
        const session = { ...baseSession, status: 'playing' as const };
        for (const mode of ['compact-docked', 'wide-docked', 'wide-floating'] as const) {
            const vm = deriveMiniNowPlayingViewModel(session, baseTransport, mode);
            assert.strictEqual(vm.visible, true, `${mode} 均可见`);
            assert.strictEqual(vm.layoutMode, mode, 'layoutMode 透传');
        }
        const miniSrc = readRepoText('components/NowPlaying/MiniNowPlaying.tsx');
        assert.ok(
            miniSrc.includes('desktopFloatingPlayerEnabled'),
            'Mini 必须读取桌面偏好（仅供 layoutMode）'
        );
        // visible 派生不得以偏好为条件：同一 session 下切换偏好不改变 visible。
        assert.ok(!/visible\s*=\s*.*desktopFloatingPlayerEnabled/.test(miniSrc), 'visible 公式不得含偏好');
        assert.ok(
            miniSrc.includes('useNowPlayingLayoutMode'),
            '形态必须经 M6-01 三态 hook 派生'
        );
    }
    console.log('PASS: M6-02-07 config independence');

    console.log('=== M6-02-08: openExpanded 精确 push(/player) ===');
    {
        assert.strictEqual(NOW_PLAYING_COMPAT_ROUTE, '/player');
        assert.strictEqual(shouldSuppressNowPlayingEntry('/player'), true, '/player 上 no-op');
        assert.strictEqual(shouldSuppressNowPlayingEntry('/library'), false);
        assert.strictEqual(shouldSuppressNowPlayingEntry(null), false);
        const calls: string[] = [];
        const ctl = createNowPlayingEntryController(
            (url) => {
                calls.push(url);
            },
            '/library'
        );
        ctl.openExpanded();
        assert.deepStrictEqual(calls, ['/player'], 'openExpanded 精确 push(/player)');
        calls.length = 0;
        ctl.openDetails();
        assert.deepStrictEqual(calls, ['/player'], 'openDetails 同义 push(/player)');
        const suppressed: string[] = [];
        const ctlSuppressed = createNowPlayingEntryController(
            (url) => {
                suppressed.push(url);
            },
            '/player'
        );
        ctlSuppressed.openExpanded();
        ctlSuppressed.openDetails();
        assert.deepStrictEqual(suppressed, [], '/player 上两次调用均 no-op');
        const entrySrc = readRepoText('components/NowPlaying/useNowPlayingEntry.ts');
        assert.ok(entrySrc.includes("'/player'"), 'facade 必须含精确路由字符串');
        assert.ok(!entrySrc.includes('/player/') && !entrySrc.includes('/player?'), '不得附加后缀/查询');
        const miniSrc = readRepoText('components/NowPlaying/MiniNowPlaying.tsx');
        assert.ok(miniSrc.includes('openDetails'), 'Mini 必须经 facade 打开详情');
        assert.ok(!miniSrc.includes("router.push('/player')"), 'Mini 不得硬编码路由 push');
        assert.ok(!miniSrc.includes("push('/player')"), 'Mini 不得直调 push');
    }
    console.log('PASS: M6-02-08 entry contract');

    console.log('=== M6-02-09: Mini 模块禁止 import 历史播放面 ===');
    {
        const rels = [
            'components/NowPlaying/MiniNowPlaying.tsx',
            'components/NowPlaying/deriveMiniNowPlayingViewModel.ts',
            'components/NowPlaying/presentation.tsx',
            'components/NowPlaying/useNowPlayingEntry.ts',
            'components/NowPlaying/types.ts',
        ];
        const forbiddenImports = [
            "from '@/stores/playbackProgressStore'",
            'from "@/stores/playbackProgressStore"',
            "from '@/stores/generationHistoryStore'",
            'from "@/stores/generationHistoryStore"',
            "from '@/stores/generationStore'",
            'from "@/stores/generationStore"',
        ];
        for (const rel of rels) {
            const src = readRepoText(rel);
            for (const token of forbiddenImports) {
                assert.ok(!src.includes(token), `${rel} 禁止 import ${token}`);
            }
            assert.ok(!src.includes('StoryCardPart'), `${rel} 不得引用 StoryCard`);
            assert.ok(!src.includes('usePlaybackProgressStore('), `${rel} 不得调用旧进度 store`);
            assert.ok(!src.includes('useGenerationHistoryStore('), `${rel} 不得调用历史 store`);
        }
        // Transport deprecated identity 镜像禁读（执行面；Session.title 允许，Transport.title 禁止）。
        const miniSrc = readRepoText('components/NowPlaying/MiniNowPlaying.tsx');
        for (const token of [
            'state.currentAudioUrl',
            'state.isRehydratedReady',
            'state.sourceType',
            'state.sourceId',
            'state.isOneShot',
        ]) {
            assert.ok(!miniSrc.includes(token), `Mini 不得读 Transport 镜像 ${token}`);
        }
        // Transport.title 镜像：仅当经 usePlaybackStore 读取时判违规（Session 经 usePlaybackSessionStore 读 title 合法）。
        const transportTitleReads = miniSrc
            .split('\n')
            .filter((line) => line.includes('usePlaybackStore') && line.includes('state.title'));
        assert.strictEqual(transportTitleReads.length, 0, 'Mini 不得经 Transport 读 title 镜像');
        const deriveSrc = readRepoText('components/NowPlaying/deriveMiniNowPlayingViewModel.ts');
        assert.ok(!deriveSrc.includes("from '@/stores/"), 'derive 必须保持纯函数（不 import 任何 store）');
        assert.ok(!deriveSrc.includes("from '@/lib/"), 'derive 不得 import lib 持久层');
    }
    console.log('PASS: M6-02-09 legacy import guard');

    console.log('=== M9-03: FloatingPlayer 兼容 shim 已删除（M6-04-FIXUP 到期）===');
    {
        // M9-03：兼容期结束，shim 目录物理删除；正式命名唯一（MiniNowPlaying）。
        assert.strictEqual(
            fs.existsSync(path.resolve(process.cwd(), 'components/FloatingPlayer')),
            false,
            'M9-03 必须删除 components/FloatingPlayer 兼容 shim 目录'
        );
        assert.strictEqual(
            fs.existsSync(path.resolve(process.cwd(), 'components/FloatingPlayer/index.tsx')),
            false,
            'M9-03 必须删除 FloatingPlayer/index.tsx 兼容 shim'
        );
        // store 兼容别名 useFloatingPlayer 一并删除（ChatLayout 已迁至 Transport 直调）。
        const playbackStoreSrc = readRepoText('stores/playbackStore.ts');
        assert.ok(
            !playbackStoreSrc.includes('export const useFloatingPlayer'),
            'M9-03 必须删除 useFloatingPlayer deprecated 别名导出',
        );
        const chatSrc = readRepoText('app/(main)/chat/components/ChatLayout/index.tsx');
        assert.ok(
            !chatSrc.includes('useFloatingPlayer'),
            'ChatLayout 不得再消费 useFloatingPlayer 别名',
        );
        const layoutSrc = readRepoText('app/(main)/layout.tsx');
        // M6-03 演进：Mini 已收进 MainChrome/BottomChrome slot（spec §16/§34），
        // layout 经 MainChrome 编排，不再直引 Mini；正式命名链由 BottomChrome 持有。
        // 意图不变：全局仍为正式 MiniNowPlaying，绝不回退 FloatingPlayer。
        const bottomChromeSrc = readRepoText('components/MainChrome/BottomChrome.tsx');
        assert.ok(
            layoutSrc.includes('MiniNowPlaying') || bottomChromeSrc.includes('MiniNowPlaying'),
            '全局仍须为正式 MiniNowPlaying（M6-03 经 BottomChrome slot 持有）'
        );
        assert.ok(
            layoutSrc.includes("from '@/components/MainChrome'") ||
                layoutSrc.includes("from '@/components/NowPlaying/MiniNowPlaying'"),
            'layout 必须经 MainChrome 或正式 surface 编排 Mini'
        );
        assert.ok(
            bottomChromeSrc.includes("from '@/components/NowPlaying/MiniNowPlaying'"),
            'BottomChrome 必须从正式 surface 导入 Mini'
        );
        assert.ok(!layoutSrc.includes("from '@/components/FloatingPlayer'"), 'layout 不得再走兼容路径');
        assert.ok(!bottomChromeSrc.includes("from '@/components/FloatingPlayer'"), 'BottomChrome 不得走兼容路径');
        assert.ok(
            !chatSrc.includes("from '@/components/FloatingPlayer'"),
            'chat 不得经 UI 兼容文件取 hook'
        );
    }
    console.log('PASS: M9-03 naming retirement');

    console.log('=== M6-02-G1: MiniNowPlaying 源码架构守卫 ===');
    {
        const miniSrc = readRepoText('components/NowPlaying/MiniNowPlaying.tsx');
        assert.ok(!miniSrc.includes('isFloatingVisible'), 'Mini 不得含旧显隐标记');
        assert.ok(!miniSrc.includes('isMiniVisible'), 'Mini 不得含第二套显隐');
        assert.ok(!miniSrc.includes('showPlayer') && !miniSrc.includes('showMiniPlayer'), 'Mini 不得含 show 命令');
        assert.ok(!miniSrc.includes('showFloatingPlayer'), 'Mini 不得调用旧 show');
        assert.ok(!miniSrc.includes('hideFloatingPlayer'), 'Mini 不得调用旧 hide');
        // 直接写 session 持久字段（执行面）：setState/set({ sessionId/status/continuationMode。
        assert.ok(!miniSrc.includes('setStatus'), 'Mini 不得直接写 status');
        assert.ok(!miniSrc.includes('setActiveStory'), 'Mini 不得直接写 session');
        assert.ok(!miniSrc.includes('continuationMode'), 'Mini 不得触续写模式');
        assert.ok(!/setState\([^)]*sessionId/.test(miniSrc), 'Mini 不得 setState 写 sessionId');
        assert.ok(!miniSrc.includes('usePlaybackSessionStore.setState'), 'Mini 不得直写 SessionStore');
        // Flow 委托必须存在。
        assert.ok(miniSrc.includes('pausePlayback'), 'Mini 必须委托 pausePlayback');
        assert.ok(miniSrc.includes('resumePlayback'), 'Mini 必须委托 resumePlayback');
        assert.ok(miniSrc.includes('restartPlayback'), 'Mini 必须委托 restartPlayback');
        assert.ok(miniSrc.includes('playbackSessionFlow'), 'Mini 必须经 M5 Flow');
        assert.ok(!miniSrc.includes('audioController'), 'Mini 不得直调 AudioController');
    }
    console.log('PASS: M6-02-G1 source guard');

    console.log('\nALL MINI NOW PLAYING SEMANTIC UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runMiniSemanticTests()
    .then(() => {
        console.log('ALL MINI NOW PLAYING SEMANTIC UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Mini now playing semantic test failed:', error);
        process.exit(1);
    });

export default testPromise;
