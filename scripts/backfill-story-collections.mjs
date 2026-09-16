// StoryCollection 可重复执行的数据回填脚本。
// 用法（必须先在隔离库上完成 migrate deploy）：
//   DATABASE_URL="file:$PWD/.e2e-runtime/test-db/manual/backfill.db" node scripts/backfill-story-collections.mjs
// 安全：仅允许 .e2e-runtime/ 下的隔离库；拒绝生产 app.db 与共享 prisma/dev.db。输出为脱敏计数，不含用户数据。
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const require = createRequire(import.meta.url);
const jiti = require('jiti')(path.join(cwd, 'index.js'), { alias: { '@': cwd } });

const url = process.env.DATABASE_URL ?? '';
if (!url.startsWith('file:')) {
  console.error('BLOCKED: 缺少受控 file: DATABASE_URL');
  process.exit(2);
}
if (url.includes('dev.db') || url.includes('app.db')) {
  console.error('BLOCKED: 拒绝指向开发/生产库');
  process.exit(2);
}
if (!url.includes('.e2e-runtime/')) {
  console.error('BLOCKED: 仅允许 .e2e-runtime/ 下的隔离库');
  process.exit(2);
}

const mod = await jiti(path.join(cwd, 'lib/server/storyCollectionBackfill.ts'));
const before = await mod.measureStoryCollectionMigrationState();
const counts = await mod.runStoryCollectionBackfill();
const after = await mod.measureStoryCollectionMigrationState();
const orphans = after.userWorksOrphaned + after.guestWorksOrphaned;
const positionless = after.userWorksPositionless + after.guestWorksPositionless;
process.stdout.write(
  `${JSON.stringify({ before, counts, after, orphans, positionless }, null, 2)}\n`,
);
if (orphans !== 0 || positionless !== 0) {
  console.error(`BLOCKED: backfill 后存在孤儿=${orphans} 无 position=${positionless}`);
  process.exit(1);
}
process.exit(0);
