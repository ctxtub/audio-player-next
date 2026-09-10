import { test as base, expect } from "@playwright/test";
import type { BrowserContextOptions, Page, TestInfo } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCaseRecorder } from "./evidence-recorder.mjs";
import { buildCaseId } from "./jsonl-reporter";

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
 * harness test：context 隔离 + evidence 自动记录。
 *
 * - contextOptions：每用例全新空 storageState（不复用登录态/缓存）；
 * - harnessEnv：当次 run 的服务地址；
 * - auto evidence：用例结束按 testInfo 写 manifest（含 browser/version/assertion 占位）。
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
            const recorder = createCaseRecorder({
                runId: harnessEnv.runId,
                caseId,
                specPath: specRel,
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
            recorder.finish({
                verdict: statusToVerdict(testInfo.status),
                browser: testInfo.project.name,
                browserVersion,
                assertions: [
                    {
                        assertion_id: "playwright-expectations",
                        passed: testInfo.status === "passed",
                        detail: `status=${testInfo.status}`,
                    },
                ],
            });
        },
        { auto: true },
    ],
});

export { expect };
