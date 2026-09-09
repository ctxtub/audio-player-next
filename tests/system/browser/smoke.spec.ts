import { test, expect } from "@playwright/test";

/**
 * 真实浏览器技术栈 spike 烟雾用例（任务12）。
 *
 * 覆盖矩阵：
 * ① production server（localhost:31111）首屏可达；
 * ② 固定 MP3（本地 mock 上游 localhost:9301）触发浏览器自然 loadedmetadata/ended 真媒体事件；
 * ④ Safari/Chromium autoplay 与手势策略实测记录（只记录、不硬断言 autoplay 允许与否）。
 *
 * 注意：本文件不使用 dispatchEvent 合成媒体事件；ended 必须由浏览器解码播放自然产生。
 */

/** 被测 production server 首屏地址（快照隔离启动；契约端口 31111，见 spike-matrix.md 端口说明）。 */
const APP_URL = process.env.SPIKE_APP_URL ?? "http://localhost:31111/";

/** 本地 mock 上游的固定 MP3 地址（scripts/dev/mock-openai.mjs；契约端口 9301，见端口说明）。 */
const MOCK_MP3_URL = process.env.SPIKE_MOCK_MP3_URL ?? "http://localhost:9301/fixture.mp3";

test("production 首屏 200 可达", async ({ page }) => {
    // 中文注释：首屏响应即矩阵①的浏览器侧断言（curl 断言另见 green.log）。
    const response = await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toBeVisible();
});

test("固定 MP3 自然产生 loadedmetadata/ended 真媒体事件", async ({ page }) => {
    // 中文注释：先打开被测首屏拿到可用页面上下文，再挂载真实 <audio> 元素。
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    const result = await page.evaluate(async (src) => {
        const audio = new Audio();
        audio.src = src;
        audio.preload = "auto";
        // 中文注释：静音播放（headless 下无用户手势时 unmuted 可能被策略拒绝；
        // muted 不影响解码与 ended 触发，unmuted 行为由下一个用例单独实测记录）。
        const loaded = await new Promise<{ duration: number; readyState: number }>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error("loadedmetadata timeout")), 15000);
            audio.addEventListener(
                "loadedmetadata",
                () => {
                    window.clearTimeout(timer);
                    resolve({ duration: audio.duration, readyState: audio.readyState });
                },
                { once: true },
            );
            audio.addEventListener(
                "error",
                () => {
                    window.clearTimeout(timer);
                    reject(new Error("audio element error"));
                },
                { once: true },
            );
        });
        // 中文注释：短静音 MP3（约 1s），静音 play 后等待浏览器自然触发 ended。
        audio.muted = true;
        await audio.play();
        await new Promise<boolean>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error("ended timeout")), 15000);
            audio.addEventListener(
                "ended",
                () => {
                    window.clearTimeout(timer);
                    resolve(true);
                },
                { once: true },
            );
        });
        return { duration: loaded.duration, readyState: loaded.readyState, ended: true };
    }, MOCK_MP3_URL);
    // 中文注释：loadedmetadata 已自然触发（duration 有限正数），ended 已自然触发。
    // 中文注释：打印自然事件实测值，供 spike-matrix.md 摘录。
    console.log(`[media-events] ${JSON.stringify(result)}`);
    expect(result.ended).toBe(true);
    expect(result.readyState).toBeGreaterThanOrEqual(1);
    expect(result.duration).toBeGreaterThan(0);
});

test("autoplay 与手势策略实测记录", async ({ page }) => {
    // 中文注释：本用例只做实测记录；是否允许自动播放如实输出到控制台，不做通过性断言。
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    const measured = await page.evaluate(async (src) => {
        const probe = async (muted: boolean): Promise<string> => {
            const audio = new Audio(src);
            audio.muted = muted;
            try {
                await audio.play();
                audio.pause();
                return "resolved";
            } catch (error) {
                return `rejected:${error instanceof Error ? error.name : String(error)}`;
            }
        };
        return {
            isSecureContext: window.isSecureContext,
            userAgent: window.navigator.userAgent,
            mutedAutoplay: await probe(true),
            unmutedAutoplay: await probe(false),
        };
    }, MOCK_MP3_URL);
    // 中文注释：打印到测试输出，供 spike-matrix.md 逐项摘录。
    console.log(`[autoplay-probe] ${JSON.stringify(measured)}`);
    expect(typeof measured.isSecureContext).toBe("boolean");
});
