import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cwd = process.cwd();

// 中文注释：共享隔离库——静态导入 lib/db 的套件需要一个带 schema 的库。
// 运行器在加载任何用例前建好并注入 DATABASE_URL；只写 .e2e-runtime 隔离库，
// 绝不触碰 prisma/dev.db、.env.local 与生产端口。外部已注入时予以尊重。
const sharedDbPath = path.join(cwd, '.e2e-runtime', 'test-shared.db');
if (!process.env.DATABASE_URL) {
  fs.mkdirSync(path.dirname(sharedDbPath), { recursive: true });
  if (fs.existsSync(sharedDbPath)) {
    fs.unlinkSync(sharedDbPath);
  }
  execFileSync(path.join(cwd, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: `file:${sharedDbPath}` },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = `file:${sharedDbPath}`;
  console.log(`=== DB: shared ${sharedDbPath} ===`);
}

// 中文注释：每套件独立子进程执行——共享 jiti 单进程里跨套件的 globalThis/window/
// require.cache/模块单例会互相污染（wave1 实测：h08 的 window 桩在 resolve 后复活，
// 污染 h03 的 trpc init 求值）。套件内依赖 jiti；runner 自身只做进程编排与聚合退出码。
// canonical loader 仍为 jiti（suite-worker.mjs），TRPCError 口径不变（lib/trpc/init）。

const testFiles = [
  './tests/test-sec-01.ts',
  './tests/test-sec-02.ts',
  './tests/test-batch-02.ts',
  './tests/test-release-pipeline.ts',
  './tests/test-auth-guest-matrix.ts',
  './tests/test-guest-signed-cookie.ts',
  './tests/test-agent-summarize-guard.ts',
  './tests/test-session-branches.ts',
  './tests/test-rate-limit.ts',
  './tests/test-orphan-prevention.ts',
  './tests/test-guest-config.ts',
  './tests/test-guest-creative-sync.ts',
  './tests/test-guest-creative-e2e-harness.ts',
  './tests/test-paragraph-resume.ts',
  './tests/test-storycard-resume-fix01.ts',
  './tests/test-fix03-resume-countdown.ts',
  './tests/test-fix04-no-autocontinue.ts',
  './tests/test-restart-mock-managed.ts',
  './tests/test-e2e-db-guard.ts',
  './tests/test-e2e-db-guard-regression.ts',
  './tests/test-e2e-stream-observe.ts',
  './tests/test-toast-terminal-priority.ts',
  './tests/test-audio-ended-guard.ts',
  './tests/test-audio-ended-guard-wiring.ts',
  './tests/test-chat-onboarding.ts',
  './tests/test-h04-double-submit.ts',
  './tests/test-h08-budget-exhaustion.ts',
  './tests/test-h07-paragraph-guard.ts',
  './tests/test-h03-preload-isolation.ts',
  './tests/test-h16-exit-flush.ts',
  './tests/test-h15-concurrent-write.ts',
  './tests/test-h14-config-rollback.ts',
  './tests/test-h06-logout-probe.ts',
];

console.log('Running test suite...\n');
for (const file of testFiles) {
  console.log(`=== Executing ${file} ===`);
  const res = spawnSync(
    process.execPath,
    [path.join(cwd, 'scripts', 'suite-worker.mjs'), file],
    {
      cwd,
      env: process.env,
      stdio: 'inherit',
      encoding: 'utf8',
    },
  );
  if (res.status !== 0) {
    console.error(`FAIL: ${file} (exit ${res.status})`);
    process.exit(1);
  }
  console.log(`PASS: ${file}\n`);
}
console.log('ALL TEST SUITES PASSED SUCCESSFULLY (exit code 0)');
