/**
 * 用例证据记录器（任务13 harness）。
 *
 * 每个用例记录 {case_id, spec_path, start/end UTC, browser version,
 * video/screenshot path(可选), steps[], verdict} →
 * 写 .e2e-results/browser/<run-id>/<case-id>/manifest.json。
 *
 * manifest 必含（方案第12节）：commit、browser/version、fixture hash、
 * mock hash、spec(runner) hash、assertion 结果。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 中文注释：仓库根（node 运行 cwd；Playwright 将 spec 依赖转 CJS 加载，禁用 import.meta）。
const repoRoot = process.cwd();
// 中文注释：harness 目录。
const harnessDir = join(repoRoot, 'tests', 'system', 'browser', 'harness');
// 中文注释：默认浏览器证据根（.e2e-results/browser，gitignore 运行时证据）。
const defaultResultsRoot = join(repoRoot, '.e2e-results', 'browser');

// 中文注释： verdict 枚举（方案第14节，与 runner 一致）。
export const VERDICTS = ['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'FLAKY'];

// 中文注释：L3 执行 runner 配置（playwright runner 入口；独立复算口径见 manifest.hashes.runner）。
const runnerConfigRel = join('tests', 'system', 'browser', 'playwright.config.ts');
// 中文注释：harness 执行文件清单（按文件名排序后逐文件 sha256 再整体 sha256；
// 独立复算：取 manifest.hashes.harness_files 逐文件复算后比对 manifest.hashes.harness）。
const harnessHashRels = [
    join('tests', 'system', 'browser', 'harness', 'app-server.mjs'),
    join('tests', 'system', 'browser', 'harness', 'evidence-recorder.mjs'),
    join('tests', 'system', 'browser', 'harness', 'fixtures.ts'),
    join('tests', 'system', 'browser', 'harness', 'global-setup.mjs'),
    join('tests', 'system', 'browser', 'harness', 'global-teardown.mjs'),
    join('tests', 'system', 'browser', 'harness', 'jsonl-reporter.ts'),
    join('tests', 'system', 'browser', 'harness', 'mock-openai.mjs'),
    join('tests', 'system', 'browser', 'harness', 'mock-standalone.mjs'),
].sort();

/**
 * 取当前 commit 完整 SHA（取不到回退 'unknown'，如实记录不伪造）。
 * @returns commit SHA
 */
export function currentCommit() {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
        return 'unknown';
    }
}

/**
 * 对文件算 sha256（缺失返回 null，如实记录）。
 * @param absPath 文件绝对路径
 * @returns hex 或 null
 */
export function sha256File(absPath) {
    try {
        if (!existsSync(absPath)) return null;
        return createHash('sha256').update(readFileSync(absPath)).digest('hex');
    } catch {
        return null;
    }
}

/**
 * 对多个文件算组合 sha256（各文件 sha256 按给定顺序拼接后整体 sha256；
 * 缺失文件以空串参与并如实计入返回的缺失表，调用方写入 manifest 备查）。
 * @param absPaths 文件绝对路径数组
 * @returns { digest, missing } 组合摘要与缺失路径
 */
export function sha256Files(absPaths) {
    const perFile = [];
    const missing = [];
    for (const p of absPaths) {
        const h = sha256File(p);
        if (h === null) {
            missing.push(p);
            perFile.push('');
        } else {
            perFile.push(h);
        }
    }
    return { digest: createHash('sha256').update(perFile.join('\n')).digest('hex'), missing };
}

/**
 * harness 组合哈希（清单内存在文件参与；缺失即如实记录，不伪造）。
 * @returns { digest, files, missing } 摘要、参与相对路径、缺失绝对路径
 */
export function harnessDigest() {
    const absPaths = harnessHashRels.map((r) => join(repoRoot, r));
    const { digest, missing } = sha256Files(absPaths);
    return { digest, files: [...harnessHashRels], missing };
}

/**
 * 当前 UTC ISO 时间戳。
 * @returns ISO 字符串
 */
function utcNow() {
    return new Date().toISOString();
}

/**
 * 创建用例记录器。
 * @param params 参数 { runId, caseId, specPath, resultsRoot?, commit?, catalogCaseId?, executableId?, candidateCaseIds?, reason? }
 *   caseId 为文件系统目录标识；catalogCaseId 为 catalog case_id（缺省沿用 caseId 保持兼容；
 *   显式 null 表示 catalog 暂无绑定，manifest 如实记 null + reason，不编造）。
 * @returns 记录器 { dir, manifestPath, step(name, detail?), finish(opts) }
 */
export function createCaseRecorder(params) {
    const runId = params.runId;
    const caseId = params.caseId;
    const specPath = params.specPath;
    const resultsRoot = params.resultsRoot ?? defaultResultsRoot;
    const commit = params.commit ?? currentCommit();
    const hasCatalogBinding = params.catalogCaseId !== undefined;
    const catalogCaseId = hasCatalogBinding ? params.catalogCaseId : caseId;
    const executableId = params.executableId ?? null;
    const candidateCaseIds = params.candidateCaseIds ?? (hasCatalogBinding && typeof catalogCaseId === 'string' ? [catalogCaseId] : []);
    const bindReason = params.reason ?? null;
    if (!runId || !caseId || !specPath) {
        throw new Error('[evidence-recorder] runId/caseId/specPath 均为必填');
    }
    const dir = join(resultsRoot, runId, caseId);
    mkdirSync(dir, { recursive: true });
    const manifestPath = join(dir, 'manifest.json');
    const startedAtUtc = utcNow();
    const steps = [];
    return {
        dir,
        manifestPath,
        /**
         * 记录一步操作。
         * @param name 步骤名
         * @param detail 细节（可 JSON 序列化）
         */
        step(name, detail) {
            steps.push({ name, detail: detail ?? null, at_utc: utcNow() });
        },
        /**
         * 收尾并写 manifest.json。
         * @param opts 收尾参数 { verdict, browser, browserVersion, assertions?, screenshotPath?, videoPath? }
         * @returns manifest 路径
         */
        finish(opts) {
            const verdict = opts.verdict;
            if (!VERDICTS.includes(verdict)) {
                throw new Error(`[evidence-recorder] 非法 verdict: ${verdict}`);
            }
            // 中文注释：Fix 9——harness 执行文件组合哈希 + 参与清单（独立复算口径；缺失如实记 missing）。
            const harnessInfo = harnessDigest();
            const manifest = {
                case_id: catalogCaseId,
                executable_id: executableId,
                candidate_case_ids: candidateCaseIds,
                reason: bindReason,
                spec_path: specPath,
                run_id: runId,
                commit,
                started_at_utc: startedAtUtc,
                ended_at_utc: utcNow(),
                browser: opts.browser ?? 'unknown',
                browser_version: opts.browserVersion ?? 'unknown',
                verdict,
                assertions: opts.assertions ?? [],
                steps,
                evidence: {
                    manifest: manifestPath,
                    screenshot: opts.screenshotPath ?? null,
                    video: opts.videoPath ?? null,
                },
                hashes: {
                    fixture: sha256File(join(repoRoot, 'tests', 'support', 'fixtures', 'spike-fixed.mp3')),
                    mock: sha256File(join(harnessDir, 'mock-openai.mjs')),
                    spec: sha256File(join(repoRoot, specPath)),
                    // 中文注释：Fix 9——独立可复算的 runner 配置哈希（playwright runner 入口）。
                    runner: sha256File(join(repoRoot, runnerConfigRel)),
                    runner_path: runnerConfigRel,
                    // 中文注释：Fix 9——harness 执行文件组合哈希 + 参与清单（独立复算口径）。
                    harness: harnessInfo.digest,
                    harness_files: harnessInfo.files,
                    harness_missing: harnessInfo.missing,
                },
            };
            writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
            return manifestPath;
        },
    };
}
