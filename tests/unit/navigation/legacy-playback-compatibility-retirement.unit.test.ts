import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// 中文注释：M9-03 Legacy Playback Compatibility Adapter Retirement 静态守卫（L1，纯静态，不触库/网络）。
// 锁定任务验收 1–6 + 8：
// P1 active product imports 三件套归零 + 文件物理删除；P2 useFloatingPlayer 别名删除；
// P3 legacy procedures 移除 + client/product refs 归零 + 旧 DTO/Input/helper 删除；
// P4 AccountSync 只 init PlaybackSessionStore；P5 Work 经 library.get/Anchor；
// P6 Draft 经 M5 canonical draft resolver；P8 无第二套 Zustand playback identity SSOT。
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
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      out.push(rel);
    }
  };
  for (const root of AUDIT_ROOTS) walk(root);
  return out.sort();
};

async function runLegacyPlaybackCompatibilityRetirementTests(): Promise<void> {
  console.log('=== M9-03-P1: 三件套 active imports 归零 + 文件删除 ===');
  {
    assert.strictEqual(
      fs.existsSync(path.resolve(process.cwd(), 'components/FloatingPlayer')),
      false,
      'components/FloatingPlayer 目录必须物理删除',
    );
    assert.strictEqual(
      fs.existsSync(path.resolve(process.cwd(), 'stores/playbackProgressStore.ts')),
      false,
      'stores/playbackProgressStore.ts 必须物理删除',
    );
    assert.strictEqual(
      fs.existsSync(path.resolve(process.cwd(), 'lib/client/playbackProgress.ts')),
      false,
      'lib/client/playbackProgress.ts 必须物理删除',
    );
    const files = walkAuditFiles();
    assert.ok(files.length > 50, `审计文件过少（实际 ${files.length}）`);
    const violations: string[] = [];
    for (const rel of files) {
      const code = stripComments(readRepoText(rel));
      if (code.includes('@/components/FloatingPlayer')) violations.push(`${rel} 含 FloatingPlayer import`);
      if (code.includes('@/stores/playbackProgressStore')) violations.push(`${rel} 含 playbackProgressStore import`);
      if (code.includes('@/lib/client/playbackProgress')) violations.push(`${rel} 含 legacy playbackProgress client import`);
      if (/from\s+['"]@\/lib\/client\/playbackProgress['"]/.test(code)) {
        violations.push(`${rel} 直引 legacy client`);
      }
    }
    assert.deepStrictEqual(violations, [], `active product imports 必须归零：${violations.join('；')}`);
    console.log('PASS: M9-03-P1 imports-zero + files-deleted');
  }

  console.log('=== M9-03-P2: useFloatingPlayer 别名删除 ===');
  {
    const files = walkAuditFiles();
    const violations: string[] = [];
    for (const rel of files) {
      const code = stripComments(readRepoText(rel));
      if (code.includes('useFloatingPlayer')) violations.push(rel);
    }
    assert.deepStrictEqual(violations, [], `useFloatingPlayer 必须零残留：${violations.join('；')}`);
    const storeSrc = readRepoText('stores/playbackStore.ts');
    assert.ok(!storeSrc.includes('useFloatingPlayer'), 'playbackStore 不得再导出别名');
    console.log('PASS: M9-03-P2 alias-removed');
  }

  console.log('=== M9-03-P3: legacy procedures 移除 + DTO/Input/helper 删除 ===');
  {
    const routerText = readRepoText('lib/trpc/routers/playback.ts');
    const routerCode = stripComments(routerText);
    for (const legacy of ['getProgress', 'saveProgress', 'clearProgress']) {
      assert.strictEqual(
        new RegExp(`\\b${legacy}\\s*:`).test(routerCode),
        false,
        `router 必须删除 playback.${legacy}`,
      );
    }
    for (const name of [
      'getAnchor',
      'beginSession',
      'saveCheckpoint',
      'completeSession',
      'clearAnchor',
      'promoteDraftToWork',
      'getWorkProgressBatch',
    ]) {
      assert.match(routerCode, new RegExp(`\\b${name}\\s*:`), `M5 正式 procedure 必须保留：${name}`);
    }
    // 旧 server helper 仅服务 legacy procedures → 同一提交删除。
    assert.strictEqual(
      fs.existsSync(path.resolve(process.cwd(), 'lib/server/playbackProgress.ts')),
      false,
      'lib/server/playbackProgress.ts 必须删除',
    );
    // 旧 DTO/Input 删除（M5 共用类型保留：Anchor/Source/WorkProgress/checkpoint 仍在）。
    const schemaText = readRepoText('lib/trpc/schemas/playback.ts');
    assert.strictEqual(/export const savePlaybackProgressInputSchema/.test(schemaText), false, '必须删除 save input');
    assert.strictEqual(/export const playbackProgressDTOSchema/.test(schemaText), false, '必须删除 progress DTO');
    for (const token of [
      'playbackAnchorDTOSchema',
      'playbackSourceSchema',
      'workPlaybackProgressDTOSchema',
      'playbackSessionIdSchema',
      'savePlaybackCheckpointInputSchema',
    ]) {
      assert.match(schemaText, new RegExp(`export const ${token}`), `M5 契约必须保留 ${token}`);
    }
    // client/product refs 归零：除历史注释外不得再调旧 procedure 名。
    const files = walkAuditFiles();
    const refViolations: string[] = [];
    for (const rel of files) {
      const code = stripComments(readRepoText(rel));
      for (const legacy of ['playback.getProgress', 'playback.saveProgress', 'playback.clearProgress']) {
        if (code.includes(legacy)) refViolations.push(`${rel} 含 ${legacy}`);
      }
      if (/trpc\.playback\.(getProgress|saveProgress|clearProgress)\b/.test(code)) {
        refViolations.push(`${rel} 直调 legacy procedure`);
      }
    }
    assert.deepStrictEqual(refViolations, [], `legacy procedure refs 必须归零：${refViolations.join('；')}`);
    console.log('PASS: M9-03-P3 procedures-removed + contract-retained');
  }

  console.log('=== M9-03-P4: AccountSync 只 init PlaybackSessionStore ===');
  {
    const syncSrc = readRepoText('stores/accountSync.ts');
    const syncCode = stripComments(syncSrc);
    assert.ok(syncCode.includes('usePlaybackSessionStore'), 'AccountSync 必须 init PlaybackSessionStore');
    assert.ok(syncCode.includes("name: 'playbackSession'"), '参与项必须为 playbackSession');
    assert.ok(!syncCode.includes('usePlaybackProgressStore'), '不得再 init legacy progress store');
    assert.ok(!syncCode.includes("name: 'playbackProgress'"), '不得再保留 playbackProgress 参与项');
    console.log('PASS: M9-03-P4 account-sync-session-only');
  }

  console.log('=== M9-03-P5/P6: Work 走 library.get/Anchor；Draft 走 canonical resolver ===');
  {
    const sessionSrc = readRepoText('stores/playbackSessionStore.ts');
    const sessionCode = stripComments(sessionSrc);
    assert.ok(
      sessionCode.includes('@/lib/client/library') || sessionCode.includes('getWorkDetail'),
      'Work hydrate 必须经 library.get 精确 resolve',
    );
    assert.ok(
      sessionCode.includes('playbackDraftSnapshot') || sessionCode.includes('resolvePlaybackDraftSnapshot'),
      'Draft hydrate 必须走 M5 canonical draft resolver',
    );
    assert.ok(!sessionCode.includes('generationHistoryStore'), 'Session 不得走 generationHistory 最近 N 条');
    assert.ok(!sessionCode.includes('playbackProgressStore'), 'Session 不得依赖旧 progress store');
    const cardSrc = stripComments(readRepoText('app/(main)/chat/components/MessageParts/StoryCardPart.tsx'));
    assert.ok(!cardSrc.includes('playbackProgressStore'), 'StoryCard 不得再读旧 progress store');
    assert.ok(cardSrc.includes('usePlaybackSessionStore'), 'StoryCard resume 位必须经 Session SSOT');
    const flowSrc = stripComments(readRepoText('app/services/storyFlow.ts'));
    assert.ok(!flowSrc.includes('playbackProgressStore'), 'storyFlow 不得再消费旧 progress store');
    console.log('PASS: M9-03-P5/P6 hydrate-canonical');
  }

  console.log('=== M9-03-P8: 无第二套 Zustand playback identity SSOT ===');
  {
    assert.strictEqual(
      fs.existsSync(path.resolve(process.cwd(), 'stores/playbackProgressStore.ts')),
      false,
      '不得保留第二套 playback identity store 文件',
    );
    const files = walkAuditFiles();
    const ssotViolations: string[] = [];
    for (const rel of files) {
      if (rel === 'stores/playbackSessionStore.ts' || rel === 'stores/playbackStore.ts') continue;
      const code = stripComments(readRepoText(rel));
      if (code.includes('usePlaybackProgressStore')) ssotViolations.push(rel);
    }
    assert.deepStrictEqual(ssotViolations, [], `第二 SSOT 引用必须为 0：${ssotViolations.join('；')}`);
    // Session SSOT 身份面仍在：source/sessionId/next。
    const sessionCode = stripComments(readRepoText('stores/playbackSessionStore.ts'));
    assert.ok(sessionCode.includes('source'), 'Session SSOT 必须保留 source');
    assert.ok(sessionCode.includes('sessionId'), 'Session SSOT 必须保留 sessionId');
    assert.ok(sessionCode.includes('nextParagraphIndex'), 'Session SSOT 必须保留 next');
    console.log('PASS: M9-03-P8 single-ssot');
  }

  console.log('\nALL LEGACY PLAYBACK COMPATIBILITY RETIREMENT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runLegacyPlaybackCompatibilityRetirementTests()
  .then(() => {
    console.log('ALL LEGACY PLAYBACK COMPATIBILITY RETIREMENT TESTS PASSED SUCCESSFULLY!');
  })
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });

export default testPromise;
