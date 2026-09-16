import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 中文注释：M9-04 Dead-code / Allowlist Closure & M9 Final Gate 静态守卫（L1，纯静态，不触库/网络）。
// 锁 10 条静态不变量（M9 收官）：
// 1) page.tsx 为 redirect('/library') 且不 import legacy Player UI；
// 2) player 目录仅 compatibility route（仅 page.tsx）；
// 3) PlaybackStatusBoard/GenerationPreview/旧 AudioPlayer/HistoryPanel legacy ownership 归零，且 Chat History surface 亦退役；
// 4) FloatingPlayer/useFloatingPlayer 归零；
// 5) playbackProgressStore/lib/client/playbackProgress 归零；
// 6) 产品 navigation 到 /player 归零（单文件 allowlist 口径）；
// 7) AudioControllerHost 为唯一 audio owner；
// 8) 正式 Now Playing 入口为 MiniNowPlaying + openExpanded()，Expanded 非 route；
// 9) M5 冻结签名不可变（7 procedures + 四表 schema 原样）；
// 10) P3B implementation markers 归零（注释剥离后）。
// 审计口径：app/components/lib/stores 下 .ts/.tsx 中**未被 gitignore 命中**的手写源文件；
// 被排除者须全经 git check-ignore 自证为生成物（见 M9-04-10），且对其复跑 P3B 命中仅允许来自 lib/generated/；
// docs/specs/plans/tests 历史引用不计入；.e2e-runtime/snapshots 等非产品面不参与。

const readRepoText = (rel: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

const AUDIT_ROOTS = ['app', 'components', 'lib', 'stores'];

// M9-C1 T4R1（W39）：被 gitignore 的构建产物不得进入审计（曾因 regen 的 Prisma
// DMMF base64 偶然命中 P3B 造成确定性假红）。排除口径 = git check-ignore 命中
// （而非 git ls-files 白名单），以免漏扫未提交的手写新文件。

/** 单次 check-ignore 判定一批相对路径中被忽略的子集（posix 口径）。 */
const getGitIgnoredSubset = (rels: string[]): Set<string> => {
  if (rels.length === 0) return new Set();
  let out: string;
  try {
    out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: rels.map((r) => r.split(path.sep).join('/')).join('\n'),
    });
  } catch (err) {
    // check-ignore 无命中时以 exit 1 退出且无输出——属正常“零忽略”，不得误报。
    const code = (err as { status?: unknown }).status;
    if (code === 1) return new Set();
    throw new Error(`git check-ignore 调用失败（审计无法证明排除口径，fail-closed）：${String(err).slice(0, 200)}`);
  }
  return new Set(out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0));
};

const walkAllAuditFiles = (): string[] => {
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

/** 缓存的忽略子集（单测进程内单次 git 调用）。 */
let cachedIgnored: Set<string> | null = null;
const getIgnoredAuditPaths = (all: string[]): Set<string> => {
  if (!cachedIgnored) cachedIgnored = getGitIgnoredSubset(all);
  return cachedIgnored;
};

const toPosix = (rel: string): string => rel.split(path.sep).join('/');

const walkAuditFiles = (): string[] => {
  const all = walkAllAuditFiles();
  const ignored = getIgnoredAuditPaths(all);
  return all.filter((rel) => !ignored.has(toPosix(rel)));
};

/** 被排除的审计文件（walk 命中但 gitignore 命中），供自证断言使用。 */
const walkExcludedAuditFiles = (): string[] => {
  const all = walkAllAuditFiles();
  const ignored = getIgnoredAuditPaths(all);
  return all.filter((rel) => ignored.has(toPosix(rel)));
};

const ALLOWLIST_FILES = new Set<string>(['app/(main)/player/page.tsx']);

const isAllowlisted = (rel: string): boolean => {
  const posix = rel.split(path.sep).join('/');
  return ALLOWLIST_FILES.has(posix);
};

const NAV_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "router.push('/player')", re: /\.push\s*\(\s*['"]\/player['"]\s*\)/ },
  { name: "router.replace('/player')", re: /\.replace\s*\(\s*['"]\/player['"]\s*\)/ },
  { name: "navigate('/player')", re: /navigate\s*\(\s*['"]\/player['"]\s*\)/ },
  { name: '<Link href="/player">', re: /<Link[^>]*href\s*=\s*['"]\/player['"]/ },
  { name: 'href="/player"', re: /href\s*=\s*['"]\/player['"]/ },
  { name: "location.href='/player'", re: /location\.href\s*=\s*['"]\/player['"]/ },
  { name: 'push(NOW_PLAYING_COMPAT_ROUTE)', re: /push\s*\(\s*NOW_PLAYING_COMPAT_ROUTE\s*\)/ },
];

const countAudioTags = (code: string): number => (code.match(/<audio\b/g) ?? []).length;

async function runM9ClosureUnit(): Promise<void> {
  console.log('=== M9-04-01: page.tsx 为 redirect(/library)，不 import legacy Player UI ===');
  {
    const pageSrc = readRepoText('app/(main)/player/page.tsx');
    const code = stripComments(pageSrc);
    assert.ok(!/['"]use client['"]/.test(pageSrc), 'compat route 必须为 server 组件');
    assert.ok(
      /import\s*\{\s*redirect\s*\}\s*from\s*['"]next\/navigation['"]/.test(code),
      '必须 import { redirect } from next/navigation'
    );
    assert.ok(/redirect\s*\(\s*['"]\/library['"]\s*\)/.test(code), '必须精确 redirect(/library)');
    assert.ok(!/redirect\s*\(\s*['"]\/library\//.test(code), '不得 redirect 到 /library/[id]');
    assert.ok(!/redirect\s*\(\s*['"]\/player/.test(code), '不得 redirect 回 /player');
    for (const forbidden of ['PlaybackStatusBoard', 'GenerationPreview', 'AudioPlayer', 'HomePage', './index']) {
      assert.ok(!code.includes(forbidden), `compat route 不得渲染旧 UI：${forbidden}`);
    }
    assert.ok(!code.includes('useEffect'), '不得用 useEffect 跳转');
    assert.ok(!code.includes('useRouter'), '不得用 useRouter 跳转');
    assert.ok(/export\s+default\s+function/.test(code), '必须默认导出函数组件');
    console.log('PASS: M9-04-01 server-redirect-form');
  }

  console.log('=== M9-04-02: player 目录仅 compatibility route ===');
  {
    const playerDir = path.resolve(process.cwd(), 'app/(main)/player');
    assert.ok(fs.existsSync(playerDir), 'player 目录必须存在');
    assert.ok(fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/page.tsx')), 'page.tsx 必须保留');
    assert.ok(!fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/index.tsx')), 'index.tsx 不得回流');
    assert.ok(
      !fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/index.module.scss')),
      'index.module.scss 不得回流'
    );
    assert.ok(
      !fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/components')),
      'components/** 不得回流'
    );
    const entries = fs.readdirSync(playerDir).filter((n) => !n.startsWith('.'));
    assert.deepStrictEqual(entries.sort(), ['page.tsx'], `目录必须只含 page.tsx，实际=${entries.join(',')}`);
    console.log('PASS: M9-04-02 player-dir-only-page');
  }

  console.log('=== M9-04-03: 旧三件套 + HistoryPanel legacy ownership 归零（含 Chat surface 退役） ===');
  {
    const files = walkAuditFiles();
    assert.ok(files.length > 50, `审计文件过少（实际 ${files.length}）`);
    const importViolations: string[] = [];
    const defViolations: string[] = [];
    for (const rel of files) {
      const code = stripComments(readRepoText(rel));
      if (code.includes('player/components/')) importViolations.push(rel);
      if (/const\s+PlaybackStatusBoard\b/.test(code)) defViolations.push(`${rel}:PlaybackStatusBoard`);
      if (/const\s+GenerationPreview\b/.test(code)) defViolations.push(`${rel}:GenerationPreview`);
      if (/const\s+AudioPlayer\s*:/.test(code)) defViolations.push(`${rel}:AudioPlayer`);
    }
    assert.deepStrictEqual(importViolations, [], `不得再 import player/components/**：${importViolations.join('；')}`);
    assert.deepStrictEqual(defViolations, [], `旧三件套定义必须为 0：${defViolations.join('；')}`);
    // HistoryPanel：player 侧零 ownership。
    const playerDir = path.resolve(process.cwd(), 'app/(main)/player');
    const walkPlayer: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else walkPlayer.push(abs);
      }
    };
    walk(playerDir);
    assert.deepStrictEqual(
      walkPlayer.filter((abs) => abs.includes('History')),
      [],
      'player 下不得有 History ownership'
    );
    for (const abs of walkPlayer) {
      if (abs.endsWith('.ts') || abs.endsWith('.tsx')) {
        const code = stripComments(fs.readFileSync(abs, 'utf8'));
        assert.ok(!code.includes('HistoryPanel'), `${abs} 不得引用 HistoryPanel`);
      }
    }
    // M9-C1 T2：Chat History Surface 同样物理退役——四个目录不得回流。
    for (const comp of ['HistoryPanel', 'HistoryRecords', 'GenerationHistory', 'HistoryList']) {
      assert.strictEqual(
        fs.existsSync(path.resolve(process.cwd(), `app/(main)/chat/components/${comp}`)),
        false,
        `Chat components/${comp} 不得回流`
      );
    }
    // Chat 目录内不得再出现「打开历史」入口文案。
    const chatDir = path.resolve(process.cwd(), 'app/(main)/chat');
    const chatFiles: string[] = [];
    const walkChat = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walkChat(abs);
        else if (abs.endsWith('.ts') || abs.endsWith('.tsx')) chatFiles.push(abs);
      }
    };
    walkChat(chatDir);
    const openHistoryHits = chatFiles.filter((abs) => fs.readFileSync(abs, 'utf8').includes('打开历史'));
    assert.deepStrictEqual(openHistoryHits, [], `Chat 不得再有「打开历史」入口：${openHistoryHits.join('；')}`);
    console.log(`PASS: M9-04-03 zero-legacy-ownership files=${files.length}`);
  }

  console.log('=== M9-04-04: FloatingPlayer / useFloatingPlayer 归零 ===');
  {
    assert.strictEqual(
      fs.existsSync(path.resolve(process.cwd(), 'components/FloatingPlayer')),
      false,
      'components/FloatingPlayer 不得回流'
    );
    const files = walkAuditFiles();
    const violations: string[] = [];
    for (const rel of files) {
      const code = stripComments(readRepoText(rel));
      if (code.includes('useFloatingPlayer')) violations.push(rel);
      if (code.includes('@/components/FloatingPlayer')) violations.push(`${rel}:import`);
      if (/const\s+FloatingPlayer\b/.test(code)) violations.push(`${rel}:def`);
    }
    assert.deepStrictEqual(violations, [], `FloatingPlayer 残留必须为 0：${violations.join('；')}`);
    console.log('PASS: M9-04-04 floating-retired');
  }

  console.log('=== M9-04-05: playbackProgressStore / legacy client 归零 ===');
  {
    assert.strictEqual(
      fs.existsSync(path.resolve(process.cwd(), 'stores/playbackProgressStore.ts')),
      false,
      'stores/playbackProgressStore.ts 不得回流'
    );
    assert.strictEqual(
      fs.existsSync(path.resolve(process.cwd(), 'lib/client/playbackProgress.ts')),
      false,
      'lib/client/playbackProgress.ts 不得回流'
    );
    const files = walkAuditFiles();
    const violations: string[] = [];
    for (const rel of files) {
      const code = stripComments(readRepoText(rel));
      if (code.includes('@/stores/playbackProgressStore')) violations.push(`${rel}:store`);
      if (code.includes('@/lib/client/playbackProgress')) violations.push(`${rel}:client`);
      if (code.includes('usePlaybackProgressStore')) violations.push(`${rel}:hook`);
    }
    assert.deepStrictEqual(violations, [], `legacy progress 引用必须为 0：${violations.join('；')}`);
    console.log('PASS: M9-04-05 progress-retired');
  }

  console.log('=== M9-04-06: 产品 navigation 到 /player 归零（单文件 allowlist） ===');
  {
    const files = walkAuditFiles();
    const violations: string[] = [];
    for (const rel of files) {
      if (isAllowlisted(rel)) continue;
      const code = stripComments(readRepoText(rel));
      for (const pat of NAV_PATTERNS) {
        if (pat.re.test(code)) violations.push(`${rel} 含 ${pat.name}`);
      }
    }
    assert.deepStrictEqual(violations, [], `产品 navigation 必须为 0：${violations.join('；')}`);
    assert.ok(
      fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/page.tsx')),
      'allowlist 单文件必须存在'
    );
    {
      const entries = fs
        .readdirSync(path.resolve(process.cwd(), 'app/(main)/player'))
        .filter((n) => !n.startsWith('.'));
      assert.deepStrictEqual(entries.sort(), ['page.tsx'], '目录防回流');
    }
    {
      const entryCode = stripComments(readRepoText('components/NowPlaying/useNowPlayingEntry.ts'));
      assert.ok(!entryCode.includes('/player'), 'useNowPlayingEntry 已从 allowlist 移除（零字面量）');
      assert.ok(!entryCode.includes('NOW_PLAYING_COMPAT_ROUTE'), '兼容常量不得回流');
    }
    console.log(`PASS: M9-04-06 zero-player-navigation files=${files.length}`);
  }

  console.log('=== M9-04-07: AudioControllerHost 为唯一 audio owner ===');
  {
    const hostRel = 'components/AudioControllerHost/index.tsx';
    assert.ok(fs.existsSync(path.resolve(process.cwd(), hostRel)), 'Host 必须存在');
    const hostCode = stripComments(readRepoText(hostRel));
    assert.ok(hostCode.includes('<audio'), 'Host 必须拥有全局 <audio>');
    assert.ok(hostCode.includes('registerAudioController'), 'Host 必须注册 controller');
    const files = walkAuditFiles();
    let total = 0;
    const perFile: string[] = [];
    for (const rel of files) {
      const code = stripComments(readRepoText(rel));
      const n = countAudioTags(code);
      if (n > 0) {
        total += n;
        perFile.push(`${rel}x${n}`);
      }
    }
    assert.strictEqual(total, 1, `全局 <audio> 必须唯一，实际=${perFile.join(',')}`);
    assert.deepStrictEqual(perFile, [`${hostRel}x1`], '唯一 owner 必须为 Host');
    console.log('PASS: M9-04-07 single-audio-owner');
  }

  console.log('=== M9-04-08: 正式 Now Playing 入口 = Mini + openExpanded，Expanded 非 route ===');
  {
    // Mini 正式入口存在且经 facade 打开 Expanded。
    assert.ok(
      fs.existsSync(path.resolve(process.cwd(), 'components/NowPlaying/MiniNowPlaying.tsx')),
      'MiniNowPlaying 必须存在'
    );
    const miniCode = stripComments(readRepoText('components/NowPlaying/MiniNowPlaying.tsx'));
    assert.ok(miniCode.includes('useNowPlayingEntry'), 'Mini 必须经 useNowPlayingEntry 打开');
    assert.ok(miniCode.includes('openDetails'), 'Mini 必须调 openDetails/openExpanded');
    const bottomCode = stripComments(readRepoText('components/MainChrome/BottomChrome.tsx'));
    assert.ok(
      bottomCode.includes("from '@/components/NowPlaying/MiniNowPlaying'"),
      'BottomChrome 必须从正式 surface 导入 Mini'
    );
    // Entry facade 为 M7 store open，不触路由。
    const entryCode = stripComments(readRepoText('components/NowPlaying/useNowPlayingEntry.ts'));
    assert.ok(entryCode.includes('openExpanded'), 'facade 必须含 openExpanded');
    assert.ok(
      entryCode.includes('useNowPlayingUiStore') || entryCode.includes('nowPlayingUiStore'),
      'facade 必须委托 nowPlayingUiStore'
    );
    assert.ok(
      entryCode.includes('createExpandedNowPlayingEntryController'),
      'facade 必须提供 M7 纯工厂'
    );
    assert.ok(!entryCode.includes('useRouter'), 'facade 不得绑定 useRouter');
    assert.ok(!entryCode.includes("'/player'"), 'facade 不得再含旧路由');
    // Expanded 非 route：无独立路由目录，且经 Modal 呈现。
    assert.ok(
      !fs.existsSync(path.resolve(process.cwd(), 'app/(main)/expanded')),
      'Expanded 不得为独立 route（app/(main)/expanded 不存在）'
    );
    assert.ok(
      !fs.existsSync(path.resolve(process.cwd(), 'app/(main)/now-playing')),
      'Expanded 不得为独立 route（app/(main)/now-playing 不存在）'
    );
    const expandedCode = stripComments(readRepoText('components/NowPlaying/ExpandedNowPlaying.tsx'));
    assert.ok(expandedCode.includes('ModalOverlay'), 'Expanded 必须为 Modal 浮层');
    assert.ok(expandedCode.includes('Dialog'), 'Expanded 必须用 Dialog');
    assert.ok(!expandedCode.includes("push('/player')"), 'Expanded 不得 push 旧路由');
    console.log('PASS: M9-04-08 formal-entry');
  }

  console.log('=== M9-04-09: M5 冻结签名不可变 ===');
  {
    const routerCode = stripComments(readRepoText('lib/trpc/routers/playback.ts'));
    for (const name of [
      'getAnchor',
      'beginSession',
      'saveCheckpoint',
      'completeSession',
      'clearAnchor',
      'promoteDraftToWork',
      'getWorkProgressBatch',
    ]) {
      assert.match(routerCode, new RegExp(`\\b${name}\\s*:`), `M5 procedure 必须保留：${name}`);
    }
    for (const legacy of ['getProgress', 'saveProgress', 'clearProgress']) {
      assert.strictEqual(
        new RegExp(`\\b${legacy}\\s*:`).test(routerCode),
        false,
        `legacy procedure 不得回流：${legacy}`
      );
    }
    // client 薄包装对应（router getWorkProgressBatch ↔ client getWorkPlaybackProgressBatch）。
    const clientCode = stripComments(readRepoText('lib/client/playbackSession.ts'));
    assert.ok(clientCode.includes('getWorkPlaybackProgressBatch'), 'client 必须保留 getWorkPlaybackProgressBatch');
    const schemaText = readRepoText('lib/trpc/schemas/playback.ts');
    for (const token of [
      'playbackAnchorDTOSchema',
      'playbackSourceSchema',
      'workPlaybackProgressDTOSchema',
      'playbackSessionIdSchema',
      'savePlaybackCheckpointInputSchema',
    ]) {
      assert.match(schemaText, new RegExp(`export const ${token}`), `M5 schema 必须保留 ${token}`);
    }
    // 四表 schema 原样（User/Guest Anchor + Story/Guest Progress）。
    const prisma = readRepoText('prisma/schema.prisma');
    for (const model of [
      'UserPlaybackAnchor',
      'GuestPlaybackAnchor',
      'StoryPlaybackProgress',
      'GuestStoryPlaybackProgress',
    ]) {
      assert.ok(prisma.includes(`model ${model}`), `prisma 必须保留四表之一：${model}`);
    }
    console.log('PASS: M9-04-09 m5-frozen');
  }

  console.log('=== M9-04-10: P3B implementation markers 归零 ===');
  {
    const files = walkAuditFiles();
    const hits: string[] = [];
    for (const rel of files) {
      const code = stripComments(readRepoText(rel));
      if (code.includes('P3B')) hits.push(rel);
    }
    assert.deepStrictEqual(hits, [], `执行面 P3B markers 必须为 0：${hits.join('；')}`);
    console.log(`PASS: M9-04-10 zero-p3b files=${files.length}`);
  }

  console.log('=== M9-04-10b: 排除口径自证（W39，防掩盖真实残留） ===');
  {
    // 被排除者必须全部被 git check-ignore 命中（walkExcludedAuditFiles 的构造已保证；
    // 此处复核：任一被排除路径若未被 ignore 命中，即为掩盖， fail-closed）。
    const excluded = walkExcludedAuditFiles();
    const rechecked = getGitIgnoredSubset(excluded);
    const notIgnored = excluded.filter((rel) => !rechecked.has(toPosix(rel)));
    assert.deepStrictEqual(notIgnored, [], `被排除文件必须全部被 gitignore 命中，否则审计在掩盖：${notIgnored.join('；')}`);
    // 曾致假红的生成物路径：存在于磁盘时必须位于被排除集中。
    const generatedHit = 'lib/generated/prisma/internal/class.ts';
    if (fs.existsSync(path.resolve(process.cwd(), generatedHit))) {
      assert.ok(
        excluded.map(toPosix).includes(generatedHit),
        `${generatedHit} 必须被排除（gitignore 生成物）`
      );
    }
    // 对被排除集复跑 P3B：命中仅允许来自 lib/generated/（其它命中 = 真实残留被掩盖）。
    const maskedHits: string[] = [];
    for (const rel of excluded) {
      const code = stripComments(readRepoText(rel));
      if (code.includes('P3B') && !toPosix(rel).startsWith('lib/generated/')) {
        maskedHits.push(rel);
      }
    }
    assert.deepStrictEqual(maskedHits, [], `被排除集中不得藏匿 lib/generated/ 之外的 P3B：${maskedHits.join('；')}`);
    console.log(`PASS: M9-04-10b exclusion-self-proof excluded=${excluded.length}`);
  }

  console.log('\nALL M9 PLAYER RETIREMENT CLOSURE UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runM9ClosureUnit()
  .then(() => {
    console.log('ALL M9 PLAYER RETIREMENT CLOSURE UNIT TESTS PASSED SUCCESSFULLY!');
  })
  .catch((error) => {
    console.error('M9 closure unit test failed:', error);
    process.exit(1);
  });

export default testPromise;
