import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// 中文注释：M6-03 MainChrome & Mobile Docked Mini 单测（L1，纯函数 + 架构守卫 + CSS 契约，不触库/网络）。
// 覆盖任务验收 A-G 的确定性切面：派生显隐/键盘纯隐藏/预留/点击契约沿用/off-by-one/M5 owner 边界。
// keyboard open/close 的真实 DOM 联动归 L2 集成；真实浏览器几何归 L3。
import { resolveMainChromeVisibility } from '../../../components/MainChrome/visibility';
import {
    resolveNowPlayingLayoutMode,
    resolveViewportMode,
} from '../../../components/NowPlaying/useNowPlayingLayoutMode';
import { hasMiniNowPlaying } from '../../../components/NowPlaying/deriveMiniNowPlayingViewModel';

const draftSource = { kind: 'draft' } as const;
const workSource = { kind: 'work' } as const;

const readRepoText = (rel: string): string =>
    fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

async function runMainChromeDockedTests(): Promise<void> {
    console.log('=== M6-03-01: 无 session → 不预留幽灵空间（验收 B）===');
    {
        const idle = resolveMainChromeVisibility({
            source: null,
            status: 'idle',
            layoutMode: 'compact-docked',
            isKeyboardOpen: false,
        });
        assert.strictEqual(idle.hasNowPlaying, false, 'source null + idle → 无 session');
        assert.strictEqual(idle.visible, false, '无 session → 不渲染');
        assert.strictEqual(idle.hasDockedMini, false, '无 session → 不预留幽灵空间');
        assert.strictEqual(idle.hasFloatingMini, false);
        assert.strictEqual(
            hasMiniNowPlaying({
                source: null,
                status: 'idle',
                title: '',
                lastCompletedParagraphIndex: -1,
                nextParagraphIndex: 0,
                totalParagraphs: 1,
            }),
            false,
            'MainChrome 与 M6-02 同一 hasNowPlaying 公式'
        );
        // source null 即使 ready 仍隐藏（不得以 transport 有轨为由显示）。
        const nullSource = resolveMainChromeVisibility({
            source: null,
            status: 'ready',
            layoutMode: 'compact-docked',
            isKeyboardOpen: false,
        });
        assert.strictEqual(nullSource.visible, false, 'source null 即使 ready → hidden');
        console.log('PASS: M6-03-01 no ghost reservation');
    }

    console.log('=== M6-03-02: mobile 767 + active session → docked 预留（验收 A）===');
    {
        assert.strictEqual(resolveViewportMode(767), 'compact');
        assert.strictEqual(resolveNowPlayingLayoutMode(767, true), 'compact-docked');
        const docked = resolveMainChromeVisibility({
            source: workSource,
            status: 'paused',
            layoutMode: 'compact-docked',
            isKeyboardOpen: false,
        });
        assert.strictEqual(docked.hasNowPlaying, true);
        assert.strictEqual(docked.keyboardSuppressed, false);
        assert.strictEqual(docked.visible, true, '有 session 且键盘关闭 → 渲染');
        assert.strictEqual(docked.hasDockedMini, true, 'compact-docked 可见 → 预留');
        assert.strictEqual(docked.hasFloatingMini, false);
        console.log('PASS: M6-03-02 mobile docked reservation');
    }

    console.log('=== M6-03-03: keyboard open → 纯隐藏；close → 恢复且 session 不变（验收 C/D）===');
    {
        const input = {
            source: workSource,
            status: 'paused' as const,
            layoutMode: 'compact-docked' as const,
            isKeyboardOpen: true,
        };
        const snapshotBefore = JSON.stringify(input);
        const hidden = resolveMainChromeVisibility(input);
        assert.strictEqual(hidden.keyboardSuppressed, true, 'compact + open → 抑制');
        assert.strictEqual(hidden.visible, false, 'keyboard open → Mini 隐藏');
        assert.strictEqual(hidden.hasDockedMini, false, '隐藏时不预留（Composer 落回）');
        assert.strictEqual(JSON.stringify(input), snapshotBefore, '纯函数不得 mutation 输入（session 不变）');
        // keyboard close → 若 Session 仍存在自动恢复（同一输入仅关键盘）。
        const restored = resolveMainChromeVisibility({ ...input, isKeyboardOpen: false });
        assert.strictEqual(restored.visible, true, 'keyboard close → 恢复');
        assert.strictEqual(restored.hasDockedMini, true, '恢复后重新预留');
        assert.strictEqual(restored.hasNowPlaying, true, '恢复仍由同一 Session 派生');
        // wide 下键盘打开不抑制（桌面物理键盘）。
        const wideKept = resolveMainChromeVisibility({
            source: workSource,
            status: 'paused',
            layoutMode: 'wide-docked',
            isKeyboardOpen: true,
        });
        assert.strictEqual(wideKept.keyboardSuppressed, false, 'wide 不抑制');
        assert.strictEqual(wideKept.visible, true, 'wide 键盘 open 仍显示');
        console.log('PASS: M6-03-03 keyboard pure visibility');
    }

    console.log('=== M6-03-04: error/ended 仍存在（spec §31/§32），floating 不占位 ===');
    {
        for (const status of ['error', 'ended', 'synthesizing', 'ready', 'playing'] as const) {
            const v = resolveMainChromeVisibility({
                source: draftSource,
                status,
                layoutMode: 'compact-docked',
                isKeyboardOpen: false,
            });
            assert.strictEqual(v.visible, true, `${status} → Mini 继续存在`);
        }
        const floating = resolveMainChromeVisibility({
            source: workSource,
            status: 'paused',
            layoutMode: 'wide-floating',
            isKeyboardOpen: false,
        });
        assert.strictEqual(floating.visible, true, 'floating 仍渲染（兼容路径）');
        assert.strictEqual(floating.hasDockedMini, false, 'floating 不占位');
        assert.strictEqual(floating.hasFloatingMini, true);
        const wideDocked = resolveMainChromeVisibility({
            source: workSource,
            status: 'paused',
            layoutMode: 'wide-docked',
            isKeyboardOpen: false,
        });
        assert.strictEqual(wideDocked.hasDockedMini, true, 'wide-docked 仍预留');
        console.log('PASS: M6-03-04 error/ended + floating');
    }

    console.log('=== M6-03-05: 768 不进 mobile 分支（off-by-one，验收 G）===');
    {
        assert.strictEqual(resolveViewportMode(768), 'wide', '768 必须为 wide（含边界）');
        assert.strictEqual(resolveNowPlayingLayoutMode(768, true), 'wide-floating');
        assert.strictEqual(resolveNowPlayingLayoutMode(768, false), 'wide-docked');
        const at768 = resolveMainChromeVisibility({
            source: workSource,
            status: 'paused',
            layoutMode: resolveNowPlayingLayoutMode(768, true),
            isKeyboardOpen: false,
        });
        assert.notStrictEqual(at768, null);
        // 768 派生绝不为 compact-docked（即使键盘打开也不走 compact 抑制分支）。
        assert.strictEqual(resolveNowPlayingLayoutMode(768, true), 'wide-floating');
        const at768kbd = resolveMainChromeVisibility({
            source: workSource,
            status: 'paused',
            layoutMode: 'wide-floating',
            isKeyboardOpen: true,
        });
        assert.strictEqual(at768kbd.keyboardSuppressed, false, '768 floating + keyboard 不抑制');
        console.log('PASS: M6-03-05 off-by-one 768');
    }

    console.log('=== M6-03-06: M5 owner 边界（布局层零 mutation，验收 F 前置）===');
    {
        const chromeStateSrc = readRepoText('components/MainChrome/useMainChromeState.ts');
        const mainChromeSrc = readRepoText('components/MainChrome/index.tsx');
        const bottomSrc = readRepoText('components/MainChrome/BottomChrome.tsx');
        const visibilitySrc = readRepoText('components/MainChrome/visibility.ts');
        const layoutSrc = readRepoText('app/(main)/layout.tsx');
        // 执行面守卫：剥离注释后检查（注释中的契约说明不计入执行面）。
        const stripComments = (text: string): string =>
            text
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/(^|\s)\/\/.*$/gm, '$1');
        const allLayoutExec = stripComments(
            `${chromeStateSrc}\n${mainChromeSrc}\n${bottomSrc}\n${visibilitySrc}\n${layoutSrc}`
        );
        const mainChromeExec = stripComments(`${chromeStateSrc}\n${mainChromeSrc}\n${bottomSrc}\n${visibilitySrc}`);
        // 禁止布局层直接 mutation 会话持久字段（动作必须走 playbackSessionFlow）。
        for (const token of [
            'sessionId:',
            'sessionId :',
            'continuationMode:',
            'clearAnchor',
            'beginPlayback',
            'isMiniVisible',
            'isFloatingVisible',
            'showFloatingPlayer',
            'hideFloatingPlayer',
        ]) {
            assert.ok(!allLayoutExec.includes(token), `布局层不得出现 ${token}`);
        }
        // 禁止 MainChrome 内挂载第二 Host（唯一 owner 在 layout 平级）；注释提及不计。
        assert.ok(
            !mainChromeExec.includes('AudioControllerHost'),
            'MainChrome 内不得挂载第二 Host（唯一 owner 在 layout 平级）'
        );
        // M6-04 收官：drag 仅 Mini floating Grip（useMiniFloatingDrag），MainChrome/BottomChrome 仍不得引入。
        assert.ok(!stripComments(chromeStateSrc).includes('useDrag'), 'MainChrome state 不得引入 useDrag（drag 归 Mini floating）');
        assert.ok(!stripComments(bottomSrc).includes('useDrag'), 'BottomChrome 不得引入 useDrag（drag 归 Mini floating）');
        assert.ok(layoutSrc.includes('AudioControllerHost'), 'layout 必须保留唯一 Host');
        assert.ok(layoutSrc.includes('MainChrome'), 'layout 必须经 MainChrome 编排');
        assert.ok(!layoutSrc.includes('MiniNowPlaying'), 'layout 不得直挂 Mini（必须经 BottomChrome slot）');
        assert.ok(!layoutSrc.includes('FloatingPlayer'), 'layout 不得回退旧 Floating 命名');
        // BottomChrome 必须为纯 props（单源派生在 MainChrome，原子一致）。
        assert.ok(!bottomSrc.includes('usePlaybackSessionStore'), 'BottomChrome 不得自读 Session');
        assert.ok(!bottomSrc.includes('useSoftKeyboardState'), 'BottomChrome 不得自读键盘');
        assert.ok(!bottomSrc.includes('useNowPlayingLayoutMode'), 'BottomChrome 不得自派生 viewport');
        assert.ok(bottomSrc.includes('data-testid="bottom-chrome"'), 'BottomChrome 打点缺失');
        assert.ok(bottomSrc.includes('data-testid="mini-slot"'), 'Mini slot 打点缺失');
        assert.ok(mainChromeSrc.includes('data-testid="main-chrome"'), 'MainChrome 打点缺失');
        console.log('PASS: M6-03-06 owner boundary');
    }

    console.log('=== M6-03-07: CSS reservation 契约（验收 A/B 前置）===');
    {
        const appScss = readRepoText('styles/app.module.scss');
        assert.ok(appScss.includes('--bottom-chrome-safe-bottom'), 'app 必须定义新 reservation');
        assert.ok(appScss.includes('appWithDockedNowPlaying'), 'app 必须有 docked 修饰');
        assert.ok(
            appScss.includes('padding-bottom: var(--bottom-chrome-safe-bottom)'),
            'content 必须消费新 reservation'
        );
        assert.ok(
            appScss.includes('var(--size-mini-now-playing-height)'),
            '预留必须引用 Mini 高度 token（不 hardcode）'
        );
        const sizing = readRepoText('styles/tokens/_sizing.scss');
        for (const token of [
            '--size-mini-now-playing-height',
            '--size-mini-now-playing-wide',
            '--size-mini-now-playing-docked-max',
        ]) {
            assert.ok(sizing.includes(token), `sizing 缺 ${token}`);
        }
        const composer = readRepoText('app/(main)/chat/components/Composer/Composer.module.scss');
        assert.ok(composer.includes('--bottom-chrome-safe-bottom'), 'Composer 必须消费新 reservation');
        const chatPage = readRepoText('app/(main)/chat/index.module.scss');
        assert.ok(chatPage.includes('--bottom-chrome-safe-bottom'), 'chatPage 必须消费新 reservation');
        const library = readRepoText('app/(main)/library/index.module.scss');
        assert.ok(library.includes('--bottom-chrome-safe-bottom'), 'library 必须消费新 reservation');
        // 底部元素不得各自 hardcode Mini 高度/裸 68px。
        for (const [name, text] of [
            ['composer', composer],
            ['chatPage', chatPage],
            ['library', library],
        ] as const) {
            assert.ok(!text.includes('--size-mini-now-playing-height'), `${name} 不得直引 Mini 高度（只消费预留）`);
            assert.ok(!text.includes('68px'), `${name} 不得 hardcode Mini 高度`);
        }
        const miniScss = readRepoText('components/NowPlaying/MiniNowPlaying.module.scss');
        assert.ok(
            miniScss.includes('bottom: calc(var(--tab-bar-safe-bottom) + var(--space-2))'),
            'Mini docked 必须复用 tab-bar token + space-2（不重复加 safe-area）'
        );
        // M6-04 收官：Mini floating 引入 DragGrip 样式（grip-only drag，spec §18.2），
        // 不再禁止样式侧 drag 字样；完整 floating CSS 契约由 desktop-floating-geometry 单测锁定。
        assert.ok(miniScss.includes('.dragGrip'), 'M6-04 Mini 须有 DragGrip 样式');
        console.log('PASS: M6-03-07 css contract');
    }

    console.log('\nALL MAIN CHROME DOCKED UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runMainChromeDockedTests()
    .then(() => {
        console.log('ALL MAIN CHROME DOCKED UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Main chrome docked test failed:', error);
        process.exit(1);
    });

export default testPromise;
