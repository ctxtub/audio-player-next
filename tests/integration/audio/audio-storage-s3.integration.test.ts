import assert from 'node:assert';
import {
  S3AudioAssetStorage,
  createS3Driver,
  parseS3ForcePathStyle,
  resolveSignedUrlTtlSeconds,
  type S3Driver,
} from '../../../lib/audio/storage/s3';
import { AudioObjectNotFoundError } from '../../../lib/audio/storage/types';

/**
 * M8-02 S3 后端集成测试（spec §49：SDK mock/fake contract，不新增永久 MinIO）。
 *
 * 覆盖：put / exists / getMetadata / resolveRead（短时签名 redirect）/
 * delete / 缺失对象 / traversal 拒绝 / 真实驱动工厂配置校验。
 * 与 Local 套件契约层对称（同一接口语义；差异只在传输：redirect vs bytes）。
 */

/** 内存 fake S3 驱动（无网络、无 SDK 行为依赖，仅实现 S3Driver 窄契约） */
class FakeS3Driver implements S3Driver {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly signedGets: string[] = [];
  constructor(readonly ttlSeconds: number = 900) {}

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes: bytes.slice(), contentType });
  }

  async head(key: string) {
    const found = this.objects.get(key);
    if (!found) return null;
    return { size: found.bytes.byteLength, contentType: found.contentType };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async signGet(key: string): Promise<string> {
    this.signedGets.push(key);
    return `https://s3.example.test/unit-bucket/${key}?X-Amz-Expires=${this.ttlSeconds}&X-Amz-Signature=fake`;
  }
}

function sampleBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 7) % 256;
  return out;
}

async function runS3StorageIntegrationTests() {
  console.log('=== 1. put / exists / metadata（fake contract） ===');
  {
    const driver = new FakeS3Driver();
    const storage = new S3AudioAssetStorage({
      bucket: 'unit-bucket',
      driver,
    });
    const key = 'story-audio/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp3';
    assert.strictEqual(await storage.exists(key), false);
    assert.strictEqual(await storage.getMetadata(key), null);
    await storage.put({ key, bytes: sampleBytes(128), contentType: 'audio/mpeg' });
    assert.strictEqual(await storage.exists(key), true, 'put 后存在');
    const meta = await storage.getMetadata(key);
    assert.ok(meta);
    assert.strictEqual(meta!.size, 128);
    assert.strictEqual(meta!.contentType, 'audio/mpeg');
    console.log('PASS: 1. put/exists/metadata 通过');
  }

  console.log('=== 2. resolveRead → 短时签名 redirect（App 不代理 bytes） ===');
  {
    const driver = new FakeS3Driver(900);
    const storage = new S3AudioAssetStorage({
      bucket: 'unit-bucket',
      signedUrlTtlSeconds: 900,
      driver,
    });
    const key = 'story-audio/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp3';
    await storage.put({ key, bytes: sampleBytes(64), contentType: 'audio/mpeg' });
    // Range 头被忽略（由对象存储原生处理），恒返回 redirect
    for (const range of [undefined, null, 'bytes=0-99', 'bytes=100-']) {
      const read = await storage.resolveRead(key, range);
      assert.strictEqual(read.kind, 'redirect', `Range=${range} 仍须 redirect`);
      if (read.kind === 'redirect') {
        assert.ok(
          read.url.includes(key),
          '签名 URL 须定位到同一对象'
        );
        assert.ok(
          read.url.includes('X-Amz-Expires=900'),
          '签名 URL 须携带短 TTL'
        );
      }
    }
    assert.deepStrictEqual(driver.signedGets, [key, key, key, key]);
    console.log('PASS: 2. signed redirect 通过');
  }

  console.log('=== 3. delete + 缺失对象 ===');
  {
    const driver = new FakeS3Driver();
    const storage = new S3AudioAssetStorage({ bucket: 'unit-bucket', driver });
    const key = 'story-audio/cccccccc-cccc-4ccc-8ccc-cccccccccccc.mp3';
    await storage.put({ key, bytes: sampleBytes(16), contentType: 'audio/mpeg' });
    await storage.delete(key);
    assert.strictEqual(await storage.exists(key), false);
    assert.strictEqual(await storage.getMetadata(key), null);
    await storage.delete(key);
    await assert.rejects(
      storage.resolveRead(key),
      (err: unknown) => err instanceof AudioObjectNotFoundError,
      '缺失对象读取必须抛 NotFound（route → 404）'
    );
    console.log('PASS: 3. delete/缺失通过');
  }

  console.log('=== 4. traversal key 全方法拒绝（未达驱动层） ===');
  {
    const driver = new FakeS3Driver();
    const storage = new S3AudioAssetStorage({ bucket: 'unit-bucket', driver });
    const evil = 'story-audio/../../evil.mp3';
    await assert.rejects(
      storage.put({ key: evil, bytes: sampleBytes(4), contentType: 'audio/mpeg' })
    );
    await assert.rejects(storage.resolveRead(evil));
    assert.strictEqual(driver.objects.size, 0, '非法 key 不得写入驱动层');
    assert.deepStrictEqual(driver.signedGets, [], '非法 key 不得签发 URL');
    console.log('PASS: 4. traversal 拒绝通过');
  }

  console.log('=== 5. 真实驱动工厂：配置校验（不触网络） ===');
  {
    // 缺 secret → 抛错且不回显
    assert.throws(
      () =>
        createS3Driver({
          bucket: 'b',
          region: 'us-east-1',
          accessKeyId: 'k',
          secretAccessKey: '   ',
        }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes('AUDIO_S3_SECRET_ACCESS_KEY'),
      '缺 secret 必须拒绝'
    );
    assert.strictEqual(resolveSignedUrlTtlSeconds(null), 900, 'TTL 缺省 900');
    assert.strictEqual(resolveSignedUrlTtlSeconds('60'), 60);
    assert.throws(() => resolveSignedUrlTtlSeconds('0'), /TTL_SECONDS/);
    assert.throws(() => resolveSignedUrlTtlSeconds('abc'), /TTL_SECONDS/);
    assert.strictEqual(parseS3ForcePathStyle(null), false);
    assert.strictEqual(parseS3ForcePathStyle('true'), true);
    assert.strictEqual(parseS3ForcePathStyle('1'), true);
    assert.strictEqual(parseS3ForcePathStyle('false'), false);
    assert.throws(
      () => new S3AudioAssetStorage({ bucket: '  ', driver: new FakeS3Driver() }),
      /bucket/,
      '空 bucket 必须拒绝'
    );
    console.log('PASS: 5. 工厂配置校验通过');
  }

  console.log('ALL S3 STORAGE INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runS3StorageIntegrationTests()
  .then(() => {
    console.log('ALL S3 STORAGE INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
