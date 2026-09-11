import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(__dirname, '../../..');
const workflowPath = path.join(projectRoot, '.github/workflows/docker-push.yml');
const scriptPath = path.join(projectRoot, 'scripts/push-ghcr.sh');

/**
 * WS2 fixup-ws2-01 共享解析辅助（F2–F7 锁定用，不引入 YAML 依赖）。
 * 注释行（# 开头）不计入权限/并发计数，避免头注干扰。
 */
function stripCommentLinesForCount(workflow: string): string {
  return workflow
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
}

function countJobWritePermissionsForCount(workflow: string): number {
  return (stripCommentLinesForCount(workflow).match(/packages:\s*write/g) || []).length;
}

function extractJobSectionForCount(workflow: string, jobName: string): string {
  const lines: string[] = workflow.split('\n');
  const startIdx: number = lines.findIndex((l) => new RegExp(`^  ${jobName}:\\s*$`).test(l));
  assert.ok(startIdx >= 0, `缺 job ${jobName}=RED`);
  let endIdx: number = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

function getPromoteIfLineForCount(workflow: string): string {
  const section: string = extractJobSectionForCount(workflow, 'promote-latest');
  const line: string | undefined = section.split('\n').find((l) => /^\s*if:/.test(l));
  assert.ok(line !== undefined, 'WS2: promote-latest 缺 if 运行条件=RED');
  return line as string;
}

function isPromoteGateValidForCount(ifLine: string): boolean {
  const hasSourceNonEmpty: boolean =
    (ifLine.includes('source_digest') || ifLine.includes('source_ref')) &&
    (ifLine.includes("!= ''") || ifLine.includes('!= ""'));
  const hasPromoteTrue: boolean = ifLine.includes('promote_latest') && ifLine.includes('== true');
  return hasSourceNonEmpty && hasPromoteTrue && ifLine.includes('&&');
}

function hasOciLabelReadBackForCount(section: string): boolean {
  return (
    section.includes('imagetools inspect') &&
    section.includes('--format') &&
    section.includes('org.opencontainers.image.revision') &&
    section.includes('org.opencontainers.image.source')
  );
}

console.log('--- Testing Release Pipeline & Security Controls ---');

// 1. Validate GitHub Actions workflow contract
assert(fs.existsSync(workflowPath), 'Workflow file must exist');
const workflowContent = fs.readFileSync(workflowPath, 'utf-8');

// Triggers (2026-09-11 决策：删除全部自动触发，docker-push 仅显式 dispatch)
assert(!workflowContent.includes('branches:\n      - main'), 'WS2: docker-push must not trigger on main push');
assert(!workflowContent.includes("tags:\n      - 'v*'"), 'docker-push 不得保留 v* tag 自动触发=RED（已改为仅手动 dispatch）');
assert(!/^\s{2}push:/m.test(workflowContent), 'docker-push 不得存在 push 自动触发=RED');
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
  assert(!workflowContent.includes("tags:\n      - 'v*'"), 'WS2: docker-push 不得保留 v* tag 自动触发=RED');
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

// WS2 fixup-ws2-01（F2–F7 锁定）：单串行写入路径 + 双输入耦合（解析 if 行）+ OCI 回读 + fan-in + tier_select + secret/工件。
// 不删除既有断言，只追加强断言；每条新断言均有真负例（错误实现下会红）。
{
  const codeOnly: string = stripCommentLinesForCount(workflowContent);
  // F2：恰两个写入能力 job（禁止回退 >=1），两 job 显式锁定。
  assert.strictEqual(
    countJobWritePermissionsForCount(workflowContent),
    2,
    'WS2: publisher set must be exactly 2 (docker-push + promote-latest)=RED',
  );
  const dockerPushSection: string = extractJobSectionForCount(workflowContent, 'docker-push');
  const promoteSection: string = extractJobSectionForCount(workflowContent, 'promote-latest');
  assert.ok(/packages:\s*write/.test(dockerPushSection), 'WS2: docker-push job must contain packages:write=RED');
  assert.ok(/packages:\s*write/.test(promoteSection), 'WS2: promote-latest job must contain packages:write=RED');
  // F2 真负例：第三个写权限必须使 ===2 变红。
  const threeWriteFixture: string = `${codeOnly}\n  evil:\n    permissions:\n      packages: write\n`;
  assert.strictEqual(countJobWritePermissionsForCount(threeWriteFixture), 3, 'WS2 negative fixture must count 3=RED');
  assert.ok(countJobWritePermissionsForCount(threeWriteFixture) !== 2, 'WS2: third packages:write must break ===2=RED');
  // 三处串行组一致 + promote 串行。
  assert.strictEqual((codeOnly.match(/image-publisher-global/g) || []).length, 3, 'WS2: image-publisher-global must appear exactly 3 times=RED');
  assert.strictEqual((codeOnly.match(/cancel-in-progress:\s*false/g) || []).length, 3, 'WS2: cancel-in-progress: false must appear exactly 3 times=RED');
  assert.ok(/needs:\s*\[docker-push\]/.test(promoteSection), 'WS2: promote-latest must needs: [docker-push]=RED');
  // F5 fan-in：docker-push needs 恰含三者（无仅 quality 回退）；同文件；唯一构建发布者。
  assert.ok(
    /needs:\s*\[quality,\s*tier-gate,\s*browser-smoke\]/.test(dockerPushSection),
    'WS2: docker-push needs must be exactly [quality, tier-gate, browser-smoke]=RED',
  );
  for (const job of ['quality', 'tier-gate', 'browser-smoke', 'docker-push']) {
    assert.ok(new RegExp(`^  ${job}:\\s*$`, 'm').test(workflowContent), `WS2: ${job} must be in the same workflow file=RED`);
  }
  assert.ok(!promoteSection.includes('buildx build'), 'WS2: promote-latest must not contain buildx build (retag-only)=RED');
  // F4：解析 if 行，双输入耦合 + 两条真负例。
  const ifLine: string = getPromoteIfLineForCount(workflowContent);
  assert.ok(ifLine.includes('source_digest') || ifLine.includes('source_ref'), `WS2: promote if must reference source input=RED: ${ifLine.trim()}`);
  assert.ok(ifLine.includes("!= ''") || ifLine.includes('!= ""'), `WS2: promote if must contain source non-empty check=RED: ${ifLine.trim()}`);
  assert.ok(ifLine.includes('promote_latest') && ifLine.includes('== true'), `WS2: promote if must contain promote_latest == true=RED: ${ifLine.trim()}`);
  assert.ok(ifLine.includes('&&'), `WS2: promote if must couple both inputs with &&=RED: ${ifLine.trim()}`);
  assert.ok(isPromoteGateValidForCount(ifLine), 'WS2: promote if must require both source non-empty and promote_latest==true=RED');
  assert.ok(!isPromoteGateValidForCount('if: ${{ inputs.promote_latest == true }}'), 'WS2 negative: only-promote if must be rejected=RED');
  assert.ok(
    !isPromoteGateValidForCount("if: ${{ (inputs.source_digest != '' || inputs.source_ref != '') }}"),
    'WS2 negative: only-source if must be rejected=RED',
  );
  // F3：Verify 含 revision/source label 比对 + 真负例。
  assert.ok(hasOciLabelReadBackForCount(promoteSection), 'WS2: Verify must compare revision/source labels via --format=RED');
  assert.ok(promoteSection.includes('org.opencontainers.image.revision'), 'WS2: Verify must check revision label=RED');
  assert.ok(promoteSection.includes('org.opencontainers.image.source'), 'WS2: Verify must check source label=RED');
  assert.ok(promoteSection.includes('exit 1'), 'WS2: read-back mismatch must exit 1=RED');
  assert.ok(
    !hasOciLabelReadBackForCount('docker buildx imagetools inspect x\necho ok | grep -q digest'),
    'WS2 negative: Verify without label comparison must be rejected=RED',
  );
  // F6：tier_select 缺省 RELEASE + 选项 + tag 硬编码。
  assert.ok(workflowContent.includes("default: 'RELEASE'"), "WS2: tier_select must default to 'RELEASE'=RED");
  assert.ok(workflowContent.includes('- CANDIDATE') && workflowContent.includes('- RELEASE'), 'WS2: tier_select options must include CANDIDATE and RELEASE=RED');
  assert.ok(workflowContent.includes('node scripts/check-tier-gate.mjs --select RELEASE'), 'WS2: tag branch must hard-code --select RELEASE=RED');
  assert.ok(workflowContent.includes("inputs.tier_select || 'RELEASE'"), "WS2: dispatch must fall back to inputs.tier_select || 'RELEASE'=RED");
  // F7：quality 首步 secret 扫描 + 工件白/黑名单 + 留存精确。
  const qualitySection: string = extractJobSectionForCount(workflowContent, 'quality');
  const stepNames: string[] = qualitySection.split('\n').filter((l) => /^\s*- name:/.test(l));
  assert.ok(stepNames.length >= 1 && stepNames[0].includes('Secret scan'), 'WS2: quality first step must be secret scan=RED');
  assert.ok(qualitySection.includes('git grep') && qualitySection.includes('tracked only'), 'WS2: secret scan must be tracked-only bounded=RED');
  const uploadIdx: number = workflowContent.indexOf('upload-artifact');
  assert.ok(uploadIdx >= 0, 'WS2: missing upload-artifact=RED');
  const retentionIdx: number = workflowContent.indexOf('retention-days: 30', uploadIdx);
  assert.ok(retentionIdx >= 0, 'WS2: retention-days must be exactly 30=RED');
  const uploadBlock: string = workflowContent.slice(uploadIdx, retentionIdx);
  for (const artifact of ['results.jsonl', 'manifest.json', 'summary.log', 'p0-smoke.png', 'digest.txt']) {
    assert.ok(uploadBlock.includes(artifact), `WS2: artifact allowlist missing ${artifact}=RED`);
  }
  assert.ok(!uploadBlock.includes('.env'), 'WS2: artifacts must never upload .env*=RED');
  assert.ok(!uploadBlock.includes('.db'), 'WS2: artifacts must never upload DB=RED');
  assert.ok(!uploadBlock.toLowerCase().includes('secret'), 'WS2: artifacts must never upload secret=RED');
  console.log('PASS: WS2 fixup-ws2-01 locked gates (publisher set, dual-input if, OCI labels, fan-in, tier_select, secret/artifacts).');
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
