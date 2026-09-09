import { createRequire } from 'node:module';
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

const jiti = require('jiti')(path.join(cwd, 'index.js'), {
  alias: { '@': cwd },
});

const testFiles = [
  './tests/test-sec-01.ts',
  './tests/test-sec-02.ts',
  './tests/test-batch-02.ts',
  './tests/test-release-pipeline.ts',
  './tests/test-auth-guest-matrix.ts',
  './tests/test-guest-signed-cookie.ts',
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
];

console.log('Running test suite...\n');
for (const file of testFiles) {
  console.log(`=== Executing ${file} ===`);
  try {
    const res = await jiti(file);
    if (res?.default && typeof res.default.then === 'function') {
      await res.default;
    } else if (res && typeof res.then === 'function') {
      await res;
    }
    console.log(`PASS: ${file}\n`);
  } catch (err) {
    console.error(`FAIL: ${file}`, err);
    process.exit(1);
  }
}
console.log('ALL TEST SUITES PASSED SUCCESSFULLY (exit code 0)');
