import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// 中文注释：M10-05 历史 browser 债务清零与目录冻结静态守卫（L1，纯静态，不触库/网络）。
// 锁 M10 收官 6 条 browser oracle 迁移 + 目录冻结规则（M10 CLOSED 时）：
// M10-01) main-navigation-route-journey 不再期待 Legacy /player UI（compat redirect 形态）；
// M10-02) main-chrome-mobile-docked 不再期待 Mini 导航 /player（openExpanded + URL 不变）；
// M10-03) cold-start 不再断言旧主导航名「播放器」（现 IA = 创作 / 故事库 / 设置）；
// M10-04) Generation History browser oracle 不再把 replay 定义成 Transport-only oneShot（正式 Work Session）；
// M10-05) History Prompt autoplay 要求正式 Session / Mini（正式 Draft Session）；
// M10-06) /player compatibility 仅允许既有白名单形态（产品三件套 + browser compat spec 白名单）；
// M10-07) 目录冻结：catalog 无 KNOWN BASELINE 豁免态；deferred 项保持 PLANNED + executable_ids=[]；
//         browser runner retries=0；本 closure 自身绑定不被静默解绑。
// 审计口径：被测 spec / 产品文件原文读取，注释剥离后做“旧语义归零”判定，冻结标记做“存在性”判定。

const readRepoText = (rel: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

const MAIN_NAV_SPEC = 'tests/system/browser/scenarios/main-navigation-route-journey.spec.ts';
const DOCKED_SPEC = 'tests/system/browser/scenarios/main-chrome-mobile-docked.spec.ts';
const COLD_START_SPEC = 'tests/system/browser/scenarios/guest-cold-start-first-screen.spec.ts';
const GEN_HISTORY_SPEC = 'tests/system/browser/scenarios/generation-history-play-once.spec.ts';
const HISTORY_PROMPT_SPEC = 'tests/system/browser/scenarios/history-prompt-start-new-creation.spec.ts';
const SCENARIO_DIR = 'tests/system/browser/scenarios';

/** 允许以“导航进入 /player”形态（goto / waitForURL / client transition）覆盖兼容入口的 spec 白名单。 */
const PLAYER_NAV_ALLOWLIST = new Set<string>([
  'main-navigation-route-journey.spec.ts',
  'player-compat-redirect.spec.ts',
  'm9-player-retirement-closure.spec.ts',
  'expanded-now-playing-surface.spec.ts',
]);

const listScenarioSpecs = (): string[] =>
  fs
    .readdirSync(path.resolve(process.cwd(), SCENARIO_DIR))
    .filter((n) => n.endsWith('.spec.ts'))
    .sort();

async function runM10ClosureUnit(): Promise<void> {
  console.log('=== M10-01: main-navigation 不再期待 Legacy /player UI ===');
  {
    const raw = readRepoText(MAIN_NAV_SPEC);
    // 冻结形态存在性：compat redirect 落到 /library + 故事库 Tab 选中 + 旧 Player DOM 零计数。
    assert.ok(raw.includes('waitForURL("**/library"'), '必须等待落到 /library');
    assert.ok(raw.includes('not.toContain("/player")'), '必须以否定形态锁 /player 非落地');
    for (const marker of ['播放进度', '播放速度', '从头重播']) {
      assert.ok(
        raw.includes(`name: "${marker}" })).toHaveCount(0`),
        `旧 Player 地标必须零计数：${marker}`
      );
    }
    assert.ok(raw.includes('单宿主'), '必须锁共享布局单宿主挂载（MPA 语义）');
    // 旧语义归零：剥离否定断言后，不得再有“落到 /player”的正向期待。
    const withoutNeg = raw.split('not.toContain("/player")').join('');
    assert.ok(!withoutNeg.includes('toContain("/player")'), '不得有正向 toContain(/player) 落地期待');
    assert.ok(!withoutNeg.includes('toHaveURL(') || !withoutNeg.match(/toHaveURL\([^)]*player/), '不得有 toHaveURL(/player) 期待');
    assert.ok(!/pathname\)\.toBe\("\/player"\)/.test(withoutNeg), '不得期待 pathname 落到 /player');
    console.log('PASS: M10-01 main-navigation-compat-form');
  }

  console.log('=== M10-02: mobile-docked 不再期待 Mini 导航 /player ===');
  {
    const raw = readRepoText(DOCKED_SPEC);
    // 冻结形态存在性：Mini 点击走 openExpanded + URL 不变 + 会话连续 + 从未进入 /player。
    assert.ok(raw.includes('mini-metadata-button'), '必须经 Mini 元数据区打开');
    assert.ok(raw.includes('expanded-now-playing'), '必须打开 Expanded');
    assert.ok(raw.includes('expect(page.url()).toBe(urlBeforeExpand)'), '必须断言 URL 不变');
    assert.ok(raw.includes('not.toContain("/player")'), '必须锁从未进入 /player');
    assert.ok(raw.includes('openExpanded'), '必须为 openExpanded 语义（注释或断言）');
    // 旧语义归零：本 spec 不得导航进入 /player（无 goto / waitForURL player 形态）。
    const code = stripComments(raw);
    assert.ok(!/goto\([^)]*\/player/.test(code), 'Mini 链路不得 goto /player');
    assert.ok(!/waitForURL\([^)]*player/.test(code), 'Mini 链路不得 waitForURL /player');
    console.log('PASS: M10-02 docked-open-expanded-form');
  }

  console.log('=== M10-03: cold-start 不再断言旧主导航名「播放器」 ===');
  {
    const raw = readRepoText(COLD_START_SPEC);
    // 旧名归零：全文件不得出现「播放器」。
    assert.ok(!raw.includes('播放器'), 'cold-start 不得再出现旧主导航名「播放器」');
    // 现 IA 冻结：创作 / 故事库 / 设置三 Tab。
    assert.ok(
      raw.includes('["创作", "故事库", "设置"]') || raw.includes("['创作', '故事库', '设置']"),
      '必须断言冻结 IA 三 Tab：创作 / 故事库 / 设置'
    );
    console.log('PASS: M10-03 cold-start-frozen-ia');
  }

  console.log('=== M10-04: Generation History 不再是 Transport-only oneShot ===');
  {
    const raw = readRepoText(GEN_HISTORY_SPEC);
    const code = stripComments(raw);
    // 旧语义归零：可执行面不得再有 oneShot / isOneShot（退役说明只允许留在注释）。
    assert.ok(!code.includes('oneShot'), '可执行面不得再定义 oneShot 回放');
    assert.ok(!code.includes('isOneShot'), '可执行面不得再断言 isOneShot');
    // 冻结形态存在性：正式 Work Session（kind=work + workId=点击项 + finite + 真 Anchor work 身份）。
    assert.ok(raw.includes('source?.kind).toBe("work")'), '必须断言 source.kind=work');
    assert.ok(raw.includes('continuationMode).toBe("finite")'), '必须断言 finite（非 Draft、无 replay-text 身份）');
    assert.ok(raw.includes('toBe("work")'), '必须断言真 server Anchor 身份为 work');
    assert.ok(raw.includes('startsWith("replay-text-")).toBe(false)'), '必须否定 replay-text 伪身份');
    // 正式 Session / Mini 可达：Mini 同帧可见 + Expanded 可开（URL/会话不变）。
    assert.ok(raw.includes('mini-now-playing'), '回放必须 Mini 可见');
    assert.ok(raw.includes('expanded-now-playing'), '回放必须 Expanded 可达');
    console.log('PASS: M10-04 generation-history-work-session');
  }

  console.log('=== M10-05: History Prompt autoplay 要求正式 Session / Mini ===');
  {
    const raw = readRepoText(HISTORY_PROMPT_SPEC);
    // 旧语义归零：全文件不得再有 oneShot（Transport-only 语义已退役）。
    assert.ok(!raw.includes('oneShot'), 'History Prompt 链路不得再有 oneShot 语义');
    const code = stripComments(raw);
    assert.ok(!code.includes('isOneShot'), '可执行面不得再断言 isOneShot');
    // 冻结形态存在性：正式 Draft Session（kind=draft + 新 messageId + 新 sessionId + 非 idle + finite）。
    assert.ok(raw.includes('autoplayDraftStory'), '必须为 autoplayDraftStory 正式 Draft 链路');
    assert.ok(raw.includes('source?.kind).toBe("draft")'), '必须断言 source.kind=draft');
    assert.ok(raw.includes('continuationMode).toBe("finite")'), '必须断言 finite');
    assert.ok(raw.includes('status).not.toBe("idle")'), '必须断言 Session 非 idle（先有 Session 后有播放）');
    assert.ok(raw.includes('mini-now-playing'), 'autoplay 必须 Mini 可见（只派生自 Session）');
    assert.ok(raw.includes('startsWith("replay-text-")).toBe(false)'), '必须否定 replay-text 伪身份');
    console.log('PASS: M10-05 history-prompt-draft-session');
  }

  console.log('=== M10-06: /player compatibility 仅允许既有白名单形态 ===');
  {
    // 产品侧三件套冻结形态。
    const pageSrc = readRepoText('app/(main)/player/page.tsx');
    const pageCode = stripComments(pageSrc);
    assert.ok(!/['"]use client['"]/.test(pageSrc), 'compat route 必须为 server 组件');
    assert.ok(/redirect\s*\(\s*['"]\/library['"]\s*\)/.test(pageCode), '必须精确 redirect(/library)');
    const navSrc = readRepoText('lib/navigation/mainNavigation.ts');
    assert.ok(navSrc.includes("'/player'"), '冻结 alias 必须保留 /player 映射声明');
    assert.ok(navSrc.includes("'library'"), '冻结 alias 必须映射到 library');
    const middlewareSrc = readRepoText('middleware.ts');
    assert.ok(middlewareSrc.includes("'/player'"), 'middleware 兼容守卫必须保留 /player 受保护路径');
    // browser 侧：导航进入 /player 只允许白名单 compat spec。
    const navRe = /goto\([^)]*\/player|waitForURL\([^)]*player|transitionToPlayerCompatViaClientRouter\(page,\s*"\/player/;
    const offenders: string[] = [];
    const whitelistHits: string[] = [];
    for (const name of listScenarioSpecs()) {
      const code = stripComments(readRepoText(`${SCENARIO_DIR}/${name}`));
      if (navRe.test(code)) {
        if (PLAYER_NAV_ALLOWLIST.has(name)) whitelistHits.push(name);
        else offenders.push(name);
      }
    }
    assert.deepStrictEqual(offenders, [], `非白名单 spec 不得导航进入 /player：${offenders.join('；')}`);
    assert.deepStrictEqual(
      whitelistHits.sort(),
      [...PLAYER_NAV_ALLOWLIST].sort(),
      `白名单 spec 必须保持既有四件套，实际=${whitelistHits.join('；')}`
    );
    console.log(`PASS: M10-06 player-compat-allowlist specs=${whitelistHits.join(',')}`);
  }

  console.log('=== M10-07: 目录冻结（无 KNOWN BASELINE 豁免 + deferred 保持 PLANNED + retries=0） ===');
  {
    const catalogText = readRepoText('tests/test-catalog.yaml');
    // 豁免态归零：catalog 不得出现任何 KNOWN BASELINE 豁免标记。
    assert.ok(!/known[\s_-]*baseline/i.test(catalogText), 'catalog 不得存在 KNOWN BASELINE 豁免态');
    // deferred 冻结：story-card double-tap / TTS 相关保持 PLANNED + executable_ids=[]。
    const chunks = catalogText.split(/\n  - case_id: /);
    const byId = new Map<string, string>();
    for (let i = 1; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const id = chunk.split('\n', 1)[0].trim();
      byId.set(id, chunk);
    }
    const plannedFrozen = [
      'story-card-double-tap-suppress',
      'tts-voice-fallback-browser-behavior',
      'tts-limit-tier-voice-fallback',
      'tts-synthesize-fail-no-zombie',
      'breakpoint-switch-tts-fail-retry-bound',
    ];
    for (const id of plannedFrozen) {
      const chunk = byId.get(id);
      assert.ok(chunk, `deferred case 必须仍登记在 catalog：${id}`);
      assert.ok(chunk.includes('lifecycle_status: PLANNED'), `${id} 必须保持 PLANNED`);
      assert.ok(/executable_ids: \[\]/.test(chunk), `${id} 必须保持 executable_ids=[]`);
    }
    // 本 closure 自身绑定锁死：ACTIVE + L1 executable 落盘（防静默解绑缩分母）。
    const selfChunk = byId.get('m10-browser-debt-closure');
    assert.ok(selfChunk, '本 closure case 必须登记在 catalog');
    assert.ok(selfChunk.includes('lifecycle_status: ACTIVE'), '本 closure 必须为 ACTIVE');
    assert.ok(selfChunk.includes('exec-m10-browser-debt-closure'), '本 closure 必须绑定 L1 executable');
    assert.ok(
      fs.existsSync(path.resolve(process.cwd(), 'tests/unit/navigation/m10-browser-debt-closure.unit.test.ts')),
      '本 closure L1 文件必须落盘'
    );
    // runner 口径锁死：browser 全量 retries=0（不靠重试掩盖失败）。
    const pwConfig = readRepoText('tests/system/browser/playwright.config.ts');
    assert.ok(/retries:\s*0/.test(stripComments(pwConfig)), 'browser runner 必须 retries=0');
    assert.ok(!/test\.skip\(|test\.fixme\(/.test(stripComments(pwConfig)), 'browser config 不得新增 skip/fixme');
    console.log('PASS: M10-07 catalog-freeze');
  }

  console.log('\nALL M10 BROWSER DEBT CLOSURE UNIT TESTS PASSED SUCCESSFULLY!');
}

const testPromise = runM10ClosureUnit()
  .then(() => {
    console.log('ALL M10 BROWSER DEBT CLOSURE UNIT TESTS PASSED SUCCESSFULLY!');
  })
  .catch((error) => {
    console.error('M10 closure unit test failed:', error);
    process.exit(1);
  });

export default testPromise;
