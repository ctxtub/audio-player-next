import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  AUDIO_DELETION_DEFAULT_LIMIT,
  AUDIO_DELETION_MAX_LIMIT,
} from '../../../lib/server/audioStorageCleanup';
import {
  runStartupAudioDeletionCleanup,
  STARTUP_AUDIO_CLEANUP_EMPTY_RESULT,
  STARTUP_AUDIO_CLEANUP_LIMIT,
} from '../../../lib/server/audioStorageStartup';
import {
  getOpportunisticAudioCleanupLastRunMsForTests,
  maybeRunOpportunisticAudioDeletionCleanup,
  OPPORTUNISTIC_AUDIO_CLEANUP_MIN_INTERVAL_MS,
  resetOpportunisticAudioCleanupThrottleForTests,
  setOpportunisticAudioCleanupRunnerForTests,
} from '../../../lib/server/storyAudio';

/**
 * M8-05-04 Production Closure 触发器单元测试（无需真库）。
 *
 * 锁定：
 * 1. startup 成功透传引擎结果，且默认 limit == DEFAULT（有界）；
 * 2. startup 失败不崩：runner 抛错 → 零结果 + warn 一次；logger 再抛亦不崩；
 * 3. instrumentation 钩子薄：register 导出 + nodejs 分支 + 动态 import 可测函数
 *    + fire-and-forget + 不直连 DB/存储；
 * 4. opportunistic 节流：间隔内多次调用只执行一次；过期后再次触发；时间戳可观测；
 * 5. opportunistic 失败吞错：runner 抛错仍 resolve（true），永不抛；
 * 6. 有界：两处触发均复用 DEFAULT limit（MAX 钳制由冻结引擎保证）+ ensureSegment
 *    调用点为 `void` fire-and-forget（无 await，不影响结果/延迟）；
 * 7. Docker plumbing 静态：Dockerfile 含 ARG（缺省空=fail-closed）+ 构建内联 env +
 *    runtime CANONICAL_AUDIO_ENABLED；compose 传递两变量（默认空）；.env.sample
 *    文档化两变量与 fail-closed 语义；canonicalFlag 语义未变（strict '1' 才开）。
 */

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
}

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
}

async function runAudioCleanupTriggersUnitTests() {
  console.log('=== 1. startup 成功透传 + 默认有界 ===');
  {
    assert.strictEqual(
      STARTUP_AUDIO_CLEANUP_LIMIT,
      AUDIO_DELETION_DEFAULT_LIMIT,
      '启动清理上限必须复用冻结引擎 DEFAULT',
    );
    assert.ok(
      STARTUP_AUDIO_CLEANUP_LIMIT > 0 &&
        STARTUP_AUDIO_CLEANUP_LIMIT <= AUDIO_DELETION_MAX_LIMIT,
      '启动清理上限必须落在 (0, MAX] 有界区间',
    );
    let seenLimit = -1;
    const res = await runStartupAudioDeletionCleanup({
      runner: async (opts) => {
        seenLimit = opts.limit;
        return {
          attempted: 2,
          succeeded: 2,
          failed: 0,
          attemptedKeys: ['k1', 'k2'],
        };
      },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    });
    assert.strictEqual(seenLimit, AUDIO_DELETION_DEFAULT_LIMIT, '缺省透传 DEFAULT limit');
    assert.deepStrictEqual(
      res,
      { attempted: 2, succeeded: 2, failed: 0, attemptedKeys: ['k1', 'k2'] },
      '成功原样透传引擎结果',
    );
    const custom = await runStartupAudioDeletionCleanup({
      limit: 7,
      runner: async (opts) => {
        seenLimit = opts.limit;
        return { ...STARTUP_AUDIO_CLEANUP_EMPTY_RESULT };
      },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    });
    assert.strictEqual(seenLimit, 7, '显式 limit 透传');
    assert.deepStrictEqual(custom, STARTUP_AUDIO_CLEANUP_EMPTY_RESULT, '空结果形状稳定');
    console.log('PASS: 1. startup 成功透传通过');
  }

  console.log('=== 2. startup 失败不崩服务 ===');
  {
    let warns = 0;
    const res = await runStartupAudioDeletionCleanup({
      runner: async () => {
        throw new Error('db unreachable');
      },
      logger: {
        warn: () => {
          warns += 1;
        },
        info: () => {},
        error: () => {},
      },
    });
    assert.deepStrictEqual(res, STARTUP_AUDIO_CLEANUP_EMPTY_RESULT, 'runner 抛错必须返回零结果');
    assert.strictEqual(warns, 1, '失败必须记录一次 warn');
    // logger 本身抛错亦不得崩
    const res2 = await runStartupAudioDeletionCleanup({
      runner: async () => {
        throw new Error('storage boom');
      },
      logger: {
        warn: () => {
          throw new Error('log sink down');
        },
        info: () => {},
        error: () => {},
      },
    });
    assert.deepStrictEqual(res2, STARTUP_AUDIO_CLEANUP_EMPTY_RESULT, '日志失败亦返回零结果');
    console.log('PASS: 2. startup 失败不崩通过');
  }

  console.log('=== 3. instrumentation 钩子薄 ===');
  {
    const hookSrc = readRepoFile('instrumentation.ts');
    const hookCode = stripComments(hookSrc);
    assert.ok(/export\s+async\s+function\s+register\b/.test(hookCode), '必须导出 register()');
    assert.ok(
      /export\s+const\s+runtime\s*=\s*['"]nodejs['"]/.test(hookCode),
      '必须声明 nodejs runtime（server hook 语义锁定）',
    );
    assert.ok(
      hookCode.includes("process.env.NEXT_RUNTIME") && hookCode.includes("'nodejs'"),
      '仅 nodejs runtime 触发',
    );
    assert.ok(
      hookCode.includes('lib/server/audioStorageStartup') &&
        hookCode.includes('runStartupAudioDeletionCleanup'),
      '核心逻辑必须走可测函数（动态 import）',
    );
    assert.ok(
      /void\s+mod\.runStartupAudioDeletionCleanup\(\)/.test(hookCode),
      '必须 fire-and-forget（void，不阻塞启动）',
    );
    for (const pat of [
      /audioStorageDeletion/,
      /getAudioAssetStorage/,
      /cleanupAudioStorageDeletions/,
      /prisma/,
    ]) {
      assert.strictEqual(pat.test(hookCode), false, `钩子不得直连 ${String(pat)}（保持薄）`);
    }
    assert.ok(hookSrc.includes('docker-start.sh'), '必须声明不另造 lifecycle runner');
    // middleware 存在时 hook 会被 edge 编译器亦编译一份：next.config 必须对 edge
    // 编译将启动链标 external（edge 侧永不执行），否则构建期 node: 内建爆炸。
    const nextConfig = stripComments(readRepoFile('next.config.ts'));
    assert.ok(
      nextConfig.includes("nextRuntime === 'edge'") &&
        nextConfig.includes('audioStorageStartup'),
      'next.config 必须含 edge 编译 external（启动链）',
    );
    console.log('PASS: 3. instrumentation 钩子薄通过');
  }

  console.log('=== 4. opportunistic 节流（多次调用只执行一次） ===');
  {
    assert.ok(
      OPPORTUNISTIC_AUDIO_CLEANUP_MIN_INTERVAL_MS >= 60_000,
      '节流间隔必须足够低频（≥60s），禁止每次请求全表扫描',
    );
    resetOpportunisticAudioCleanupThrottleForTests();
    setOpportunisticAudioCleanupRunnerForTests(null);
    let runs = 0;
    setOpportunisticAudioCleanupRunnerForTests(async () => {
      runs += 1;
    });
    try {
      const t0 = 1_000_000;
      assert.strictEqual(await maybeRunOpportunisticAudioDeletionCleanup(t0), true, '首调触发');
      assert.strictEqual(runs, 1, '首调执行一次');
      assert.strictEqual(
        getOpportunisticAudioCleanupLastRunMsForTests(),
        t0,
        '触发时间戳可观测',
      );
      assert.strictEqual(
        await maybeRunOpportunisticAudioDeletionCleanup(t0 + 1),
        false,
        '间隔内跳过',
      );
      assert.strictEqual(
        await maybeRunOpportunisticAudioDeletionCleanup(
          t0 + OPPORTUNISTIC_AUDIO_CLEANUP_MIN_INTERVAL_MS - 1,
        ),
        false,
        '边界前仍跳过',
      );
      assert.strictEqual(runs, 1, '多次调用只执行一次清理');
      assert.strictEqual(
        await maybeRunOpportunisticAudioDeletionCleanup(
          t0 + OPPORTUNISTIC_AUDIO_CLEANUP_MIN_INTERVAL_MS,
        ),
        true,
        '间隔到期再次触发',
      );
      assert.strictEqual(runs, 2, '到期后执行第二次');
    } finally {
      setOpportunisticAudioCleanupRunnerForTests(null);
      resetOpportunisticAudioCleanupThrottleForTests();
    }
    console.log('PASS: 4. opportunistic 节流通过');
  }

  console.log('=== 5. opportunistic 失败吞错永不抛 ===');
  {
    resetOpportunisticAudioCleanupThrottleForTests();
    setOpportunisticAudioCleanupRunnerForTests(async () => {
      throw new Error('cleanup backend down');
    });
    try {
      const origWarn = console.warn;
      let warns = 0;
      console.warn = (() => {
        warns += 1;
      }) as typeof console.warn;
      try {
        const out = await maybeRunOpportunisticAudioDeletionCleanup(2_000_000);
        assert.strictEqual(out, true, '失败仍 resolve（已触发），永不抛');
      } finally {
        console.warn = origWarn;
      }
      assert.strictEqual(warns, 1, '失败必须记录一次 warn');
    } finally {
      setOpportunisticAudioCleanupRunnerForTests(null);
      resetOpportunisticAudioCleanupThrottleForTests();
    }
    console.log('PASS: 5. opportunistic 失败吞错通过');
  }

  console.log('=== 6. 有界 + ensureSegment 调用点 fire-and-forget ===');
  {
    const storySrc = stripComments(readRepoFile('lib/server/storyAudio.ts'));
    assert.ok(
      storySrc.includes('limit: AUDIO_DELETION_DEFAULT_LIMIT'),
      '机会清理必须复用 DEFAULT limit（有界）',
    );
    assert.ok(
      storySrc.includes('cleanupAudioStorageDeletions({'),
      '机会清理必须复用冻结引擎',
    );
    assert.ok(
      /void\s+maybeRunOpportunisticAudioDeletionCleanup\(\)/.test(storySrc),
      'ensureSegment 必须 void fire-and-forget 触发（不 await）',
    );
    assert.strictEqual(
      /await\s+maybeRunOpportunisticAudioDeletionCleanup/.test(storySrc),
      false,
      'ensureSegment 不得 await 机会清理（不得影响结果/延迟）',
    );
    const startupSrc = stripComments(readRepoFile('lib/server/audioStorageStartup.ts'));
    assert.ok(
      startupSrc.includes('cleanupAudioStorageDeletions({ limit: opts.limit })') ||
        startupSrc.includes('cleanupAudioStorageDeletions({ limit: opts.limit })'),
      '启动清理必须复用冻结引擎（有界透传）',
    );
    console.log('PASS: 6. 有界 + 调用点通过');
  }

  console.log('=== 7. Docker / env plumbing 静态 ===');
  {
    const dockerfile = readRepoFile('Dockerfile');
    assert.ok(
      /ARG\s+NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED\s*=\s*""/.test(dockerfile),
      'builder 必须新增 ARG（缺省空=fail-closed）',
    );
    assert.ok(
      dockerfile.includes('ENV NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED='),
      'build 阶段必须作为 env 供 Next 构建内联',
    );
    assert.ok(
      dockerfile.includes('ENV CANONICAL_AUDIO_ENABLED='),
      'runtime 阶段必须支持 CANONICAL_AUDIO_ENABLED',
    );
    const compose = readRepoFile('docker-compose.yml');
    assert.ok(
      compose.includes('NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED'),
      'compose 必须传递构建期变量',
    );
    assert.ok(
      compose.includes('CANONICAL_AUDIO_ENABLED'),
      'compose 必须传递运行时变量',
    );
    assert.ok(compose.includes(':-'), 'compose 默认空（关闭）');
    const envSample = readRepoFile('.env.sample');
    assert.ok(
      envSample.includes('NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED'),
      '.env.sample 必须文档化构建期变量',
    );
    assert.ok(
      envSample.includes('CANONICAL_AUDIO_ENABLED'),
      '.env.sample 必须文档化运行时变量',
    );
    assert.ok(/fail-closed/i.test(envSample), '.env.sample 必须说明 fail-closed 语义');
    // 源码默认不得变：strict '1' 才开
    const flagSrc = readRepoFile('lib/audio/canonicalFlag.ts');
    assert.ok(
      flagSrc.includes("CANONICAL_AUDIO_ENABLED_VALUE = '1'"),
      '唯一合法开启值恒为 1',
    );
    assert.ok(
      /===\s*CANONICAL_AUDIO_ENABLED_VALUE/.test(stripComments(flagSrc)),
      '判定必须 strict 相等（语义不得变）',
    );
    console.log('PASS: 7. Docker plumbing 通过');
  }

  console.log('=== 8. T3 单轨 GC 触发 + isPlaying 守卫 + 双 flag plumbing 静态 ===');
  {
    const assetSrc = stripComments(readRepoFile('lib/server/storyAudioAsset.ts'));
    assert.ok(
      /void\s+maybeRunStoryAudioAssetGc\(\)/.test(assetSrc),
      'ensure 必须 void fire-and-forget 触发单轨 GC（不 await）',
    );
    assert.strictEqual(
      /await\s+maybeRunStoryAudioAssetGc\(/.test(assetSrc),
      false,
      'ensure 不得 await 单轨 GC（不得影响结果/延迟）',
    );
    assert.ok(
      assetSrc.includes('STORY_AUDIO_ASSET_GC_MIN_INTERVAL_MS') &&
        assetSrc.includes('STORY_AUDIO_ASSET_PLAYING_WINDOW_MS'),
      '必须定义机会式 GC 节流与「正在播放」窗口常量',
    );
    assert.ok(
      /lastPlayedAt:\s*\{\s*gte:\s*since\s*\},\s*completedAt:\s*null\s*\}/.test(assetSrc),
      'isPlaying 判定必须来自近期 lastPlayedAt 且 completedAt 为 null 的进度行',
    );
    assert.ok(
      assetSrc.includes('isPlaying: (workId) => playingUser.has(workId)') &&
        assetSrc.includes('isPlaying: (workId) => playingGuest.has(workId)'),
      'User/Guest 必须分域构建 isPlaying（避免 id 碰撞）',
    );
    assert.ok(
      assetSrc.includes('isSingleTrackAudioEnabled()'),
      '单轨服务必须受 flag 门禁（flag off ⇒ 无单轨流量）',
    );
    const readSrc = stripComments(readRepoFile('lib/server/audioAssetRead.ts'));
    assert.ok(
      readSrc.includes('isSingleTrackAudioEnabled()'),
      '读取路由必须受 flag 门禁（flag off ⇒ 404）',
    );
    const startupSrc = stripComments(readRepoFile('lib/server/audioStorageStartup.ts'));
    assert.ok(
      startupSrc.includes('runStartupStoryAudioAssetGc'),
      '启动模块必须导出单轨 GC 入口',
    );
    assert.ok(
      startupSrc.includes("await import('@/lib/server/storyAudioAsset')"),
      '启动入口必须动态 import 单轨服务（避免静态拉入 DB/存储）',
    );
    const instrumentationSrc = stripComments(readRepoFile('instrumentation.ts'));
    assert.ok(
      /void\s+mod\.runStartupStoryAudioAssetGc\(\)/.test(instrumentationSrc),
      'instrumentation 必须 void 触发单轨 GC（薄钩子）',
    );
    assert.strictEqual(
      /await\s+mod\.runStartupStoryAudioAssetGc\(/.test(instrumentationSrc),
      false,
      'instrumentation 不得 await 单轨 GC',
    );
    const dockerfile = readRepoFile('Dockerfile');
    assert.ok(
      /ARG\s+NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED\s*=\s*""/.test(dockerfile),
      'builder 必须新增单轨 build ARG（缺省空=fail-closed）',
    );
    assert.ok(
      dockerfile.includes('ENV NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED=') &&
        dockerfile.includes('ENV SINGLE_TRACK_AUDIO_ENABLED='),
      'build/runtime 阶段必须支持单轨双变量',
    );
    const compose = readRepoFile('docker-compose.yml');
    assert.ok(
      compose.includes('NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED') &&
        compose.includes('SINGLE_TRACK_AUDIO_ENABLED'),
      'compose 必须传递单轨双变量',
    );
    const envSample = readRepoFile('.env.sample');
    assert.ok(
      envSample.includes('NEXT_PUBLIC_SINGLE_TRACK_AUDIO_ENABLED') &&
        envSample.includes('SINGLE_TRACK_AUDIO_ENABLED'),
      '.env.sample 必须文档化单轨双变量',
    );
    const flagSrc = readRepoFile('lib/audio/singleTrackFlag.ts');
    assert.ok(
      /SINGLE_TRACK_AUDIO_ENABLED_VALUE\s*=\s*'1'/.test(flagSrc),
      '单轨唯一合法开启值恒为 1',
    );
    console.log('PASS: 8. T3 单轨 GC + 双 flag plumbing 通过');
  }

  console.log('ALL AUDIO CLEANUP TRIGGERS UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioCleanupTriggersUnitTests()
  .then(() => {
    console.log('ALL AUDIO CLEANUP TRIGGERS UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
