import { spawn, execFileSync } from 'node:child_process';
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

// 中文注释：每套件独立子进程执行——共享 jiti 单进程里跨套件的 globalThis/window/
// require.cache/模块单例会互相污染。套件内依赖 jiti；runner 只做进程编排与聚合退出码。
const testFiles = [
    './tests/test-sec-01.ts',
    './tests/test-sec-02.ts',
    './tests/test-batch-02.ts',
    './tests/test-release-pipeline.ts',
    './tests/test-auth-guest-matrix.ts',
    './tests/test-guest-signed-cookie.ts',
    './tests/test-agent-summarize-guard.ts',
    './tests/test-session-branches.ts',
    './tests/test-rate-limit.ts',
    './tests/test-orphan-prevention.ts',
    './tests/test-guest-config.ts',
    './tests/test-guest-creative-sync.ts',
    './tests/test-guest-creative-e2e-harness.ts',
    './tests/test-paragraph-resume.ts',
    './tests/test-storycard-resume-fix01.ts',
    './tests/test-fix03-resume-countdown.ts',
    './tests/test-fix04-no-autocontinue.ts',
    './tests/test-restart-mock-managed.ts',
    './tests/test-e2e-db-guard.ts',
    './tests/test-e2e-db-guard-regression.ts',
    './tests/test-e2e-stream-observe.ts',
    './tests/test-toast-terminal-priority.ts',
    './tests/test-audio-ended-guard.ts',
    './tests/test-audio-ended-guard-wiring.ts',
    './tests/test-chat-onboarding.ts',
    './tests/test-h04-double-submit.ts',
    './tests/test-h08-budget-exhaustion.ts',
    './tests/test-h07-paragraph-guard.ts',
    './tests/test-h03-preload-isolation.ts',
    './tests/test-h16-exit-flush.ts',
    './tests/test-h15-concurrent-write.ts',
    './tests/test-h14-config-rollback.ts',
    './tests/test-h06-logout-probe.ts',
    './tests/test-h08-explicit-budget.ts',
    './tests/test-h15-wiring-e2e.ts',
    './tests/test-wave2-h03b-preload-context.ts',
    './tests/test-wave2-h16-keepalive-dedup.ts',
    './tests/test-wave2-0202-ux.ts',
    './tests/test-wave2-h14-saveseq.ts',
    './tests/test-wave2-h06-probe-hardening.ts',
    './tests/tooling/db-guard/runner-database-path-safety.tooling.test.ts',
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
 * 主流程：逐 suite 隔离建库→迁移→探针→执行→清理。
 */
async function main() {
    installSignalHandlers();
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
        suiteIds = testFiles.map((f) => safety.suiteIdFromTestPath(f));
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
    console.log(`run-id=${runId}`);
    console.log(`suites=${testFiles.length}`);
    console.log('Running test suite...\n');
    for (let i = 0; i < testFiles.length; i += 1) {
        const file = testFiles[i];
        const suiteId = suiteIds[i];
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
        // 中文注释：suite 完成后关闭子进程（已退出）并清理其 DB（含 wal/shm）。
        try {
            safety.cleanupSuiteDb(built.dbPath, runDir);
        } catch {
            // 忽略清理错误，不掩盖 verdict
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
