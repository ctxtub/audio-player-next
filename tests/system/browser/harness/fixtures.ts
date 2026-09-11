import { test as base, expect } from "@playwright/test";
import type { BrowserContextOptions, Page, TestInfo } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { createCaseRecorder } from "./evidence-recorder.mjs";
import { buildCaseId } from "./jsonl-reporter";
import { findExecutablesForPath, getCaseIdsForExecutable, loadEvidenceCatalog } from "../../../../scripts/evidence-schema.mjs";

/**
 * 浏览器用例 fixtures（任务13 harness）。
 *
 * 每用例新 context（fresh storageState/no cache），page fixture 挂 evidence-recorder：
 * 用例结束自动按 testInfo 状态写 manifest（verdict 映射与 reporter 一致）。
 */

/** harness 运行时环境（global-setup 写入指针文件）。 */
export interface HarnessEnv {
    /** 运行标识。 */
    runId: string;
    /** 被测 production server 地址。 */
    appUrl: string;
    /** mock 上游地址。 */
    mockUrl: string;
    /** 固定 MP3 地址。 */
    mockMp3Url: string;
}

/** 用例 fixtures 表。 */
export interface HarnessFixtures {
    /** 当次运行的服务地址。 */
    harnessEnv: HarnessEnv;
    /** 自动证据记录（auto fixture，用例内无需显式使用）。 */
    evidence: unknown;
}

/** 指针文件相对仓库根路径。 */
const pointerRel: string = join(".e2e-runtime", "browser-harness", "active.json");

/**
 * 读 harness 运行时指针（global-setup 写入；缺失即抛错不伪造地址）。
 * @returns 运行环境
 */
export function readHarnessEnv(): HarnessEnv {
    const abs: string = join(process.cwd(), pointerRel);
    if (!existsSync(abs)) {
        throw new Error(`[fixtures] harness 指针缺失：${abs}（global-setup 未运行？）`);
    }
    const parsed: unknown = JSON.parse(readFileSync(abs, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error("[fixtures] harness 指针损坏：非对象");
    }
    const record: Record<string, unknown> = parsed as Record<string, unknown>;
    for (const key of ["runId", "appUrl", "mockUrl", "mockMp3Url"]) {
        if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
            throw new Error(`[fixtures] harness 指针缺字段：${key}`);
        }
    }
    return {
        runId: record["runId"] as string,
        appUrl: record["appUrl"] as string,
        mockUrl: record["mockUrl"] as string,
        mockMp3Url: record["mockMp3Url"] as string,
    };
}

/**
 * testInfo 状态映射为证据 verdict（与 reporter 同口径）。
 * @param status testInfo.status
 * @returns verdict 枚举
 */
function statusToVerdict(status: TestInfo["status"]): "PASS" | "FAIL" | "SKIPPED" | "BLOCKED" {
    if (status === "passed") return "PASS";
    if (status === "skipped") return "SKIPPED";
    if (status === "interrupted") return "BLOCKED";
    return "FAIL";
}

/**
 * catalog 绑定解析结果。
 */
interface SpecBinding {
    /** 主 catalog case_id（首个绑定；无绑定为 null）。 */
    catalogCaseId: string | null;
    /** 命中的 L3 executable（首个；无绑定为 null）。 */
    executableId: string | null;
    /** 全部候选 case_id。 */
    candidateCaseIds: string[];
}

/**
 * 由 spec 相对路径反查 catalog L3 绑定（与 reporter 同一口径）。
 * catalog 不可读/无绑定即返回空绑定（调用方记 BLOCKED，绝不编造）。
 * @param specRelPosix 相对仓库根的 posix 路径
 * @returns 绑定解析结果
 */
function resolveSpecBinding(specRelPosix: string): SpecBinding {
    const empty: SpecBinding = { catalogCaseId: null, executableId: null, candidateCaseIds: [] };
    let catalog: {
        cases: Map<string, unknown>;
        executables: Map<string, { executable_id: string; layer: string }>;
        executableToCaseIds?: Map<string, string[]>;
    };
    try {
        catalog = loadEvidenceCatalog(process.cwd()) as unknown as typeof catalog;
    } catch {
        return empty;
    }
    const execs = findExecutablesForPath(catalog, specRelPosix, "L3") as Array<{
        executable_id: string;
        layer: string;
    }>;
    if (execs.length === 0) return empty;
    const seen: Set<string> = new Set();
    const candidateCaseIds: string[] = [];
    for (const e of execs) {
        for (const cid of getCaseIdsForExecutable(catalog, e.executable_id)) {
            if (!seen.has(cid)) {
                seen.add(cid);
                candidateCaseIds.push(cid);
            }
        }
    }
    if (candidateCaseIds.length === 0) return empty;
    const catalogCaseId: string = candidateCaseIds[0] as string;
    return { catalogCaseId, executableId: execs[0]?.executable_id as string, candidateCaseIds };
}

/**
 * harness test：context 隔离 + evidence 自动记录。
 *
 * - contextOptions：每用例全新空 storageState（不复用登录态/缓存）；
 * - harnessEnv：当次 run 的服务地址；
 * - auto evidence：用例结束按 testInfo 写最小 manifest（含 browser/version，配合 Playwright 原始 attachment）。
 */
export const test = base.extend<HarnessFixtures>({
    // 中文注释：每用例新 context 的隔离选项（fresh storageState/no cache）。
    contextOptions: async ({}, use) => {
        const options: BrowserContextOptions = {
            storageState: { cookies: [], origins: [] },
        };
        await use(options);
    },
    // 中文注释：当次运行服务地址（读指针文件，跨 global-setup 与用例进程）。
    harnessEnv: async ({}, use) => {
        await use(readHarnessEnv());
    },
    // 中文注释：自动证据 fixture（挂 page 取浏览器版本；teardown 按 testInfo 写 manifest）。
    // 中文注释：case 口径——Playwright TestCase.titlePath()[0] 为 project 名（reporter 侧），
    // testInfo.titlePath 不含 project，故此处显式前缀 project 名，保证 manifest 目录与 jsonl 行一致且双 project 不互覆。
    // 中文注释：spec_path 按用例实际文件动态推导（相对仓库根），避免 scenarios 新 spec 仍记 smoke；
    // 隔离库路径按当次 run 的 app-handle 直读并记 step，供断言直查（外部时间线/DB 证据不靠页面内日志自证）。
    evidence: [
        async (
            { page, harnessEnv }: { page: Page; harnessEnv: HarnessEnv },
            use: (value: unknown) => Promise<void>,
            testInfo: TestInfo,
        ) => {
            const caseId: string = `${testInfo.project.name}-::-${buildCaseId(testInfo.titlePath)}`;
            const specAbs: string = (testInfo as unknown as { file?: string }).file ?? "";
            const specRel: string = specAbs.startsWith(`${process.cwd()}/`)
                ? specAbs.slice(process.cwd().length + 1)
                : "tests/system/browser/smoke.spec.ts";
            const specRelPosix: string = specRel.split(sep).join("/");
            // 中文注释：C5——case_id 改用 catalog case_id（与 reporter 同一反查口径）；
            // catalog 暂无绑定（如烟雾 spec 尚未登记 L3 executable）即诚实缺口：
            // manifest 记 BLOCKED(reason=no-catalog-binding)，严禁伪造 PASS 或编造 case_id。
            const binding: SpecBinding = resolveSpecBinding(specRelPosix);
            const recorder = createCaseRecorder({
                runId: harnessEnv.runId,
                caseId,
                specPath: specRel,
                catalogCaseId: binding.catalogCaseId,
                executableId: binding.executableId,
                candidateCaseIds: binding.candidateCaseIds,
                reason: binding.catalogCaseId === null ? "no-catalog-binding" : undefined,
            });
            recorder.step("用例开始", { project: testInfo.project.name, title: testInfo.title });
            try {
                const handlePath: string = join(
                    process.cwd(),
                    ".e2e-runtime",
                    "browser-harness",
                    `app-handle-${harnessEnv.runId}.json`,
                );
                const handleRaw: string = readFileSync(handlePath, "utf8");
                const handleParsed: unknown = JSON.parse(handleRaw);
                const dbFile: unknown = (handleParsed as Record<string, unknown>)["dbFile"];
                if (typeof dbFile === "string" && dbFile.length > 0) {
                    recorder.step("隔离库路径", { dbFile });
                }
            } catch {
                // 中文注释：handle 缺失不阻断用例（用例内按需再读并断言）。
            }
            await use(recorder);
            const browserVersion: string = page.context().browser()?.version() ?? "unknown";
            recorder.step("用例结束", { status: testInfo.status });
            const mappedVerdict = statusToVerdict(testInfo.status);
            const finalVerdict = binding.catalogCaseId === null ? "BLOCKED" : mappedVerdict;
            recorder.finish({
                verdict: finalVerdict,
                browser: testInfo.project.name,
                browserVersion,
            });
        },
        { auto: true },
    ],
});

export { expect };
