import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { AddressInfo } from 'node:net';
import path from 'node:path';

/**
 * restart-mock.sh 受管替换契约测试（缺陷 #5，测试基建）。
 *
 * 覆盖行为（06-04 实证金标准）：
 * 1. 同一受管 mock 二次 restart 会终止旧 PID，并获得新的流式合格实例（含 TTS 健康）。
 * 2. 端口被不受管进程占用时拒绝击杀并失败（无 pid 文件 / 外来 PID 两种情形）。
 * 3. 普通非流 200 但流式探针缺 `[DONE]` 时必须失败。
 * 4. TTS 注入失败（MOCK_FAIL_TTS=1）时必须失败（TTS 健康为成功判据之一）。
 *
 * 隔离约束：全程使用全新临时端口/目录/自包含 mock，禁止触碰 :9301 / :31111 /
 * :38080 / prisma/dev.db / 既有 .e2e-runtime 资产；不写任何密钥（仅内存进程环境）。
 * 本测试不依赖任何 git 忽略的运行时资产，新鲜克隆即可运行。
 *
 * 被测脚本选择：
 * - 默认测试仓库内跟踪脚本 `scripts/restart-mock.sh`（经 MOCK_PORT /
 *   MOCK_PID_FILE / MOCK_LOG_FILE / MOCK_SCRIPT 环境覆盖指向临时作用域）。
 * - 当设置 `RED_BASELINE_SRC=<基线脚本路径>` 时，针对每个用例生成一份仅做
 *   作用域字面量重定向（端口/pid/log/mock 路径）的基线副本并改测该副本，
 *   用于复现基线 RED（基线脚本不支持环境覆盖，但逻辑保持原样；mock 端口
 *   仍经 MOCK_PORT 环境传递，因自包含 mock 统一从环境读端口）。
 */

// 中文注释：仓库根目录（测试一律以仓库根为 cwd 运行）。
const repoRoot: string = process.cwd();

// 中文注释：被测脚本解析结果（真实脚本或基线重定向副本）。
interface ScriptUnderTest {
    /** 传给 bash 的脚本路径。 */
    scriptPath: string;
    /** 是否为基线重定向副本（仅 RED 复现用）。 */
    isBaselineCopy: boolean;
}

// 中文注释：单次脚本执行结果。
interface RunResult {
    /** 进程退出码（被信号终止时为 null）。 */
    exitCode: number | null;
    /** 合并后的 stdout+stderr 文本。 */
    output: string;
}

// 中文注释：用例级临时作用域（端口/pid/log/mock 全隔离）。
interface CaseScope {
    /** 作用域根目录（用例结束即删除）。 */
    dir: string;
    /** 本用例独占的临时端口（断言禁止 9301）。 */
    port: number;
    /** 指向作用域内文件的 pid 路径。 */
    pidFile: string;
    /** 指向作用域内文件的 log 路径。 */
    logFile: string;
    /** 作用域内 mock 脚本路径（默认 mock 的副本）。 */
    mockJs: string;
    /** 本用例拉起的全部子进程 PID（清理用）。 */
    ownedPids: number[];
}

// 中文注释：基线重定向来源（仅 RED 复现运行时设置，日常/GREEN 为空）。
const redBaselineSrc: string = process.env.RED_BASELINE_SRC ?? '';

/**
 * 自包含健康 mock 源码（新鲜克隆可用，不依赖 git 忽略的运行时资产）。
 * 端口经 MOCK_PORT 环境读取；MOCK_FAIL_TTS=1 时 TTS 返回 500（用例 4 注入）。
 */
const HEALTHY_MOCK_SRC: string =
    "import http from 'node:http';\n" +
    'const port = Number(process.env.MOCK_PORT || 9301);\n' +
    "http.createServer((req, res) => {\n" +
    "  let b = '';\n" +
    "  req.on('data', (c) => { b += c; });\n" +
    "  req.on('end', () => {\n" +
    '    let j = {};\n' +
    "    try { j = JSON.parse(b || '{}'); } catch { j = {}; }\n" +
    "    if (req.url === '/v1/audio/speech') {\n" +
    "      if (process.env.MOCK_FAIL_TTS === '1') {\n" +
    "        res.writeHead(500, { 'content-type': 'application/json' });\n" +
    "        res.end(JSON.stringify({ error: { message: 'mock injected TTS failure' } }));\n" +
    '        return;\n' +
    '      }\n' +
    "      res.writeHead(200, { 'content-type': 'audio/mpeg' });\n" +
    '      res.end(Buffer.from([0x49, 0x44, 0x33, 0x00, 0x01, 0x02]));\n' +
    '      return;\n' +
    '    }\n' +
    "    if (j.stream === true) {\n" +
    "      res.writeHead(200, { 'content-type': 'text/event-stream' });\n" +
    '      res.end(\'data: {"choices":[{"delta":{"content":"hi"}}]}\\n\\ndata: [DONE]\\n\\n\');\n' +
    '      return;\n' +
    '    }\n' +
    "    res.writeHead(200, { 'content-type': 'application/json' });\n" +
    '    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));\n' +
    '  });\n' +
    "}).listen(port, '127.0.0.1');\n";

/**
 * 分配一个当前空闲的本地 TCP 端口（绑定 0 后立即释放，仅作候选）。
 * @returns 候选端口号（调用方断言其不为 9301/31111）。
 */
async function allocFreePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const srv = createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr: AddressInfo | string | null = srv.address();
            const port: number = typeof addr === 'object' && addr !== null ? addr.port : 0;
            srv.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(port);
            });
        });
    });
}

/**
 * 为单个用例搭建临时作用域并写入自包含健康 mock。
 * @returns 初始化好的用例作用域。
 */
async function makeCaseScope(): Promise<CaseScope> {
    const dir: string = mkdtempSync(path.join(tmpdir(), 'd5-restart-mock-'));
    const port: number = await allocFreePort();
    assert.ok(port !== 9301 && port !== 31111 && port !== 38080, `临时端口与禁区冲突: ${port}`);
    const pidFile: string = path.join(dir, 'mock.pid');
    const logFile: string = path.join(dir, 'mock.log');
    const mockJs: string = path.join(dir, 'healthy-mock.mjs');
    writeFileSync(mockJs, HEALTHY_MOCK_SRC);
    return { dir, port, pidFile, logFile, mockJs, ownedPids: [] };
}

/**
 * 解析被测脚本：真实脚本直接用；基线 SRC 则生成作用域重定向副本。
 * @param scope 用例作用域（含端口与路径）。
 * @param mockOverride mock 脚本覆盖（缺省用作用域默认副本）。
 * @returns 被测脚本描述。
 */
function resolveScriptUnderTest(scope: CaseScope, mockOverride?: string): ScriptUnderTest {
    const mockJs: string = mockOverride ?? scope.mockJs;
    if (redBaselineSrc === '') {
        return { scriptPath: path.join(repoRoot, 'scripts', 'restart-mock.sh'), isBaselineCopy: false };
    }
    const src: string = readFileSync(redBaselineSrc, 'utf8');
    const redirected: string = src
        .split('9301')
        .join(String(scope.port))
        .split('.e2e-runtime/mock.pid')
        .join(scope.pidFile)
        .split('.e2e-runtime/mock.log')
        .join(scope.logFile)
        .split('.e2e-runtime/mock-openai.mjs')
        .join(mockJs);
    assert.ok(!redirected.includes('9301'), '基线重定向副本仍残留 9301，禁止执行');
    const copyPath: string = path.join(scope.dir, 'restart-mock.baseline-copy.sh');
    writeFileSync(copyPath, redirected, { mode: 0o755 });
    return { scriptPath: copyPath, isBaselineCopy: true };
}

/**
 * 执行被测脚本一次。
 * @param script 被测脚本。
 * @param scope 用例作用域。
 * @param extraEnv 追加进程环境（内存传递，不落盘）。
 * @param mockOverride mock 脚本覆盖（RED 用例 3/4 需要故障 mock 时经此传入）。
 * @returns 退出码与合并输出。
 */
function runRestartScript(
    script: ScriptUnderTest,
    scope: CaseScope,
    extraEnv: Record<string, string> = {},
    mockOverride?: string,
): RunResult {
    const mockJs: string = mockOverride ?? scope.mockJs;
    const env: NodeJS.ProcessEnv = { ...process.env };
    // 中文注释：作用域环境一律传递；基线脚本忽略未知变量（字面量重定向生效），
    // 自包含 mock 统一经 MOCK_PORT 监听作用域端口，保证 RED/GREEN 接线一致。
    env.MOCK_PORT = String(scope.port);
    env.MOCK_PID_FILE = scope.pidFile;
    env.MOCK_LOG_FILE = scope.logFile;
    env.MOCK_SCRIPT = mockJs;
    Object.assign(env, extraEnv);
    const res = spawnSync('bash', [script.scriptPath], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 90000,
    });
    const output: string = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    return { exitCode: res.status, output };
}

/**
 * 读取 pid 文件中的数字 PID。
 * @param pidFile pid 文件路径。
 * @returns PID（文件缺失或非法时返回 null）。
 */
function readPidFile(pidFile: string): number | null {
    if (!existsSync(pidFile)) {
        return null;
    }
    const raw: string = readFileSync(pidFile, 'utf8').trim();
    if (!/^\d+$/.test(raw)) {
        return null;
    }
    return Number(raw);
}

/**
 * 判断 PID 是否存活（ESRCH 即死亡，EPERM 视为存活）。
 * @param pid 待查 PID。
 * @returns 存活返回 true。
 */
function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * 非流探针：chat/completions 非流请求。
 * @param port 目标端口。
 * @returns HTTP 状态码。
 */
async function probeNonStream(port: number): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], stream: false }),
    });
    await res.text();
    return res.status;
}

/**
 * 流式探针：chat/completions 流式 SSE 必须含 `data: [DONE]`。
 * @param port 目标端口。
 * @returns 含 [DONE] 返回 true。
 */
async function probeStreamDone(port: number): Promise<boolean> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], stream: true }),
    });
    const text: string = await res.text();
    return res.status === 200 && text.includes('data: [DONE]');
}

/**
 * TTS 探针：audio/speech 返回 200 且为音频负载。
 * @param port 目标端口。
 * @returns 健康返回 true。
 */
async function probeTts(port: number): Promise<boolean> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'ping' }),
    });
    const buf: ArrayBuffer = await res.arrayBuffer();
    const ctype: string = res.headers.get('content-type') ?? '';
    return res.status === 200 && ctype.includes('audio') && buf.byteLength > 0;
}

/**
 * 清理用例作用域：杀掉本用例拉起的进程并删除临时目录。
 * @param scope 用例作用域。
 */
function cleanupScope(scope: CaseScope): void {
    const pids: number[] = [...scope.ownedPids];
    const filed: number | null = readPidFile(scope.pidFile);
    if (filed !== null) {
        pids.push(filed);
    }
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // 中文注释：进程已死或不可达均视为清理完成。
        }
    }
    rmSync(scope.dir, { recursive: true, force: true });
}

/**
 * 用例 1：同一受管 mock 二次 restart 必须终止旧 PID 并获得新流式合格实例。
 */
async function caseManagedReplace(): Promise<void> {
    const scope: CaseScope = await makeCaseScope();
    try {
        const script: ScriptUnderTest = resolveScriptUnderTest(scope);
        const first: RunResult = runRestartScript(script, scope);
        assert.strictEqual(first.exitCode, 0, `首次启动应成功，输出=${first.output}`);
        const pid1: number | null = readPidFile(scope.pidFile);
        assert.ok(pid1 !== null && isPidAlive(pid1), '首次 pid 必须存活');

        const second: RunResult = runRestartScript(script, scope);
        assert.strictEqual(second.exitCode, 0, `二次 restart 应成功，输出=${second.output}`);
        const pid2: number | null = readPidFile(scope.pidFile);
        assert.ok(pid2 !== null, '二次 restart 后 pid 文件必须存在');
        assert.notStrictEqual(pid2, pid1, '二次 restart 必须产生新 PID（旧实例被替换）');
        assert.ok(isPidAlive(pid2 as number), '新 PID 必须存活（基线 EADDRINUSE 崩溃即 RED）');
        assert.ok(!isPidAlive(pid1 as number), '旧 PID 必须已被终止（基线旧注入进程继续即 RED）');
        scope.ownedPids.push(pid2 as number);

        assert.strictEqual(await probeNonStream(scope.port), 200, '新实例非流探针 200');
        assert.ok(await probeStreamDone(scope.port), '新实例流式探针必须含 [DONE]');
        assert.ok(await probeTts(scope.port), '新实例 TTS 必须健康');
    } finally {
        cleanupScope(scope);
    }
}

/**
 * 用例 2：端口被不受管进程占用时必须拒绝击杀并失败。
 * 覆盖无 pid 文件与外来 PID 两种情形；占用者全程必须存活。
 */
async function caseUnmanagedOccupantRefused(): Promise<void> {
    for (const withForeignPid of [false, true]) {
        const scope: CaseScope = await makeCaseScope();
        // 中文注释：与 mock 文件名无交集的普通 200 占用者（模拟旧注入残留之外的陌生监听）。
        const occupantJs: string = path.join(scope.dir, 'plain-200-occupant.mjs');
        writeFileSync(
            occupantJs,
            "import http from 'node:http';\n" +
                `const port = ${scope.port};\n` +
                "http.createServer((req, res) => {\n" +
                "  let b = '';\n" +
                "  req.on('data', (c) => { b += c; });\n" +
                "  req.on('end', () => {\n" +
                "    res.writeHead(200, { 'content-type': 'application/json' });\n" +
                "    res.end(JSON.stringify({ occupant: true }));\n" +
                '  });\n' +
                `}).listen(port, '127.0.0.1');\n`,
        );
        // 中文注释：异步拉起占用者（detached=false，随用例清理）。
        const { spawn } = await import('node:child_process');
        const occupant = spawn('node', [occupantJs], { cwd: repoRoot, stdio: 'ignore', detached: false });
        assert.ok(occupant.pid !== undefined, '占用者必须拉起');
        const occupantPid: number = occupant.pid as number;
        scope.ownedPids.push(occupantPid);
        try {
            // 中文注释：等待占用者开始监听。
            let ready = false;
            for (let i = 0; i < 20; i++) {
                try {
                    await fetch(`http://127.0.0.1:${scope.port}/`);
                    ready = true;
                    break;
                } catch {
                    await new Promise((r) => setTimeout(r, 250));
                }
            }
            assert.ok(ready, '占用者必须开始监听');
            if (withForeignPid) {
                writeFileSync(scope.pidFile, `${occupantPid}\n`);
            }
            const script: ScriptUnderTest = resolveScriptUnderTest(scope);
            const res: RunResult = runRestartScript(script, scope);
            assert.notStrictEqual(res.exitCode, 0, `不受管占用必须失败（foreignPid=${withForeignPid}），输出=${res.output}`);
            assert.ok(isPidAlive(occupantPid), '不受管占用者绝不能被杀');
            assert.ok(
                /非受管|不受管|unmanaged|拒绝|refus/i.test(res.output),
                `失败输出必须给出可操作错误，输出=${res.output}`,
            );
        } finally {
            try {
                occupant.kill('SIGKILL');
            } catch {
                // 中文注释：占用者已死即无需再杀。
            }
            cleanupScope(scope);
        }
    }
}

/**
 * 用例 3：普通非流 200 但流式探针缺 `[DONE]` 时必须失败。
 */
async function caseBrokenStreamMustFail(): Promise<void> {
    const scope: CaseScope = await makeCaseScope();
    // 中文注释：故障 mock：非流/TTS 均 200，流式提前结束且永不发 [DONE]（模拟 ABORT 注入态）。
    const brokenJs: string = path.join(scope.dir, 'broken-stream-mock.mjs');
    writeFileSync(
        brokenJs,
        "import http from 'node:http';\n" +
            `const port = ${scope.port};\n` +
            "http.createServer((req, res) => {\n" +
            "  let b = '';\n" +
            "  req.on('data', (c) => { b += c; });\n" +
            "  req.on('end', () => {\n" +
            "    let j = {};\n" +
            "    try { j = JSON.parse(b || '{}'); } catch { j = {}; }\n" +
            "    if (req.url === '/v1/audio/speech') {\n" +
            "      res.writeHead(200, { 'content-type': 'audio/mpeg' });\n" +
            "      res.end(Buffer.from([0x49, 0x44, 0x33, 0x00]));\n" +
            "      return;\n" +
            "    }\n" +
            "    if (j.stream === true) {\n" +
            "      res.writeHead(200, { 'content-type': 'text/event-stream' });\n" +
            "      res.end('data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\\n\\n');\n" +
            "      return;\n" +
            "    }\n" +
            "    res.writeHead(200, { 'content-type': 'application/json' });\n" +
            '    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));\n' +
            '  });\n' +
            `}).listen(port, '127.0.0.1');\n`,
    );
    try {
        // 中文注释：先独立拉起故障 mock 验证 RED 前提（非流 200 但流式缺 [DONE]），再杀掉；
        // 随后被测脚本用同一故障 mock 启动必须失败且自行清理，避免“探活后置”与“失败清理”的时序矛盾。
        const { spawn } = await import('node:child_process');
        const premise = spawn('node', [brokenJs], { cwd: repoRoot, stdio: 'ignore', detached: false });
        assert.ok(premise.pid !== undefined, '前提故障 mock 必须拉起');
        try {
            let ready = false;
            for (let i = 0; i < 20; i++) {
                try {
                    await probeNonStream(scope.port);
                    ready = true;
                    break;
                } catch {
                    await new Promise((r) => setTimeout(r, 250));
                }
            }
            assert.ok(ready, '前提故障 mock 必须开始监听');
            assert.strictEqual(await probeNonStream(scope.port), 200, '故障 mock 非流应为 200（RED 前提）');
            assert.ok(!(await probeStreamDone(scope.port)), '故障 mock 流式应缺 [DONE]（RED 前提）');
        } finally {
            try {
                premise.kill('SIGKILL');
            } catch {
                // 中文注释：前提进程已死即无需再杀。
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        const script: ScriptUnderTest = resolveScriptUnderTest(scope, brokenJs);
        const res: RunResult = runRestartScript(script, scope, {}, brokenJs);
        assert.notStrictEqual(res.exitCode, 0, `流探针坏必须失败，输出=${res.output}`);
        const leaked: number | null = readPidFile(scope.pidFile);
        if (leaked !== null) {
            scope.ownedPids.push(leaked);
            assert.ok(!isPidAlive(leaked), '失败后自己拉起的故障实例必须已清理');
        }
    } finally {
        cleanupScope(scope);
    }
}

/**
 * 用例 4：TTS 注入失败时必须失败（TTS 健康为成功判据之一）。
 */
async function caseTtsFailureMustFail(): Promise<void> {
    const scope: CaseScope = await makeCaseScope();
    try {
        const script: ScriptUnderTest = resolveScriptUnderTest(scope);
        const res: RunResult = runRestartScript(script, scope, { MOCK_FAIL_TTS: '1' });
        assert.notStrictEqual(res.exitCode, 0, `TTS 失败必须导致 restart 失败，输出=${res.output}`);
        const leaked: number | null = readPidFile(scope.pidFile);
        if (leaked !== null) {
            scope.ownedPids.push(leaked);
            assert.ok(!isPidAlive(leaked), '失败后自己拉起的实例必须已清理');
        }
    } finally {
        cleanupScope(scope);
    }
}

/**
 * 测试入口：串行执行 4 个用例（端口/PID 互斥，避免交叉干扰）。
 */
async function main(): Promise<void> {
    assert.ok(
        (process.env.RED_BASELINE_SRC ?? '') === '' || existsSync(redBaselineSrc),
        'RED_BASELINE_SRC 必须指向存在的基线脚本',
    );
    await caseManagedReplace();
    await caseUnmanagedOccupantRefused();
    await caseBrokenStreamMustFail();
    await caseTtsFailureMustFail();
}

export default main();
