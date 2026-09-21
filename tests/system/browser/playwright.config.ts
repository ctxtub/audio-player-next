import { defineConfig, devices } from "@playwright/test";

/** Playwright 自身的临时 attachment/output；结构化证据仍由 harness reporter 按 run-id 写入。 */
const playwrightOutputDir: string = process.env.PLAYWRIGHT_OUTPUT_DIR ?? ".e2e-results/playwright/test-results";

/**
 * 浏览器测试配置（任务13 harness 接管服务管理）。
 *
 * - 服务来源：harness globalSetup/globalTeardown 启停 isolation production
 *   server + 可编程 mock（不用 Playwright 内建 webServer）；
 * - 默认交付命令只选 Chromium；WebKit project 仅供明确兼容风险时显式补跑；
 * - reporter：只输出 Playwright 控制台结果，不维护用例编号或 catalog 映射。
 */
export default defineConfig({
    testDir: ".",
    testMatch: ["scenarios/*.spec.ts"],
    timeout: 120000,
    globalTimeout: 30 * 60 * 1000,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [["line"]],
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
