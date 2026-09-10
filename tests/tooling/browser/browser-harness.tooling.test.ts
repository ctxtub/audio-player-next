import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';

/**
 * 浏览器 harness 自测 tooling 套件（任务13 第一段）。
 *
 * 覆盖 harness 五件（tests/system/browser/harness/）：
 * 1. app-server 启停：startAppServer 后 health 可达，stopAppServer 后端口释放；
 * 2. mock：固定 MP3 端点 Content-Type 为 audio/mpeg（含 Range 206），TTS/Agent 端点固定响应；
 * 3. evidence-recorder：在 tmp 模拟根下产出 manifest.json，结构含 commit/browser/version/assertions；
 * 4. jsonl-reporter：模拟 suite 结束追加 results.jsonl 行，字段齐全且 verdict 枚举合法。
 * 5. 脏 tracked 树拒绝：临时 git 仓 fixture 改脏 tracked 文件 → 守卫与 ensureSnapshot 抛 BLOCKED，
 *    预置 ready 快照亦拒绝复用（fast-path 守卫），且未产生/覆盖快照；
 * 6. EXPECTED_TARGET_SHA 绑定：失配抛 BLOCKED（含 expected/actual 短 SHA），短前缀等价放行，未设置不阻断；
 * 7. 干净树放行：干净 fixture 走到守卫通过点（不跑完整 build），untracked 不阻断。
 *
 * 隔离约束：全程仅 localhost；app-server 用 31120-31150 范围空闲端口，
 * mock 用随机空闲端口；禁止触碰 :31111/:9301/:38080、prisma/dev.db、.env*；
 * 不真跑浏览器（第 4 项用伪造 test/result 对象直调 reporter）。
 * 快照构建较重（production build 约数十秒），本套件串行执行并复用 commit 级快照缓存。
 */

// 中文注释：仓库根（harness 相对路径解析用，测试一律以仓库根为 cwd 运行）。
const repoRoot: string = process.cwd();

// 中文注释：harness 目录（被测对象所在地）。
const harnessDir: string = path.join(repoRoot, 'tests', 'system', 'browser', 'harness');

// 中文注释： verdict 枚举（与 runner/方案第14节一致）。
const VERDICTS: readonly string[] = ['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'FLAKY'];

/**
 * 判断 TCP 端口当前是否无监听（stop 后释放断言用）。
 * @param port 待查端口
 * @returns 空闲返回 true
 */
async function isPortFree(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const sock = createConnection({ host: '127.0.0.1', port });
        sock.once('connect', () => {
            sock.destroy();
            resolve(false);
        });
        sock.once('error', () => {
            sock.destroy();
            resolve(true);
        });
    });
}

/**
 * 用例 1：app-server 启停后端口释放。
 * 全量启停：隔离快照 → 合成 secret/隔离库 migrate → next start → health 探测 → kill 树 → 端口释放确认。
 */
async function caseAppServerLifecycle(): Promise<void> {
    const mod = await import(path.join(harnessDir, 'app-server.mjs'));
    assert.strictEqual(typeof mod.startAppServer, 'function', 'app-server 必须导出 startAppServer');
    assert.strictEqual(typeof mod.stopAppServer, 'function', 'app-server 必须导出 stopAppServer');
    const handle = await mod.startAppServer();
    try {
        assert.ok(handle.port >= 31120 && handle.port <= 31150, `端口须在 31120-31150 范围内，实际=${handle.port}`);
        assert.ok(typeof handle.url === 'string' && handle.url.includes(String(handle.port)), 'handle.url 须含端口');
        const res = await fetch(handle.url, { redirect: 'manual' });
        assert.ok(res.status === 200 || res.status === 307 || res.status === 308, `health 探测须可达，实际=${res.status}`);
        await res.arrayBuffer();
    } finally {
        await mod.stopAppServer(handle);
    }
    let released = false;
    for (let i = 0; i < 20; i += 1) {
        if (await isPortFree(handle.port)) {
            released = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(released, `stop 后端口必须释放：${handle.port}`);
}

/**
 * 用例 2：mock 固定 MP3 Content-Type 正确，TTS/Agent 端点固定响应。
 */
async function caseMockServer(): Promise<void> {
    const mod = await import(path.join(harnessDir, 'mock-openai.mjs'));
    assert.strictEqual(typeof mod.startMockServer, 'function', 'mock 必须导出 startMockServer');
    assert.strictEqual(typeof mod.stopMockServer, 'function', 'mock 必须导出 stopMockServer');
    const handle = await mod.startMockServer();
    try {
        // 中文注释：固定 MP3 端点（200 全量）。
        const full = await fetch(`${handle.url}/fixture.mp3`);
        assert.strictEqual(full.status, 200, 'fixture.mp3 须 200');
        assert.ok((full.headers.get('content-type') ?? '').includes('audio/mpeg'), 'fixture.mp3 Content-Type 须为 audio/mpeg');
        const fullBytes = Buffer.from(await full.arrayBuffer());
        assert.ok(fullBytes.length > 0, 'fixture.mp3 须有负载');
        // 中文注释：Range 206（浏览器 <audio> 媒体请求必需）。
        const ranged = await fetch(`${handle.url}/fixture.mp3`, { headers: { Range: 'bytes=0-99' } });
        assert.strictEqual(ranged.status, 206, 'Range 请求须 206');
        assert.ok((ranged.headers.get('content-type') ?? '').includes('audio/mpeg'), 'Range 响应 Content-Type 须为 audio/mpeg');
        // 中文注释：TTS 固定响应端点。
        const tts = await fetch(`${handle.url}/v1/audio/speech`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ input: 'ping', voice: 'fake' }),
        });
        assert.strictEqual(tts.status, 200, 'TTS 端点须 200');
        assert.ok((tts.headers.get('content-type') ?? '').includes('audio/mpeg'), 'TTS Content-Type 须为 audio/mpeg');
        // 中文注释：Agent 固定响应端点（chat/completions 非流）。
        const agent = await fetch(`${handle.url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], stream: false }),
        });
        assert.strictEqual(agent.status, 200, 'Agent 端点须 200');
        const agentJson = (await agent.json()) as { choices?: Array<{ message?: { content?: string } }> };
        assert.ok(Array.isArray(agentJson.choices) && agentJson.choices.length > 0, 'Agent 固定响应须含 choices');
    } finally {
        await mod.stopMockServer(handle);
    }
    let released = false;
    for (let i = 0; i < 20; i += 1) {
        if (await isPortFree(handle.port)) {
            released = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(released, `mock stop 后端口必须释放：${handle.port}`);
}

/**
 * 用例 3：evidence-recorder 在 tmp 模拟根下产出结构合法的 manifest。
 */
async function caseEvidenceRecorder(): Promise<void> {
    const tmpRoot: string = mkdtempSync(path.join(tmpdir(), 'browser-evidence-'));
    try {
        const mod = await import(path.join(harnessDir, 'evidence-recorder.mjs'));
        assert.strictEqual(typeof mod.createCaseRecorder, 'function', 'evidence-recorder 必须导出 createCaseRecorder');
        const recorder = mod.createCaseRecorder({
            runId: 'tooling-selftest-run',
            caseId: 'tooling-selftest-case',
            specPath: 'tests/system/browser/smoke.spec.ts',
            resultsRoot: tmpRoot,
        });
        recorder.step('打开首屏', { url: 'http://localhost:31120/' });
        recorder.step('断言首屏 200');
        const manifestPath: string = await recorder.finish({
            verdict: 'PASS',
            browser: 'chromium',
            browserVersion: '153.0.8010.12',
            assertions: [{ assertion_id: 'first-screen-200', passed: true, detail: '首屏可达' }],
        });
        assert.ok(existsSync(manifestPath), 'finish 须写出 manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        for (const key of [
            'case_id',
            'spec_path',
            'run_id',
            'commit',
            'started_at_utc',
            'ended_at_utc',
            'browser',
            'browser_version',
            'steps',
            'verdict',
            'assertions',
        ]) {
            assert.ok(key in manifest, `manifest 缺必填键：${key}`);
        }
        assert.strictEqual(manifest['case_id'], 'tooling-selftest-case', 'manifest case_id 须一致');
        assert.ok(VERDICTS.includes(String(manifest['verdict'])), 'manifest verdict 须为合法枚举');
        assert.ok(Array.isArray(manifest['steps']) && (manifest['steps'] as unknown[]).length === 2, 'manifest steps 须记录两步');
        // 中文注释：Fix 9——manifest 必须含独立可复算的 runner/harness 两类哈希（等价物不接受缺失）。
        const hashes = manifest['hashes'] as Record<string, unknown>;
        assert.ok(hashes && typeof hashes === 'object', 'manifest 须含 hashes 对象');
        for (const key of ['fixture', 'mock', 'spec', 'runner', 'harness']) {
            assert.ok(typeof hashes[key] === 'string' && (hashes[key] as string).length === 64, `hashes.${key} 须为 64 位 hex`);
        }
        // 中文注释：Fix 9——runner 哈希独立复算（直读 playwright.config.ts）。
        const { createHash } = await import('node:crypto');
        const expectedRunner: string = createHash('sha256')
            .update(readFileSync(path.join(repoRoot, 'tests', 'system', 'browser', 'playwright.config.ts')))
            .digest('hex');
        assert.strictEqual(hashes['runner'], expectedRunner, 'hashes.runner 须与独立复算一致');
        assert.strictEqual(
            hashes['runner_path'],
            path.join('tests', 'system', 'browser', 'playwright.config.ts'),
            'hashes.runner_path 须标明复算口径',
        );
        // 中文注释：Fix 9——harness 组合哈希独立复算（按 harness_files 清单逐文件复算后比对）。
        const harnessFiles = hashes['harness_files'] as unknown;
        assert.ok(Array.isArray(harnessFiles) && harnessFiles.length > 0, 'hashes.harness_files 须为非空清单');
        const perFile: string[] = (harnessFiles as string[]).map((rel: string) =>
            createHash('sha256').update(readFileSync(path.join(repoRoot, rel))).digest('hex'),
        );
        const expectedHarness: string = createHash('sha256').update(perFile.join('\n')).digest('hex');
        assert.strictEqual(hashes['harness'], expectedHarness, 'hashes.harness 须与独立复算一致');
        assert.ok(
            Array.isArray(hashes['harness_missing']) && (hashes['harness_missing'] as unknown[]).length === 0,
            'harness 清单文件须全部存在（harness_missing 为空）',
        );
    } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
}

/**
 * 用例 4：jsonl-reporter 模拟 suite 结束追加合法行。
 */
async function caseJsonlReporter(): Promise<void> {
    const tmpRoot: string = mkdtempSync(path.join(tmpdir(), 'browser-jsonl-'));
    const runId = 'tooling-jsonl-run';
    try {
        const mod = await import(path.join(harnessDir, 'jsonl-reporter.ts'));
        assert.ok(typeof mod.default === 'function', 'jsonl-reporter 须默认导出 Reporter 类');
        assert.strictEqual(typeof mod.mapOutcomeToVerdict, 'function', 'jsonl-reporter 须导出 mapOutcomeToVerdict');
        assert.strictEqual(mod.mapOutcomeToVerdict('passed', 'expected'), 'PASS', 'passed/expected 须映射 PASS');
        assert.strictEqual(mod.mapOutcomeToVerdict('failed', 'unexpected'), 'FAIL', 'failed/unexpected 须映射 FAIL');
        assert.strictEqual(mod.mapOutcomeToVerdict('skipped', 'expected'), 'SKIPPED', 'skipped 须映射 SKIPPED');
        const Reporter = mod.default as new (opts?: { resultsRoot?: string; runId?: string }) => {
            onBegin?: (config: unknown, suite: unknown) => void;
            onTestEnd?: (test: unknown, result: unknown) => void;
        };
        const reporter = new Reporter({ resultsRoot: tmpRoot, runId });
        reporter.onBegin?.({}, { title: 'root' });
        reporter.onTestEnd?.(
            {
                title: 'production 首屏 200 可达',
                titlePath: () => ['smoke.spec.ts', 'production 首屏 200 可达'],
                outcome: () => 'expected',
            },
            { status: 'passed', duration: 123, retry: 0 },
        );
        const lines: string = readFileSync(path.join(tmpRoot, runId, 'results.jsonl'), 'utf8');
        const row = JSON.parse(lines.trim().split('\n').pop() as string) as Record<string, unknown>;
        for (const key of ['run_id', 'case_id', 'verdict', 'duration_ms', 'evidence_path']) {
            assert.ok(key in row, `jsonl 行缺必填键：${key}`);
        }
        assert.strictEqual(row['run_id'], runId, 'jsonl run_id 须一致');
        assert.ok(VERDICTS.includes(String(row['verdict'])), 'jsonl verdict 须为合法枚举');
        assert.strictEqual(row['verdict'], 'PASS', 'passed 用例 verdict 须为 PASS');
        assert.ok(typeof row['duration_ms'] === 'number', 'duration_ms 须为数字');
    } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
}

/**
 * WS4 守卫 fixture：在系统 tmp 下建临时 git 仓（绝不碰真工作区）。
 * 流程：mkdtemp → git init → 写 tracked 文件并提交 → 返回仓根与 HEAD full SHA。
 * @returns 仓根、tracked 文件绝对路径、HEAD full SHA
 */
function makeTempGitRepo(): { dir: string; file: string; fullSha: string } {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'browser-guard-'));
    try {
        execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'guard-fixture@example.invalid'], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'guard-fixture'], { cwd: dir, stdio: 'pipe' });
        const file: string = path.join(dir, 'tracked.txt');
        writeFileSync(file, 'clean-content\n');
        execFileSync('git', ['add', 'tracked.txt'], { cwd: dir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'fixture init'], { cwd: dir, stdio: 'pipe' });
        const fullSha: string = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: dir,
            encoding: 'utf8',
            stdio: 'pipe',
        }).trim();
        assert.ok(/^[0-9a-f]{40}$/.test(fullSha), 'fixture HEAD 须为 full SHA');
        return { dir, file, fullSha };
    } catch (err) {
        rmSync(dir, { recursive: true, force: true });
        throw err;
    }
}

/**
 * WS4 用例 5：脏 tracked 树在 archive 前被拒（BLOCKED），且未产生/覆盖快照。
 * 临时仓 fixture：提交后改脏 tracked 文件 → 守卫与 ensureSnapshot 均抛 BLOCKED；
 * 预置 ready 快照证明 fast-path 同样先验守卫（脏树拒绝复用旧快照）。
 */
async function caseDirtyTreeRejected(): Promise<void> {
    const mod = await import(path.join(harnessDir, 'app-server.mjs'));
    assert.strictEqual(typeof mod.assertArchivePreconditions, 'function', 'app-server 必须导出 assertArchivePreconditions（WS4 守卫）');
    assert.strictEqual(typeof mod.ensureSnapshot, 'function', 'app-server 必须导出 ensureSnapshot（WS4 接线验证用）');
    const { dir, file, fullSha } = makeTempGitRepo();
    try {
        writeFileSync(file, 'dirty-modification\n');
        const dirty: string = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
            cwd: dir,
            encoding: 'utf8',
            stdio: 'pipe',
        }).trim();
        assert.ok(dirty.length > 0, 'fixture 必须处于脏 tracked 树状态');
        assert.throws(
            () => mod.assertArchivePreconditions({ cwd: dir }),
            /BLOCKED/,
            '脏 tracked 树必须抛 BLOCKED',
        );
        // 中文注释：预置 ready 快照 → fast-path 命中路径同样先验守卫，脏树拒绝复用且不得覆盖。
        const snapshotBase: string = path.join(dir, '.guard-snapshots');
        const snapshotDir: string = path.join(snapshotBase, fullSha);
        mkdirSync(snapshotDir, { recursive: true });
        const marker: string = path.join(snapshotDir, '.snapshot-ready');
        writeFileSync(marker, `${fullSha}\n`);
        await assert.rejects(
            mod.ensureSnapshot(fullSha, {}, { cwd: dir, snapshotBase }),
            /BLOCKED/,
            '脏树即使快照已就绪也必须拒绝复用（fast-path 守卫）',
        );
        assert.strictEqual(readFileSync(marker, 'utf8'), `${fullSha}\n`, '守卫拒绝时不得覆盖既有快照');
        // 中文注释：无快照基线 → 脏树拒绝时不得产生新快照。
        const freshBase: string = path.join(dir, '.guard-fresh');
        await assert.rejects(
            mod.ensureSnapshot(fullSha, {}, { cwd: dir, snapshotBase: freshBase }),
            /BLOCKED/,
            '脏树必须抛 BLOCKED',
        );
        assert.ok(!existsSync(path.join(freshBase, fullSha)), '脏树拒绝时不得产生快照目录');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * WS4 用例 6：EXPECTED_TARGET_SHA 失配即抛；短前缀等价放行；未设置不阻断。
 */
async function caseExpectedShaMismatchRejected(): Promise<void> {
    const mod = await import(path.join(harnessDir, 'app-server.mjs'));
    assert.strictEqual(typeof mod.assertArchivePreconditions, 'function', 'app-server 必须导出 assertArchivePreconditions（WS4 守卫）');
    const { dir, fullSha } = makeTempGitRepo();
    const prev: string | undefined = process.env.EXPECTED_TARGET_SHA;
    try {
        // 中文注释：翻转首个 hex 字符构造失配 SHA（等长 hex，非前缀关系）。
        const wrong: string = fullSha.startsWith('0') ? `1${fullSha.slice(1)}` : `0${fullSha.slice(1)}`;
        assert.throws(
            () => mod.assertArchivePreconditions({ cwd: dir, expectedSha: wrong }),
            /BLOCKED/,
            'EXPECTED_TARGET_SHA 失配必须抛 BLOCKED',
        );
        let seen = '';
        try {
            mod.assertArchivePreconditions({ cwd: dir, expectedSha: wrong });
        } catch (err) {
            seen = String((err as Error)?.message ?? err);
        }
        assert.ok(seen.includes(fullSha.slice(0, 7)), '失配信息须含 actual 短 SHA');
        assert.ok(seen.includes(wrong.slice(0, 7)), '失配信息须含 expected 短 SHA');
        // 中文注释：短 SHA 前缀等价 → 放行；full 相等 → 放行；空串（未设置）→ 不阻断。
        mod.assertArchivePreconditions({ cwd: dir, expectedSha: fullSha.slice(0, 7) });
        mod.assertArchivePreconditions({ cwd: dir, expectedSha: fullSha });
        mod.assertArchivePreconditions({ cwd: dir, expectedSha: '' });
        // 中文注释：环境变量路径——非空失配抛，恢复后放行。
        process.env.EXPECTED_TARGET_SHA = wrong;
        assert.throws(
            () => mod.assertArchivePreconditions({ cwd: dir }),
            /BLOCKED/,
            '环境变量 EXPECTED_TARGET_SHA 失配必须抛 BLOCKED',
        );
    } finally {
        if (prev === undefined) delete process.env.EXPECTED_TARGET_SHA;
        else process.env.EXPECTED_TARGET_SHA = prev;
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * WS4 用例 7：干净 tracked 树走到守卫通过点（不必跑完整 build）；untracked 不阻断。
 */
async function caseCleanTreePasses(): Promise<void> {
    const mod = await import(path.join(harnessDir, 'app-server.mjs'));
    assert.strictEqual(typeof mod.assertArchivePreconditions, 'function', 'app-server 必须导出 assertArchivePreconditions（WS4 守卫）');
    const { dir, fullSha } = makeTempGitRepo();
    try {
        const ok = mod.assertArchivePreconditions({ cwd: dir }) as { fullSha?: unknown };
        assert.ok(ok && typeof ok === 'object', '干净树守卫须通过并返回证据');
        assert.strictEqual((ok as { fullSha: string }).fullSha, fullSha, '守卫返回的 full SHA 须等于 HEAD');
        // 中文注释：untracked（??）不阻断——archive 天然排除 .env*/.db/.next/node_modules。
        writeFileSync(path.join(dir, '.env.local'), 'SYNTHETIC=untracked-fixture\n');
        writeFileSync(path.join(dir, 'scratch.tmp'), 'tmp\n');
        mod.assertArchivePreconditions({ cwd: dir });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 测试入口：串行执行 7 个用例（端口/快照互斥，避免交叉干扰）。
 */
async function main(): Promise<void> {
    await caseAppServerLifecycle();
    console.log('PASS: 用例1 app-server 启停与端口释放');
    await caseMockServer();
    console.log('PASS: 用例2 mock 端点与 Range 206');
    await caseEvidenceRecorder();
    console.log('PASS: 用例3 evidence-recorder manifest（含 Fix 9 runner/harness 独立复算哈希）');
    await caseJsonlReporter();
    console.log('PASS: 用例4 jsonl-reporter 行字段');
    await caseDirtyTreeRejected();
    console.log('PASS: 用例5 脏 tracked 树拒绝（BLOCKED，未产生/覆盖快照）');
    await caseExpectedShaMismatchRejected();
    console.log('PASS: 用例6 EXPECTED_TARGET_SHA 失配拒绝/前缀等价放行/未设置不阻断');
    await caseCleanTreePasses();
    console.log('PASS: 用例7 干净树守卫通过（untracked 不阻断）');
    console.log('ALL BROWSER HARNESS TESTS PASSED');
}

export default main();
