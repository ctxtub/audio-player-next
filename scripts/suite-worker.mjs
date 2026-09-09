// 中文注释：套件 worker——单套件进程内用 jiti 求值目标文件并 await 其 default promise。
// canonical loader = jiti（与历史口径一致），TRPCError 断言仍从 lib/trpc/init 取。
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cwd = process.cwd();
const jiti = require('jiti')(path.join(cwd, 'index.js'), {
  alias: { '@': cwd },
});

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/suite-worker.mjs <test-file>');
  process.exit(2);
}

const res = await jiti(file);
if (res?.default && typeof res.default.then === 'function') {
  await res.default;
} else if (res && typeof res.then === 'function') {
  await res;
}
