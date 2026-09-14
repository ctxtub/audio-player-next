import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertSafeStorageKey,
  isSafeStorageKey,
  parseRangeHeader,
} from '../../../lib/audio/storage/types';
import {
  DEFAULT_LOCAL_AUDIO_ROOT,
  LocalFilesystemStorage,
  resolveLocalRoot,
} from '../../../lib/audio/storage/local';
import { S3AudioAssetStorage } from '../../../lib/audio/storage/s3';
import {
  getAudioAssetStorage,
  isCoupledLegacyAudioRoot,
  LEGACY_COUPLED_AUDIO_DIR,
  resetAudioAssetStorageForTests,
  resolveAudioStorageConfig,
  resolveStorageDriverName,
} from '../../../lib/audio/storage/index';

/**
 * M8-02 Storage 抽象单元测试（spec §2–§4/§33/§38/§48）。
 *
 * 覆盖：
 * 1. 存储配置：driver 二选一装配（缺省 local；非法拒绝）、Local root 缺省与耦合拒绝、
 *    S3 必需项与 TTL/secret 脱敏；
 * 2. Range 解析：bytes=0-99 / bytes=100- / 后缀 / 越界钳制 / invalid 三类；
 * 3. Key/path traversal 防护（通用口径 + Local 落盘不逃逸）；
 * 4. 静态守卫：DB 不存 URL、client DTO 不含 storageKey、S3 SDK 仅 storage adapter 可见、
 *    Local root 不落耦合目录、route 不泄漏 storageKey/bucket。
 */

const SENSITIVE_MARK = 'unit-only-fake-secret-9f3c';

function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k] as string;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
    resetAudioAssetStorageForTests();
  }
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
}

function collectSourceFiles(
  dir: string,
  out: string[] = []
): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.next') continue;
      collectSourceFiles(abs, out);
    } else if (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx')) {
      out.push(abs);
    }
  }
  return out;
}

async function runAudioStorageUnitTests() {
  console.log('=== 1. driver 二选一装配 ===');
  {
    assert.strictEqual(resolveStorageDriverName(null), 'local', '缺省 local');
    assert.strictEqual(resolveStorageDriverName(''), 'local', '空串 local');
    assert.strictEqual(resolveStorageDriverName('LOCAL'), 'local', '大小写不敏感');
    assert.strictEqual(resolveStorageDriverName('s3'), 's3', 's3 装配');
    assert.throws(
      () => resolveStorageDriverName('both'),
      /s3\|local/,
      'local+S3 双写口径必须拒绝'
    );
    assert.throws(
      () => resolveStorageDriverName('hot-cache'),
      /s3\|local/,
      'Hot Cache 口径必须拒绝'
    );

    withEnv(
      { AUDIO_STORAGE_DRIVER: 'local', AUDIO_LOCAL_ROOT: undefined },
      () => {
        const storage = getAudioAssetStorage();
        assert.ok(
          storage instanceof LocalFilesystemStorage,
          'local 配置必须装配 Local 后端'
        );
        // 单例：同一进程恒同一实例
        assert.strictEqual(getAudioAssetStorage(), storage, '必须返回同一单例');
      }
    );
    withEnv(
      {
        AUDIO_STORAGE_DRIVER: 's3',
        AUDIO_S3_REGION: 'us-east-1',
        AUDIO_S3_BUCKET: 'unit-bucket',
        AUDIO_S3_ACCESS_KEY_ID: 'unit-key',
        AUDIO_S3_SECRET_ACCESS_KEY: SENSITIVE_MARK,
      },
      () => {
        const fakeDriver = {
          put: async () => {},
          head: async () => null,
          delete: async () => {},
          signGet: async () => 'https://example.test/signed',
        };
        const storage = getAudioAssetStorage(undefined, {
          s3Driver: fakeDriver,
        });
        assert.ok(
          storage instanceof S3AudioAssetStorage,
          's3 配置必须装配 S3 后端'
        );
      }
    );
    console.log('PASS: 1. driver 二选一装配断言通过');
  }

  console.log('=== 2. Local root：缺省与耦合拒绝 ===');
  {
    assert.strictEqual(
      DEFAULT_LOCAL_AUDIO_ROOT,
      '/app/audio',
      'Local 缺省根必须为 /app/audio（独立 volume，spec §3）'
    );
    withEnv({ AUDIO_LOCAL_ROOT: undefined }, () => {
      assert.strictEqual(resolveLocalRoot(null), '/app/audio');
      const config = resolveAudioStorageConfig({ AUDIO_STORAGE_DRIVER: 'local' });
      assert.strictEqual(config.driver, 'local');
      if (config.driver === 'local') {
        assert.strictEqual(config.localRoot, '/app/audio');
      }
    });
    withEnv({ AUDIO_LOCAL_ROOT: '/tmp/unit-audio' }, () => {
      assert.strictEqual(resolveLocalRoot(null), '/tmp/unit-audio', '显式 root 直通');
    });
    // 耦合目录拒绝（本身/子目录/尾斜杠）
    for (const bad of [
      '/app/data/audio',
      '/app/data/audio/',
      '/app/data/audio/shard-01',
    ]) {
      assert.strictEqual(
        isCoupledLegacyAudioRoot(bad),
        true,
        `必须识别耦合目录：${bad}`
      );
      assert.throws(
        () =>
          resolveAudioStorageConfig({
            AUDIO_STORAGE_DRIVER: 'local',
            AUDIO_LOCAL_ROOT: bad,
          }),
        /must not be under/,
        `耦合 root 必须 fail-fast：${bad}`
      );
    }
    assert.strictEqual(
      isCoupledLegacyAudioRoot('/app/audio'),
      false,
      '缺省独立卷不得误判'
    );
    assert.strictEqual(
      isCoupledLegacyAudioRoot('/app/data'),
      false,
      '/app/data 本身不在拒绝口径（仅拒绝其下 audio 耦合目录）'
    );
    assert.strictEqual(
      LEGACY_COUPLED_AUDIO_DIR,
      '/app/data/audio',
      '耦合目录常量冻结'
    );
    console.log('PASS: 2. Local root 断言通过');
  }

  console.log('=== 3. S3 配置：必需项 / TTL / secret 脱敏 ===');
  {
    const base = {
      AUDIO_STORAGE_DRIVER: 's3',
      AUDIO_S3_REGION: 'us-east-1',
      AUDIO_S3_BUCKET: 'unit-bucket',
      AUDIO_S3_ACCESS_KEY_ID: 'unit-key',
      AUDIO_S3_SECRET_ACCESS_KEY: SENSITIVE_MARK,
    };
    const config = resolveAudioStorageConfig(base);
    assert.strictEqual(config.driver, 's3');
    if (config.driver === 's3') {
      assert.strictEqual(config.signedUrlTtlSeconds, 900, 'TTL 缺省 900（spec §3）');
      assert.strictEqual(config.forcePathStyle, false, 'path style 缺省 false');
      assert.strictEqual(config.hasAccessKeyId, true);
      assert.strictEqual(config.hasSecretAccessKey, true);
    }
    // 解析快照可打印：绝不含 secret 明文
    assert.strictEqual(
      JSON.stringify(config).includes(SENSITIVE_MARK),
      false,
      '配置快照永不回显 secret'
    );
    // 必需项逐个缺失 → 抛错且只报变量名
    for (const field of [
      'AUDIO_S3_REGION',
      'AUDIO_S3_BUCKET',
      'AUDIO_S3_ACCESS_KEY_ID',
      'AUDIO_S3_SECRET_ACCESS_KEY',
    ] as const) {
      assert.throws(
        () => resolveAudioStorageConfig({ ...base, [field]: '   ' }),
        (err: unknown) =>
          err instanceof Error && err.message.includes(field) && !err.message.includes(SENSITIVE_MARK),
        `缺失 ${field} 必须抛错且不回显 secret`
      );
    }
    // TTL 非法
    for (const bad of ['0', '-5', 'abc', '1.5', '']) {
      if (bad === '') continue; // 空串视为缺省
      assert.throws(
        () =>
          resolveAudioStorageConfig({
            ...base,
            AUDIO_SIGNED_URL_TTL_SECONDS: bad,
          }),
        /TTL_SECONDS/,
        `非法 TTL 必须拒绝：${bad}`
      );
    }
    assert.strictEqual(
      resolveAudioStorageConfig({ ...base, AUDIO_SIGNED_URL_TTL_SECONDS: '60' }).driver,
      's3'
    );
    console.log('PASS: 3. S3 配置断言通过');
  }

  console.log('=== 4. Range 解析（spec §48 三类行为） ===');
  {
    // 无头 → full
    assert.deepStrictEqual(parseRangeHeader(null, 1000), { kind: 'full' });
    assert.deepStrictEqual(parseRangeHeader(undefined, 1000), { kind: 'full' });
    assert.deepStrictEqual(parseRangeHeader('   ', 1000), { kind: 'full' });
    // bytes=0-99
    assert.deepStrictEqual(parseRangeHeader('bytes=0-99', 1000), {
      kind: 'range',
      start: 0,
      end: 99,
    });
    // bytes=100-
    assert.deepStrictEqual(parseRangeHeader('bytes=100-', 1000), {
      kind: 'range',
      start: 100,
      end: 999,
    });
    // 后缀
    assert.deepStrictEqual(parseRangeHeader('bytes=-100', 1000), {
      kind: 'range',
      start: 900,
      end: 999,
    });
    // 越界钳制
    assert.deepStrictEqual(parseRangeHeader('bytes=0-99999', 1000), {
      kind: 'range',
      start: 0,
      end: 999,
    });
    // invalid 三类及以上
    const invalidCases = [
      'bytes=1000-',
      'bytes=1000-2000',
      'bytes=200-100',
      'bytes=abc-def',
      'bytes=',
      'items=0-99',
      'bytes=0-99,200-299',
      'bytes=-0',
      'bytes=--5',
      '',
    ].filter((s) => s.length > 0);
    assert.ok(invalidCases.length >= 3, 'invalid 用例不得少于三类');
    for (const header of invalidCases) {
      assert.deepStrictEqual(
        parseRangeHeader(header, 1000),
        { kind: 'invalid' },
        `非法 Range 必须判 invalid：${header}`
      );
    }
    console.log('PASS: 4. Range 解析断言通过');
  }

  console.log('=== 5. Key/path traversal 防护 ===');
  {
    const good = [
      'story-audio/11111111-1111-4111-8111-111111111111.mp3',
      'a.mp3',
      'nested/dir/file-01_v2.mp3',
    ];
    for (const key of good) {
      assert.strictEqual(isSafeStorageKey(key), true, `合法 key 必须放行：${key}`);
      assert.doesNotThrow(() => assertSafeStorageKey(key));
    }
    const bad = [
      '',
      '/abs/path.mp3',
      '../evil.mp3',
      'a/../../evil.mp3',
      'story-audio/../../etc/passwd',
      'a//b.mp3',
      'a/./b.mp3',
      '..',
      '.',
      'back\\slash.mp3',
      'with space.mp3',
      'tab\t.mp3',
      `${'k'.repeat(513)}`,
    ];
    for (const key of bad) {
      assert.strictEqual(isSafeStorageKey(key), false, `非法 key 必须拒绝：${JSON.stringify(key)}`);
      assert.throws(() => assertSafeStorageKey(key), /invalid storage key/);
    }
    // Local 落盘不逃逸：非法 key 在触文件系统前拒绝，且 root 外无残留
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm802-unit-'));
    try {
      const storage = new LocalFilesystemStorage({ root: tmpRoot });
      const evil = '../unit-escape-probe.mp3';
      await assert.rejects(storage.put({ key: evil, bytes: new Uint8Array([1]), contentType: 'audio/mpeg' }));
      const parentEntries = await fs.promises.readdir(path.dirname(tmpRoot));
      assert.strictEqual(
        parentEntries.includes('unit-escape-probe.mp3'),
        false,
        'traversal 写入不得逃逸到 root 之外'
      );
      // 合法 key 解析恒在 root 内
      const abs = storage.resolvePathForKey('story-audio/x.mp3');
      assert.ok(abs.startsWith(tmpRoot + path.sep), '解析路径必须位于 root 内');
      assert.throws(() => storage.resolvePathForKey(evil), /invalid storage key|escapes root/);
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
    console.log('PASS: 5. traversal 防护断言通过');
  }

  console.log('=== 6. 静态守卫 ===');
  {
    const repoRoot = process.cwd();
    // 6a. DB schema 不存 URL（spec §33）
    const schemaSource = stripComments(
      fs.readFileSync(path.join(repoRoot, 'prisma/schema.prisma'), 'utf-8')
    );
    assert.strictEqual(/https?:\/\//.test(schemaSource), false, 'schema 不得出现 URL 字面量');
    for (const model of [
      'StoryAudioSegment',
      'GuestStoryAudioSegment',
      'AudioStorageDeletion',
    ]) {
      const start = schemaSource.indexOf(`model ${model} `);
      assert.ok(start >= 0, `schema 必须存在 ${model}`);
      const end = schemaSource.indexOf('\n}', start);
      const block = schemaSource.slice(start, end);
      assert.strictEqual(
        /\b\w*[Uu]rl\w*\b/.test(block),
        false,
        `${model} 不得含 URL 字段`
      );
    }
    // 6b. client DTO 不含 storageKey
    for (const file of [
      'lib/trpc/schemas/library.ts',
      'lib/storyWork/metadata.ts',
    ]) {
      const abs = path.join(repoRoot, file);
      if (!fs.existsSync(abs)) continue;
      assert.strictEqual(
        fs.readFileSync(abs, 'utf-8').includes('storageKey'),
        false,
        `${file} 不得含 storageKey`
      );
    }
    // 6c. 非 storage adapter 代码不 import S3 SDK
    const hits: string[] = [];
    for (const scope of ['lib', 'app']) {
      for (const file of collectSourceFiles(path.join(repoRoot, scope))) {
        const rel = path.relative(repoRoot, file);
        if (rel === path.join('lib/audio/storage/s3.ts')) continue;
        const content = fs.readFileSync(file, 'utf-8');
        if (content.includes('@aws-sdk')) hits.push(rel);
      }
    }
    assert.deepStrictEqual(hits, [], `仅 s3.ts 可依赖 S3 SDK，违规：${hits.join(',')}`);
    // 6d. Local 缺省 root 不落耦合目录（行为口径）
    assert.notStrictEqual(DEFAULT_LOCAL_AUDIO_ROOT, LEGACY_COUPLED_AUDIO_DIR);
    assert.strictEqual(isCoupledLegacyAudioRoot(DEFAULT_LOCAL_AUDIO_ROOT), false);
    // 6e. route 不泄漏 storageKey/bucket（错误体仅固定 code；backend 调用仅经 segment.storageKey）
    const routeSource = fs.readFileSync(
      path.join(repoRoot, 'app/api/audio/segments/[segmentId]/route.ts'),
      'utf-8'
    );
    assert.strictEqual(/@aws-sdk/.test(routeSource), false, 'route 不得直引 S3 SDK');
    assert.strictEqual(/bucket/i.test(routeSource), false, 'route 不得出现 bucket');
    // 代码行（去注释）内 storageKey 只允许后端调用（segment.storageKey 传参）
    for (const line of stripComments(routeSource).split('\n')) {
      if (line.includes('storageKey')) {
        assert.ok(
          /segment\.storageKey/.test(line),
          `route 内 storageKey 只允许后端调用行：${line.trim()}`
        );
      }
    }
    console.log('PASS: 6. 静态守卫断言通过');
  }

  console.log('ALL AUDIO STORAGE UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioStorageUnitTests()
  .then(() => {
    console.log('ALL AUDIO STORAGE UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
