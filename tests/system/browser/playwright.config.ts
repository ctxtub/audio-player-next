import { defineConfig, devices } from "@playwright/test";

/**
 * 真实浏览器 spike 配置（任务12）。
 *
 * 说明：
 * - 不设 webServer：被测 production server 为快照隔离手动启动
 *  （.e2e-runtime/task12-snapshot，端口 31111），启动命令与耗时见 green.log；
 * - 双 project：chromium + webkit（serial，retries=0，spike 如实记录不重试）；
 * - 固定 MP3 由本地 mock 上游（localhost:9301）提供，见 scripts/dev/mock-openai.mjs。
 */
export default defineConfig({
    testDir: ".",
    testMatch: "smoke.spec.ts",
    timeout: 60000,
    fullyParallel: false,
    retries: 0,
    reporter: [["line"]],
    use: {
        baseURL: "http://localhost:31111",
    },
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
