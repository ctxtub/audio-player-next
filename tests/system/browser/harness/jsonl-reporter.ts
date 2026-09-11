import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import {
    findExecutablesForPath,
    getCaseIdsForExecutable,
    loadEvidenceCatalog,
    validateRow,
} from "../../../../scripts/evidence-schema.mjs";

/**
 * Playwright 自定义 JSONL reporter（任务13 harness；C5 升级为证据 schema v1）。
 *
 * suite 结束 append .e2e-results/browser/<run-id>/results.jsonl，
 * 行协议 v1（校验器 `scripts/evidence-schema.mjs`，与 Node runner 共用同一口径）：
 * - 有 catalog 绑定的 spec（location.file 反查 L3 executable）：记 summary 行
 *   （kind=summary，case_ids/executable 全 join catalog）；
 * - 无绑定的 spec（如 smoke.spec.ts 尚未登记 L3 executable）：记一行
 *   BLOCKED(reason=no-catalog-binding)，严禁伪造 PASS 或编造 case_id；
 * - 无 location 的合成调用（ frozen 的 browser-harness 单元测试直调口径）：
 *   走 legacy 兼容 fallback（synthetic=true，--check 拒收，仅保既有断言）。
 *
 * 运行标识来源（优先级从高到低）：构造参数 → 环境变量 BROWSER_RUN_ID →
 * harness 运行时指针文件（global-setup 写入）→ 本地回退 run-id。
 */

/** Playwright test 状态（result.status）。 */
export type PlaywrightStatus = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";

/** Playwright 用例 outcome（test.outcome()）。 */
export type PlaywrightOutcome = "expected" | "unexpected" | "flaky" | "skipped";

/** 证据 verdict 枚举（方案第14节，与 runner 一致）。 */
export type EvidenceVerdict = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED" | "FLAKY";

/** JSONL 结果行（最小结果协议：summary 行携带绑定或 reason）。 */
export interface JsonlResultRow {
    /** schema 版本（恒 1）。 */
    schema_version?: number;
    /** 行种类（summary）。 */
    kind?: string;
    /** 运行标识。 */
    run_id: string;
    /** 用例标识。 */
    case_id?: string;
    /** catalog case_ids。 */
    case_ids?: string[];
    /** catalog executable。 */
    executable_id?: string;
    /** 结论枚举。 */
    verdict: EvidenceVerdict;
    /** 耗时毫秒。 */
    duration_ms: number;
    /** 证据目录（相对仓库根；manifest 所在目录）。 */
    evidence_path: string;
    /** 无绑定 BLOCKED 的原因。 */
    reason?: string;
    /** 合成调用标记（--check 拒收）。 */
    synthetic?: boolean;
    /** Playwright project 名。 */
    browser?: string;
    /** 用例相对路径。 */
    spec_path?: string;
}

/** reporter 构造参数。 */
export interface JsonlReporterOptions {
    /** 证据根（缺省 <repo>/.e2e-results/browser）。 */
    resultsRoot?: string;
    /** 运行标识（缺省按来源优先级解析）。 */
    runId?: string;
}

/** 仓库根（Playwright CLI 调用 cwd；reporter 经 CJS require 加载，禁用 import.meta）。 */
const repoRoot: string = process.cwd();

/** 默认证据根。 */
const defaultResultsRoot: string = join(repoRoot, ".e2e-results", "browser");

/** harness 运行时指针文件（global-setup 写入当次 run/app/mock 地址）。 */
const pointerPath: string = join(repoRoot, ".e2e-runtime", "browser-harness", "active.json");

/**
 * 解析运行标识（构造参数 → 环境变量 → 指针文件 → 本地回退）。
 * @param explicit 构造参数显式值
 * @returns 运行标识
 */
export function resolveRunId(explicit?: string): string {
    if (explicit) return explicit;
    const fromEnv: string | undefined = process.env.BROWSER_RUN_ID;
    if (fromEnv) return fromEnv;
    try {
        if (existsSync(pointerPath)) {
            const parsed: unknown = JSON.parse(readFileSync(pointerPath, "utf8"));
            if (typeof parsed === "object" && parsed !== null && "runId" in parsed) {
                const runId: unknown = (parsed as Record<string, unknown>).runId;
                if (typeof runId === "string" && runId.length > 0) return runId;
            }
        }
    } catch {
        // 中文注释：指针缺失/损坏即回退本地 run-id，不抛错。
    }
    return `local-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Playwright 结果映射为证据 verdict。
 * @param status result.status
 * @param outcome test.outcome()
 * @returns verdict 枚举
 */
export function mapOutcomeToVerdict(status: PlaywrightStatus, outcome: PlaywrightOutcome): EvidenceVerdict {
    if (outcome === "flaky") return "FLAKY";
    if (outcome === "skipped" || status === "skipped") return "SKIPPED";
    if (status === "interrupted") return "BLOCKED";
    if (status === "passed") return "PASS";
    return "FAIL";
}

/**
 * 由测试标题构造 case_id（spec 文件名 + 归一化标题）。
 * v1 下仅用于 legacy 合成 fallback 的目录/标识；真实行一律用 catalog case_id。
 * @param titlePath test.titlePath()（[spec 文件, 用例标题...]）
 * @returns case_id
 */
export function buildCaseId(titlePath: string[]): string {
    const cleaned: string[] = titlePath.map((s) => s.trim()).filter((s) => s.length > 0);
    return cleaned
        .join(" :: ")
        .replace(/\s+/g, "-")
        .slice(0, 160);
}

/**
 * 绝对路径转相对仓库根的 posix 路径（evidence_path 口径）。
 * @param abs 绝对路径
 * @returns 相对路径
 */
function toRepoRel(abs: string): string {
    return relative(repoRoot, abs).split(sep).join("/");
}

/**
 * 取用例的 Playwright project 名（取不到记 unknown，如实记录不伪造）。
 * @param test Playwright 用例
 * @returns project 名
 */
function projectNameOf(test: TestCase): string {
    try {
        const parent: unknown = (test as unknown as Record<string, unknown>)["parent"];
        if (typeof parent === "object" && parent !== null && "project" in parent) {
            const project: unknown = (parent as { project: () => unknown }).project();
            if (typeof project === "object" && project !== null && "name" in project) {
                const name: unknown = (project as Record<string, unknown>)["name"];
                if (typeof name === "string" && name.length > 0) return name;
            }
        }
    } catch {
        // 中文注释：合成调用无 parent，走 unknown。
    }
    return "unknown";
}

/**
 * JSONL reporter：每用例结束追加单条执行结果行（bound 写 summary，无绑定写 BLOCKED）。
 */
export default class JsonlReporter implements Reporter {
    /** 证据根目录。 */
    private readonly resultsRoot: string;
    /** 运行标识（onBegin 时惰性重解析，见方法注释）。 */
    private runId: string;
    /** 是否显式指定 runId（显式则 onBegin 不再重解析）。 */
    private readonly explicitRunId?: string;

    /**
     * 构造 reporter。
     * @param opts 构造参数
     */
    constructor(opts?: JsonlReporterOptions) {
        this.resultsRoot = opts?.resultsRoot ?? process.env.BROWSER_RESULTS_ROOT ?? defaultResultsRoot;
        this.explicitRunId = opts?.runId;
        this.runId = resolveRunId(opts?.runId);
    }

    /**
     * 运行开始：确保 run 目录存在。
     *
     * 构造发生在 globalSetup 之前（指针文件尚不存在），故此处惰性重解析一次：
     * 非显式 runId 时优先采用 globalSetup 写入指针的 runId，保证与 manifest 同目录。
     */
    onBegin(): void {
        if (!this.explicitRunId) {
            this.runId = resolveRunId(undefined);
        }
        mkdirSync(join(this.resultsRoot, this.runId), { recursive: true });
    }

    /**
     * 由 location.file 反查 catalog L3 绑定并组行。
     * @param test Playwright 用例
     * @param verdict 已映射 verdict
     * @param evidencePath 相对证据目录
     * @param durationMs 耗时毫秒
     * @param locFile location.file 绝对路径
     * @returns 待写行数组
     */
    private buildBoundRows(
        test: TestCase,
        verdict: EvidenceVerdict,
        evidencePath: string,
        durationMs: number,
        locFile: string,
    ): Record<string, unknown>[] {
        const specRel: string = toRepoRel(locFile);
        const browser: string = projectNameOf(test);
        let catalog: {
            cases: Map<string, unknown>;
            executables: Map<string, { executable_id: string; layer: string }>;
            executableToCaseIds?: Map<string, string[]>;
        };
        try {
            catalog = loadEvidenceCatalog(repoRoot) as unknown as typeof catalog;
        } catch {
            return [
                {
                    schema_version: 1,
                    kind: "summary",
                    run_id: this.runId,
                    verdict: "BLOCKED",
                    reason: "evidence-catalog-unreadable",
                    spec_path: specRel,
                    browser,
                    evidence_path: evidencePath,
                    duration_ms: durationMs,
                },
            ];
        }
        const execs = findExecutablesForPath(catalog, specRel, "L3") as Array<{
            executable_id: string;
            layer: string;
        }>;
        if (execs.length === 0) {
            // 中文注释：诚实缺口——catalog 暂无对应 case 绑定（如烟雾 spec 尚未登记 L3
            // executable），记 BLOCKED 不伪造 PASS、不编造 case_id。
            return [
                {
                    schema_version: 1,
                    kind: "summary",
                    run_id: this.runId,
                    verdict: "BLOCKED",
                    reason: "no-catalog-binding",
                    spec_path: specRel,
                    browser,
                    evidence_path: evidencePath,
                    duration_ms: durationMs,
                },
            ];
        }
        const rows: Record<string, unknown>[] = [];
        for (const e of execs) {
            rows.push({
                schema_version: 1,
                kind: "summary",
                run_id: this.runId,
                case_ids: getCaseIdsForExecutable(catalog, e.executable_id),
                executable_id: e.executable_id,
                verdict,
                evidence_path: evidencePath,
                duration_ms: durationMs,
                browser,
                spec_path: specRel,
            });
        }
        return rows;
    }

    /**
     * 用例结束：append 一行（或多行）v1 结果。
     * @param test Playwright 用例
     * @param result Playwright 结果
     */
    onTestEnd(test: TestCase, result: TestResult): void {
        const status: PlaywrightStatus = result.status;
        const outcome: PlaywrightOutcome = test.outcome();
        const verdict: EvidenceVerdict = mapOutcomeToVerdict(status, outcome);
        const dirAbs: string = join(this.resultsRoot, this.runId, buildCaseId(test.titlePath()));
        const evidencePath: string = toRepoRel(dirAbs);
        const locFile: unknown = (test as unknown as Record<string, unknown>)["location"] as unknown;
        const locPath: unknown =
            typeof locFile === "object" && locFile !== null ? (locFile as Record<string, unknown>)["file"] : undefined;
        let rows: Record<string, unknown>[];
        if (typeof locPath === "string" && locPath.length > 0) {
            rows = this.buildBoundRows(test, verdict, evidencePath, result.duration, locPath);
        } else {
            // 中文注释：legacy 兼容 fallback——无 location 的合成调用（frozen 的
            // browser-harness 单元测试直调口径）。标记 synthetic，--check 拒收，
            // 仅保证既有用例不断言回归；真实 Playwright 调用恒带 location。
            rows = [
                {
                    schema_version: 1,
                    kind: "summary",
                    synthetic: true,
                    run_id: this.runId,
                    case_id: buildCaseId(test.titlePath()),
                    verdict,
                    duration_ms: result.duration,
                    evidence_path: evidencePath,
                },
            ];
        }
        mkdirSync(join(this.resultsRoot, this.runId), { recursive: true });
        for (const row of rows) {
            let finalRow: Record<string, unknown> = row;
            if (row["synthetic"] !== true) {
                try {
                    const checked = validateRow(row) as { ok: boolean; errors: string[] };
                    if (!checked.ok) {
                        console.error(`[jsonl-reporter] 行校验失败转 BLOCKED: ${checked.errors.join("; ")}`);
                        finalRow = {
                            schema_version: 1,
                            kind: "summary",
                            run_id: this.runId,
                            verdict: "BLOCKED",
                            reason: "evidence-contract-broken",
                            evidence_path: evidencePath,
                            duration_ms: result.duration,
                        };
                    }
                } catch (err) {
                    console.error(`[jsonl-reporter] 行校验异常转 BLOCKED: ${String(err)}`);
                    finalRow = {
                        schema_version: 1,
                        kind: "summary",
                        run_id: this.runId,
                        verdict: "BLOCKED",
                        reason: "evidence-contract-broken",
                        evidence_path: evidencePath,
                        duration_ms: result.duration,
                    };
                }
            }
            appendFileSync(join(this.resultsRoot, this.runId, "results.jsonl"), `${JSON.stringify(finalRow)}\n`);
        }
    }
}
