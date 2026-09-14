import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalFilesystemStorage } from '../../../lib/audio/storage/local';
import {
  AudioObjectNotFoundError,
  StorageRangeNotSatisfiableError,
} from '../../../lib/audio/storage/types';

/**
 * M8-02 Local backend 集成测试（spec §48；真临时目录）。
 *
 * 覆盖：put / exists / getMetadata / resolveRead（full + bytes=0-99 +
 * bytes=100- + invalid）/ 同 key 覆盖写（spec §18.1）/ delete 幂等 /
 * traversal 拒绝。S3 语义一致性由 s3 fake 契约套件对称覆盖。
 */

function sampleBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = i % 256;
  return out;
}

async function runLocalStorageIntegrationTests() {
  const tmpRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'm802-local-')
  );
  try {
    console.log('=== 1. put / exists / metadata ===');
    {
      const storage = new LocalFilesystemStorage({ root: tmpRoot });
      const key = 'story-audio/11111111-1111-4111-8111-111111111111.mp3';
      assert.strictEqual(await storage.exists(key), false, '写入前不存在');
      assert.strictEqual(await storage.getMetadata(key), null, '写入前 metadata 为 null');
      const bytes = sampleBytes(256);
      await storage.put({ key, bytes, contentType: 'audio/mpeg' });
      assert.strictEqual(await storage.exists(key), true, '写入后存在');
      const meta = await storage.getMetadata(key);
      assert.ok(meta, 'metadata 存在');
      assert.strictEqual(meta!.size, 256, 'size 一致');
      assert.strictEqual(meta!.contentType, 'audio/mpeg', 'contentType 一致');
      console.log('PASS: 1. put/exists/metadata 通过');
    }

    console.log('=== 2. resolveRead：full + range 三类行为 ===');
    {
      const storage = new LocalFilesystemStorage({ root: tmpRoot });
      const key = 'story-audio/22222222-2222-4222-8222-222222222222.mp3';
      const bytes = sampleBytes(256);
      await storage.put({ key, bytes, contentType: 'audio/mpeg' });

      // full（无 Range）
      const full = await storage.resolveRead(key);
      assert.strictEqual(full.kind, 'bytes');
      if (full.kind === 'bytes') {
        assert.strictEqual(full.range, null, 'full 时 range 为 null（route → 200）');
        assert.strictEqual(full.totalSize, 256);
        assert.strictEqual(full.contentType, 'audio/mpeg');
        assert.deepStrictEqual(Buffer.from(full.bytes), Buffer.from(bytes));
      }

      // bytes=0-99
      const head = await storage.resolveRead(key, 'bytes=0-99');
      assert.strictEqual(head.kind, 'bytes');
      if (head.kind === 'bytes') {
        assert.deepStrictEqual(head.range, { start: 0, end: 99 });
        assert.strictEqual(head.totalSize, 256);
        assert.strictEqual(head.bytes.byteLength, 100);
        assert.deepStrictEqual(Buffer.from(head.bytes), Buffer.from(bytes.subarray(0, 100)));
      }

      // bytes=100-
      const tail = await storage.resolveRead(key, 'bytes=100-');
      assert.strictEqual(tail.kind, 'bytes');
      if (tail.kind === 'bytes') {
        assert.deepStrictEqual(tail.range, { start: 100, end: 255 });
        assert.strictEqual(tail.bytes.byteLength, 156);
        assert.deepStrictEqual(Buffer.from(tail.bytes), Buffer.from(bytes.subarray(100)));
      }

      // invalid range → 抛错（route → 416）
      for (const bad of ['bytes=999-', 'garbage', 'bytes=200-100']) {
        await assert.rejects(
          storage.resolveRead(key, bad),
          (err: unknown) =>
            err instanceof StorageRangeNotSatisfiableError &&
            err.totalSize === 256,
          `非法 Range 必须抛 416 口径错：${bad}`
        );
      }
      console.log('PASS: 2. full/range/invalid 通过');
    }

    console.log('=== 3. 同 key 覆盖写（spec §18.1 retry overwrite） ===');
    {
      const storage = new LocalFilesystemStorage({ root: tmpRoot });
      const key = 'story-audio/33333333-3333-4333-8333-333333333333.mp3';
      await storage.put({
        key,
        bytes: sampleBytes(10),
        contentType: 'audio/mpeg',
      });
      await storage.put({
        key,
        bytes: sampleBytes(20),
        contentType: 'audio/mpeg',
      });
      const meta = await storage.getMetadata(key);
      assert.strictEqual(meta!.size, 20, '同 key 覆盖后 size 为新值');
      const read = await storage.resolveRead(key);
      assert.strictEqual(read.kind, 'bytes');
      if (read.kind === 'bytes') {
        assert.strictEqual(read.bytes.byteLength, 20, '同 key 覆盖后 bytes 为新值');
      }
      console.log('PASS: 3. 覆盖写通过');
    }

    console.log('=== 4. delete 幂等 + 缺失读取 ===');
    {
      const storage = new LocalFilesystemStorage({ root: tmpRoot });
      const key = 'story-audio/44444444-4444-4444-8444-444444444444.mp3';
      await storage.put({
        key,
        bytes: sampleBytes(8),
        contentType: 'audio/mpeg',
      });
      await storage.delete(key);
      assert.strictEqual(await storage.exists(key), false, '删除后不存在');
      assert.strictEqual(await storage.getMetadata(key), null, '删除后 metadata 为 null');
      await storage.delete(key);
      assert.strictEqual(await storage.exists(key), false, '重复删除仍幂等成功');
      await assert.rejects(
        storage.resolveRead(key),
        (err: unknown) => err instanceof AudioObjectNotFoundError,
        '缺失对象读取必须抛 NotFound（route → 404）'
      );
      console.log('PASS: 4. delete/缺失通过');
    }

    console.log('=== 5. traversal key 全方法拒绝 ===');
    {
      const storage = new LocalFilesystemStorage({ root: tmpRoot });
      const evil = '../m802-local-escape.mp3';
      await assert.rejects(
        storage.put({ key: evil, bytes: sampleBytes(4), contentType: 'audio/mpeg' })
      );
      await assert.rejects(storage.resolveRead(evil));
      assert.strictEqual(
        await fs.promises
          .access(path.join(path.dirname(tmpRoot), 'm802-local-escape.mp3'))
          .then(() => true)
          .catch(() => false),
        false,
        'traversal 不得在 root 外留下文件'
      );
      console.log('PASS: 5. traversal 拒绝通过');
    }
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }

  console.log('ALL LOCAL STORAGE INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runLocalStorageIntegrationTests()
  .then(() => {
    console.log('ALL LOCAL STORAGE INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
