import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(__dirname, '..');
const workflowPath = path.join(projectRoot, '.github/workflows/docker-push.yml');
const scriptPath = path.join(projectRoot, 'scripts/push-ghcr.sh');

console.log('--- Testing Release Pipeline & Security Controls ---');

// 1. Validate GitHub Actions workflow contract
assert(fs.existsSync(workflowPath), 'Workflow file must exist');
const workflowContent = fs.readFileSync(workflowPath, 'utf-8');

// Triggers
assert(workflowContent.includes('branches:\n      - main'), 'Workflow must trigger on push to main');
assert(workflowContent.includes('tags:\n      - \'v*\''), 'Workflow must trigger on push to v* tags');
assert(workflowContent.includes('workflow_dispatch:'), 'Workflow must support workflow_dispatch');

// Least privilege permissions
assert(workflowContent.includes('permissions: {}'), 'Top level and notify job must specify least privilege empty permissions');
assert(workflowContent.includes('permissions:\n      contents: read\n      packages: write'), 'docker-push job must have bounded permissions');

// Secret hygiene
assert(!workflowContent.includes('${{ secrets.BARK_WEBHOOK }}/'), 'BARK_WEBHOOK secret must not be interpolated directly into shell command');
assert(workflowContent.includes('password: ${{ secrets.GHCR_TOKEN || secrets.GITHUB_TOKEN }}'), 'Login must use GHCR_TOKEN with GITHUB_TOKEN fallback');

console.log('PASS: .github/workflows/docker-push.yml structure, triggers, permissions, and secret hygiene validated.');

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
  // Test A: Default execution (push to main or manual latest)
  {
    const { result, logs } = runScriptWithMock([], {
      GITHUB_SHA: '508aae557e49a16fc7a8c1019e1e7a247e48cf64',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'main',
      PUSH_IMAGE: 'false',
    });
    assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:latest'), 'Must tag latest');
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:sha-508aae5'), 'Must tag immutable sha-508aae5');
    assert(logs.includes('--label org.opencontainers.image.revision=508aae557e49a16fc7a8c1019e1e7a247e48cf64'), 'Must set OCI revision');
    assert(logs.includes('--label org.opencontainers.image.source=https://github.com/ctxtub/audio-player-next'), 'Must set OCI source');
    assert(!logs.includes('--push'), 'PUSH_IMAGE=false must omit --push');
  }

  // Test B: Tag release v1.2.3
  {
    const { result, logs } = runScriptWithMock(['v1.2.3'], {
      GITHUB_SHA: '508aae557e49a16fc7a8c1019e1e7a247e48cf64',
      PUSH_IMAGE: 'true',
    });
    assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:v1.2.3'), 'Must tag v1.2.3');
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:latest'), 'Must tag latest on release');
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:sha-508aae5'), 'Must tag immutable sha');
    assert(logs.includes('--push'), 'PUSH_IMAGE=true must include --push');
  }

  // Test C: Deduplication when tag is explicitly latest or sha
  {
    const { result, logs } = runScriptWithMock(['latest'], {
      GITHUB_SHA: '508aae557e49a16fc7a8c1019e1e7a247e48cf64',
      PUSH_IMAGE: 'false',
    });
    assert.strictEqual(result.status, 0);
    const latestOccurrences = (logs.match(/-t ghcr\.io\/ctxtub\/audio-player-next:latest/g) || []).length;
    assert.strictEqual(latestOccurrences, 1, 'latest tag must appear exactly once');
  }

  // Test D: Fallback to local git commit SHA when GITHUB_SHA is unset
  {
    const { result, logs } = runScriptWithMock([], {
      GITHUB_SHA: '',
      PUSH_IMAGE: 'false',
    });
    assert.strictEqual(result.status, 0);
    assert(logs.includes('-t ghcr.io/ctxtub/audio-player-next:sha-'), 'Must tag sha- from local git');
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

  console.log('PASS: scripts/push-ghcr.sh immutable tags, OCI labels, dry-run, deduplication, and secret isolation validated.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('ALL RELEASE PIPELINE TESTS PASSED.');
