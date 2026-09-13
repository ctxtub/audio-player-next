import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// 中文注释：M6-04 Desktop Floating Mode 单元契约（L1，纯函数 + 源码架构守卫，不触库/网络/DOM）。
// 覆盖 spec §18（默认右下 CSS / grip-only drag / clamp / edge snap / resize repair / localStorage 持久化 + refresh restore / 纯 presentation）
// + §19（wide-docked 预留）+ §49/C（跨 768 往返同一 Session、drag 不残留）。
import {
    MINI_FLOATING_MARGIN_X_PX,
    MINI_FLOATING_MARGIN_Y_PX,
    clampFloatingPosition,
    resolveFloatingDragEnd,
    resolveFloatingSnapSide,
    snapFloatingToEdge,
} from '../../../components/NowPlaying/MiniFloatingGeometry';
import {
    resolveNowPlayingLayoutMode,
    resolveViewportMode,
} from '../../../components/NowPlaying/useNowPlayingLayoutMode';
import { resolveMainChromeVisibility } from '../../../components/MainChrome/visibility';

const draftSource = { kind: 'draft' } as const;
const workSource = { kind: 'work' } as const;

const readRepoText = (rel: string): string =>
    fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

async function runDesktopFloatingTests(): Promise<void> {
    console.log('=== M6-04-01: clamp 到 viewport 内（drag 期间/结束/resize 通用）===');
    {
        // 内部不变。
        assert.deepStrictEqual(
            clampFloatingPosition(100, 100, { width: 1280, height: 800 }, { width: 360, height: 68 }),
            { x: 100, y: 100 }
        );
        // 越左上 → 边距。
        assert.deepStrictEqual(
            clampFloatingPosition(-999, -999, { width: 1280, height: 800 }, { width: 360, height: 68 }),
            { x: MINI_FLOATING_MARGIN_X_PX, y: MINI_FLOATING_MARGIN_Y_PX }
        );
        // 越右下 → 视口-面板-边距。
        assert.deepStrictEqual(
            clampFloatingPosition(9999, 9999, { width: 1280, height: 800 }, { width: 360, height: 68 }),
            { x: 1280 - 360 - MINI_FLOATING_MARGIN_X_PX, y: 800 - 68 - MINI_FLOATING_MARGIN_Y_PX }
        );
        // 边距与 token 对齐：水平 16=space-4，垂直 8=space-2。
        assert.strictEqual(MINI_FLOATING_MARGIN_X_PX, 16, '水平边距须=var(--space-4)=16');
        assert.strictEqual(MINI_FLOATING_MARGIN_Y_PX, 8, '垂直保留须=var(--space-2)=8');
        // 退化视口（宽度小于面板）不抛非法坐标：x 回退为边距，y 仍在合法区即保留。
        const deg = clampFloatingPosition(50, 50, { width: 300, height: 200 }, { width: 360, height: 68 });
        assert.strictEqual(deg.x, MINI_FLOATING_MARGIN_X_PX, '窄视口 x 回退边距');
        assert.strictEqual(deg.y, 50, '窄视口 y 合法即保留');
        const degOver = clampFloatingPosition(200, 180, { width: 300, height: 200 }, { width: 360, height: 68 });
        assert.deepStrictEqual(
            degOver,
            { x: MINI_FLOATING_MARGIN_X_PX, y: 200 - 68 - MINI_FLOATING_MARGIN_Y_PX },
            '窄视口越界回退边距/下界'
        );
        // NaN 防御。
        const nan = clampFloatingPosition(NaN, NaN, { width: 1280, height: 800 }, { width: 360, height: 68 });
        assert.deepStrictEqual(nan, { x: MINI_FLOATING_MARGIN_X_PX, y: MINI_FLOATING_MARGIN_Y_PX });
        console.log('PASS: M6-04-01 clamp');
    }

    console.log('=== M6-04-02: drag end 吸附最近水平边，垂直保留（§18.3）===');
    {
        assert.strictEqual(resolveFloatingSnapSide(16, 1280, 360), 'left', '左下起始贴左');
        assert.strictEqual(
            resolveFloatingSnapSide(1280 - 360 - 16, 1280, 360),
            'right',
            '右下起始贴右'
        );
        // 中线确定性：中心偏左一像素即 left，含中线偏右即 right。
        assert.strictEqual(resolveFloatingSnapSide(459, 1280, 360), 'left', '639中心-1 → left');
        assert.strictEqual(resolveFloatingSnapSide(460, 1280, 360), 'right', '640中心 → right（含中线）');
        // snap 只改 x，y 原样保留。
        const snapped = snapFloatingToEdge(500, 123, 1280, 360);
        assert.strictEqual(snapped.y, 123, 'snap 不改垂直');
        assert.ok(
            snapped.x === MINI_FLOATING_MARGIN_X_PX || snapped.x === 1280 - 360 - MINI_FLOATING_MARGIN_X_PX,
            'snap x 必贴一边'
        );
        const leftSnap = snapFloatingToEdge(100, 200, 1280, 360);
        assert.deepStrictEqual(leftSnap, { x: 16, y: 200 }, '左侧 drag end 贴左');
        const rightSnap = snapFloatingToEdge(900, 200, 1280, 360);
        assert.deepStrictEqual(rightSnap, { x: 1280 - 360 - 16, y: 200 }, '右侧 drag end 贴右');
        // 终态=先 clamp 再 snap（越界输入仍贴边合法）。
        const end = resolveFloatingDragEnd(9999, 9999, { width: 1280, height: 800 }, { width: 360, height: 68 });
        assert.deepStrictEqual(end, { x: 1280 - 360 - 16, y: 800 - 68 - 8 }, '越界 drag end 仍合法贴边');
        console.log('PASS: M6-04-02 edge snap');
    }

    console.log('=== M6-04-03: resize 缩窗 re-clamp（§18.4，不吸附横跳）===');
    {
        // 1280 右贴边 → 缩到 800 仍可见（re-clamp，非 snap 横跳）。
        const at1280 = { x: 1280 - 360 - 16, y: 600 };
        const repaired = clampFloatingPosition(at1280.x, at1280.y, { width: 800, height: 600 }, { width: 360, height: 68 });
        assert.ok(repaired.x <= 800 - 360 - 16, '缩窗后 x 不出界');
        assert.ok(repaired.x >= 16 && repaired.y >= 8, '缩窗后仍在可视区');
        assert.strictEqual(repaired.y, 600 > 600 - 68 - 8 ? 600 - 68 - 8 : 600, '垂直 re-clamp');
        console.log('PASS: M6-04-03 resize repair');
    }

    console.log('=== M6-04-04: 三态 + wide-docked 预留（§19/B，配置只定形态不定存在）===');
    {
        assert.strictEqual(resolveViewportMode(767), 'compact');
        assert.strictEqual(resolveViewportMode(768), 'wide');
        assert.strictEqual(resolveNowPlayingLayoutMode(767, true), 'compact-docked', 'compact 不受偏好影响');
        assert.strictEqual(resolveNowPlayingLayoutMode(768, true), 'wide-floating');
        assert.strictEqual(resolveNowPlayingLayoutMode(768, false), 'wide-docked');
        assert.strictEqual(resolveNowPlayingLayoutMode(1280, true), 'wide-floating');
        assert.strictEqual(resolveNowPlayingLayoutMode(1280, false), 'wide-docked');
        // floating 仍渲染但不占位；wide-docked 仍预留（与移动端一致）。
        const floating = resolveMainChromeVisibility({
            source: workSource,
            status: 'paused',
            layoutMode: 'wide-floating',
            isKeyboardOpen: false,
        });
        assert.strictEqual(floating.visible, true, 'floating 仍存在（pref 不定存在性）');
        assert.strictEqual(floating.hasFloatingMini, true);
        assert.strictEqual(floating.hasDockedMini, false, 'floating 不占位');
        const docked = resolveMainChromeVisibility({
            source: workSource,
            status: 'paused',
            layoutMode: 'wide-docked',
            isKeyboardOpen: false,
        });
        assert.strictEqual(docked.visible, true, 'wide-docked 仍存在（OFF≠hidden）');
        assert.strictEqual(docked.hasDockedMini, true, 'wide-docked 固定 TabBar 上方并预留');
        // 跨 768 往返同一 Session：显隐公式同源（仅 layoutMode 变化，hasNowPlaying 不变）。
        const compact = resolveMainChromeVisibility({
            source: workSource,
            status: 'paused',
            layoutMode: 'compact-docked',
            isKeyboardOpen: false,
        });
        assert.strictEqual(compact.hasNowPlaying, true);
        assert.strictEqual(floating.hasNowPlaying, true);
        assert.strictEqual(docked.hasNowPlaying, true, '往返 hasNowPlaying 同一 Session 派生');
        console.log('PASS: M6-04-04 tri-state + reservation');
    }

    console.log('=== M6-04-05: 源码架构守卫（grip-only / CSS 默认 / localStorage 持久化 / 纯 presentation）===');
    {
        const miniSrc = readRepoText('components/NowPlaying/MiniNowPlaying.tsx');
        const miniExec = stripComments(miniSrc);
        const hookSrc = readRepoText('components/NowPlaying/useMiniFloatingDrag.ts');
        const hookExec = stripComments(hookSrc);
        const geomSrc = readRepoText('components/NowPlaying/MiniFloatingGeometry.ts');
        const geomExec = stripComments(geomSrc);
        const scss = readRepoText('components/NowPlaying/MiniNowPlaying.module.scss');
        // Grip 唯一绑定：Mini 仅一处 spread gripBind，且位于 grip（metadata/playback 不参与 drag）。
        const gripBindHits = (miniExec.match(/gripBind\(\)/g) ?? []).length;
        assert.strictEqual(gripBindHits, 1, `gripBind 必须恰 spread 一次到 Grip（得 ${gripBindHits}）`);
        assert.ok(miniExec.includes('mini-drag-grip'), '必须渲染 DragGrip（data-testid）');
        assert.ok(miniExec.includes('useMiniFloatingDrag'), '必须经 floating hook 派生坐标');
        // 按钮语义不参与 drag：gripBind 唯一 spread 必须位于 Grip JSX 块内，
        // Metadata/Playback 的 JSX props 块内不得出现 gripBind（import 行不计）。
        const gripIdx = miniExec.indexOf('mini-drag-grip');
        const bindIdx = miniExec.indexOf('gripBind()');
        assert.ok(gripIdx !== -1 && bindIdx !== -1, 'Grip 与绑定必须存在');
        assert.ok(
            Math.abs(bindIdx - gripIdx) < 800,
            'gripBind 必须紧邻 Grip（同一 JSX 块，Playback/Metadata 不参与）'
        );
        const metaJsxIdx = miniExec.indexOf('<MiniMetadataButton');
        const playJsxIdx = miniExec.indexOf('<MiniPlaybackButton');
        for (const [name, idx] of [
            ['Metadata', metaJsxIdx],
            ['Playback', playJsxIdx],
        ] as const) {
            assert.ok(idx !== -1, `${name} JSX 必须存在`);
            // 取该按钮 JSX 起始后 600 字符为 props 窗口（覆盖其 props，不跨到 Grip）。
            const window400 = miniExec.slice(idx, idx + 600);
            assert.ok(!window400.includes('gripBind'), `${name} 不得绑定 drag`);
            assert.ok(!window400.includes('useDrag'), `${name} 不得直引 useDrag`);
        }
        // 初始无固定像素：删除 x:16,y:360 / innerHeight-280 类初始化。
        for (const token of ['x: 16, y: 360', 'x:16,y:360', 'innerHeight - 280', 'innerHeight-280']) {
            assert.ok(!miniExec.includes(token) && !hookExec.includes(token), `不得残留固定像素初始化 ${token}`);
        }
        // hook 必须用 useDrag + filterTaps，且仅 grip 生效（enabled 门控）。
        assert.ok(hookExec.includes('useDrag'), 'hook 必须使用 useDrag');
        assert.ok(hookExec.includes('filterTaps'), '必须 filterTaps（防 tap 误拖）');
        assert.ok(hookExec.includes('enabled'), '必须有 enabled 门控（仅 floating 生效）');
        // resize 双源监听。
        assert.ok(hookExec.includes("addEventListener('resize'"), '必须监听 resize');
        assert.ok(hookExec.includes('visualViewport'), '必须监听 visualViewport.resize');
        // clamp + snap 委托纯函数。
        assert.ok(hookExec.includes('clampFloatingPosition'), 'hook 必须委托 clamp');
        assert.ok(hookExec.includes('resolveFloatingDragEnd'), 'hook 必须委托 drag end（clamp+snap）');
        // localStorage 持久化 + refresh restore（M6-04-FIXUP 评审 Blocking 1）：
        // hook 经 localStorage 读写坐标（容错 fallback 默认右下），geometry 仍保持纯函数。
        assert.ok(hookExec.includes('useState'), '位置须 state 持有（含持久化恢复）');
        assert.ok(hookExec.includes('localStorage'), 'hook 必须经 localStorage 持久化位置');
        assert.ok(
            hookExec.includes('MINI_FLOATING_POSITION_STORAGE_KEY'),
            'hook 必须经版本化 storage key 读写'
        );
        assert.ok(hookSrc.includes('mini-floating-position-v1'), 'storage key 须为 mini-floating-position-v1');
        // 读写容错：解析失败/非法值 fallback 默认右下，绝不 throw。
        assert.ok(hookExec.includes('try'), 'hook 读写必须 try/catch 容错');
        assert.ok(hookExec.includes('catch'), 'hook 读写必须 catch fallback');
        assert.ok(
            hookSrc.includes('loadPersistedFloatingPosition') || hookSrc.includes('parseStoredPosition'),
            'hook 初始化必须读取并校验持久化值'
        );
        assert.ok(
            hookSrc.includes('persistFloatingPosition') || hookSrc.includes('setItem'),
            'hook position 变更时必须持久化'
        );
        // 初始化 clamp 到当前 viewport（防跨屏/缩窗出界）。
        assert.ok(
            hookSrc.includes('clampFloatingPosition'),
            'hook 初始化/恢复必须 clamp 到 viewport'
        );
        // hook 仍不得触 DB/UserConfig（仅允许 localStorage 坐标面）。
        for (const token of ['UserConfig', 'GuestConfig', 'prisma', '@map']) {
            assert.ok(!hookExec.includes(token), `hook 不得触持久化 ${token}`);
            assert.ok(!geomExec.includes(token), `geometry 不得触持久化 ${token}`);
        }
        // geometry 纯函数层仍不得触 localStorage（持久化归 hook）。
        assert.ok(!geomExec.includes('localStorage'), 'geometry 不得触 localStorage（持久化归 hook）');
        assert.ok(!miniExec.includes('localStorage.setItem'), 'Mini 不得直写 localStorage（归 hook）');
        // 纯 presentation：hook/geometry 不 mutation session/transport。
        for (const token of [
            'usePlaybackSessionStore',
            'playbackSessionFlow',
            'pausePlayback',
            'resumePlayback',
            'restartPlayback',
            'audioController',
            'setStatus',
            'setActiveStory',
            'continuationMode',
        ]) {
            assert.ok(!hookExec.includes(token), `hook 不得触会话/播放 ${token}`);
            assert.ok(!geomExec.includes(token), `geometry 不得触会话/播放 ${token}`);
        }
        // geometry 纯函数：不 import store/router/DOM。
        assert.ok(!geomExec.includes("from '@/stores/"), 'geometry 不得 import store');
        assert.ok(!geomExec.includes("from 'react'") && !geomExec.includes('from "react"'), 'geometry 不得 import react');
        // CSS 默认右下 + floating 形态 token（§18.1）。
        assert.ok(scss.includes("data-layoutmode='wide-floating'") || scss.includes('data-layoutmode="wide-floating"'), 'SCSS 必须有 floating 形态分支');
        assert.ok(scss.includes('right: var(--space-4)'), 'floating 默认 right:var(--space-4)');
        assert.ok(
            scss.includes('bottom: calc(var(--tab-bar-safe-bottom) + var(--space-4))'),
            'floating 默认 bottom:tab-bar-safe-bottom + space-4'
        );
        assert.ok(scss.includes('width: var(--size-mini-now-playing-wide)'), 'floating 宽度 token');
        assert.ok(scss.includes('z-index: var(--z-floating)'), 'floating z-index token');
        assert.ok(scss.includes('.dragGrip'), '必须有 DragGrip 样式');
        assert.ok(scss.includes('touch-action: none'), 'grip 必须 touch-action:none（手势优先）');
        assert.ok(scss.includes("data-dragged='true'") || scss.includes('data-dragged="true"'), '已拖拽 left/top 分支');
        // docked 仍为 TabBar 上方（wide-docked 与移动端一致，§19）。
        assert.ok(
            scss.includes('bottom: calc(var(--tab-bar-safe-bottom) + var(--space-2))'),
            'docked 仍固定 TabBar 上方（space-2，不重复 safe-area）'
        );
        console.log('PASS: M6-04-05 source guard');
    }

    console.log('=== M6-04-06: token 契约（sizing/breakpoint/z/spacing）===');
    {
        const sizing = readRepoText('styles/tokens/_sizing.scss');
        for (const token of [
            '--size-mini-now-playing-height',
            '--size-mini-now-playing-wide',
            '--size-mini-now-playing-docked-max',
        ]) {
            assert.ok(sizing.includes(token), `sizing 缺 ${token}`);
        }
        const bpScss = readRepoText('styles/tokens/_breakpoints.scss');
        assert.ok(bpScss.includes('$breakpoint-lg: 768px'), 'SCSS 断点须 768');
        const spacing = readRepoText('styles/tokens/_spacing.scss');
        assert.ok(spacing.includes('--space-4: 16px'), 'space-4 须 16px（吸附边距同源）');
        assert.ok(spacing.includes('--tab-bar-safe-bottom'), '须有 tab-bar 预留 token');
        const z = readRepoText('styles/tokens/_z-index.scss');
        assert.ok(z.includes('--z-floating'), '须有 z-floating token');
        console.log('PASS: M6-04-06 tokens');
    }

    console.log('\nALL DESKTOP FLOATING GEOMETRY UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runDesktopFloatingTests()
    .then(() => {
        console.log('ALL DESKTOP FLOATING GEOMETRY UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Desktop floating geometry test failed:', error);
        process.exit(1);
    });

export default testPromise;
