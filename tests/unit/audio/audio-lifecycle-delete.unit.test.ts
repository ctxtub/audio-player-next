import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * M8-05-02 Audio-aware Physical Delete / Trash / Restore / Guest GC 单元测试（无真库）。
 *
 * 锁定（与任务验收对应，静态 + 纯函数口径）：
 * 1. 唯一合法位置：全仓 prisma.storyWork.delete/deleteMany 与
 *    prisma.guestStoryWork.delete/deleteMany 仅出现在
 *    lib/server/storyWork.ts 的 executeStoryWorkPhysicalDelete 内；
 * 2. Trash / Restore 零 Audio side effect（源码静态：不碰 tombstone/存储/TTS/Manifest/Segment）；
 * 3. Physical Delete 事务顺序：同一 $transaction 内
 *    findMany Work → findMany Manifest → findMany Segment →
 *    enqueueAudioDeletionTombstones → deleteMany；COMMIT 后 best-effort cleanupAudioStorageKeys；
 * 4. 窄 discriminated contract：仅 user/trash、guest/trash、guest/retention 三形态，无自由 where；
 * 5. Guest GC 经统一 seam（guestGc 含 executeStoryWorkPhysicalDelete、无直调 delete、无 Audio GC 复制）；
 * 6. 05-01 冻结 API 只消费不改契约（audioStorageCleanup 导出面 + 零跨域导入 + 有界消费保持）。
 */

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
}

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
}

function collectLibFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'generated') continue;
        walk(abs);
        continue;
      }
      if (ent.name.endsWith('.ts')) out.push(abs);
    }
  };
  walk(path.join(process.cwd(), 'lib'));
  return out;
}

async function runAudioLifecycleDeleteUnitTests() {
  const repoRoot = process.cwd();

  console.log('=== 1. 静态 oracle：唯一合法 physical-delete 位置 ===');
  {
    const files = collectLibFiles();
    const offenders: string[] = [];
    for (const abs of files) {
      const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
      if (rel === 'lib/server/storyWork.ts') continue;
      const src = stripComments(fs.readFileSync(abs, 'utf-8'));
      if (
        /prisma\s*\.\s*storyWork\s*\.\s*delete(Many)?\b/.test(src) ||
        /prisma\s*\.\s*guestStoryWork\s*\.\s*delete(Many)?\b/.test(src) ||
        /tx\s*\.\s*storyWork\s*\.\s*delete\b/.test(src) ||
        /tx\s*\.\s*guestStoryWork\s*\.\s*delete\b/.test(src)
      ) {
        // 允许 tx.storyWork.deleteMany / tx.guestStoryWork.deleteMany 仅在 seam 内；
        // 此处扫描的是 seam 之外的文件，任何匹配即违规（含 tx 形态，防第二套 helper 经 tx 绕行）。
        offenders.push(rel);
      }
      // tx.deleteMany 形态在 seam 外亦违规（同上）。
      if (/\.storyWork\s*\.\s*deleteMany/.test(src) || /\.guestStoryWork\s*\.\s*deleteMany/.test(src)) {
        if (!offenders.includes(rel)) offenders.push(rel);
      }
    }
    // 去重后断言：seam 外零写入
    assert.deepStrictEqual(offenders, [], `非法 physical-delete 位置：${offenders.join(',')}`);
    // seam 内确有三处 deleteMany（user/trash、guest/trash、guest/retention）
    const seam = stripComments(readRepoFile('lib/server/storyWork.ts'));
    const seamDeletes = seam.match(/\.storyWork\s*\.\s*deleteMany|\.guestStoryWork\s*\.\s*deleteMany/g) ?? [];
    assert.ok(
      seamDeletes.length >= 3,
      `seam 内应有 ≥3 处 deleteMany（user/guest-trash/guest-retention），实际 ${seamDeletes.length}`,
    );
    // 全仓不得新增裸 prisma.storyWork.delete（单条亦禁）
    for (const abs of files) {
      const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
      if (rel === 'lib/server/storyWork.ts') continue;
      const src = stripComments(fs.readFileSync(abs, 'utf-8'));
      assert.strictEqual(
        /prisma\s*\.\s*(storyWork|guestStoryWork)\s*\.\s*delete\b/.test(src),
        false,
        `${rel} 不得裸调单条 delete`,
      );
    }
    console.log('PASS: 1. 唯一合法位置通过');
  }

  console.log('=== 2. Trash / Restore 零 Audio side effect（静态） ===');
  {
    const seamSrc = readRepoFile('lib/server/storyWork.ts');
    const code = stripComments(seamSrc);
    const trashBlock = code.slice(
      code.indexOf('export async function trashStoryWorkForSubject'),
      code.indexOf('export async function restoreStoryWorkForSubject'),
    );
    const restoreBlock = code.slice(
      code.indexOf('export async function restoreStoryWorkForSubject'),
      code.indexOf('export type PhysicalDeleteStoryWorkOptions'),
    );
    assert.ok(trashBlock.length > 500, 'trash 块可定位');
    assert.ok(restoreBlock.length > 500, 'restore 块可定位');
    for (const [label, block] of [
      ['trash', trashBlock],
      ['restore', restoreBlock],
    ] as const) {
      for (const pat of [
        /audioStorageDeletion/,
        /enqueueAudioDeletionTombstones/,
        /cleanupAudioStorageKeys/,
        /cleanupAudioStorageDeletions/,
        /getAudioAssetStorage/,
        /synthesize/,
        /storyAudioManifest/i,
        /storyAudioSegment/i,
        /guestStoryAudioManifest/i,
        /guestStoryAudioSegment/i,
        /storage\.delete/,
        /\.deleteMany/,
      ]) {
        assert.strictEqual(pat.test(block), false, `${label} 不得触达 ${String(pat)}`);
      }
      // 仅允许 deletedAt 单字段条件写
      assert.ok(/deletedAt/.test(block), `${label} 应写 deletedAt`);
    }
    console.log('PASS: 2. Trash/Restore 零 Audio 通过');
  }

  console.log('=== 3. Physical Delete 事务顺序与 invariant（静态） ===');
  {
    const src = readRepoFile('lib/server/storyWork.ts');
    const code = stripComments(src);
    const primStart = code.indexOf('export async function executeStoryWorkPhysicalDelete');
    assert.ok(primStart >= 0, 'primitive 可定位');
    const prim = code.slice(primStart, primStart + 20000);
    // 同一 $transaction 内完成 tombstone + delete
    assert.ok(/\$transaction\s*\(/.test(prim), '必须经 $transaction');
    assert.ok(/enqueueAudioDeletionTombstones/.test(prim), '事务内必须 enqueue tombstone');
    assert.ok(/cleanupAudioStorageKeys/.test(prim), 'COMMIT 后必须 best-effort cleanup');
    // 顺序：find Work → find Manifest → find Segment → enqueue → deleteMany → cleanup（commit 后）
    const orderMarkers = [
      /storyWork\s*\.\s*findMany|guestStoryWork\s*\.\s*findMany/,
      /storyAudioManifest\s*\.\s*findMany|guestStoryAudioManifest\s*\.\s*findMany/,
      /storyAudioSegment\s*\.\s*findMany|guestStoryAudioSegment\s*\.\s*findMany/,
      /enqueueAudioDeletionTombstones/,
      /storyWork\s*\.\s*deleteMany|guestStoryWork\s*\.\s*deleteMany/,
      /cleanupAudioStorageKeys/,
    ];
    let cursor = -1;
    for (const pat of orderMarkers) {
      const idx = prim.search(pat);
      assert.ok(idx > cursor, `顺序违规：${String(pat)} 应在前一标记之后`);
      cursor = idx;
    }
    // cleanup 必须在 $transaction 闭包之外（commit 后），且失败吞掉不 rollback
    const txCloseHint = prim.indexOf('cleanupAudioStorageKeys');
    assert.ok(txCloseHint > prim.indexOf('$transaction'), 'cleanup 在 transaction 调用之后');
    assert.ok(/try\s*\{[\s\S]*cleanupAudioStorageKeys[\s\S]*\}\s*catch/.test(prim), 'cleanup 失败必须吞掉');
    // 禁止先 delete → commit → 再查 key：segment 查询必须在 deleteMany 之前
    const firstSegFind = prim.search(/storyAudioSegment\s*\.\s*findMany|guestStoryAudioSegment\s*\.\s*findMany/);
    const firstDelete = prim.search(/storyWork\s*\.\s*deleteMany|guestStoryWork\s*\.\s*deleteMany/);
    assert.ok(firstSegFind >= 0 && firstDelete >= 0 && firstSegFind < firstDelete, '必须先读 key 再删 Work');
    console.log('PASS: 3. 事务顺序通过');
  }

  console.log('=== 4. 窄 discriminated contract（静态） ===');
  {
    const src = stripComments(readRepoFile('lib/server/storyWork.ts'));
    assert.ok(/export type PhysicalDeleteStoryWorkOptions/.test(src), '窄契约类型存在');
    assert.ok(/target:\s*'user'/.test(src), 'user 形态存在');
    assert.ok(/target:\s*'guest'/.test(src), 'guest 形态存在');
    assert.ok(/reason:\s*'trash'/.test(src), 'trash 形态存在');
    assert.ok(/reason:\s*'retention'/.test(src), 'retention 形态存在');
    // 不接受自由 where：primitive 入参必须为 PhysicalDeleteStoryWorkOptions 窄类型
    assert.ok(
      /export async function executeStoryWorkPhysicalDelete\(\s*options:\s*PhysicalDeleteStoryWorkOptions/.test(src),
      'primitive 入参必须为窄契约',
    );
    // 禁止第二套 delete helper：全仓仅一处 export executeStoryWorkPhysicalDelete 定义
    const defs = src.match(/export async function executeStoryWorkPhysicalDelete/g) ?? [];
    assert.strictEqual(defs.length, 1, '仅一处 primitive 定义');
    console.log('PASS: 4. 窄契约通过');
  }

  console.log('=== 5. Guest GC 统一 seam 回归（静态） ===');
  {
    const src = stripComments(readRepoFile('lib/server/guestGc.ts'));
    assert.ok(/executeStoryWorkPhysicalDelete/.test(src), 'Guest GC 必须经统一 seam');
    assert.ok(/reason:\s*'retention'/.test(src), 'Guest GC 必须为 retention 形态');
    assert.strictEqual(/prisma\s*\.\s*guestStoryWork\s*\.\s*delete/.test(src), false, 'Guest GC 不得直调 delete');
    for (const pat of [
      /storage\.delete/,
      /audioStorageDeletion/,
      /enqueueAudioDeletionTombstones/,
      /cleanupAudioStorage/,
      /getAudioAssetStorage/,
    ]) {
      assert.strictEqual(pat.test(src), false, `Guest GC 不得复制 Audio GC：${String(pat)}`);
    }
    console.log('PASS: 5. Guest GC seam 通过');
  }

  console.log('=== 6. 05-01 冻结 API 只消费不改契约（静态） ===');
  {
    const src = stripComments(readRepoFile('lib/server/audioStorageCleanup.ts'));
    for (const name of [
      'enqueueAudioDeletionTombstones',
      'cleanupAudioStorageDeletions',
      'cleanupAudioStorageKeys',
    ]) {
      assert.ok(new RegExp(`export async function ${name}`).test(src), `冻结导出 ${name} 存在`);
    }
    // 冻结文件不得反向依赖删除域（单向 storyWork → cleanup）
    for (const pat of [
      /from\s+['"][^'"]*server\/storyWork[^'"]*['"]/,
      /from\s+['"][^'"]*server\/guestGc[^'"]*['"]/,
      /from\s+['"][^'"]*server\/retention[^'"]*['"]/,
      /executeStoryWorkPhysicalDelete/,
      /purgeExpiredGuestData/,
    ]) {
      assert.strictEqual(pat.test(src), false, `冻结文件不得反向依赖：${String(pat)}`);
    }
    // storyWork 仅消费冻结 API（enqueue + directed cleanup），不碰 bounded 消费与纯函数重实现
    const seam = stripComments(readRepoFile('lib/server/storyWork.ts'));
    assert.ok(/enqueueAudioDeletionTombstones/.test(seam), 'seam 消费 enqueue');
    assert.ok(/cleanupAudioStorageKeys/.test(seam), 'seam 消费 directed cleanup');
    assert.strictEqual(/cleanupAudioStorageDeletions\s*\(/.test(seam), false, 'seam 不得直调 bounded 消费（留给 retry）');
    console.log('PASS: 6. 冻结契约通过');
  }

  console.log('ALL AUDIO LIFECYCLE DELETE UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioLifecycleDeleteUnitTests()
  .then(() => {
    console.log('ALL AUDIO LIFECYCLE DELETE UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
