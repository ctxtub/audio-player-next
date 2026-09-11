import { defineConfig, devices } from "@playwright/test";

/** Playwright 自身的临时 attachment/output；结构化证据仍由 harness reporter 按 run-id 写入。 */
const playwrightOutputDir: string = process.env.PLAYWRIGHT_OUTPUT_DIR ?? ".e2e-results/playwright/test-results";

/**
 * 浏览器测试配置（任务13 harness 接管服务管理）。
 *
 * - 服务来源：harness globalSetup/globalTeardown 启停 isolation production
 *   server + 可编程 mock（不用 Playwright 内建 webServer）；
 * - 双 project：chromium + webkit（serial，retries=0，如实记录不重试）；
 * - reporter：line（控制台）+ harness jsonl-reporter（results.jsonl 证据）。
 */
export default defineConfig({
    testDir: ".",
    testMatch: ["scenarios/*.spec.ts"],
    timeout: 120000,
    globalTimeout: 30 * 60 * 1000,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [["line"], ["./harness/jsonl-reporter.ts"]],
    outputDir: playwrightOutputDir,
    globalSetup: "./harness/global-setup.mjs",
    globalTeardown: "./harness/global-teardown.mjs",
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
        {
            name: "webkit",
            use: { ...devices["Desktop Safari"] },
        },
    ],
});
