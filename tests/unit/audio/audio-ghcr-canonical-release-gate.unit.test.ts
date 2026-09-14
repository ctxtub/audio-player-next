import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

/**
 * M8-05-04 FIXUP closure static oracle：GHCR 正式发布链必须把
 * NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED 传进 Docker build；runtime
 * CANONICAL_AUDIO_ENABLED 不能被当成浏览器 rollout flag 的替代品。
 *
 * 锁定三条（纯静态，不触库/网络/浏览器）：
 * a) scripts/push-ghcr.sh 的 buildx build 必带 NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED build-arg；
 * b) auto-delivery publish job 显式传该变量且 default empty（fail-closed，不改 sha-only）；
 * c) source/Docker default 仍 empty/fail-closed（client bundle 不因 runtime env 变化）+ 注释口径准确。
 */

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
}

function publishSection(workflow: string): string {
  const lines: string[] = workflow.split('\n');
  const start: number = lines.findIndex((l) => /^  publish:\s*$/.test(l));
  assert.ok(start >= 0, '缺 publish job=RED');
  let end: number = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

async function runGhcrCanonicalReleaseGateUnitTests(): Promise<void> {
  console.log('=== a. push-ghcr.sh buildx build 必带 client build-arg ===');
  {
    const script: string = readRepoFile('scripts/push-ghcr.sh');
    assert.ok(script.includes('set -euo pipefail'), '脚本须保持 set -u 风格=RED');
    assert.ok(script.includes('docker buildx build'), '须经 docker buildx build 发布=RED');
    const buildIdx: number = script.indexOf('docker buildx build');
    const buildTail: string = script.slice(buildIdx, buildIdx + 2000);
    assert.ok(
      buildTail.includes('--build-arg') &&
        buildTail.includes('NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED='),
      'buildx build 必须带 NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED build-arg=RED',
    );
    assert.ok(
      script.includes('${NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED:-}'),
      'build-arg 必须用 ${VAR:-} 空值安全形态（set -u 下 unset 不炸，空=OFF）=RED',
    );
    assert.ok(
      script.includes('--build-arg "NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED=${NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED:-}"'),
      'build-arg 行必须为字面 --build-arg "NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED=${NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED:-}"（单字引号，无展开坑）=RED',
    );
    assert.strictEqual(
      script.includes('NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED=1'),
      false,
      '脚本不得硬编码 =1（只透传 env，默认空=OFF）=RED',
    );
    console.log('PASS: a. push-ghcr.sh build-arg 通过');
  }

  console.log('=== b. auto-delivery publish 显式透传且 default empty ===');
  {
    const workflow: string = readRepoFile('.github/workflows/auto-delivery.yml');
    const publish: string = publishSection(workflow);
    assert.ok(
      publish.includes('NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED: ${{ vars.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED }}'),
      'publish Push 步骤 env 必须显式含 NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED: ${{ vars.NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED }}=RED',
    );
    assert.strictEqual(
      /NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED:\s*1/.test(publish),
      false,
      'publish 不得硬编码 =1（repository variable 未设置时为空串=OFF，fail-closed）=RED',
    );
    // 不改变 sha-only：仍无参调用、无 ref 名。
    const codeLines: string[] = publish.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    const invocations: string[] = codeLines.filter((l) => l.trimStart().startsWith('./scripts/push-ghcr.sh'));
    assert.ok(invocations.length >= 1, 'publish 须经 push-ghcr.sh 发布=RED');
    for (const line of invocations) {
      assert.ok(
        /^\s*\.\/scripts\/push-ghcr\.sh\s*$/.test(line),
        `publish 必须无参调用（空 tag=sha-only），违规行=${line.trim()}=RED`,
      );
    }
    assert.ok(!publish.includes('github.ref_name'), 'publish 不得传 ref 名（sha-only 不变）=RED');
    console.log('PASS: b. auto-delivery publish 透传通过');
  }

  console.log('=== c. source/Docker default 空 + 注释口径准确 ===');
  {
    const dockerfile: string = readRepoFile('Dockerfile');
    assert.ok(
      /ARG\s+NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED\s*=\s*""/.test(dockerfile),
      'Dockerfile ARG 缺省必须为空（fail-closed）=RED',
    );
    assert.ok(
      dockerfile.includes('ENV NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED='),
      'Dockerfile 构建内联 env 保留=RED',
    );
    assert.ok(
      /ENV\s+CANONICAL_AUDIO_ENABLED\s*=\s*""/.test(dockerfile),
      'Dockerfile runtime default 必须为空（fail-closed）=RED',
    );
    const compose: string = readRepoFile('docker-compose.yml');
    assert.ok(
      compose.includes('NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED: "${NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED:-}"'),
      'compose build.args 默认必须为空=RED',
    );
    assert.ok(
      compose.includes('CANONICAL_AUDIO_ENABLED: "${CANONICAL_AUDIO_ENABLED:-}"'),
      'compose environment 默认必须为空=RED',
    );
    const envSample: string = readRepoFile('.env.sample');
    assert.ok(envSample.includes('NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED'), '.env.sample 须文档化构建期变量=RED');
    assert.ok(envSample.includes('CANONICAL_AUDIO_ENABLED'), '.env.sample 须文档化运行时变量=RED');
    assert.ok(/fail-closed/i.test(envSample), '.env.sample 须保留 fail-closed 语义=RED');
    assert.strictEqual(
      envSample.split('\n').some((l) => !l.trimStart().startsWith('#') && /CANONICAL_AUDIO_ENABLED\s*=\s*1/.test(l)),
      false,
      '.env.sample 不得有非注释的 =1 示例开启（默认关闭）=RED',
    );
    // 注释口径：删除“任一为 1 即开”，改为 build 时必须 + runtime 不能替代。
    for (const [name, text] of [
      ['.env.sample', envSample],
      ['Dockerfile', dockerfile],
      ['docker-compose.yml', compose],
    ] as Array<[string, string]>) {
      assert.strictEqual(
        /任一/.test(text),
        false,
        `${name} 不得残留“任一…即开”口径（runtime 不能描述为单独足够开启生产播放）=RED`,
      );
      assert.ok(
        text.includes('必须在 build 时设置 NEXT_PUBLIC_CANONICAL_AUDIO_ENABLED=1'),
        `${name} 必须写明浏览器 rollout 须在 build 时设置 NEXT_PUBLIC flag=RED`,
      );
      assert.ok(
        text.includes('不能替代 client build flag') || text.includes('单独不足以开启生产播放'),
        `${name} 必须写明运行时变量不能替代 client build flag=RED`,
      );
    }
    console.log('PASS: c. default 空 + 注释口径通过');
  }

  console.log('ALL GHCR CANONICAL RELEASE GATE UNIT TESTS PASSED SUCCESSFULLY');
}

const testPromise = runGhcrCanonicalReleaseGateUnitTests()
  .then(() => {
    console.log('ALL GHCR CANONICAL RELEASE GATE UNIT TESTS PASSED SUCCESSFULLY');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

export default testPromise;
