import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../../lib/db';
import { encodeGuestId, encodeSession } from '../../../lib/session';
import {
  getAudioAssetStorage,
  resetAudioAssetStorageForTests,
  setAudioAssetStorageForTests,
} from '../../../lib/audio/storage/index';
import type { AudioAssetStorage } from '../../../lib/audio/storage/types';
import { S3AudioAssetStorage } from '../../../lib/audio/storage/s3';
import { GET } from '../../../app/api/audio/segments/[segmentId]/route';

process.env.SESSION_SECRET = 'test-secret-m802-audio-read-12345';

/**
 * M8-02 授权读取路由集成测试（spec §19/§19.1–§19.3）。
 *
 * 覆盖：owner 可读（200 + Range 206 三类 + invalid 416）/ 其他 subject 拒绝（403）/
 * Trash owned Work 的 ready asset 可读 / unknown 或已删除 segment → 404 /
 * 非 ready → 404 / 未鉴权 → 401 / S3 后端 307 redirect / 错误体不泄漏内部标识 /
 * 存储故障 → 500（不降级 404，spec §45）/ ready 但对象缺失 → 404 AUDIO_OBJECT_MISSING。
 */

function sampleBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = i % 256;
  return out;
}

const BYTES = sampleBytes(256);

async function callGet(
  segmentId: string,
  cookie: string | null,
  range?: string
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (range) headers.range = range;
  const req = new Request(`http://localhost/api/audio/segments/${segmentId}`, {
    headers,
  });
  return GET(req, { params: Promise.resolve({ segmentId }) });
}

async function readBody(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

type UserFixture = {
  userId: number;
  cookie: string;
  workId: number;
  manifestId: number;
  segmentId: string;
  storageKey: string;
};

async function createReadyUserSegment(
  tag: string,
  status: string = 'ready'
): Promise<UserFixture> {
  const user = await prisma.user.create({
    data: {
      username: `m802_reader_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      password: 'TestPassword123!',
      nickname: 'M802Reader',
    },
  });
  const work = await prisma.storyWork.create({
    data: {
      userId: user.id,
      prompt: '测试提示词',
      storyText: '这是测试故事正文内容，用于授权读取验证。',
      voiceId: 'alloy',
      title: '测试作品',
      excerpt: '测试摘要',
      contentHash: 'm802hash',
    },
  });
  const manifest = await prisma.storyAudioManifest.create({
    data: {
      storyWorkId: work.id,
      contentHash: 'm802hash',
      segmentationVersion: 'v1',
      voiceId: 'alloy',
      ttsBackendId: 'openai',
      ttsModel: 'tts-1',
      synthesisVersion: 'canonical-mp3-v1',
      segmentCount: 1,
    },
  });
  const segmentId = randomUUID();
  const storageKey = `story-audio/${segmentId}.mp3`;
  await prisma.storyAudioSegment.create({
    data: {
      id: segmentId,
      manifestId: manifest.id,
      segmentIndex: 0,
      text: '这是测试故事正文内容，用于授权读取验证。',
      textHash: 'm802texthash',
      status,
      storageKey,
      contentType: 'audio/mpeg',
      byteLength: BYTES.byteLength,
    },
  });
  if (status === 'ready') {
    await getAudioAssetStorage().put({
      key: storageKey,
      bytes: BYTES,
      contentType: 'audio/mpeg',
    });
  }
  return {
    userId: user.id,
    cookie: `auth=${encodeSession(user.id, 'M802Reader')}`,
    workId: work.id,
    manifestId: manifest.id,
    segmentId,
    storageKey,
  };
}

async function createReadyGuestSegment(tag: string) {
  const gid = `g_${randomUUID()}`;
  const work = await prisma.guestStoryWork.create({
    data: {
      guestId: gid,
      prompt: '访客提示词',
      storyText: '访客故事正文内容，用于授权读取验证。',
      voiceId: 'alloy',
      title: '访客作品',
      excerpt: '访客摘要',
      contentHash: 'm802guesthash',
    },
  });
  const manifest = await prisma.guestStoryAudioManifest.create({
    data: {
      storyWorkId: work.id,
      contentHash: 'm802guesthash',
      segmentationVersion: 'v1',
      voiceId: 'alloy',
      ttsBackendId: 'openai',
      ttsModel: 'tts-1',
      synthesisVersion: 'canonical-mp3-v1',
      segmentCount: 1,
    },
  });
  const segmentId = randomUUID();
  const storageKey = `story-audio/${segmentId}.mp3`;
  await prisma.guestStoryAudioSegment.create({
    data: {
      id: segmentId,
      manifestId: manifest.id,
      segmentIndex: 0,
      text: '访客故事正文内容，用于授权读取验证。',
      textHash: 'm802guesttexthash',
      status: 'ready',
      storageKey,
      contentType: 'audio/mpeg',
      byteLength: BYTES.byteLength,
    },
  });
  await getAudioAssetStorage().put({
    key: storageKey,
    bytes: BYTES,
    contentType: 'audio/mpeg',
  });
  return {
    gid,
    cookie: `guest=${encodeGuestId(gid)}`,
    workId: work.id,
    segmentId,
    storageKey,
  };
}

async function runAudioSegmentReadTests() {
  const tmpRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'm802-route-')
  );
  const savedDriver = process.env.AUDIO_STORAGE_DRIVER;
  const savedRoot = process.env.AUDIO_LOCAL_ROOT;
  process.env.AUDIO_STORAGE_DRIVER = 'local';
  process.env.AUDIO_LOCAL_ROOT = tmpRoot;
  resetAudioAssetStorageForTests();
  try {
    console.log('=== 1. owner 可读：200 全量 ===');
    const owner = await createReadyUserSegment('owner');
    {
      const res = await callGet(owner.segmentId, owner.cookie);
      assert.strictEqual(res.status, 200, 'owner 全量读取 200');
      assert.strictEqual(res.headers.get('accept-ranges'), 'bytes');
      assert.strictEqual(res.headers.get('content-type'), 'audio/mpeg');
      assert.strictEqual(res.headers.get('content-length'), '256');
      assert.strictEqual(res.headers.get('content-range'), null);
      assert.deepStrictEqual(await readBody(res), Buffer.from(BYTES));
    }
    console.log('PASS: 1. owner 200 通过');

    console.log('=== 2. Range：bytes=0-99 / bytes=100- / invalid 416 ===');
    {
      const head = await callGet(owner.segmentId, owner.cookie, 'bytes=0-99');
      assert.strictEqual(head.status, 206);
      assert.strictEqual(head.headers.get('content-range'), 'bytes 0-99/256');
      assert.strictEqual(head.headers.get('content-length'), '100');
      assert.deepStrictEqual(
        await readBody(head),
        Buffer.from(BYTES.subarray(0, 100))
      );

      const tail = await callGet(owner.segmentId, owner.cookie, 'bytes=100-');
      assert.strictEqual(tail.status, 206);
      assert.strictEqual(tail.headers.get('content-range'), 'bytes 100-255/256');
      assert.strictEqual(tail.headers.get('content-length'), '156');
      assert.deepStrictEqual(
        await readBody(tail),
        Buffer.from(BYTES.subarray(100))
      );

      for (const bad of ['bytes=999-', 'not-a-range']) {
        const res = await callGet(owner.segmentId, owner.cookie, bad);
        assert.strictEqual(res.status, 416, `非法 Range 必须 416：${bad}`);
        assert.strictEqual(res.headers.get('content-range'), 'bytes */256');
      }
    }
    console.log('PASS: 2. Range 三类行为通过');

    console.log('=== 3. 其他 subject 拒绝（403，不泄漏内部标识） ===');
    {
      const other = await prisma.user.create({
        data: {
          username: `m802_other_${Date.now()}`,
          password: 'TestPassword123!',
        },
      });
      const otherCookie = `auth=${encodeSession(other.id, 'Other')}`;
      const res = await callGet(owner.segmentId, otherCookie);
      assert.strictEqual(res.status, 403, '他人资产必须 403');
      const body = (await res.json()) as unknown;
      assert.deepStrictEqual(body, { error: { code: 'FORBIDDEN' } });
      assert.strictEqual(
        JSON.stringify(body).includes('story-audio'),
        false,
        '403 不得泄漏 storageKey'
      );
    }
    console.log('PASS: 3. 403 拒绝通过');

    console.log('=== 4. 未鉴权 → 401；未知 segment → 404 ===');
    {
      const anon = await callGet(owner.segmentId, null);
      assert.strictEqual(anon.status, 401);
      assert.deepStrictEqual(await anon.json(), {
        error: { code: 'UNAUTHORIZED' },
      });
      const unknown = await callGet(randomUUID(), owner.cookie);
      assert.strictEqual(unknown.status, 404);
      assert.deepStrictEqual(await unknown.json(), {
        error: { code: 'SEGMENT_NOT_FOUND' },
      });
    }
    console.log('PASS: 4. 401/404 通过');

    console.log('=== 5. 非 ready segment → 404（不生成、不改 ready） ===');
    {
      const pending = await createReadyUserSegment('pending', 'missing');
      const before = await prisma.storyAudioSegment.findUnique({
        where: { id: pending.segmentId },
      });
      const res = await callGet(pending.segmentId, pending.cookie);
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(await res.json(), {
        error: { code: 'SEGMENT_NOT_READY' },
      });
      const after = await prisma.storyAudioSegment.findUnique({
        where: { id: pending.segmentId },
      });
      assert.strictEqual(
        after!.status,
        before!.status,
        '读取不得改写 segment 状态'
      );
    }
    console.log('PASS: 5. 非 ready 404 通过');

    console.log('=== 6. Trash owned Work 的 ready asset 仍可读 ===');
    {
      await prisma.storyWork.update({
        where: { id: owner.workId },
        data: { deletedAt: new Date() },
      });
      const res = await callGet(owner.segmentId, owner.cookie);
      assert.strictEqual(res.status, 200, 'Trash 后已有 asset 仍可读');
      assert.deepStrictEqual(await readBody(res), Buffer.from(BYTES));
    }
    console.log('PASS: 6. Trash 可读通过');

    console.log('=== 7. Permanent deleted（row 不存在）→ 404 ===');
    {
      await prisma.storyWork.delete({ where: { id: owner.workId } });
      const goneSeg = await prisma.storyAudioSegment.findUnique({
        where: { id: owner.segmentId },
      });
      assert.strictEqual(goneSeg, null, '级联删除后 segment row 不存在');
      const res = await callGet(owner.segmentId, owner.cookie);
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(await res.json(), {
        error: { code: 'SEGMENT_NOT_FOUND' },
      });
    }
    console.log('PASS: 7. 永久删除 404 通过');

    console.log('=== 8. Guest 对称：owner 可读 / 他人 403 / User 越界 403 ===');
    {
      const guest = await createReadyGuestSegment('g1');
      const res = await callGet(guest.segmentId, guest.cookie);
      assert.strictEqual(res.status, 200, 'guest owner 可读');
      assert.deepStrictEqual(await readBody(res), Buffer.from(BYTES));

      const otherGid = `g_${randomUUID()}`;
      const otherGuestRes = await callGet(
        guest.segmentId,
        `guest=${encodeGuestId(otherGid)}`
      );
      assert.strictEqual(otherGuestRes.status, 403, '其他 guest 必须 403');

      const user = await prisma.user.create({
        data: {
          username: `m802_xuser_${Date.now()}`,
          password: 'TestPassword123!',
        },
      });
      const crossRes = await callGet(
        guest.segmentId,
        `auth=${encodeSession(user.id, 'X')}`
      );
      assert.strictEqual(crossRes.status, 403, 'User 越界读 Guest 资产必须 403');
    }
    console.log('PASS: 8. Guest 对称通过');

    console.log('=== 9. S3 后端：同一 route → 307 短时 redirect（不代理 bytes） ===');
    {
      const fakeObjects = new Map<string, Uint8Array>();
      const s3Storage = new S3AudioAssetStorage({
        bucket: 'route-test-bucket',
        signedUrlTtlSeconds: 900,
        driver: {
          put: async (key: string, bytes: Uint8Array) => {
            fakeObjects.set(key, bytes.slice());
          },
          head: async (key: string) =>
            fakeObjects.has(key)
              ? { size: fakeObjects.get(key)!.byteLength, contentType: 'audio/mpeg' }
              : null,
          delete: async (key: string) => {
            fakeObjects.delete(key);
          },
          signGet: async (key: string) =>
            `https://s3.example.test/route-test-bucket/${key}?X-Amz-Expires=900&sig=route`,
        },
      });
      const fx = await createReadyUserSegment('s3x');
      // Local 已写入；再经 fake S3 登记同一 key（模拟同一 storageKey 的后端视图）
      await s3Storage.put({
        key: fx.storageKey,
        bytes: BYTES,
        contentType: 'audio/mpeg',
      });
      setAudioAssetStorageForTests(s3Storage);
      try {
        const res = await callGet(fx.segmentId, fx.cookie);
        assert.strictEqual(res.status, 307, 'S3 后端必须 307');
        const location = res.headers.get('location');
        assert.ok(location, '307 必须带 Location');
        assert.ok(
          location!.includes(fx.storageKey),
          '签名 URL 须定位同一对象'
        );
        assert.ok(location!.includes('X-Amz-Expires=900'), '签名 URL 须短 TTL');
        assert.strictEqual(
          location!.includes('route-test-bucket') ||
            location!.includes('s3.example.test'),
          true
        );
        // redirect 响应不带音频 bytes
        assert.strictEqual((await res.arrayBuffer()).byteLength, 0);
      } finally {
        resetAudioAssetStorageForTests();
      }
      // 切回 Local 后同一资产仍 200（契约层一致，差异只在传输）
      const back = await callGet(fx.segmentId, fx.cookie);
      assert.strictEqual(back.status, 200, '切回 Local 后仍可读');
    }
    console.log('PASS: 9. S3 307 通过');

    console.log('=== 10. 错误体永不泄漏内部标识 ===');
    {
      const fx = await createReadyUserSegment('leak');
      const res = await callGet(fx.segmentId, null);
      const text = await res.text();
      assert.strictEqual(text.includes('story-audio'), false);
      assert.strictEqual(text.includes(tmpRoot), false);
      assert.strictEqual(text.toLowerCase().includes('bucket'), false);
    }
    console.log('PASS: 10. 脱敏通过');

    console.log('=== 11. 存储故障（getMetadata throw）→ 500，非 404（spec §45） ===');
    {
      const fx = await createReadyUserSegment('backend-down');
      const downStorage: AudioAssetStorage = {
        put: async () => {},
        exists: async () => true,
        delete: async () => {},
        getMetadata: async () => {
          throw new Error('backend-down');
        },
        resolveRead: async () => {
          throw new Error('backend-down');
        },
      };
      setAudioAssetStorageForTests(downStorage);
      try {
        const res = await callGet(fx.segmentId, fx.cookie);
        assert.strictEqual(res.status, 500, '存储故障必须 500');
        assert.notStrictEqual(res.status, 404, '存储故障不得降级为 404');
        assert.deepStrictEqual(await res.json(), {
          error: { code: 'AUDIO_READ_FAILED' },
        });
      } finally {
        resetAudioAssetStorageForTests();
      }
      // 故障解除后同一资产仍可读（确为瞬时故障，非 corruption）
      const recovered = await callGet(fx.segmentId, fx.cookie);
      assert.strictEqual(recovered.status, 200, '故障解除后仍可读');
    }
    console.log('PASS: 11. 故障 500 通过');

    console.log('=== 12. ready 但对象缺失 → 404 AUDIO_OBJECT_MISSING ===');
    {
      const fx = await createReadyUserSegment('obj-missing');
      await getAudioAssetStorage().delete(fx.storageKey);
      const res = await callGet(fx.segmentId, fx.cookie);
      assert.strictEqual(res.status, 404, '对象缺失必须 404');
      assert.deepStrictEqual(await res.json(), {
        error: { code: 'AUDIO_OBJECT_MISSING' },
      });
      const seg = await prisma.storyAudioSegment.findUnique({
        where: { id: fx.segmentId },
      });
      assert.strictEqual(seg!.status, 'ready', '404 不得改写 segment 状态');
    }
    console.log('PASS: 12. 缺失 404 通过');
  } finally {
    if (savedDriver === undefined) delete process.env.AUDIO_STORAGE_DRIVER;
    else process.env.AUDIO_STORAGE_DRIVER = savedDriver;
    if (savedRoot === undefined) delete process.env.AUDIO_LOCAL_ROOT;
    else process.env.AUDIO_LOCAL_ROOT = savedRoot;
    resetAudioAssetStorageForTests();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }

  console.log('ALL AUDIO SEGMENT READ INTEGRATION TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioSegmentReadTests()
  .then(() => {
    console.log('ALL AUDIO SEGMENT READ INTEGRATION TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
