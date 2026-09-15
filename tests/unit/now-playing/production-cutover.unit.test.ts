import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 中文注释：M7-04-04 Production Cutover 静态守卫（L1，纯静态，不触库/网络，M9-04 closure 收紧）。
// 锁定 spec §6.1/§49/§50/§52：正常产品行为 0 个 navigate/push/link 到 /player
// （allowlist 制，不是 repo 全局字符串归零）；/player 兼容路由仅剩单文件
// app/(main)/player/page.tsx（redirect）；M9-04 起 deprecated 兼容三符号已删除；
// NowPlaying 不依赖旧 AudioPlayer；NowPlaying 不拼 continuation Prompt；M7-01 UI Store 不含领域状态。

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
};

const stripComments = (src: string): string =>
    src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1');

// allowlist（M9-04 closure 收紧，spec §50/M9）：
// 1. app/(main)/player/page.tsx 单文件语义 —— M9-02 起目录仅剩 redirect page.tsx，
//    宽目录 allowlist 已收窄为单文件；守卫同步断言目录内无其他文件（防回流）；
//    components/NowPlaying/useNowPlayingEntry.ts 已从 allowlist 移除
//    （三符号删除后注释剥离后零 /player 字面量）；
// 2. tests/docs → 仅允许验证 /player → /library compatibility 的上下文
//    （tests/unit/navigation/*compat*、tests/system/browser harness/scenarios compat、
//    docs/e2e/09-*；产品运行时代码外允许出现 /player 字符串；
//    .e2e-runtime/snapshots 等非产品面不参与审计，审计路径仅下述 AUDIT_ROOTS）。
const ALLOWLIST_FILES = new Set<string>(['app/(main)/player/page.tsx']);

// 审计路径（spec §50 正常产品流）：components/**、app/(main)/**、lib/client/**、stores/**。
const AUDIT_ROOTS = ['components', 'app/(main)', 'lib/client', 'stores'];

const walkAuditFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        const abs = path.resolve(process.cwd(), dir);
        if (!fs.existsSync(abs)) {
            return;
        }
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            const rel = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(rel);
            } else if (rel.endsWith('.ts') || rel.endsWith('.tsx')) {
                out.push(rel);
            }
        }
    };
    for (const root of AUDIT_ROOTS) {
        walk(root);
    }
    return out.sort();
};

const isAllowlisted = (rel: string): boolean => {
    const posix = rel.split(path.sep).join('/');
    if (ALLOWLIST_FILES.has(posix)) {
        return true;
    }
    return false;
};

// 正常产品导航到 /player 的字面形态（注释已剥离后匹配；双引号/单引号/空白变体全覆盖）。
const NAV_PATTERNS: Array<{ name: string; re: RegExp }> = [
    { name: "router.push('/player')", re: /\.push\s*\(\s*['"]\/player['"]\s*\)/ },
    { name: "router.replace('/player')", re: /\.replace\s*\(\s*['"]\/player['"]\s*\)/ },
    { name: "navigate('/player')", re: /navigate\s*\(\s*['"]\/player['"]\s*\)/ },
    { name: '<Link href="/player">', re: /<Link[^>]*href\s*=\s*['"]\/player['"]/ },
    { name: 'href="/player"', re: /href\s*=\s*['"]\/player['"]/ },
    { name: "location.href='/player'", re: /location\.href\s*=\s*['"]\/player['"]/ },
    // 常量间接 push（deprecated 工厂语义）：allowlist 外出现即视为产品导航。
    { name: 'push(NOW_PLAYING_COMPAT_ROUTE)', re: /push\s*\(\s*NOW_PLAYING_COMPAT_ROUTE\s*\)/ },
];

const walkNowPlayingFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        const abs = path.resolve(process.cwd(), dir);
        if (!fs.existsSync(abs)) {
            return;
        }
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            const rel = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(rel);
            } else if (rel.endsWith('.ts') || rel.endsWith('.tsx')) {
                out.push(rel);
            }
        }
    };
    walk('components/NowPlaying');
    return out.sort();
};

async function runProductionCutoverUnit(): Promise<void> {
    installUnitStubs();

    console.log('=== M7-04-04-P1: 正常产品流 /player 零导航（allowlist 制，§6.1/§50） ===');
    {
        const files = walkAuditFiles();
        assert.ok(files.length > 50, `审计文件过少（实际 ${files.length}，审计路径可能缺失）`);
        const violations: string[] = [];
        for (const rel of files) {
            if (isAllowlisted(rel)) {
                continue;
            }
            const code = stripComments(readRepoText(rel));
            for (const pat of NAV_PATTERNS) {
                if (pat.re.test(code)) {
                    violations.push(`${rel} 含 ${pat.name}`);
                }
            }
        }
        assert.deepStrictEqual(violations, [], `正常产品流不得 navigate/push/link 到 /player（allowlist 外零容忍）：${violations.join('；')}`);
        // allowlist 自身存在性（防误删/防 guard 空转；M9-04 起收窄为单文件 page.tsx）：
        assert.ok(
            fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/page.tsx')),
            'allowlist 单文件 app/(main)/player/page.tsx 必须存在（M9-02 起仅剩 redirect page）'
        );
        // 目录防回流：除 page.tsx 外无其他产品文件（系统点文件除外）。
        {
            const entries = fs
                .readdirSync(path.resolve(process.cwd(), 'app/(main)/player'))
                .filter((n) => !n.startsWith('.'));
            assert.deepStrictEqual(entries.sort(), ['page.tsx'], `player 目录必须只含 page.tsx（防回流），实际=${entries.join(',')}`);
        }
        // useNowPlayingEntry 已从 allowlist 移除：注释剥离后零 /player 字面量。
        {
            const entryCode = stripComments(readRepoText('components/NowPlaying/useNowPlayingEntry.ts'));
            assert.ok(!entryCode.includes('/player'), 'useNowPlayingEntry 注释剥离后不得再含 /player（M9-04 已删三符号）');
            assert.ok(!entryCode.includes('NOW_PLAYING_COMPAT_ROUTE'), 'useNowPlayingEntry 不得再含兼容常量名');
        }
        console.log(`PASS: M7-04-04-P1 zero-player-navigation files=${files.length}`);
    }

    console.log('=== M7-04-04-P2: app/(main)/player/** 物理退役（M9-02 仅剩 redirect） ===');
    {
        assert.ok(
            !fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/index.tsx')),
            '旧 /player index 必须已删除（M9-02）'
        );
        assert.ok(
            fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/page.tsx')),
            '/player page 必须仍存在（redirect）'
        );
        const pageSrc = readRepoText('app/(main)/player/page.tsx');
        assert.ok(pageSrc.includes("redirect('/library')") || pageSrc.includes('redirect("/library")'), '/player 页必须为 redirect（M9-01 冻结）');
        console.log('PASS: M7-04-04-P2 player-physically-retired');
    }

    console.log('=== M7-04-04-P3: deprecated 兼容符号已移除（M9-04 closure） ===');
    {
        const src = readRepoText('components/NowPlaying/useNowPlayingEntry.ts');
        const code = stripComments(src);
        assert.ok(!src.includes('NOW_PLAYING_COMPAT_ROUTE'), '兼容常量必须已删除');
        assert.ok(!src.includes('shouldSuppressNowPlayingEntry'), '兼容判定必须已删除');
        assert.ok(!/\bcreateNowPlayingEntryController\b/.test(src), '兼容工厂必须已删除');
        assert.ok(src.includes('createExpandedNowPlayingEntryController'), 'M7 纯工厂必须保留');
        assert.ok(src.includes('useNowPlayingEntry'), 'M7 hook 必须保留');
        assert.ok(src.includes('NowPlayingEntryController'), 'M7 控制器类型必须保留');
        assert.ok(!code.includes('/player'), '注释剥离后不得再含 /player 字面量');
        // barrel 同步清理：不再 re-export 死符号，仅保留 live facade。
        const barrel = readRepoText('components/NowPlaying/index.ts');
        assert.ok(!barrel.includes('NOW_PLAYING_COMPAT_ROUTE'), 'barrel 不得再导出兼容常量');
        assert.ok(!barrel.includes('shouldSuppressNowPlayingEntry'), 'barrel 不得再导出兼容判定');
        assert.ok(!/\bcreateNowPlayingEntryController\b/.test(barrel), 'barrel 不得再导出兼容工厂');
        assert.ok(barrel.includes('createExpandedNowPlayingEntryController'), 'barrel 必须保留 M7 纯工厂');
        assert.ok(barrel.includes('useNowPlayingEntry'), 'barrel 必须保留 M7 hook');
        // 运行时亦已移除（防静态/运行时分叉）。
        const mod = loadViaJiti('./components/NowPlaying/useNowPlayingEntry.ts') as unknown as Record<
            string,
            unknown
        >;
        assert.strictEqual(mod['NOW_PLAYING_COMPAT_ROUTE'], undefined, '运行时兼容常量必须已移除');
        assert.strictEqual(mod['shouldSuppressNowPlayingEntry'], undefined, '运行时兼容判定必须已移除');
        assert.strictEqual(mod['createNowPlayingEntryController'], undefined, '运行时兼容工厂必须已移除');
        assert.ok(typeof mod['createExpandedNowPlayingEntryController'] === 'function', '运行时 M7 纯工厂必须保留');
        console.log('PASS: M7-04-04-P3 compat-symbols-removed');
    }

    console.log('=== M7-04-04-P4: NowPlaying 不依赖旧 AudioPlayer ===');
    {
        const files = walkNowPlayingFiles();
        assert.ok(files.length > 10, 'NowPlaying 文件过少');
        for (const rel of files) {
            const code = stripComments(readRepoText(rel));
            assert.ok(!code.includes('app/(main)/player'), `${rel} 不得引用旧 player 路径`);
            assert.ok(!/import[^;]*AudioPlayer/.test(code), `${rel} 不得 import 旧 AudioPlayer 组件`);
        }
        console.log(`PASS: M7-04-04-P4 no-audio-player-dep files=${files.length}`);
    }

    console.log('=== M7-04-04-P5: NowPlaying 不拼 continuation Prompt ===');
    {
        const files = walkNowPlayingFiles();
        for (const rel of files) {
            const code = stripComments(readRepoText(rel));
            assert.ok(!code.includes('AUTO_CONTINUE_PROMPT'), `${rel} 不得引用自动续写常量`);
            assert.ok(!code.includes('continueFromStoryWork('), `${rel} 不得真实调用 continuation（行为归 M4）`);
            assert.ok(!code.includes('请继续'), `${rel} 不得拼装 continuation Prompt`);
        }
        console.log('PASS: M7-04-04-P5 no-continuation-prompt');
    }

    console.log('=== M7-04-04-P6: M7-01 UI Store 不含领域状态（纯 UI） ===');
    {
        const code = stripComments(readRepoText('stores/nowPlayingUiStore.ts'));
        assert.ok(code.includes('isExpanded'), 'UI store 必须含 isExpanded');
        assert.ok(code.includes('openExpanded'), 'UI store 必须含 openExpanded');
        assert.ok(code.includes('closeExpanded'), 'UI store 必须含 closeExpanded');
        for (const forbidden of [
            'session',
            'work',
            'timer',
            'transcript',
            'isPlaying',
            'currentTime',
            'playback',
            'storyText',
            'speed',
            'progress',
            'sleep',
            'sessionId',
            'workId',
            'status',
            'audio',
            'paragraph',
            'voice',
            'duration',
        ]) {
            assert.ok(!code.includes(forbidden), `UI store 不得含领域状态：${forbidden}`);
        }
        assert.ok(!code.includes('playbackSessionStore'), 'UI store 不得 import Session');
        assert.ok(!code.includes('playbackStore'), 'UI store 不得 import Transport');
        assert.ok(!code.includes('router'), 'UI store 不得碰路由');
        console.log('PASS: M7-04-04-P6 ui-store-pure');
    }

    console.log('\nALL PRODUCTION CUTOVER UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runProductionCutoverUnit()
    .then(() => {
        console.log('ALL PRODUCTION CUTOVER UNIT TESTS PASSED SUCCESSFULLY!');
    })
    .catch((error) => {
        console.error('Production cutover unit test failed:', error);
        process.exit(1);
    });

export default testPromise;
