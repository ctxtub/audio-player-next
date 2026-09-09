import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import * as safety from './test-database-path-safety.mjs';

const cwd = process.cwd();

// 中文注释：预期 schema 表集合（probe 子集断言用，不含迁移内表）。
const EXPECTED_TABLES = [
    'User',
    'ChatMessage',
    'GenerationHistory',
    'PromptHistory',
    'UserConfig',
    'GuestConfig',
    'GuestChatMessage',
    'GuestGenerationHistory',
    'GuestPromptHistory',
    'UserPlaybackProgress',
    'GuestPlaybackProgress',
];
// 中文注释：单 suite 执行上限毫秒（180 秒，超时 exit 4）。
const SUITE_TIMEOUT_MS = 180000;
// 中文注释：允许的 group 枚举（含任务流全部层级）。
const ALLOWED_GROUPS = ['unit', 'integration', 'contract', 'tooling', 'static', 'legacy', 'e2e', 'browser'];
// 中文注释：unit 禁止导入 lib/db 的静态扫描正则。
const LIB_DB_IMPORT_RE = /from\s+['"].*lib\/db['"]|require\(['"].*lib\/db['"]\)/;

// 中文注释：套件注册表（41 项，id 由 path 推导剥后缀，group 按迁移表归类，needs_db 仅 unit 为 false）。
const SUITES = [
    { id: 'test-sec-01', path: './tests/test-sec-01.ts', group: 'unit', needs_db: false },
    { id: 'test-sec-02', path: './tests/test-sec-02.ts', group: 'legacy', needs_db: true },
    { id: 'test-batch-02', path: './tests/test-batch-02.ts', group: 'legacy', needs_db: true },
    { id: 'test-release-pipeline', path: './tests/test-release-pipeline.ts', group: 'tooling', needs_db: true },
    { id: 'test-auth-guest-matrix', path: './tests/test-auth-guest-matrix.ts', group: 'integration', needs_db: true },
    { id: 'test-guest-signed-cookie', path: './tests/test-guest-signed-cookie.ts', group: 'integration', needs_db: true },
    { id: 'test-agent-summarize-guard', path: './tests/test-agent-summarize-guard.ts', group: 'integration', needs_db: true },
    { id: 'test-session-branches', path: './tests/test-session-branches.ts', group: 'unit', needs_db: false },
    { id: 'test-rate-limit', path: './tests/test-rate-limit.ts', group: 'unit', needs_db: false },
    { id: 'test-orphan-prevention', path: './tests/test-orphan-prevention.ts', group: 'integration', needs_db: true },
    { id: 'test-guest-config', path: './tests/test-guest-config.ts', group: 'integration', needs_db: true },
    { id: 'test-guest-creative-sync', path: './tests/test-guest-creative-sync.ts', group: 'integration', needs_db: true },
    { id: 'test-guest-creative-e2e-harness', path: './tests/test-guest-creative-e2e-harness.ts', group: 'integration', needs_db: true },
    { id: 'test-paragraph-resume', path: './tests/test-paragraph-resume.ts', group: 'legacy', needs_db: true },
    { id: 'test-storycard-resume-fix01', path: './tests/test-storycard-resume-fix01.ts', group: 'integration', needs_db: true },
    { id: 'test-fix03-resume-countdown', path: './tests/test-fix03-resume-countdown.ts', group: 'integration', needs_db: true },
    { id: 'test-fix04-no-autocontinue', path: './tests/test-fix04-no-autocontinue.ts', group: 'integration', needs_db: true },
    { id: 'test-restart-mock-managed', path: './tests/test-restart-mock-managed.ts', group: 'tooling', needs_db: true },
    { id: 'test-e2e-db-guard', path: './tests/test-e2e-db-guard.ts', group: 'tooling', needs_db: true },
    { id: 'test-e2e-db-guard-regression', path: './tests/test-e2e-db-guard-regression.ts', group: 'tooling', needs_db: true },
    { id: 'test-e2e-stream-observe', path: './tests/test-e2e-stream-observe.ts', group: 'tooling', needs_db: true },
    { id: 'test-toast-terminal-priority', path: './tests/test-toast-terminal-priority.ts', group: 'legacy', needs_db: true },
    { id: 'test-audio-ended-guard', path: './tests/test-audio-ended-guard.ts', group: 'unit', needs_db: false },
    { id: 'test-audio-ended-guard-wiring', path: './tests/test-audio-ended-guard-wiring.ts', group: 'legacy', needs_db: true },
    { id: 'test-chat-onboarding', path: './tests/test-chat-onboarding.ts', group: 'unit', needs_db: false },
    { id: 'test-h04-double-submit', path: './tests/test-h04-double-submit.ts', group: 'legacy', needs_db: true },
    { id: 'test-h08-budget-exhaustion', path: './tests/test-h08-budget-exhaustion.ts', group: 'unit', needs_db: false },
    { id: 'test-h07-paragraph-guard', path: './tests/test-h07-paragraph-guard.ts', group: 'integration', needs_db: true },
    { id: 'test-h03-preload-isolation', path: './tests/test-h03-preload-isolation.ts', group: 'integration', needs_db: true },
    { id: 'test-h16-exit-flush', path: './tests/test-h16-exit-flush.ts', group: 'integration', needs_db: true },
    { id: 'test-h15-concurrent-write', path: './tests/test-h15-concurrent-write.ts', group: 'integration', needs_db: true },
    { id: 'test-h14-config-rollback', path: './tests/test-h14-config-rollback.ts', group: 'unit', needs_db: false },
    { id: 'test-h06-logout-probe', path: './tests/test-h06-logout-probe.ts', group: 'integration', needs_db: true },
    { id: 'test-h08-explicit-budget', path: './tests/test-h08-explicit-budget.ts', group: 'integration', needs_db: true },
    { id: 'test-h15-wiring-e2e', path: './tests/test-h15-wiring-e2e.ts', group: 'legacy', needs_db: true },
    { id: 'test-wave2-h03b-preload-context', path: './tests/test-wave2-h03b-preload-context.ts', group: 'unit', needs_db: false },
    { id: 'test-wave2-h16-keepalive-dedup', path: './tests/test-wave2-h16-keepalive-dedup.ts', group: 'legacy', needs_db: true },
    { id: 'test-wave2-0202-ux', path: './tests/test-wave2-0202-ux.ts', group: 'legacy', needs_db: true },
    { id: 'test-wave2-h14-saveseq', path: './tests/test-wave2-h14-saveseq.ts', group: 'unit', needs_db: false },
    { id: 'test-wave2-h06-probe-hardening', path: './tests/test-wave2-h06-probe-hardening.ts', group: 'legacy', needs_db: true },
    { id: 'runner-database-path-safety', path: './tests/tooling/db-guard/runner-database-path-safety.tooling.test.ts', group: 'tooling', needs_db: true },
];

/** 当前拥有的子进程（信号处理用）。 */
let currentChild = null;
/** 当前 run 目录（信号清理用）。 */
let currentRunDir = '';
/** 允许根（信号清理用）。 */
let currentAllowedRoot = '';
/** 是否正在关闭（防重入）。 */
let shuttingDown = false;

/**
 * 脱敏错误信息（不打印任何环境变量值）。
 * @param unknown 错误对象
 * @returns 脱敏后短信息
 */
function sanitizeError(err) {
    let msg = err instanceof Error ? err.message : String(err);
    if (err && typeof err === 'object' && 'stderr' in err && err.stderr) {
        try {
            msg += ` | ${String(err.stderr).slice(0, 500)}`;
        } catch {
            // 忽略
        }
    }
    // 中文注释：抹去 file: URL 值与可能的绝对路径值，只留结构。
    msg = msg.replace(/file:[^\s'"`]+/g, 'file:<redacted>');
    msg = msg.replace(/DATABASE_URL\s*=\s*[^\s]+/g, 'DATABASE_URL=<redacted>');
    return msg.slice(0, 800);
}

/**
 * 构造受控子进程 env：先 delete ambient 再赋受控值。
 * @param controlledUrl 受控 file URL
 * @param extra 额外受控变量
 * @returns 子进程 env
 */
function buildControlledEnv(controlledUrl, extra = {}) {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    env.DATABASE_URL = controlledUrl;
    for (const [k, v] of Object.entries(extra)) {
        env[k] = v;
    }
    return env;
}

/**
 * 解析命令行参数（--list/--group/--suite），非法即 exit 2。
 * @param argv 参数表（不含 node 与脚本名）
 * @returns {{ list: boolean, group: string|null, suite: string|null }}
 */
function parseArgs(argv) {
    let list = false;
    let group = null;
    let suite = null;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--list') {
            list = true;
        } else if (a === '--group') {
            const v = argv[i + 1];
            if (typeof v !== 'string' || v.startsWith('--') || v.length === 0) {
                console.error('参数错误：--group 缺取值');
                process.exit(2);
            }
            if (!ALLOWED_GROUPS.includes(v)) {
                console.error(`参数错误：非法 --group ${v}`);
                process.exit(2);
            }
            group = v;
            i += 1;
        } else if (a === '--suite') {
            const v = argv[i + 1];
            if (typeof v !== 'string' || v.startsWith('--') || v.length === 0) {
                console.error('参数错误：--suite 缺取值');
                process.exit(2);
            }
            suite = v;
            i += 1;
        } else {
            console.error(`参数错误：未知参数 ${a}`);
            process.exit(2);
        }
    }
    return { list, group, suite };
}

/**
 * 按 group/suite 过滤注册表（空选集调用方判 exit 2）。
 * @param group group 过滤（null 不过滤）
 * @param suite suite id 过滤（null 不过滤）
 * @returns 过滤后条目
 */
function selectSuites(group, suite) {
    let out = SUITES;
    if (group !== null) {
        out = out.filter((e) => e.group === group);
    }
    if (suite !== null) {
        out = out.filter((e) => e.id === suite);
    }
    return out;
}

/**
 * 对单 suite 执行 prisma migrate（execFile 数组 + 受控 env）。
 * @param suiteId suite ID
 * @param controlledUrl 受控 URL
 */
function runMigrate(suiteId, controlledUrl) {
    const prismaBin = path.join(cwd, 'node_modules', '.bin', 'prisma');
    const env = buildControlledEnv(controlledUrl);
    try {
        execFileSync(prismaBin, ['migrate', 'deploy'], { env, stdio: 'pipe' });
    } catch (err) {
        console.error(`BOOTSTRAP migrate 失败 suite=${suiteId} err=${sanitizeError(err)}`);
        process.exit(safety.BOOTSTRAP_EXIT_CODE);
    }
}

/**
 * schema probe：SELECT sqlite_master 断言模型表为子集。
 * @param suiteId suite ID
 * @param controlledUrl 受控 URL
 */
async function runSchemaProbe(suiteId, controlledUrl) {
    let client = null;
    try {
        client = createClient({ url: controlledUrl });
        const rs = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
        const names = new Set(rs.rows.map((r) => String(r[0])));
        const missing = EXPECTED_TABLES.filter((t) => !names.has(t));
        if (missing.length > 0) {
            console.error(`BOOTSTRAP schema probe 缺表 suite=${suiteId} missing=${missing.join(',')}`);
            process.exit(safety.BOOTSTRAP_EXIT_CODE);
        }
    } catch (err) {
        console.error(`BOOTSTRAP schema probe 失败 suite=${suiteId} err=${sanitizeError(err)}`);
        process.exit(safety.BOOTSTRAP_EXIT_CODE);
    } finally {
        if (client !== null) {
            try {
                client.close();
            } catch {
                // 忽略
            }
        }
    }
}

/**
 * 带超时标记的执行（超时 exit 4）。
 * @param file 测试文件
 * @param controlledEnv 受控 env
 * @returns { code, timedOut }
 */
function runSuiteWithTimeout(file, controlledEnv) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(cwd, 'scripts', 'suite-worker.mjs'), file], {
            cwd,
            env: controlledEnv,
            stdio: 'inherit',
        });
        currentChild = child;
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            console.error(`TIMEOUT suite=${file} 超过 180 秒，正在终止子进程`);
            try {
                child.kill('SIGTERM');
            } catch {
                // 忽略
            }
            const killTimer = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // 忽略
                }
            }, 5000);
            child.once('exit', () => {
                clearTimeout(killTimer);
                currentChild = null;
                resolve({ code: safety.SUITE_TIMEOUT_EXIT_CODE, timedOut: true });
            });
        }, SUITE_TIMEOUT_MS);
        child.once('exit', (code) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            currentChild = null;
            resolve({ code: code ?? 1, timedOut: false });
        });
        child.once('error', () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            currentChild = null;
            resolve({ code: 1, timedOut: false });
        });
    });
}

/**
 * 清理本 run 目录（仅限本 run）。
 */
function cleanupCurrentRun() {
    if (currentRunDir !== '' && currentAllowedRoot !== '') {
        try {
            safety.cleanupRunDir(currentRunDir, currentAllowedRoot);
        } catch {
            // 忽略
        }
    }
}

/**
 * 信号处理：先杀子进程等待关闭，再清理本 run。
 * @param sig 信号名
 */
function installSignalHandlers() {
    const onSignal = (sig) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.error(`收到 ${sig}，正在终止子进程并清理本 run`);
        const child = currentChild;
        if (child !== null) {
            try {
                child.kill('SIGTERM');
            } catch {
                // 忽略
            }
            const wait = setInterval(() => {
                if (currentChild === null) {
                    clearInterval(wait);
                    cleanupCurrentRun();
                    process.exit(sig === 'SIGINT' ? 130 : 143);
                }
            }, 100);
            // 中文注释：5 秒仍未退出则 SIGKILL 后清理退出。
            setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // 忽略
                }
                setTimeout(() => {
                    cleanupCurrentRun();
                    process.exit(sig === 'SIGINT' ? 130 : 143);
                }, 1000);
            }, 5000);
        } else {
            cleanupCurrentRun();
            process.exit(sig === 'SIGINT' ? 130 : 143);
        }
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
}

/**
 * 主流程：参数选择→逐 suite 隔离建库→迁移→探针→执行→清理，并写 JSONL。
 */
async function main() {
    installSignalHandlers();
    const { list, group, suite } = parseArgs(process.argv.slice(2));
    // 中文注释：--suite 非法 ID 直接 exit 2（不建库）。
    if (suite !== null && !SUITES.some((e) => e.id === suite)) {
        console.error(`参数错误：未知 --suite ${suite}`);
        process.exit(2);
    }
    const selected = selectSuites(group, suite);
    // 中文注释：空选集 exit 2（stderr 简短原因，不执行不建库）。
    if (selected.length === 0) {
        console.error('参数错误：空选集（group/suite 无交集）');
        process.exit(2);
    }
    // 中文注释：--list 输出 JSON 后 exit 0，不执行不建库。
    if (list) {
        const out = selected.map((e) => ({ id: e.id, path: e.path, group: e.group, needs_db: e.needs_db }));
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        process.exit(0);
    }
    const runId = safety.generateRunId();
    if (!safety.RUN_ID_RE.test(runId)) {
        console.error('BOOTSTRAP run-id 格式非法');
        process.exit(safety.BOOTSTRAP_EXIT_CODE);
    }
    let runDir = '';
    let allowedRoot = '';
    try {
        allowedRoot = safety.getAllowedRoot(cwd);
        runDir = safety.ensureRunDir(cwd, runId);
    } catch (err) {
        console.error(`BOOTSTRAP run 目录初始化失败 err=${sanitizeError(err)}`);
        process.exit(safety.BOOTSTRAP_EXIT_CODE);
    }
    currentRunDir = runDir;
    currentAllowedRoot = allowedRoot;
    // 中文注释：启动前 suite 唯一性检查。
    let suiteIds = [];
    try {
        suiteIds = SUITES.map((e) => safety.suiteIdFromTestPath(e.path));
    } catch (err) {
        console.error(`BOOTSTRAP suite ID 非法 err=${sanitizeError(err)}`);
        cleanupCurrentRun();
        process.exit(safety.BOOTSTRAP_EXIT_CODE);
    }
    const dups = safety.checkUniqueSuiteIds(suiteIds);
    if (dups.length > 0) {
        console.error(`BOOTSTRAP suite ID 重复：${dups.join(',')}`);
        cleanupCurrentRun();
        process.exit(safety.BOOTSTRAP_EXIT_CODE);
    }
    // 中文注释：注册表 id 与路径推导一致性检查（id 剥后缀所得）。
    for (const e of SUITES) {
        const derived = safety.suiteIdFromTestPath(e.path);
        if (derived !== e.id) {
            console.error(`BOOTSTRAP 注册表 id 与 path 不一致 id=${e.id} path=${e.path}`);
            cleanupCurrentRun();
            process.exit(safety.BOOTSTRAP_EXIT_CODE);
        }
    }
    // 中文注释：结果目录 .e2e-results/<run-id>/results.jsonl（逐行 JSONL）。
    const resultsDir = path.join(cwd, '.e2e-results', runId);
    const resultsPath = path.join(resultsDir, 'results.jsonl');
    try {
        fs.mkdirSync(resultsDir, { recursive: true });
    } catch (err) {
        console.error(`BOOTSTRAP 结果目录初始化失败 err=${sanitizeError(err)}`);
        cleanupCurrentRun();
        process.exit(safety.BOOTSTRAP_EXIT_CODE);
    }
    /**
     * 写单行 JSONL（verdict=PASS/FAIL，exit 4 为 BLOCKED）。
     * @param entry 注册表条目
     * @param verdict PASS/FAIL/BLOCKED
     * @param exitCode 退出码
     * @param durationMs 耗时毫秒
     */
    function writeResultsLine(entry, verdict, exitCode, durationMs) {
        const line = {
            run_id: runId,
            suite_id: entry.id,
            suite: entry.id,
            id: entry.id,
            group: entry.group,
            needs_db: entry.needs_db,
            verdict,
            status: verdict,
            exit_code: exitCode,
            exitCode,
            duration_ms: durationMs,
            durationMs: durationMs,
            evidence_path: path.join('.e2e-results', runId, entry.id),
        };
        fs.appendFileSync(resultsPath, `${JSON.stringify(line)}\n`);
    }
    console.log(`run-id=${runId}`);
    console.log(`suites=${selected.length}`);
    console.log('Running test suite...\n');
    for (let i = 0; i < selected.length; i += 1) {
        const entry = selected[i];
        const file = entry.path;
        const suiteId = entry.id;
        const isUnit = entry.group === 'unit';
        const needsDbFalse = entry.needs_db === false;
        // 中文注释：unit 组套件执行前扫描 lib/db 导入，命中即 exit 3 停组。
        if (isUnit || needsDbFalse) {
            let content = '';
            try {
                content = fs.readFileSync(path.join(cwd, file), 'utf8');
            } catch (err) {
                console.error(`BOOTSTRAP 读取失败 suite=${suiteId} err=${sanitizeError(err)}`);
                cleanupCurrentRun();
                process.exit(safety.BOOTSTRAP_EXIT_CODE);
            }
            if (LIB_DB_IMPORT_RE.test(content)) {
                console.error(`UNIT 禁止导入 lib/db suite=${suiteId} path=${file}`);
                try {
                    writeResultsLine(entry, 'BLOCKED', 3, 0);
                } catch {
                    // 忽略写失败，不掩盖 exit 3
                }
                cleanupCurrentRun();
                process.exit(3);
            }
        }
        const startMs = Date.now();
        // 中文注释：按需建库——unit 跳过 migrate/probe，非 unit 走隔离建库。
        if (isUnit || needsDbFalse) {
            // 中文注释：unit 子进程 env 剥离 DATABASE_URL（先 buildControlledEnv 后 delete）。
            const controlledEnv = buildControlledEnv('file:///unit-no-db', {
                TEST_RUNNER_RUN_ID: runId,
                TEST_RUNNER_SUITE_ID: suiteId,
                TEST_RUNNER_DB_PATH: '',
            });
            if (entry.group === 'unit') {
                delete controlledEnv.DATABASE_URL;
            }
            if (entry.needs_db === false) {
                delete controlledEnv.DATABASE_URL;
            }
            console.log(`=== Executing ${file} ===`);
            const { code, timedOut } = await runSuiteWithTimeout(file, controlledEnv);
            const durationMs = Date.now() - startMs;
            let verdict = 'PASS';
            if (code === 0 && !timedOut) verdict = 'PASS';
            else if (code === safety.SUITE_TIMEOUT_EXIT_CODE || timedOut) verdict = 'BLOCKED';
            else verdict = 'FAIL';
            try {
                writeResultsLine(entry, verdict, code, durationMs);
            } catch {
                // 忽略写失败，不掩盖 verdict
            }
            if (timedOut || code === safety.SUITE_TIMEOUT_EXIT_CODE) {
                console.error(`TIMEOUT: ${file} 超时`);
                cleanupCurrentRun();
                process.exit(safety.SUITE_TIMEOUT_EXIT_CODE);
            }
            if (code !== 0) {
                console.error(`FAIL: ${file} (exit ${code})`);
                cleanupCurrentRun();
                process.exit(1);
            }
            console.log(`PASS: ${file}\n`);
            continue;
        }
        let built = null;
        try {
            built = safety.buildSuiteDatabaseUrl(cwd, runId, suiteId);
        } catch (err) {
            console.error(`BOOTSTRAP 路径构造失败 suite=${suiteId} err=${sanitizeError(err)}`);
            cleanupCurrentRun();
            process.exit(safety.BOOTSTRAP_EXIT_CODE);
        }
        const checked = safety.validateDatabaseUrl(built.url, { repoRoot: cwd, runId });
        if (!checked.ok) {
            console.error(`BOOTSTRAP 路径校验失败 suite=${suiteId} reason=${checked.reason}`);
            cleanupCurrentRun();
            process.exit(safety.BOOTSTRAP_EXIT_CODE);
        }
        try {
            safety.ensureSuiteDbParent(built.dbPath, { repoRoot: cwd, allowedRoot: runDir });
        } catch (err) {
            console.error(`BOOTSTRAP 父目录初始化失败 suite=${suiteId} err=${sanitizeError(err)}`);
            cleanupCurrentRun();
            process.exit(safety.BOOTSTRAP_EXIT_CODE);
        }
        runMigrate(suiteId, built.url);
        await runSchemaProbe(suiteId, built.url);
        console.log(`=== Executing ${file} ===`);
        const controlledEnv = buildControlledEnv(built.url, {
            TEST_RUNNER_RUN_ID: runId,
            TEST_RUNNER_SUITE_ID: suiteId,
            TEST_RUNNER_DB_PATH: built.dbPath,
        });
        const { code, timedOut } = await runSuiteWithTimeout(file, controlledEnv);
        const durationMs = Date.now() - startMs;
        // 中文注释：suite 完成后关闭子进程（已退出）并清理其 DB（含 wal/shm）。
        try {
            safety.cleanupSuiteDb(built.dbPath, runDir);
        } catch {
            // 忽略清理错误，不掩盖 verdict
        }
        let verdict = 'PASS';
        if (code === 0 && !timedOut) verdict = 'PASS';
        else if (code === safety.SUITE_TIMEOUT_EXIT_CODE || timedOut) verdict = 'BLOCKED';
        else verdict = 'FAIL';
        try {
            writeResultsLine(entry, verdict, code, durationMs);
        } catch {
            // 忽略写失败，不掩盖 verdict
        }
        if (timedOut || code === safety.SUITE_TIMEOUT_EXIT_CODE) {
            console.error(`TIMEOUT: ${file} 超时，已清理其 DB`);
            cleanupCurrentRun();
            process.exit(safety.SUITE_TIMEOUT_EXIT_CODE);
        }
        if (code !== 0) {
            // 中文注释：普通失败保持 exit 1，不包装为安全失败。
            console.error(`FAIL: ${file} (exit ${code})`);
            cleanupCurrentRun();
            process.exit(1);
        }
        console.log(`PASS: ${file}\n`);
    }
    cleanupCurrentRun();
    console.log('ALL TEST SUITES PASSED SUCCESSFULLY (exit code 0)');
}

await main();
