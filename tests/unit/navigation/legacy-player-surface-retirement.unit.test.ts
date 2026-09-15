import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// 中文注释：M9-02 Legacy Player Surface Physical Retirement 静态守卫（L1，纯静态，不触库/网络）。
// 锁定验收 1–4 + 6：
// P1 player 目录只剩 page.tsx；P2 全仓 active references 归零；P3 /setting 跳消失且 redirect 冻结；
// P4 audio owner 唯一收敛；P5 HistoryPanel 零 legacy ownership（Chat 正式实现保留）。
// Active 口径：app/components/lib/stores 下 .ts/.tsx，注释剥离后匹配；docs/specs/plans/tests 历史引用不计入。

const readRepoText = (rel: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

const AUDIT_ROOTS = ['app', 'components', 'lib', 'stores'];

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

const countAudioTags = (code: string): number => (code.match(/<audio\b/g) ?? []).length;

async function runLegacyPlayerRetirementUnit(): Promise<void> {
  console.log('=== M9-02-P1: player 目录只剩 page.tsx ===');
  {
    const playerDir = path.resolve(process.cwd(), 'app/(main)/player');
    assert.ok(fs.existsSync(playerDir), 'app/(main)/player 目录必须存在');
    assert.ok(fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/page.tsx')), 'page.tsx 必须保留');
    assert.ok(!fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/index.tsx')), 'index.tsx 必须物理删除');
    assert.ok(
      !fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/index.module.scss')),
      'index.module.scss 必须物理删除',
    );
    for (const comp of ['PlaybackStatusBoard', 'GenerationPreview', 'AudioPlayer']) {
      assert.ok(
        !fs.existsSync(path.resolve(process.cwd(), `app/(main)/player/components/${comp}`)),
        `components/${comp} 必须物理删除`,
      );
    }
    assert.ok(
      !fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/components')),
      'components/ 目录必须物理删除',
    );
    // 目录枚举：除 page.tsx 外无其他产品实现（允许系统文件 .DS_Store 之类 excluded？严格：只允许 page.tsx）。
    const entries = fs.readdirSync(playerDir).filter((n) => !n.startsWith('.'));
    assert.deepStrictEqual(entries.sort(), ['page.tsx'], `player 目录必须只含 page.tsx，实际=${entries.join(',')}`);
    console.log('PASS: M9-02-P1 player-dir-only-page');
  }

  console.log('=== M9-02-P2: 全仓 active references 归零 ===');
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
      // legacy AudioPlayer 组件定义形态：const AudioPlayer: React.FC（类型别名 AudioControllerHandle 等不计入）。
      if (/const\s+AudioPlayer\s*:/.test(code)) defViolations.push(`${rel}:AudioPlayer`);
    }
    assert.deepStrictEqual(importViolations, [], `不得再 import player/components/**：${importViolations.join('；')}`);
    assert.deepStrictEqual(defViolations, [], `旧三件套组件定义必须消失：${defViolations.join('；')}`);
    console.log(`PASS: M9-02-P2 zero-active-references files=${files.length}`);
  }

  console.log('=== M9-02-P3: /setting 跳消失 + redirect 冻结 ===');
  {
    const pageSrc = readRepoText('app/(main)/player/page.tsx');
    const pageCode = stripComments(pageSrc);
    // redirect 形式冻结（与 M9-01 P1 同形，本项不改形式只锁存）。
    assert.ok(!/['"]use client['"]/.test(pageSrc), 'compat route 必须为 server 组件');
    assert.ok(
      /import\s*\{\s*redirect\s*\}\s*from\s*['"]next\/navigation['"]/.test(pageCode),
      '必须 import { redirect } from next/navigation',
    );
    assert.ok(/redirect\s*\(\s*['"]\/library['"]\s*\)/.test(pageCode), '必须精确 redirect(\'/library\')');
    assert.ok(!/redirect\s*\(\s*['"]\/library\//.test(pageCode), '不得 redirect 到 /library/[id]');
    assert.ok(!/redirect\s*\(\s*['"]\/player/.test(pageCode), '不得 redirect 回 /player');
    assert.ok(!pageCode.includes('?'), 'redirect 不得拼接 query');
    assert.ok(!pageCode.includes('#'), 'redirect 不得拼接 hash');
    // player 目录整体无旧校验跳：仅剩 page.tsx，故只需锁 page 无客户端跳转形态。
    assert.ok(!pageCode.includes('useEffect'), '/player 不得再含 useEffect（旧 /setting 跳已消失）');
    assert.ok(!pageCode.includes('useRouter'), '/player 不得再含 useRouter');
    assert.ok(!pageCode.includes('/setting'), '/player 不得再含 /setting 校验跳');
    assert.ok(!pageCode.includes('router.push'), '/player 不得再含 router.push');
    assert.ok(!pageCode.includes('router.replace'), '/player 不得再含 router.replace');
    // 旧 index 已删，其 useEffect+/setting 一并消失（文件不存在即证）。
    assert.ok(!fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/index.tsx')), '旧 index（含 /setting useEffect）必须已删除');
    console.log('PASS: M9-02-P3 setting-jump-gone-redirect-frozen');
  }

  console.log('=== M9-02-P4: audio owner 唯一收敛 ===');
  {
    // 旧 AudioPlayer 不存在。
    assert.ok(
      !fs.existsSync(path.resolve(process.cwd(), 'app/(main)/player/components/AudioPlayer/index.tsx')),
      '旧 AudioPlayer 必须不存在',
    );
    // 正式 Host ownership 保持。
    const hostRel = 'components/AudioControllerHost/index.tsx';
    assert.ok(fs.existsSync(path.resolve(process.cwd(), hostRel)), 'AudioControllerHost 必须存在');
    const hostCode = stripComments(readRepoText(hostRel));
    assert.ok(hostCode.includes('<audio'), 'Host 必须拥有全局 <audio>');
    assert.ok(hostCode.includes('registerAudioController'), 'Host 必须经 playbackStore 注册 controller');
    // 全仓唯一 <audio>（注释剥离后计，避免 Transcript/Expanded 注释提及误伤）。
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
    assert.strictEqual(total, 1, `全局 <audio> 必须唯一（Host），实际 total=${total} @ ${perFile.join(',')}`);
    assert.deepStrictEqual(perFile, [`${hostRel}x1`], `唯一 owner 必须为 Host，实际=${perFile.join(',')}`);
    // NowPlaying 不得再造 <audio>。
    for (const rel of files.filter((f) => f.split(path.sep).join('/').startsWith('components/NowPlaying/'))) {
      const code = stripComments(readRepoText(rel));
      assert.ok(!code.includes('<audio'), `${rel} 不得再造 <audio>（consumer）`);
    }
    // playbackStore = transport only。
    const transportCode = stripComments(readRepoText('stores/playbackStore.ts'));
    assert.ok(transportCode.includes('registerAudioController'), 'playbackStore 必须保留 registerAudioController（transport）');
    // PlaybackSessionStore = Session SSOT。
    const sessionRel = 'stores/playbackSessionStore.ts';
    assert.ok(fs.existsSync(path.resolve(process.cwd(), sessionRel)), 'PlaybackSessionStore 必须存在');
    const sessionCode = stripComments(readRepoText(sessionRel));
    assert.ok(sessionCode.includes('createPlaybackSessionId'), 'PlaybackSessionStore 必须为 Session SSOT（session id 工厂引用保持）');
    // Mini/Expanded = consumers（经 Flow/facade 消费，不直拥 audio）。
    const miniCode = stripComments(readRepoText('components/NowPlaying/MiniNowPlaying.tsx'));
    assert.ok(miniCode.includes('playbackSessionFlow'), 'Mini 必须经 playbackSessionFlow 消费（consumer）');
    assert.ok(miniCode.includes('usePlaybackSessionStore'), 'Mini 必须消费 PlaybackSessionStore');
    assert.ok(miniCode.includes('usePlaybackStore'), 'Mini 必须消费 playbackStore transport 读面');
    const expandedCode = stripComments(readRepoText('components/NowPlaying/ExpandedNowPlaying.tsx'));
    assert.ok(
      expandedCode.includes('useExpandedPlaybackControls') || expandedCode.includes('useExpandedNowPlayingViewModel'),
      'Expanded 必须经 facade/ViewModel 消费（consumer）',
    );
    console.log('PASS: M9-02-P4 single-audio-owner');
  }

  console.log('=== M9-02-P5: HistoryPanel 零 legacy ownership ===');
  {
    // player 侧无任何 History 实现残留（目录已删，此处双保险：若未来重建目录亦能捕获）。
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
    const historyUnderPlayer = walkPlayer.filter((abs) => abs.includes('History'));
    assert.deepStrictEqual(historyUnderPlayer, [], `player 下不得有 History ownership：${historyUnderPlayer.join('；')}`);
    for (const abs of walkPlayer) {
      if (abs.endsWith('.tsx') || abs.endsWith('.ts')) {
        const code = stripComments(fs.readFileSync(abs, 'utf8'));
        assert.ok(!code.includes('HistoryPanel'), `${abs} 不得引用 HistoryPanel`);
      }
    }
    // M4 Chat 正式实现保留（不机械删除别处同名）。
    assert.ok(
      fs.existsSync(path.resolve(process.cwd(), 'app/(main)/chat/components/HistoryPanel/index.tsx')),
      'Chat HistoryPanel 正式实现必须保留（M4 所有）',
    );
    console.log('PASS: M9-02-P5 history-ownership');
  }

  console.log('\nALL LEGACY PLAYER RETIREMENT UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runLegacyPlayerRetirementUnit()
  .then(() => {
    console.log('ALL LEGACY PLAYER RETIREMENT UNIT TESTS PASSED SUCCESSFULLY!');
  })
  .catch((error) => {
    console.error('Legacy player retirement unit test failed:', error);
    process.exit(1);
  });

export default testPromise;
