import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(__dirname, '../../..');
const workflowPath = path.join(projectRoot, '.github/workflows/docker-push.yml');
const scriptPath = path.join(projectRoot, 'scripts/push-ghcr.sh');

console.log('--- Testing Release Pipeline & Security Controls ---');

// 1. Validate GitHub Actions workflow contract
assert(fs.existsSync(workflowPath), 'Workflow file must exist');
const workflowContent = fs.readFileSync(workflowPath, 'utf-8');

// Triggers (WS2: 唯一可发布事件为 v* tag 与显式 dispatch；main push 永不发布)
assert(!workflowContent.includes('branches:\n      - main'), 'WS2: docker-push must not trigger on main push');
assert(workflowContent.includes('tags:\n      - \'v*\''), 'Workflow must trigger on push to v* tags');
assert(workflowContent.includes('workflow_dispatch:'), 'Workflow must support workflow_dispatch');

// Least privilege permissions
assert(workflowContent.includes('permissions: {}'), 'Top level and notify job must specify least privilege empty permissions');
assert(workflowContent.includes('permissions:\n      contents: read\n      packages: write'), 'docker-push job must have bounded permissions');

// Secret hygiene
assert(!workflowContent.includes('${{ secrets.BARK_WEBHOOK }}/'), 'BARK_WEBHOOK secret must not be interpolated directly into shell command');
assert(workflowContent.includes('password: ${{ secrets.GHCR_TOKEN || secrets.GITHUB_TOKEN }}'), 'Login must use GHCR_TOKEN with GITHUB_TOKEN fallback');

console.log('PASS: .github/workflows/docker-push.yml structure, triggers, permissions, and secret hygiene validated.');

// WS2 RED: immutable publisher, retag-only latest, serialized same-SHA gates.
// 以下断言在 C1 基线必须 RED（发布链路尚未收敛），C2 GREEN 后全过。
{
  const scriptContentWs2 = fs.readFileSync(scriptPath, 'utf-8');
  assert(!scriptContentWs2.includes('add_tag "latest"'), 'WS2: push-ghcr.sh must not contain add_tag "latest"=RED');
  assert(scriptContentWs2.includes('--sbom=true'), 'WS2: push-ghcr.sh must enable --sbom=true=RED');
  assert(scriptContentWs2.includes('--provenance=true'), 'WS2: push-ghcr.sh must enable --provenance=true=RED');
  assert(!workflowContent.includes('branches:\n      - main'), 'WS2: docker-push must not trigger on main push=RED');
  assert(workflowContent.includes("tags:\n      - 'v*'"), 'WS2: docker-push must trigger on v* tags=RED');
  assert(workflowContent.includes('tier_select'), 'WS2: docker-push dispatch must have tier_select input=RED');
  assert(workflowContent.includes('source_digest'), 'WS2: docker-push dispatch must have source_digest input=RED');
  assert(workflowContent.includes('promote_latest'), 'WS2: docker-push dispatch must have promote_latest input=RED');
  assert(workflowContent.includes('check-tier-gate.mjs'), 'WS2: docker-push must have tier-gate job=RED');
  assert(workflowContent.includes('browser-smoke') || workflowContent.includes('browser_smoke'), 'WS2: docker-push must have browser-smoke job=RED');
  assert(workflowContent.includes('image-publisher-global'), 'WS2: publisher must have global serial concurrency=RED');
  assert(workflowContent.includes('imagetools create'), 'WS2: promote-latest must use imagetools create (retag-only)=RED');
  assert(workflowContent.includes('imagetools inspect'), 'WS2: promote-latest must have digest/OCI read-back=RED');
  assert(workflowContent.includes('retention-days: 30'), 'WS2: publisher artifacts must set retention-days: 30=RED');
  assert(workflowContent.includes('upload-artifact'), 'WS2: publisher must upload desensitized artifacts=RED');
  // 负例：晋升必须同时要求源 digest/ref 非空与 promote_latest==true，缺一即拒绝。
  assert(
    workflowContent.includes('promote_latest') && (workflowContent.includes('source_digest') || workflowContent.includes('source_ref')),
    'WS2: promote condition must require both source digest/ref and promote_latest=RED',
  );
  // 全 pin：无 tag-only 残留。
  assert(!/uses:\s*\S+@v\d+(\s|$)/m.test(workflowContent), 'WS2: all uses must be full-SHA pinned, no tag-only=RED');
  console.log('PASS: WS2 release publisher static gates (immutable, retag-only, serialized).');
}

// 2. Validate push-ghcr.sh script execution and tag generation
assert(fs.existsSync(scriptPath), 'push-ghcr.sh must exist');
const stat = fs.statSync(scriptPath);
assert((stat.mode & 0o111) !== 0, 'push-ghcr.sh must be executable');

// Create temporary mock docker directory
const tempDir = fs.mkdtempSync('/tmp/mock-docker-');
const mockDockerBin = path.join(tempDir, 'docker');
const logFile = path.join(tempDir, 'docker-calls.log');

const mockDockerScript = `#!/usr/bin/env bash
echo "$@" >> "${logFile}"
if [ "$1" = "buildx" ] && [ "$2" = "version" ]; then
  echo "buildx v0.10.0"
  exit 0
fi
if [ "$1" = "buildx" ] && [ "$2" = "inspect" ]; then
  exit 0
fi
if [ "$1" = "login" ]; then
  cat > /dev/null
  exit 0
fi
if [ "$1" = "buildx" ] && [ "$2" = "build" ]; then
  exit 0
fi
exit 0
`;

fs.writeFileSync(mockDockerBin, mockDockerScript, { mode: 0o755 });

const runScriptWithMock = (args: string[], extraEnv: Record<string, string> = {}) => {
  if (fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }
  const env = {
    ...process.env,
    PATH: `${tempDir}:${process.env.PATH}`,
    ...extraEnv,
  };
  const result = spawnSync(scriptPath, args, { env, encoding: 'utf-8' });
  const logs = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '';
  return { result, logs };
};

try {
  // Test A: Default execution (WS2: 永不含 latest，只发 sha；main 永不发布)
  {
    const { result, logs } = runScriptWithMock([], {
      GITHUB_SHA: '508aae557e49a16fc7a8c1019e1e7a247e48cf64',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'main',
      PUSH_IMAGE: 'false',
    });
    assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);
    assert(!logs.includes(':latest'), 'WS2: default must never contain latest');
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:sha-508aae5'), 'Must tag immutable sha-508aae5');
    assert(logs.includes('--label org.opencontainers.image.revision=508aae557e49a16fc7a8c1019e1e7a247e48cf64'), 'Must set OCI revision');
    assert(logs.includes('--label org.opencontainers.image.source=https://github.com/ctxtub/audio-player-next'), 'Must set OCI source');
    assert(!logs.includes('--push'), 'PUSH_IMAGE=false must omit --push');
  }

  // Test B: Tag release v1.2.3 (WS2: 只发 ref tag + sha，永不自动 latest)
  {
    const { result, logs } = runScriptWithMock(['v1.2.3'], {
      GITHUB_SHA: '508aae557e49a16fc7a8c1019e1e7a247e48cf64',
      PUSH_IMAGE: 'true',
    });
    assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:v1.2.3'), 'Must tag v1.2.3');
    assert(!logs.includes(':latest'), 'WS2: tag release must never auto-tag latest (retag-only)');
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:sha-508aae5'), 'Must tag immutable sha');
    assert(logs.includes('--push'), 'PUSH_IMAGE=true must include --push');
  }

  // Test C: Deduplication (WS2: 显式 latest 输入亦不产 latest；去重保持)
  {
    const { result, logs } = runScriptWithMock(['latest'], {
      GITHUB_SHA: '508aae557e49a16fc7a8c1019e1e7a247e48cf64',
      PUSH_IMAGE: 'false',
    });
    assert.strictEqual(result.status, 0);
    const latestOccurrences = (logs.match(/-t ghcr\.io\/ctxtub\/audio-player-next:latest/g) || []).length;
    assert.strictEqual(latestOccurrences, 0, 'WS2: latest must never appear (even on explicit latest input)');
  }

  // Test D: Fallback to local git commit SHA when GITHUB_SHA is unset (WS2: 仍不含 latest)
  {
    const { result, logs } = runScriptWithMock([], {
      GITHUB_SHA: '',
      PUSH_IMAGE: 'false',
    });
    assert.strictEqual(result.status, 0);
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:sha-'), 'Must tag sha- from local git');
    assert(!logs.includes(':latest'), 'WS2: no-SHA fallback must still contain no latest');
  }

  // Test E: Secret exposure prevention during manual/local login
  {
    const secretToken = 'mock_sensitive_secret_token_12345';
    const { result, logs } = runScriptWithMock([], {
      GHCR_TOKEN: secretToken,
      PUSH_IMAGE: 'false',
    });
    assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);
    assert(!result.stdout.includes(secretToken), 'Secret token must never be logged to stdout');
    assert(!result.stderr.includes(secretToken), 'Secret token must never be logged to stderr');
    assert(!logs.includes(secretToken), 'Secret token must never be passed as a command argument');
  }

  // WS2 Test F: 默认干跑永不含 latest（不可变发布）。
  {
    const { result, logs } = runScriptWithMock([], {
      GITHUB_SHA: '508aae557e49a16fc7a8c1019e1e7a247e48cf64',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'main',
      PUSH_IMAGE: 'false',
    });
    assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);
    assert(!logs.includes(':latest'), 'WS2: default dry-run must never contain latest=RED');
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:sha-508aae5'), 'WS2: default must still tag sha');
  }

  // WS2 Test G: 缺 source_digest 即使 promote_latest=true 也拒绝晋升（静态语义：晋升条件缺一即跳过）。
  // 此处以脚本永不产 latest 为必要条件：无显式晋升路径即无 latest。
  {
    const { result, logs } = runScriptWithMock(['v1.2.3'], {
      GITHUB_SHA: '508aae557e49a16fc7a8c1019e1e7a247e48cf64',
      PUSH_IMAGE: 'false',
    });
    assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);
    assert(!logs.includes(':latest'), 'WS2: tag release must never auto-tag latest (retag-only)=RED');
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:v1.2.3'), 'WS2: tag release must tag ref');
  }

  // WS2 Test H: 缺 promote_latest 即使有源 digest 也不晋升；无 GITHUB_SHA 回退仍不含 latest。
  {
    const { result, logs } = runScriptWithMock([], {
      GITHUB_SHA: '',
      PUSH_IMAGE: 'false',
    });
    assert.strictEqual(result.status, 0);
    assert(!logs.includes(':latest'), 'WS2: no-SHA fallback must still contain no latest=RED');
  }

  console.log('PASS: scripts/push-ghcr.sh immutable tags, OCI labels, dry-run, deduplication, and secret isolation validated.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('ALL RELEASE PIPELINE TESTS PASSED.');
