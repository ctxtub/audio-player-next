import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// 中文注释：M9-01 /player Redirect & Compatibility Contract 静态守卫（L1，纯静态，不触库/网络）。
// 锁定：page.tsx 为最薄 server redirect（redirect('/library')，不渲染旧 UI）；
// 旧组件物理保留但不可达；query/hash 不进 identity；产品路径除 compat route 外零新增 /player 导航。

const readRepoText = (rel: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

// allowlist：M9-01 兼容收口前保留（M9-02 才物理删除/清理）。
const ALLOWLIST_DIR_PREFIX = 'app/(main)/player/';
const ALLOWLIST_FILES = new Set<string>(['components/NowPlaying/useNowPlayingEntry.ts']);

// 审计路径（M7 §50 正常产品流口径，M9-01 沿用）：components/**、app/(main)/**、lib/client/**、stores/**。
const AUDIT_ROOTS = ['components', 'app/(main)', 'lib/client', 'stores'];

const walkAuditFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const abs = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(rel);
      } else if (rel.endsWith('.ts') || rel.endsWith('.tsx')) {
        out.push(rel);
      }
    }
  };
  for (const root of AUDIT_ROOTS) walk(root);
  return out.sort();
};

const isAllowlisted = (rel: string): boolean => {
  const posix = rel.split(path.sep).join('/');
  if (posix === 'app/(main)/player' || posix.startsWith(ALLOWLIST_DIR_PREFIX)) return true;
  if (ALLOWLIST_FILES.has(posix)) return true;
  return false;
};

// 产品导航到 /player 的字面形态（注释剥离后匹配；M9-01 新增 redirect 形态不计入产品导航，单列断言）。
const NAV_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "router.push('/player')", re: /\.push\s*\(\s*['"]\/player['"]\s*\)/ },
  { name: "router.replace('/player')", re: /\.replace\s*\(\s*['"]\/player['"]\s*\)/ },
  { name: "navigate('/player')", re: /navigate\s*\(\s*['"]\/player['"]\s*\)/ },
  { name: '<Link href="/player">', re: /<Link[^>]*href\s*=\s*['"]\/player['"]/ },
  { name: 'href="/player"', re: /href\s*=\s*['"]\/player['"]/ },
  { name: "location.href='/player'", re: /location\.href\s*=\s*['"]\/player['"]/ },
  { name: 'push(NOW_PLAYING_COMPAT_ROUTE)', re: /push\s*\(\s*NOW_PLAYING_COMPAT_ROUTE\s*\)/ },
];

async function runPlayerCompatRedirectUnit(): Promise<void> {
  console.log('=== M9-01-P1: page.tsx 为最薄 server redirect（redirect(\'/library\')） ===');
  {
    const pageSrc = readRepoText('app/(main)/player/page.tsx');
    const code = stripComments(pageSrc);
    // 必须是 server 组件：无 'use client'。
    assert.ok(!/['"]use client['"]/.test(pageSrc), 'compat route 必须为 server 组件，不得含 use client');
    // 必须从 next/navigation 引入 redirect。
    assert.ok(
      /import\s*\{\s*redirect\s*\}\s*from\s*['"]next\/navigation['"]/.test(code),
      '必须 import { redirect } from next/navigation',
    );
    // 必须精确 redirect('/library')（单引号/双引号均可，目标精确、无后缀、无 query）。
    assert.ok(
      /redirect\s*\(\s*['"]\/library['"]\s*\)/.test(code),
      '必须精确 redirect(\'/library\')',
    );
    // 不得 redirect 到作品详情或带参形态。
    assert.ok(!/redirect\s*\(\s*['"]\/library\//.test(code), '不得 redirect 到 /library/[id]（M1 §14）');
    assert.ok(!/redirect\s*\(\s*['"]\/player/.test(code), '不得 redirect 回 /player');
    // 不得渲染任何旧 Player UI：不得 import 旧 index/components，不得出现三件套。
    assert.ok(!code.includes('./index'), 'compat route 不得 import 旧 index（不可达）');
    assert.ok(!code.includes('HomePage'), 'compat route 不得渲染 HomePage');
    assert.ok(!code.includes('PlaybackStatusBoard'), 'compat route 不得渲染 PlaybackStatusBoard');
    assert.ok(!code.includes('GenerationPreview'), 'compat route 不得渲染 GenerationPreview');
    assert.ok(!code.includes('AudioPlayer'), 'compat route 不得渲染 AudioPlayer');
    // 不得含客户端跳转形态（server redirect 唯一）。
    assert.ok(!code.includes('useEffect'), 'compat route 不得用 useEffect 跳转');
    assert.ok(!code.includes('useRouter'), 'compat route 不得用 useRouter 跳转');
    assert.ok(!code.includes('router.replace'), 'compat route 不得用 router.replace 跳转');
    // 默认导出函数存在。
    assert.ok(/export\s+default\s+function/.test(code), '必须默认导出函数组件');
    console.log('PASS: M9-01-P1 server-redirect-form');
  }

  console.log('=== M9-01-P2: 旧组件物理保留但不可达（M9-02 前不删） ===');
  {
    assert.ok(fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/index.tsx')), 'index.tsx 必须保留');
    assert.ok(fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/index.module.scss')), 'index.module.scss 必须保留');
    assert.ok(fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/page.tsx')), 'page.tsx 必须保留（已转 redirect）');
    for (const comp of [
      'app/(main)/player/components/PlaybackStatusBoard/index.tsx',
      'app/(main)/player/components/GenerationPreview/index.tsx',
      'app/(main)/player/components/AudioPlayer/index.tsx',
    ]) {
      assert.ok(fs.existsSync(path.resolve(process.cwd(), comp)), `${comp} 必须保留`);
    }
    // 不可达：page.tsx 不引用 index/components。
    const pageCode = stripComments(readRepoText('app/(main)/player/page.tsx'));
    assert.ok(!pageCode.includes('app/(main)/player'), 'compat route 不得再引用旧 player 路径');
    // 旧 index 仍挂载三件套（证明未被掏空，删除归 M9-02）。
    const indexSrc = readRepoText('app/(main)/player/index.tsx');
    assert.ok(indexSrc.includes('PlaybackStatusBoard'), '旧 index 仍含 PlaybackStatusBoard（M9-02 前保留）');
    assert.ok(indexSrc.includes('GenerationPreview'), '旧 index 仍含 GenerationPreview（M9-02 前保留）');
    assert.ok(indexSrc.includes('AudioPlayer'), '旧 index 仍含 AudioPlayer（M9-02 前保留）');
    console.log('PASS: M9-01-P2 legacy-kept-unreachable');
  }

  console.log('=== M9-01-P3: query/hash ≠ identity（不翻译旧 query 为 M5 Session） ===');
  {
    const pageCode = stripComments(readRepoText('app/(main)/player/page.tsx'));
    // 不得读取任何 query/hash/params 并转成会话：无 searchParams/params/useSearchParams/URLSearchParams。
    for (const forbidden of ['searchParams', 'useSearchParams', 'URLSearchParams', 'useParams', 'params']) {
      // 'params' 子串误伤率高，仅在疑似读取形态时判：如 props.params / { searchParams } / useParams(。
      if (forbidden === 'params') {
        assert.ok(!/useParams\s*\(/.test(pageCode), 'compat route 不得 useParams');
        assert.ok(!/\{\s*searchParams/.test(pageCode), 'compat route 不得解构 searchParams');
        continue;
      }
      assert.ok(!pageCode.includes(forbidden), `compat route 不得读取 ${forbidden}（query/hash ≠ identity）`);
    }
    // 不得碰 M5 会话/Anchor/transport：不 import stores/flow，不 clear/reset。
    for (const forbidden of [
      'playbackSessionStore',
      'playbackStore',
      'playbackProgressStore',
      'playbackSessionFlow',
      'beginPlayback',
      'beginSession',
      'getPlaybackAnchor',
      'saveCheckpoint',
      'clearPlayback',
      '.clear(',
      '.reset(',
    ]) {
      assert.ok(!pageCode.includes(forbidden), `compat route 不得碰会话面：${forbidden}`);
    }
    // redirect 目标精确、无 query 透传。
    assert.ok(!pageCode.includes('?'), 'compat route redirect 不得拼接 query');
    assert.ok(!pageCode.includes('#'), 'compat route redirect 不得拼接 hash');
    console.log('PASS: M9-01-P3 query-hash-not-identity');
  }

  console.log('=== M9-01-P4: 产品路径静态守卫（除 compat route 外零新增 /player 导航） ===');
  {
    const files = walkAuditFiles();
    assert.ok(files.length > 50, `审计文件过少（实际 ${files.length}）`);
    const violations: string[] = [];
    for (const rel of files) {
      if (isAllowlisted(rel)) continue;
      const code = stripComments(readRepoText(rel));
      for (const pat of NAV_PATTERNS) {
        if (pat.re.test(code)) violations.push(`${rel} 含 ${pat.name}`);
      }
    }
    assert.deepStrictEqual(violations, [], `产品路径不得新增 /player 导航：${violations.join('；')}`);
    // allowlist 自身存在性（防 guard 空转）。
    assert.ok(
      fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/index.tsx')),
      'allowlist 目录必须存在（M9-02 前不删除）',
    );
    assert.ok(
      fs.existsSync(path.resolve(process.cwd(), 'components/NowPlaying/useNowPlayingEntry.ts')),
      'allowlist deprecated 文件必须存在',
    );
    console.log(`PASS: M9-01-P4 zero-new-player-navigation files=${files.length}`);
  }

  console.log('\nALL PLAYER COMPAT REDIRECT UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runPlayerCompatRedirectUnit()
  .then(() => {
    console.log('ALL PLAYER COMPAT REDIRECT UNIT TESTS PASSED SUCCESSFULLY!');
  })
  .catch((error) => {
    console.error('Player compat redirect unit test failed:', error);
    process.exit(1);
  });

export default testPromise;
