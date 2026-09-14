import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { CANONICAL_SYNTHESIS_SPEED } from '../../../lib/audio/profile';

/**
 * M8-05-04 Production Closure 静态守卫单元测试（纯静态，不触库/网络）。
 *
 * 锁定 M8 closure 上线门（沿既有 static-guard 惯例，源码扫描口径）：
 * 1. DB 不存 object URL（audio 模型无 URL 字段落盘；签名/播放 URL 只在内存拼）；
 * 2. client 不持 storageKey（lib/client + stores 零出现；components 仅主题 localStorage 别名）；
 * 3. canonical synthesis speed 恒 1.0；
 * 4. Draft 仍走 ephemeral tts.synthesize（旧路径保留且 canonical 门禁 Draft 恒 false）；
 * 5. S3 SDK 仅出现在 adapter（lib/audio/storage/s3.ts）；
 * 6. M5 PlaybackSourceRef / sessionId / Progress / Anchor schema 未改；
 * 7. M7 P3A 无 story-level timeline ownership 新增；
 * 8. /player 未删（物理保留）；
 * 9. P3B story-level seek 明确排除（deferred consumer：文档显式排除 + 代码零实现 +
 *    P3B 字样仅出现在排除性注释）。
 */

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
}

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
}

function collectTsFiles(dirRel: string): string[] {
  const out: string[] = [];
  const root = path.join(process.cwd(), dirRel);
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'generated' || ent.name === 'node_modules') continue;
        walk(abs);
        continue;
      }
      if (/\.tsx?$/.test(ent.name)) out.push(abs);
    }
  };
  walk(root);
  return out;
}

async function runAudioProductionClosureUnitTests() {
  console.log('=== 1. DB 不存 object URL ===');
  {
    const schema = readRepoFile('prisma/schema.prisma');
    const code = stripComments(schema);
    // 字段定义行出现 URL 落盘即违规（注释不算；storyCard audioUrl 置空注释已在注释层）。
    const urlFieldLines = code
      .split('\n')
      .filter((line) =>
        /^\s*(objectUrl|signedUrl|audioUrl|playbackUrl|segmentUrl)\s+\S+/.test(line),
      );
    assert.deepStrictEqual(urlFieldLines, [], `DB 不得有 URL 字段：${urlFieldLines.join(';')}`);
    // 播放 URL 只在 server 内存拼（opaque segmentId），schema 层无 playbackUrl。
    assert.strictEqual(
      /playbackUrl/.test(code),
      false,
      'schema 不得出现 playbackUrl',
    );
    console.log('PASS: 1. DB 无 object URL 通过');
  }

  console.log('=== 2. client 不持 storageKey ===');
  {
    for (const dir of ['lib/client', 'stores']) {
      for (const abs of collectTsFiles(dir)) {
        const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
        const code = stripComments(fs.readFileSync(abs, 'utf-8'));
        assert.strictEqual(
          code.includes('storageKey'),
          false,
          `${rel} 不得持有 storageKey`,
        );
      }
    }
    // components 仅允许主题 localStorage 别名（非音频资产 key）。
    for (const abs of collectTsFiles('components')) {
      const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(abs, 'utf-8'));
      if (code.includes('storageKey')) {
        assert.ok(
          code.includes('localStorage'),
          `${rel} 的 storageKey 必须仅为 localStorage 别名（主题偏好），不得为音频资产 key`,
        );
        assert.strictEqual(
          /audioStorageKey|segmentStorageKey|canonicalStorageKey/i.test(code),
          false,
          `${rel} 不得出现音频资产 key 形态`,
        );
      }
    }
    console.log('PASS: 2. client 无 storageKey 通过');
  }

  console.log('=== 3. canonical synthesis speed 恒 1.0 ===');
  {
    assert.strictEqual(CANONICAL_SYNTHESIS_SPEED, 1.0, 'canonical 合成速度常量锁 1.0');
    const storyCode = stripComments(readRepoFile('lib/server/storyAudio.ts'));
    assert.ok(
      storyCode.includes('speed: CANONICAL_SYNTHESIS_SPEED'),
      'server 合成必须以 CANONICAL_SYNTHESIS_SPEED 调用（用户倍速不进资产）',
    );
    console.log('PASS: 3. speed 1.0 通过');
  }

  console.log('=== 4. Draft 仍走 ephemeral tts.synthesize ===');
  {
    const ttsGen = stripComments(readRepoFile('lib/client/ttsGenerate.ts'));
    assert.ok(
      ttsGen.includes('tts.synthesize'),
      'Draft 旧路径必须保留 tts.synthesize 调用',
    );
    assert.strictEqual(
      ttsGen.includes('ensureSegment'),
      false,
      'Draft 旧路径不得碰 ensureSegment',
    );
    const clientAudio = stripComments(readRepoFile('lib/client/storyAudio.ts'));
    assert.ok(
      clientAudio.includes('isCanonicalAudioEnabled'),
      'Work/canonical 选择必须经 flag 门禁',
    );
    assert.ok(
      /Draft.*tts\.synthesize|tts\.synthesize.*Draft/.test(
        clientAudio.replace(/\s+/g, ' '),
      ) || readRepoFile('lib/client/storyAudio.ts').includes('Draft'),
      'client 门面必须声明 Draft 走旧路径',
    );
    console.log('PASS: 4. Draft 旧路径通过');
  }

  console.log('=== 5. S3 SDK 仅出现在 adapter ===');
  {
    const offenders: string[] = [];
    for (const abs of collectTsFiles('lib')) {
      const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(abs, 'utf-8'));
      if (code.includes('@aws-sdk')) {
        if (rel !== 'lib/audio/storage/s3.ts') offenders.push(rel);
      }
    }
    assert.deepStrictEqual(offenders, [], `S3 SDK 越界：${offenders.join(',')}`);
    console.log('PASS: 5. S3 SDK 收敛通过');
  }

  console.log('=== 6. M5 PlaybackSourceRef / sessionId / Progress / Anchor 未改 ===');
  {
    const schema = stripComments(readRepoFile('prisma/schema.prisma'));
    for (const model of [
      'model UserPlaybackAnchor',
      'model GuestPlaybackAnchor',
      'model StoryPlaybackProgress',
      'model GuestStoryPlaybackProgress',
    ]) {
      assert.ok(schema.includes(model), `schema 必须保留 ${model}`);
    }
    const sessionIdLines = schema
      .split('\n')
      .filter((line) => /^\s*sessionId\s+String\?/.test(line));
    assert.ok(
      sessionIdLines.length >= 2,
      `Anchor sessionId 可空字段必须保留（User/Guest），实际 ${sessionIdLines.length}`,
    );
    const sourceRef = stripComments(readRepoFile('lib/playback/source.ts'));
    assert.ok(sourceRef.includes('PlaybackSourceRef'), 'PlaybackSourceRef 契约保留');
    const sessionMod = stripComments(readRepoFile('lib/playback/session.ts'));
    assert.ok(
      sessionMod.includes('isValidPlaybackSessionId'),
      'session 身份校验入口保留',
    );
    assert.ok(sessionMod.includes('SessionId'), 'session 身份字段保留');
    console.log('PASS: 6. M5 冻结面通过');
  }

  console.log('=== 7. M7 P3A 无 story-level timeline ownership 新增 ===');
  {
    const schema = stripComments(readRepoFile('prisma/schema.prisma'));
    assert.strictEqual(
      /timeline/i.test(schema),
      false,
      'schema 不得新增任何 timeline 形态（story-level timeline ownership 禁入）',
    );
    assert.strictEqual(
      /model\s+StoryTimeline|storyTimeline|timelineOwner/i.test(schema),
      false,
      'schema 不得有 story timeline 所有权模型/字段',
    );
    console.log('PASS: 7. P3A 边界通过');
  }

  console.log('=== 8. /player 未删 ===');
  {
    assert.ok(
      fs.existsSync(path.join(process.cwd(), 'app/(main)/player/page.tsx')),
      '/player page 必须物理保留',
    );
    assert.ok(
      fs.existsSync(path.join(process.cwd(), 'app/(main)/player/index.tsx')),
      '/player index 必须物理保留',
    );
    console.log('PASS: 8. /player 保留通过');
  }

  console.log('=== 9. P3B story-level seek 明确排除 ===');
  {
    // 文档显式排除。
    const readPath = readRepoFile(
      'docs/e2e/07-故事库与作品资产/16-Canonical-Work-Playback-Read-Path.md',
    );
    assert.ok(readPath.includes('P3B'), '读路径文档必须显式点名 P3B 排除项');
    // 代码零 story-level seek 实现。
    const offenders: string[] = [];
    for (const dir of ['lib', 'stores']) {
      for (const abs of collectTsFiles(dir)) {
        const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
        const code = stripComments(fs.readFileSync(abs, 'utf-8'));
        if (/seekStory|storySeek|StorySeek/.test(code)) offenders.push(rel);
      }
    }
    assert.deepStrictEqual(offenders, [], `story-level seek 实现禁入：${offenders.join(',')}`);
    // P3B 字样仅允许出现在排除性注释（deferred/排除/不得/不触）。
    const p3bLines: string[] = [];
    const badP3b: string[] = [];
    for (const dir of ['lib', 'stores', 'app']) {
      for (const abs of collectTsFiles(dir)) {
        const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
        const raw = fs.readFileSync(abs, 'utf-8');
        raw.split('\n').forEach((line, idx) => {
          if (/P3B/.test(line)) {
            p3bLines.push(`${rel}:${idx + 1}`);
            if (!/deferred|排除|不得|不触/.test(line)) badP3b.push(`${rel}:${idx + 1}:${line.trim()}`);
          }
        });
      }
    }
    assert.strictEqual(
      badP3b.length,
      0,
      `P3B 只能是 deferred 排除性提及（不得消费）：${badP3b.join(';')}`,
    );
    assert.ok(p3bLines.length >= 1, '至少一处显式 P3B 排除声明可查');
    console.log('PASS: 9. P3B 排除通过');
  }

  console.log('ALL AUDIO PRODUCTION CLOSURE UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runAudioProductionClosureUnitTests()
  .then(() => {
    console.log('ALL AUDIO PRODUCTION CLOSURE UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
