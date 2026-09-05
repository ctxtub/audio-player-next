import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cwd = process.cwd();
const jiti = require('jiti')(path.join(cwd, 'index.js'), {
  alias: { '@': cwd },
});

const testFiles = [
  './tests/test-sec-01.ts',
  './tests/test-sec-02.ts',
  './tests/test-batch-02.ts',
  './tests/test-release-pipeline.ts',
  './tests/test-auth-guest-matrix.ts',
  './tests/test-rate-limit.ts',
  './tests/test-orphan-prevention.ts',
  './tests/test-guest-config.ts',
  './tests/test-guest-creative-sync.ts',
  './tests/test-guest-creative-e2e-harness.ts',
  './tests/test-paragraph-resume.ts',
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
