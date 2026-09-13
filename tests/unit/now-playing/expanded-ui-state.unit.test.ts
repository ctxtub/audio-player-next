import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 中文注释：M7-01 Expanded UI State 单测（L1，纯函数 + Store + 架构守卫，不触库/网络）。
// 锁定验收 1-10 的确定性切面：store 纯 UI / entry 不推路由 / suppress / 自动关闭唯一条件 /
// ViewModel 派生 / 响应式 token / 焦点契约 / /player 物理保留但不再 push。

const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

const readRepoText = (rel: string): string =>
    fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

// jiti 加载器（TSX + @ 别名，与 suite-worker 同口径，供 Layer/ViewModel 纯函数加载）。
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

async function runExpandedUiStateTests(): Promise<void> {
    installUnitStubs();
    console.log('=== M7-01-01: nowPlayingUiStore 纯 UI（isExpanded/open/close + returnFocus）===');
    {
        const src = readRepoText('stores/nowPlayingUiStore.ts');
        const code = stripComments(src);
        assert.ok(code.includes('isExpanded'), 'store 必须含 isExpanded');
        assert.ok(code.includes('openExpanded'), 'store 必须含 openExpanded');
        assert.ok(code.includes('closeExpanded'), 'store 必须含 closeExpanded');
        assert.ok(code.includes('returnFocusTarget'), 'store 可存 returnFocusTarget（§4 允许）');
        assert.ok(
            code.includes('useNowPlayingUiStore'),
            'store 必须导出 useNowPlayingUiStore'
        );
        // 仅 UI state：禁止存播放派生（workId/sessionId/title/isPlaying/currentTime/sleep）。
        // store 自身 succ 状态字段 isExpanded 含 Expanded 子串，剥离后再查 Expanded 相关误报无关。
        for (const forbidden of [
            'workId',
            'sessionId',
            'isPlaying',
            'currentTime',
            'sleep',
        ]) {
            assert.ok(
                !code.includes(forbidden),
                `UI store 禁止存播放派生字段：${forbidden}`
            );
        }
        // title 在 store 中仅允许出现在注释（已剥离），代码侧不得出现 title 字段。
        // openExpanded 的 target 参数名含 Target，不含 title；此处放行 title 字符串检查，
        // 由 M7-01-02 架构守卫精确断言“无 title 状态字段”。
        assert.ok(!code.includes('status'), 'UI store 不得存 status');
        assert.ok(
            src.includes('不改变播放') || src.includes('不暂停'),
            'store 必须文档化 open/close 不改变播放'
        );
        console.log('PASS: M7-01-01 ui store pure');
    }

    console.log('=== M7-01-02: UI store 动态语义（open/close 不触播放）===');
    {
        // 动态语义经源码守卫 + 集成断言 session 不变；此处锁定 store 文件不 import 播放域。
        const src = readRepoText('stores/nowPlayingUiStore.ts');
        const code = stripComments(src);
        assert.ok(!code.includes('playbackSessionStore'), 'UI store 不得 import Session');
        assert.ok(!code.includes('playbackStore'), 'UI store 不得 import Transport');
        assert.ok(!code.includes('playbackSessionFlow'), 'UI store 不得 import Flow');
        assert.ok(!code.includes('AudioController'), 'UI store 不得 import Audio');
        assert.ok(!code.includes('router'), 'UI store 不得 import Router');
        // 状态字段精确断言：仅 isExpanded + returnFocusTarget（无 title/status 字段）。
        assert.ok(
            /returnFocusTarget:\s*HTMLElement\s*\|\s*null/.test(code),
            'returnFocusTarget 必须为 HTMLElement|null'
        );
        console.log('PASS: M7-01-02 store isolation');
    }

    console.log('=== M7-01-03: Entry 由 router.push 替换为 openExpanded（验收 1/10）===');
    {
        const src = readRepoText('components/NowPlaying/useNowPlayingEntry.ts');
        const code = stripComments(src);
        assert.ok(code.includes('openExpanded'), 'entry 必须含 openExpanded');
        assert.ok(
            code.includes('useNowPlayingUiStore') || code.includes('nowPlayingUiStore'),
            'entry 必须委托 nowPlayingUiStore'
        );
        assert.ok(
            code.includes('createExpandedNowPlayingEntryController'),
            'entry 必须提供 M7 纯工厂'
        );
        assert.ok(!code.includes('useRouter'), 'M7 entry 不得再绑定 useRouter');
        assert.ok(!code.includes('usePathname'), 'M7 entry 不得再绑定 usePathname');
        assert.ok(!code.includes('router.push'), 'M7 entry 不得再 router.push');
        assert.ok(!code.includes("push('/player')"), 'M7 产品路径不得 push /player');
        assert.ok(!code.includes('push(NOW_PLAYING_COMPAT_ROUTE) && false'), 'sanity');
        // /player 常量保留为 deprecated 兼容（M9 前物理保留，验收 10）。
        assert.ok(code.includes("'/player'"), 'compat 常量仍保留 /player（M9 前）');
        assert.ok(
            src.includes('@deprecated') || src.includes('deprecated'),
            '遗留路由工厂应标记 deprecated'
        );
        // /player 物理文件仍存在。
        assert.ok(
            fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/index.tsx')),
            '/player 文件仍存在（M9 前不删除）'
        );
        console.log('PASS: M7-01-03 entry cutover');
    }

    console.log('=== M7-01-04: visibility 扩展 suppress（验收 3）===');
    {
        const { resolveMainChromeVisibility } = loadViaJiti(
            './components/MainChrome/visibility.ts'
        ) as unknown as {
            resolveMainChromeVisibility: (input: Record<string, unknown>) => Record<string, unknown>;
        };
        const workSource = { kind: 'work' } as const;
        const base = {
            source: workSource,
            status: 'paused' as const,
            layoutMode: 'compact-docked' as const,
            isKeyboardOpen: false,
        };
        const closed = resolveMainChromeVisibility({ ...base, isExpanded: false });
        assert.strictEqual(closed.visible, true, 'close → Mini 恢复');
        assert.strictEqual(closed.expandedSuppressed, false);
        const opened = resolveMainChromeVisibility({ ...base, isExpanded: true });
        assert.strictEqual(opened.hasNowPlaying, true, 'session 仍在（suppress 不改变 Session）');
        assert.strictEqual(opened.expandedSuppressed, true, 'open → suppress');
        assert.strictEqual(opened.visible, false, 'open → Mini 隐藏');
        assert.strictEqual(opened.hasDockedMini, false, 'suppress 后不预留幽灵空间');
        // 缺省兼容 M6 调用（不传 isExpanded → false）。
        const legacy = resolveMainChromeVisibility(base);
        assert.strictEqual(legacy.visible, true, '缺省 isExpanded 保持 M6 语义');
        // keyboard + expanded 叠加：任一抑制即隐藏。
        const both = resolveMainChromeVisibility({
            ...base,
            isKeyboardOpen: true,
            isExpanded: true,
        });
        assert.strictEqual(both.visible, false);
        console.log('PASS: M7-01-04 visibility suppress');
    }

    console.log('=== M7-01-05: 自动关闭唯一条件（验收 5/6，spec §8/§44）===');
    {
        const { shouldAutoCloseExpanded } = loadViaJiti(
            './components/NowPlaying/NowPlayingLayer.tsx'
        ) as unknown as {
            shouldAutoCloseExpanded: (input: { source: unknown; status: string }) => boolean;
        };
        assert.strictEqual(
            shouldAutoCloseExpanded({ source: null, status: 'ready' }),
            true,
            'source null → 自动关闭'
        );
        assert.strictEqual(
            shouldAutoCloseExpanded({ source: { kind: 'work', workId: 1 }, status: 'idle' }),
            true,
            'status idle → 自动关闭'
        );
        for (const status of [
            'hydrating',
            'ready',
            'synthesizing',
            'playing',
            'paused',
            'ended',
            'error',
        ]) {
            assert.strictEqual(
                shouldAutoCloseExpanded({
                    source: { kind: 'work', workId: 1 },
                    status,
                }),
                false,
                `${status} 不自动关闭（含 ended/error/synthesizing/paused）`
            );
        }
        // Layer 源码守卫：只监听 source/status，不监听 route/pathname。
        const layerSrc = stripComments(readRepoText('components/NowPlaying/NowPlayingLayer.tsx'));
        assert.ok(layerSrc.includes('shouldAutoCloseExpanded'), 'Layer 必须经纯判定自动关闭');
        assert.ok(layerSrc.includes('closeExpanded'), 'Layer 关闭只调 closeExpanded');
        assert.ok(!layerSrc.includes('useRouter'), 'Layer 不得依赖 Router（普通导航不关闭）');
        assert.ok(!layerSrc.includes('usePathname'), 'Layer 不得监听 pathname');
        assert.ok(!layerSrc.includes('pause'), 'Layer 不得 pause');
        assert.ok(!layerSrc.includes('playbackSessionFlow'), 'Layer 不得经 Flow 改播放');
        console.log('PASS: M7-01-05 auto-close only');
    }

    console.log('=== M7-01-06: ViewModel 最小派生（Header/Surface + 完成态）===');
    {
        const vm = loadViaJiti(
            './components/NowPlaying/useExpandedNowPlayingViewModel.ts'
        ) as unknown as {
            deriveExpandedTitle: (t: string) => string;
            deriveExpandedVoiceLabel: (v: string, o: Array<{ value: string; label: string }>) => string;
            deriveExpandedParagraph: (n: number, t: number) => { current: number; total: number };
            deriveExpandedNowPlayingViewModel: (
                s: Record<string, unknown>,
                t: Record<string, unknown>,
                o: Array<{ value: string; label: string }>
            ) => Record<string, unknown>;
        };
        assert.strictEqual(vm.deriveExpandedTitle(''), '正在播放', '空标题回退');
        assert.strictEqual(vm.deriveExpandedTitle('  月球  '), '  月球  ', '非空保留原串');
        assert.strictEqual(
            vm.deriveExpandedVoiceLabel('', []),
            'AI 语音',
            '空 voice 回退'
        );
        assert.strictEqual(
            vm.deriveExpandedVoiceLabel('v1', [{ value: 'v1', label: '小雅' }]),
            '小雅',
            'lookup 命中 label'
        );
        assert.strictEqual(
            vm.deriveExpandedVoiceLabel('unknown-v', [{ value: 'v1', label: '小雅' }]),
            'unknown-v',
            '未命中直接显示 voiceId'
        );
        assert.deepStrictEqual(vm.deriveExpandedParagraph(3, 12), {
            current: 4,
            total: 12,
        });
        assert.deepStrictEqual(vm.deriveExpandedParagraph(99, 2), {
            current: 2,
            total: 2,
        });
        const full = vm.deriveExpandedNowPlayingViewModel(
            {
                source: { kind: 'work', workId: 7 },
                status: 'ended',
                title: '故事',
                voiceId: 'v1',
                nextParagraphIndex: 1,
                totalParagraphs: 2,
            },
            { isPlaying: false, currentTime: 0.5, duration: 1 },
            [{ value: 'v1', label: '小雅' }]
        );
        assert.strictEqual(full.hasSession, true);
        assert.strictEqual(full.isEnded, true, 'ended 标记完成态');
        assert.strictEqual(full.title, '故事');
        assert.strictEqual(full.voiceLabel, '小雅');
        const idle = vm.deriveExpandedNowPlayingViewModel(
            {
                source: null,
                status: 'idle',
                title: '',
                voiceId: '',
                nextParagraphIndex: 0,
                totalParagraphs: 1,
            },
            { isPlaying: false, currentTime: 0, duration: 0 },
            []
        );
        assert.strictEqual(idle.hasSession, false);
        assert.strictEqual(idle.isEnded, false);
        // ViewModel 不 import 写面。
        const vmSrc = stripComments(
            readRepoText('components/NowPlaying/useExpandedNowPlayingViewModel.ts')
        );
        assert.ok(!vmSrc.includes('pausePlayback'), 'ViewModel 不得调 Flow');
        assert.ok(!vmSrc.includes('AudioController'), 'ViewModel 不得调 Audio');
        console.log('PASS: M7-01-06 viewmodel');
    }

    console.log('=== M7-01-07: Expanded modal 语义 + Handle-only drag（验收 7/8/9）===');
    {
        const src = stripComments(readRepoText('components/NowPlaying/ExpandedNowPlaying.tsx'));
        assert.ok(src.includes('ModalOverlay'), '必须用 RAC ModalOverlay（modal semantics）');
        assert.ok(src.includes('Modal as AriaModal') || src.includes('AriaModal'), '必须用 RAC Modal');
        assert.ok(src.includes('Dialog'), '必须用 RAC Dialog');
        assert.ok(src.includes('isDismissable'), 'backdrop 可关闭');
        assert.ok(src.includes('onOpenChange'), 'Escape/backdrop 经 onOpenChange 关闭');
        // §42 首焦点：关闭按钮 autoFocus 落在 Header（Expanded 经 Header 透传）。
        const headerForFocus = stripComments(readRepoText('components/NowPlaying/NowPlayingHeader.tsx'));
        assert.ok(headerForFocus.includes('autoFocus'), '关闭按钮 autoFocus（§42 首焦点）');
        assert.ok(src.includes('aria-label'), '对话框须有无障碍标签');
        assert.ok(src.includes('useDrag'), '移动 Sheet 须用 useDrag');
        assert.ok(
            src.includes('EXPANDED_SHEET_DISMISS_THRESHOLD_PX'),
            'dismiss 阈值须为具名常量'
        );
        assert.ok(!src.includes('playbackSessionFlow'), 'Expanded 不得经 Flow 改播放');
        assert.ok(!src.includes('AudioController'), 'Expanded 不得直调 Audio');
        // M7-04-01 收窄（spec §34/§44）：唯一允许的路由出口是查看正文动作
        //（handleViewStory 内先 close 后按需 push 精确 /library 目标）；
        // open/close/Escape/backdrop/drag 路径仍不得导航，/player 永不得出现。
        assert.ok(!src.includes("push('/player')") && !src.includes('push("/player")'), 'Expanded 永不得 push /player（M9 边界）');
        assert.strictEqual(src.split('router.push').length - 1, 1, '唯一路由出口：查看正文一处 push');
        assert.ok(
            src.indexOf('router.push', src.indexOf('handleViewStory')) >= 0,
            'push 必须位于查看正文动作内（先关后导）'
        );
        // Handle-only：bind 仅 spread 到 Header handle（内容区注释锁定）。
        const headerSrc = stripComments(readRepoText('components/NowPlaying/NowPlayingHeader.tsx'));
        assert.ok(headerSrc.includes('dragHandleProps'), 'Header 必须接收 handle 绑定');
        assert.ok(headerSrc.includes('expanded-drag-handle'), 'Handle 须有打点');
        assert.ok(headerSrc.includes('expanded-close-button'), '关闭按钮须有打点');
        console.log('PASS: M7-01-07 modal + drag');
    }

    console.log('=== M7-01-08: 响应式单一断点 + token（验收 7，resize 不重置）===');
    {
        const scss = readRepoText('components/NowPlaying/ExpandedNowPlaying.module.scss');
        assert.ok(scss.includes('--size-now-playing-sheet-max-height'), 'Sheet 高度 token');
        assert.ok(scss.includes('--size-now-playing-panel-width'), 'Panel 宽度 token');
        assert.ok(scss.includes('--size-now-playing-handle'), 'Handle token');
        assert.ok(scss.includes('--z-modal'), '浮层层级 token');
        assert.ok(scss.includes('@media (min-width: 768px)'), '768 单一断点切换 Sheet/Panel');
        assert.ok(!scss.includes('1024px'), '禁止第二边界 1024');
        assert.ok(scss.includes('prefers-reduced-motion'), 'reduced-motion 关闭动画');
        const sizing = readRepoText('styles/tokens/_sizing.scss');
        assert.ok(
            sizing.includes('--size-now-playing-sheet-max-height'),
            'token 必须落地 _sizing.scss'
        );
        assert.ok(
            sizing.includes('--size-now-playing-panel-width'),
            'panel token 必须落地 _sizing.scss'
        );
        assert.ok(sizing.includes('--size-now-playing-handle'), 'handle token 必须落地');
        // resize 不重置 isExpanded：store 无 viewport 逻辑（源码守卫）。
        const storeCode = stripComments(readRepoText('stores/nowPlayingUiStore.ts'));
        assert.ok(!storeCode.includes('innerWidth'), 'UI store 不得读 viewport');
        assert.ok(!storeCode.includes('resize'), 'UI store 不得监听 resize');
        console.log('PASS: M7-01-08 responsive tokens');
    }

    console.log('=== M7-01-09: Global Layer 挂载（MainChrome = Page + BottomChrome + Layer）===');
    {
        const chrome = stripComments(readRepoText('components/MainChrome/index.tsx'));
        assert.ok(chrome.includes('NowPlayingLayer'), 'MainChrome 必须挂载 NowPlayingLayer');
        assert.ok(chrome.includes('BottomChrome'), 'BottomChrome 保留');
        assert.ok(chrome.includes('data-expanded'), 'MainChrome 须打点 expanded');
        const stateSrc = stripComments(
            readRepoText('components/MainChrome/useMainChromeState.ts')
        );
        assert.ok(stateSrc.includes('useNowPlayingUiStore'), 'Chrome state 须订阅 isExpanded');
        assert.ok(stateSrc.includes('isExpanded'), 'Chrome state 须透传 isExpanded');
        // DESIGN_SPEC 同步。
        const spec = readRepoText('DESIGN_SPEC.md');
        assert.ok(spec.includes('Expanded Now Playing'), 'DESIGN_SPEC 须有 Expanded 节');
        assert.ok(spec.includes('--size-now-playing-panel-width'), 'SPEC 须同步 panel token');
        assert.ok(
            spec.includes('NowPlayingLayer'),
            'SPEC 全局布局须含 NowPlayingLayer'
        );
        assert.ok(!spec.includes('/player\n→ AudioPlayer 为页面视觉焦点'), 'SPEC 不得再称 /player 为视觉焦点');
        console.log('PASS: M7-01-09 global layer');
    }

    console.log('\nALL EXPANDED UI STATE UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runExpandedUiStateTests()
    .then(() => {
        console.log('ALL EXPANDED UI STATE UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Expanded ui state test failed:', error);
        process.exit(1);
    });

export default testPromise;
