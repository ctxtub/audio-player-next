import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import * as safety from './test-database-path-safety.mjs';
import { loadEvidenceCatalog, validateRow, expandAssertionClaims, SCHEMA_VERSION } from './evidence-schema.mjs';

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

// 中文注释：套件注册表（50 项，id 由 path 推导剥后缀，group 按迁移表归类，needs_db 仅 unit/static 与无库 tooling 元测试为 false）。
// 中文注释：meta-suite 策略——runner 自身测试（runner/catalog/ci 三个 tooling 元测试）以 needs_db=false 的叶子套件登记进 tooling 组，
// 它们只做 --list 只读查询 / 沙箱 catalog 校验 / 文件结构断言，从不触发套件执行与建库，故无自指递归（由 runner-group-split 用例⑧测试证明）；
// 禁止用 checker 硬编码目录排除来掩盖测试。
const SUITES = [
    { id: 'session-roundtrip', path: './tests/unit/identity-session/session-roundtrip.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'procedure-source-locks', path: './tests/static/procedure-source-locks.static.test.ts', group: 'static', needs_db: false },
    { id: 'batch-source-locks', path: './tests/static/batch-source-locks.static.test.ts', group: 'static', needs_db: false },
    { id: 'release-pipeline', path: './tests/tooling/release/release-pipeline.tooling.test.ts', group: 'tooling', needs_db: true },
    { id: 'identity-procedure-matrix', path: './tests/integration/identity-session/identity-procedure-matrix.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'guest-cookie-authorization', path: './tests/integration/identity-session/guest-cookie-authorization.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'agent-summarize-authorization', path: './tests/integration/identity-session/agent-summarize-authorization.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'session-codec', path: './tests/unit/identity-session/session-codec.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'sliding-window-rate-limit', path: './tests/unit/identity-session/sliding-window-rate-limit.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'registration-rollback', path: './tests/integration/identity-session/registration-rollback.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'guest-config-crud', path: './tests/integration/persistence-config/guest-config-crud.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'guest-creative-sync', path: './tests/integration/persistence-config/guest-creative-sync.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'guest-multisubject-lifecycle', path: './tests/integration/persistence-config/guest-multisubject-lifecycle.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'paragraph-resume-mixed', path: './tests/integration/playback/paragraph-resume-mixed.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'storycard-resume', path: './tests/integration/playback/storycard-resume.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'resume-countdown', path: './tests/integration/playback/resume-countdown.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'final-segment-stop', path: './tests/integration/playback/final-segment-stop.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'mock-lifecycle', path: './tests/tooling/mock/mock-lifecycle.tooling.test.ts', group: 'tooling', needs_db: true },
    { id: 'e2e-db-guard', path: './tests/tooling/db-guard/e2e-db-guard.tooling.test.ts', group: 'tooling', needs_db: true },
    { id: 'e2e-db-guard-regression', path: './tests/tooling/db-guard/e2e-db-guard-regression.tooling.test.ts', group: 'tooling', needs_db: true },
    { id: 'e2e-stream-observer', path: './tests/tooling/observer/e2e-stream-observer.tooling.test.ts', group: 'tooling', needs_db: true },
    { id: 'toast-terminal-priority', path: './tests/unit/creation-chat/toast-terminal-priority.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'audio-ended-guard', path: './tests/unit/playback/audio-ended-guard.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'audio-ended-guard-wiring', path: './tests/static/audio-ended-guard-wiring.static.test.ts', group: 'static', needs_db: false },
    { id: 'onboarding-storage', path: './tests/unit/creation-chat/onboarding-storage.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'reject-second-submit-while-streaming', path: './tests/integration/creation-chat/reject-second-submit-while-streaming.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'budget-exhaustion', path: './tests/unit/playback/budget-exhaustion.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'paragraph-transition-guard', path: './tests/integration/playback/paragraph-transition-guard.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'preload-isolation', path: './tests/integration/creation-chat/preload-isolation.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'pending-save-flush', path: './tests/integration/persistence-config/pending-save-flush.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'stale-conversation-write', path: './tests/integration/persistence-config/stale-conversation-write.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'optimistic-rollback', path: './tests/unit/persistence-config/optimistic-rollback.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'logout-playback-reset', path: './tests/integration/identity-session/logout-playback-reset.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'explicit-play-budget', path: './tests/integration/playback/explicit-play-budget.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'conversation-write-wiring', path: './tests/static/conversation-write-wiring.static.test.ts', group: 'static', needs_db: false },
    { id: 'preload-context-selection', path: './tests/unit/creation-chat/preload-context-selection.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'keepalive-dedup', path: './tests/integration/persistence-config/keepalive-dedup.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'pending-intent-ui', path: './tests/unit/creation-chat/pending-intent-ui.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'save-sequence', path: './tests/unit/persistence-config/save-sequence.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'agent-schema-bounds', path: './tests/unit/persistence-config/agent-schema-bounds.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'logout-probe-hardening', path: './tests/integration/identity-session/logout-probe-hardening.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'runner-database-path-safety', path: './tests/tooling/db-guard/runner-database-path-safety.tooling.test.ts', group: 'tooling', needs_db: true },
    { id: 'browser-harness', path: './tests/tooling/browser/browser-harness.tooling.test.ts', group: 'tooling', needs_db: true },
    { id: 'conversation-conflict-refresh', path: './tests/integration/persistence-config/conversation-conflict-refresh.integration.test.ts', group: 'integration', needs_db: true },
    { id: 'paragraph-segmentation', path: './tests/unit/playback/paragraph-segmentation.unit.test.ts', group: 'unit', needs_db: false },
    { id: 'runner-group-split', path: './tests/tooling/runner/runner-group-split.tooling.test.ts', group: 'tooling', needs_db: false },
    { id: 'catalog-checker', path: './tests/tooling/catalog/catalog-checker.tooling.test.ts', group: 'tooling', needs_db: false },
    { id: 'candidate-quality-workflow', path: './tests/tooling/ci/candidate-quality-workflow.tooling.test.ts', group: 'tooling', needs_db: false },
    { id: 'tier-gate', path: './tests/tooling/tier/tier-gate.tooling.test.ts', group: 'tooling', needs_db: false },
    { id: 'evidence-schema', path: './tests/tooling/evidence/evidence-schema.tooling.test.ts', group: 'tooling', needs_db: false },
    { id: 'governance-docs', path: './tests/tooling/docs/governance-docs.tooling.test.ts', group: 'tooling', needs_db: false },
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
        const e = new Error(`BOOTSTRAP migrate 失败 suite=${suiteId}`);
        e.code = safety.BOOTSTRAP_EXIT_CODE;
        e.suiteId = suiteId;
        throw e;
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
            const e = new Error(`BOOTSTRAP schema probe 缺表 suite=${suiteId}`);
            e.code = safety.BOOTSTRAP_EXIT_CODE;
            e.suiteId = suiteId;
            throw e;
        }
    } catch (err) {
        if (err && typeof err.code !== 'undefined' && err.code === safety.BOOTSTRAP_EXIT_CODE) throw err;
        console.error(`BOOTSTRAP schema probe 失败 suite=${suiteId} err=${sanitizeError(err)}`);
        const e = new Error(`BOOTSTRAP schema probe 失败 suite=${suiteId}`);
        e.code = safety.BOOTSTRAP_EXIT_CODE;
        e.suiteId = suiteId;
        throw e;
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
    // 中文注释：证据 v1 反查基座——catalog 只读解析一次；commit 记完整 SHA（取不到记
    // unknown，如实记录）。catalog 不可读时不伪造绑定：写行校验必败 → BLOCKED + exit 3。
    let evidenceCatalog = null;
    try {
        evidenceCatalog = loadEvidenceCatalog(cwd);
    } catch (err) {
        console.error(`证据 catalog 预载失败（写行时将 BLOCKED+exit 3） err=${sanitizeError(err)}`);
    }
    let commitSha = 'unknown';
    try {
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
        if (/^[0-9a-f]{40}$/.test(sha)) commitSha = sha;
    } catch {
        // 忽略，记 unknown
    }
    try {
        fs.mkdirSync(resultsDir, { recursive: true });
    } catch (err) {
        console.error(`BOOTSTRAP 结果目录初始化失败 err=${sanitizeError(err)}`);
        cleanupCurrentRun();
        process.exit(safety.BOOTSTRAP_EXIT_CODE);
    }
    /**
     * 写单行 JSONL（verdict=PASS/FAIL/BLOCKED/SKIPPED，exit 4 为 BLOCKED）。
     * v1 行协议（WS5/C5，D3 已决：每 assertion 一行）：
     * 每 suite 先写 kind=summary 汇总行（含 schema_version/case_ids 由 executable 反查
     * catalog/旧字段可选透传），再按该 suite 命中的 executable 展开写 kind=assertion
     * 行（case × executable × assertion × surface 全 join catalog）。
     * 写行前用同一校验器校验；非法即记 BLOCKED 并抛 code=3 由调用方补 SKIPPED 后 exit 3
     * （供给/契约损坏，非产品断言失败；C5 写行语义不动，本轮只改控制流与汇总）。
     * @param entry 注册表条目
     * @param verdict PASS/FAIL/BLOCKED/SKIPPED
     * @param exitCode 退出码
     * @param durationMs 耗时毫秒
     */
    function suiteEvidencePath(entry) {
        return path.join('.e2e-results', runId, entry.id);
    }
    /**
     * 由 suite 路径反查 catalog 非 L3 executable（归一化口径与 checker 一致）。
     * @param entry 注册表条目
     * @returns 匹配 executable 数组（缺 catalog 即空数组，调用方走 BLOCKED+exit 3）
     */
    function suiteExecutables(entry) {
        if (evidenceCatalog === null) return [];
        const norm = entry.path.replace(/\\/g, '/').replace(/^\.\//, '');
        const out = [];
        for (const e of evidenceCatalog.executables.values()) {
            if (e.layer === 'L3') continue;
            if (typeof e.path !== 'string') continue;
            const ep = e.path.replace(/\\/g, '/').replace(/^\.\//, '');
            if (ep === norm) out.push(e);
        }
        return out;
    }
    /**
     * 组装本 suite 的全部待写 v1 行（首 summary + N assertion）。
     * @param entry 注册表条目
     * @param verdict PASS/FAIL/BLOCKED
     * @param exitCode 退出码
     * @param durationMs 耗时毫秒
     * @returns 行数组
     */
    function buildResultRows(entry, verdict, exitCode, durationMs) {
        const evidencePath = suiteEvidencePath(entry);
        const execs = suiteExecutables(entry);
        const caseIds = [];
        const seenCases = new Set();
        for (const e of execs) {
            for (const cid of e.case_ids || []) {
                if (!seenCases.has(cid)) {
                    seenCases.add(cid);
                    caseIds.push(cid);
                }
            }
        }
        caseIds.sort();
        const summary = {
            schema_version: SCHEMA_VERSION,
            kind: 'summary',
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
            evidence_path: evidencePath,
            case_ids: caseIds,
            commit: commitSha,
        };
        const rows = [summary];
        for (const e of execs) {
            for (const claim of expandAssertionClaims(evidenceCatalog, e.executable_id)) {
                rows.push({
                    schema_version: SCHEMA_VERSION,
                    kind: 'assertion',
                    run_id: runId,
                    case_id: claim.case_id,
                    executable_id: e.executable_id,
                    assertion_id: claim.assertion_id,
                    surface: claim.surface,
                    verdict,
                    evidence_path: evidencePath,
                    duration_ms: durationMs,
                    commit: commitSha,
                    suite_id: entry.id,
                });
            }
        }
        return rows;
    }
    function writeResultsLine(entry, verdict, exitCode, durationMs) {
        const rows = buildResultRows(entry, verdict, exitCode, durationMs);
        const bad = [];
        for (const row of rows) {
            try {
                const res = validateRow(row, evidenceCatalog);
                if (!res.ok) bad.push(res.errors.join('; '));
            } catch (err) {
                bad.push(`validator-threw:${sanitizeError(err)}`);
            }
        }
        if (bad.length > 0) {
            console.error(`证据行校验失败 suite=${entry.id} reasons=${bad.join(' | ').slice(0, 500)}`);
            try {
                fs.appendFileSync(
                    resultsPath,
                    `${JSON.stringify({
                        schema_version: SCHEMA_VERSION,
                        kind: 'summary',
                        run_id: runId,
                        suite_id: entry.id,
                        verdict: 'BLOCKED',
                        evidence_path: suiteEvidencePath(entry),
                        reason: 'evidence-contract-broken',
                    })}\n`,
                );
            } catch {
                // 忽略写失败，不掩盖 exit 3
            }
            const e = new Error(`证据行校验失败 suite=${entry.id}`);
            e.code = 3;
            e.suiteId = entry.id;
            throw e;
        }
        for (const row of rows) {
            fs.appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
        }
    }
    // 中文注释：WS6/C6 聚合计数（与 verdicts.md 五态一致；FLAKY 仅显式 repeat 口径，runner 默认仍记 FAIL，此处恒 0）。
    let passedCount = 0;
    let failedCount = 0;
    let blockedCount = 0;
    let skippedCount = 0;
    /**
     * 为未跑 suite 补 SKIPPED 行（D4 已决，保证行数可审计；写行仍经同一校验器，失败则降级为最小行）。
     * 每未跑 suite 恰一行 kind=summary + blocked_by，普通聚合路径下 summary 行数 == 已调度 suite 数。
     * @param fromIndex 起始下标（含）
     * @param blockedBy 阻断来源（suiteId 或 bootstrap 原因）
     */
    function writeSkippedForRemaining(fromIndex, blockedBy) {
        for (let j = fromIndex; j < selected.length; j += 1) {
            const e = selected[j];
            let caseIds = [];
            try {
                const execs = suiteExecutables(e);
                const seen = new Set();
                for (const ex of execs) {
                    for (const cid of ex.case_ids || []) {
                        if (!seen.has(cid)) {
                            seen.add(cid);
                            caseIds.push(cid);
                        }
                    }
                }
                caseIds.sort();
            } catch {
                caseIds = [];
            }
            const row = {
                schema_version: SCHEMA_VERSION,
                kind: 'summary',
                run_id: runId,
                suite_id: e.id,
                suite: e.id,
                id: e.id,
                group: e.group,
                needs_db: e.needs_db,
                verdict: 'SKIPPED',
                status: 'SKIPPED',
                exit_code: 3,
                exitCode: 3,
                duration_ms: 0,
                durationMs: 0,
                evidence_path: suiteEvidencePath(e),
                case_ids: caseIds,
                reason: `blocked_by:${blockedBy}`,
                blocked_by: blockedBy,
                commit: commitSha,
            };
            try {
                const res = validateRow(row, evidenceCatalog);
                if (!res.ok) {
                    const fallback = { ...row };
                    delete fallback.case_ids;
                    fs.appendFileSync(resultsPath, `${JSON.stringify(fallback)}\n`);
                } else {
                    fs.appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
                }
            } catch {
                try {
                    fs.appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
                } catch {
                    // 忽略写失败，不掩盖 exit 3
                }
            }
            skippedCount += 1;
        }
    }
    /**
     * 打印终态汇总表（stdout，供 CI 日志与 review 摘录；字段与 verdicts.md 五态一致）。
     */
    function printSummary() {
        const total = selected.length;
        const flaky = 0;
        console.log('========== TEST SUMMARY ==========');
        console.log(`total=${total} passed=${passedCount} failed=${failedCount} blocked=${blockedCount} skipped=${skippedCount} flaky=${flaky}`);
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
        // 中文注释：unit 组套件执行前扫描 lib/db 导入，命中即 exit 3 立即全组停止（D4：已产生行保留，未跑记 SKIPPED+blocked_by）。
        if (isUnit || needsDbFalse) {
            let content = '';
            try {
                content = fs.readFileSync(path.join(cwd, file), 'utf8');
            } catch (err) {
                console.error(`BOOTSTRAP 读取失败 suite=${suiteId} err=${sanitizeError(err)}`);
                try {
                    writeResultsLine(entry, 'BLOCKED', 3, 0);
                } catch {
                    // 证据非法已写 fallback BLOCKED，仍计 BLOCKED
                }
                blockedCount += 1;
                writeSkippedForRemaining(i + 1, suiteId);
                printSummary();
                cleanupCurrentRun();
                process.exit(safety.BOOTSTRAP_EXIT_CODE);
            }
            if (LIB_DB_IMPORT_RE.test(content)) {
                console.error(`UNIT 禁止导入 lib/db suite=${suiteId} path=${file}`);
                try {
                    writeResultsLine(entry, 'BLOCKED', 3, 0);
                } catch {
                    // 已写 fallback，仍计 BLOCKED
                }
                blockedCount += 1;
                writeSkippedForRemaining(i + 1, suiteId);
                printSummary();
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
            else if (code === safety.BOOTSTRAP_EXIT_CODE) verdict = 'BLOCKED';
            else verdict = 'FAIL';
            try {
                writeResultsLine(entry, verdict, code, durationMs);
            } catch (e) {
                if (e && (e.code === 3 || e.code === safety.BOOTSTRAP_EXIT_CODE)) {
                    blockedCount += 1;
                    writeSkippedForRemaining(i + 1, suiteId);
                    printSummary();
                    cleanupCurrentRun();
                    process.exit(3);
                }
                // 其他写失败忽略，不掩盖 verdict
            }
            if (timedOut || code === safety.SUITE_TIMEOUT_EXIT_CODE) {
                console.error(`TIMEOUT: ${file} 超时`);
                blockedCount += 1;
                printSummary();
                cleanupCurrentRun();
                process.exit(safety.SUITE_TIMEOUT_EXIT_CODE);
            }
            if (code === safety.BOOTSTRAP_EXIT_CODE) {
                console.error(`BOOTSTRAP: ${file} 安全退出 (exit 3)，立即停止`);
                blockedCount += 1;
                writeSkippedForRemaining(i + 1, suiteId);
                printSummary();
                cleanupCurrentRun();
                process.exit(3);
            }
            if (code !== 0) {
                // 中文注释：WS6 普通 FAIL 聚合——写行后继续下一个互相隔离的 suite，终态汇总 exit 1。
                console.error(`FAIL: ${file} (exit ${code})`);
                failedCount += 1;
                continue;
            }
            console.log(`PASS: ${file}\n`);
            passedCount += 1;
            continue;
        }
        let built = null;
        try {
            built = safety.buildSuiteDatabaseUrl(cwd, runId, suiteId);
        } catch (err) {
            console.error(`BOOTSTRAP 路径构造失败 suite=${suiteId} err=${sanitizeError(err)}`);
            try {
                writeResultsLine(entry, 'BLOCKED', 3, 0);
            } catch {
                // 已写 fallback，仍计 BLOCKED
            }
            blockedCount += 1;
            writeSkippedForRemaining(i + 1, suiteId);
            printSummary();
            cleanupCurrentRun();
            process.exit(safety.BOOTSTRAP_EXIT_CODE);
        }
        const checked = safety.validateDatabaseUrl(built.url, { repoRoot: cwd, runId });
        if (!checked.ok) {
            console.error(`BOOTSTRAP 路径校验失败 suite=${suiteId} reason=${checked.reason}`);
            try {
                writeResultsLine(entry, 'BLOCKED', 3, 0);
            } catch {
                // 已写 fallback，仍计 BLOCKED
            }
            blockedCount += 1;
            writeSkippedForRemaining(i + 1, suiteId);
            printSummary();
            cleanupCurrentRun();
            process.exit(safety.BOOTSTRAP_EXIT_CODE);
        }
        try {
            safety.ensureSuiteDbParent(built.dbPath, { repoRoot: cwd, allowedRoot: runDir });
        } catch (err) {
            console.error(`BOOTSTRAP 父目录初始化失败 suite=${suiteId} err=${sanitizeError(err)}`);
            try {
                writeResultsLine(entry, 'BLOCKED', 3, 0);
            } catch {
                // 已写 fallback，仍计 BLOCKED
            }
            blockedCount += 1;
            writeSkippedForRemaining(i + 1, suiteId);
            printSummary();
            cleanupCurrentRun();
            process.exit(safety.BOOTSTRAP_EXIT_CODE);
        }
        try {
            runMigrate(suiteId, built.url);
            await runSchemaProbe(suiteId, built.url);
        } catch (err) {
            try {
                writeResultsLine(entry, 'BLOCKED', 3, 0);
            } catch {
                // 已写 fallback，仍计 BLOCKED
            }
            blockedCount += 1;
            writeSkippedForRemaining(i + 1, suiteId);
            printSummary();
            cleanupCurrentRun();
            process.exit(safety.BOOTSTRAP_EXIT_CODE);
        }
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
        else if (code === safety.BOOTSTRAP_EXIT_CODE) verdict = 'BLOCKED';
        else verdict = 'FAIL';
        try {
            writeResultsLine(entry, verdict, code, durationMs);
        } catch (e) {
            if (e && (e.code === 3 || e.code === safety.BOOTSTRAP_EXIT_CODE)) {
                blockedCount += 1;
                writeSkippedForRemaining(i + 1, suiteId);
                printSummary();
                cleanupCurrentRun();
                process.exit(3);
            }
            // 其他写失败忽略，不掩盖 verdict
        }
        if (timedOut || code === safety.SUITE_TIMEOUT_EXIT_CODE) {
            console.error(`TIMEOUT: ${file} 超时，已清理其 DB`);
            blockedCount += 1;
            printSummary();
            cleanupCurrentRun();
            process.exit(safety.SUITE_TIMEOUT_EXIT_CODE);
        }
        if (code === safety.BOOTSTRAP_EXIT_CODE) {
            console.error(`BOOTSTRAP: ${file} 安全退出 (exit 3)，立即停止`);
            blockedCount += 1;
            writeSkippedForRemaining(i + 1, suiteId);
            printSummary();
            cleanupCurrentRun();
            process.exit(3);
        }
        if (code !== 0) {
            // 中文注释：WS6 普通 FAIL 聚合——写行后继续下一个互相隔离的 suite，终态汇总 exit 1。
            console.error(`FAIL: ${file} (exit ${code})`);
            failedCount += 1;
            continue;
        }
        console.log(`PASS: ${file}\n`);
        passedCount += 1;
    }
    printSummary();
    cleanupCurrentRun();
    if (failedCount > 0) {
        console.error(`FAILURES: ${failedCount} suite(s) failed (aggregated, exit 1)`);
        process.exit(1);
    }
    console.log('ALL TEST SUITES PASSED SUCCESSFULLY (exit code 0)');
}

await main();
