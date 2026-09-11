/**
 * 用例证据记录器（任务13 harness）。
 *
 * 每个用例记录 {case_id, spec_path, start/end UTC, browser version,
 * video/screenshot path(可选), steps[], verdict} →
 * 写 .e2e-results/browser/<run-id>/<case-id>/manifest.json。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 中文注释：仓库根（node 运行 cwd；Playwright 将 spec 依赖转 CJS 加载，禁用 import.meta）。
const repoRoot = process.cwd();
// 中文注释：默认浏览器证据根（.e2e-results/browser，gitignore 运行时证据）。
const defaultResultsRoot = join(repoRoot, '.e2e-results', 'browser');

// 中文注释： verdict 枚举（方案第14节，与 runner 一致）。
export const VERDICTS = ['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'FLAKY'];

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
         * @param opts 收尾参数 { verdict, browser, browserVersion, screenshotPath?, videoPath? }
         * @returns manifest 路径
         */
        finish(opts) {
            const verdict = opts.verdict;
            if (!VERDICTS.includes(verdict)) {
                throw new Error(`[evidence-recorder] 非法 verdict: ${verdict}`);
            }
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
                steps,
                evidence: {
                    manifest: manifestPath,
                    screenshot: opts.screenshotPath ?? null,
                    video: opts.videoPath ?? null,
                },
            };
            writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
            return manifestPath;
        },
    };
}
