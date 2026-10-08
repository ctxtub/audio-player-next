import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildSnapshotEnv } from '../system/browser/harness/app-server.mjs';
const require = createRequire(import.meta.url);
const root = process.cwd();
// 每次运行独占临时数据库，不继承宿主业务配置。
const directory = mkdtempSync(path.join(tmpdir(), 'story-library-lifecycle-'));
const db = path.join(directory, 'isolated.db');
const env = buildSnapshotEnv(db, 'http://127.0.0.1:1');
const config = path.join(directory, 'prisma.config.ts');
writeFileSync(config, `import { defineConfig } from ${JSON.stringify(path.join(root, 'node_modules/prisma/config'))}; export default defineConfig({ schema: ${JSON.stringify(path.join(root, 'prisma/schema.prisma'))}, migrations: { path: ${JSON.stringify(path.join(root, 'prisma/migrations'))} }, datasource: { url: ${JSON.stringify('file:' + db)} } });`);
execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--config', config], { cwd: directory, env, stdio: 'pipe' });
// 服务导入也只使用合成业务配置，不继承宿主 API/Tracing 凭据。
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);
const jiti = require('jiti')(path.join(root, 'index.js'), { alias: { '@': root } });
const { prisma } = await jiti(path.join(root, 'lib/db.ts'));
const collectionViewModel = await jiti(path.join(root, 'lib/client/collectionViewModel.ts'));
const collection = await jiti(path.join(root, 'lib/server/storyCollection.ts'));
const work = await jiti(path.join(root, 'lib/server/storyWork.ts'));
const conversation = await jiti(path.join(root, 'lib/server/conversation.ts'));
try {
  for (const type of ['guest', 'user']) {
    const owner = type === 'user' ? await prisma.user.create({ data: { username: `isolated-${Date.now()}`, password: 'synthetic-not-a-real-password' } }) : { id: `synthetic-guest-${Date.now()}` };
    const subject = { type, id: owner.id };
    const conversations = type === 'user' ? prisma.conversation : prisma.guestConversation;
    const collections = type === 'user' ? prisma.storyCollection : prisma.guestStoryCollection;
    const works = type === 'user' ? prisma.storyWork : prisma.guestStoryWork;
    const ownerField = type === 'user' ? { userId: owner.id } : { guestId: owner.id };
    const old = await conversations.create({ data: { id: `old-${type}`, ...ownerField, state: 'active' } });
    const group = await collections.create({ data: { id: `collection-${type}`, conversationId: old.id, title: '隔离验证故事集', ...ownerField } });
    const first = await works.create({ data: { ...ownerField, collectionId: group.id, position: 0, title: '已单独删除', prompt: 'synthetic', storyText: '完全合成的验证正文', contentHash: 'synthetic-first' } });
    const second = await works.create({ data: { ...ownerField, collectionId: group.id, position: 1, title: '随集删除', prompt: 'synthetic', storyText: '完全合成的验证正文', contentHash: 'synthetic-second' } });
    await work.trashStoryWorkForSubject(subject, first.id);
    const detail = await collection.getCollectionForSubject(subject, group.id);
    assert.equal(collectionViewModel.areMemberPositionsOrdered(detail.works), true);
    assert.equal(detail.workCount, 1); assert.deepEqual(detail.works.map((item) => item.id), [second.id]);
    const hidden = await collection.listCollectionsForSubject(subject, { query: '已单独删除' });
    assert.equal(hidden.items.length, 0);
    await collection.softDeleteCollectionForSubject(subject, group.id);
    await assert.rejects(() => work.restoreStoryWorkForSubject(subject, first.id), /请先恢复/);
    await assert.rejects(() => work.getStoryWorkForSubject(subject, second.id));
    await collection.restoreCollectionForSubject(subject, group.id);
    assert.notEqual((await works.findUnique({ where: { id: first.id } })).deletedAt, null);
    assert.equal((await works.findUnique({ where: { id: second.id } })).deletedAt, null);
    const resolved = await work.getStoryWorkForSubject(subject, second.id);
    await assert.rejects(() => work.getStoryWorkForSubject(subject, second.id, 'wrong-parent')); assert.equal(resolved.collectionId, group.id); assert.equal(resolved.conversationId, old.id);
    const next = await conversation.createNewConversationForSubject(subject, old.id);
    const viewed = await conversation.getConversationForSubject(subject, old.id);
    assert.equal(viewed.state, 'closed'); assert.equal((await conversation.getActiveConversationForSubject(subject)).id, next.id);
    await assert.rejects(() => conversation.resumeConversationForSubject(subject, old.id, old.id), /已变化/);
    const resumed = await conversation.resumeConversationForSubject(subject, old.id, next.id);
    assert.equal(resumed.id, old.id); assert.equal((await conversation.getActiveConversationForSubject(subject)).id, old.id);
    await assert.rejects(() => conversation.saveConversationSnapshotForSubject(subject, next.id, []), /当前编辑/);
    const foreign = type === 'user' ? { type: 'user', id: owner.id + 9999 } : { type: 'guest', id: 'another-synthetic-guest' };
    await assert.rejects(() => conversation.resumeConversationForSubject(foreign, old.id, null));
    await assert.rejects(() => collection.getCollectionForSubject(foreign, group.id));
    console.log(`${type}: deletion provenance, visibility, source identity, resume conflict and closed-write guards PASS`);
  }
} finally { await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true }); }
