import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * Playwright 自定义 JSONL reporter（任务13 harness）。
 *
 * suite 结束 append .e2e-results/browser/<run-id>/results.jsonl，
 * 行格式 {run_id, case_id, verdict, duration_ms, evidence_path}，
 * verdict 枚举与 runner 一致（PASS|FAIL|BLOCKED|SKIPPED|FLAKY，方案第14节）。
 *
 * 运行标识来源（优先级从高到低）：构造参数 → 环境变量 BROWSER_RUN_ID →
 * harness 运行时指针文件（global-setup 写入）→ 本地回退 run-id。
 * 本文件运行时零依赖（仅 import type），tooling 可直接实例化断言行格式。
 */

/** Playwright test 状态（result.status）。 */
export type PlaywrightStatus = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";

/** Playwright 用例 outcome（test.outcome()）。 */
export type PlaywrightOutcome = "expected" | "unexpected" | "flaky" | "skipped";

/** 证据 verdict 枚举（方案第14节，与 runner 一致）。 */
export type EvidenceVerdict = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED" | "FLAKY";

/** JSONL 结果行。 */
export interface JsonlResultRow {
    /** 运行标识。 */
    run_id: string;
    /** 用例标识（spec 文件名 + 用例标题）。 */
    case_id: string;
    /** 结论枚举。 */
    verdict: EvidenceVerdict;
    /** 耗时毫秒。 */
    duration_ms: number;
    /** 证据目录（manifest 所在目录）。 */
    evidence_path: string;
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
 * JSONL reporter：每用例结束追加一行。
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
     * 用例结束：append 一行结果。
     * @param test Playwright 用例
     * @param result Playwright 结果
     */
    onTestEnd(test: TestCase, result: TestResult): void {
        const status: PlaywrightStatus = result.status;
        const outcome: PlaywrightOutcome = test.outcome();
        const row: JsonlResultRow = {
            run_id: this.runId,
            case_id: buildCaseId(test.titlePath()),
            verdict: mapOutcomeToVerdict(status, outcome),
            duration_ms: result.duration,
            evidence_path: join(this.resultsRoot, this.runId, buildCaseId(test.titlePath())),
        };
        mkdirSync(join(this.resultsRoot, this.runId), { recursive: true });
        appendFileSync(join(this.resultsRoot, this.runId, "results.jsonl"), `${JSON.stringify(row)}\n`);
    }
}
