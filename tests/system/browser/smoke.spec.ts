import { test, expect } from "./harness/fixtures";
import { ensureGuestByApi } from "./scenarios/helpers/auth";

/**
 * 真实浏览器烟雾用例（harness/environment manual diagnostic；不属于产品 coverage；不进入默认 product L3）。
 *
 * 服务来源：globalSetup 拉起的 isolation production server（harnessEnv.appUrl）
 * 与可编程 mock（harnessEnv.mockMp3Url）；证据由 fixtures 自动记录 manifest。
 *
 * 覆盖矩阵（仅供手动环境探针诊断，无产品 catalog binding）：
 * ① production server 首屏可达；
 * ② 固定 MP3 触发浏览器自然 loadedmetadata/ended 真媒体事件；
 * ④ Safari/Chromium autoplay 与手势策略实测记录（只记录、不硬断言 autoplay 允许与否）。
 *
 * 注意：本文件不使用 dispatchEvent 合成媒体事件；ended 必须由浏览器解码播放自然产生。
 */

test("production 首屏 200 可达", async ({ page, harnessEnv }) => {
    // 中文注释：首屏响应即矩阵①的浏览器侧断言（harness 地址来自 globalSetup 指针）。
    const response = await page.goto(harnessEnv.appUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    expect(response?.status()).toBe(200);
    await expect(page.locator("body")).toBeVisible();
});

test("固定 MP3 自然产生 loadedmetadata/ended 真媒体事件", async ({ page, harnessEnv }) => {
    // 中文注释：先打开被测首屏拿到可用页面上下文，再挂载真实 <audio> 元素。
    await page.goto(harnessEnv.appUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
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
    }, harnessEnv.mockMp3Url);
    // 中文注释：loadedmetadata 已自然触发（duration 有限正数），ended 已自然触发。
    // 中文注释：打印自然事件实测值，供证据摘录。
    console.log(`[media-events] ${JSON.stringify(result)}`);
    expect(result.ended).toBe(true);
    expect(result.readyState).toBeGreaterThanOrEqual(1);
    expect(result.duration).toBeGreaterThan(0);
});

test("autoplay 与手势策略实测记录", async ({ page, harnessEnv }) => {
    // 中文注释：本用例只做实测记录；是否允许自动播放如实输出到控制台，不做通过性断言。
    await page.goto(harnessEnv.appUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
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
    }, harnessEnv.mockMp3Url);
    // 中文注释：打印到测试输出，供证据摘录。
    console.log(`[autoplay-probe] ${JSON.stringify(measured)}`);
    expect(typeof measured.isSecureContext).toBe("boolean");
});

test("/player frozen compatibility boundary 验证 (Legacy Player landmark + 故事库 Tab 选中 + 无 redirect)", async ({ page, harnessEnv }) => {
    // 中文注释：经真实访客 API 写入会话 cookie，避开未认证拦截
    await ensureGuestByApi(page, harnessEnv.appUrl);

    // 中文注释：直接访问 /player
    const response = await page.goto(`${harnessEnv.appUrl}/player`, { waitUntil: "domcontentloaded", timeout: 30000 });
    expect(response?.status()).toBe(200);

    // 中文注释：三项合一 Contract 1 —— URL 保持 /player，无 redirect（严禁 /player -> /library 自动迁移）
    expect(new URL(page.url()).pathname).toBe("/player");

    // 中文注释：三项合一 Contract 2 —— 渲染 Legacy Player 页面（AudioPlayer + HistoryPanel 核心稳定 landmark 可见）
    // 1) AudioPlayer: 播放进度条 slider、倍速按钮、从头重播按钮
    await expect(page.getByRole("slider", { name: "播放进度" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "播放速度" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "从头重播" })).toBeVisible({ timeout: 15000 });
    // 2) HistoryPanel: 历史类型切换 tablist 及两个 tab（提示词历史、生成历史）
    await expect(page.getByRole("tablist", { name: "历史类型切换" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("tab", { name: "提示词历史" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("tab", { name: "生成历史" })).toBeVisible({ timeout: 15000 });

    // 中文注释：三项合一 Contract 3 —— /player 时故事库 Tab 保持 selected (aria-selected="true")
    const libraryTab = page.getByRole("tab", { name: "故事库" });
    await expect(libraryTab).toBeVisible({ timeout: 15000 });
    await expect(libraryTab).toHaveAttribute("aria-selected", "true");

    // 其余主导航 Tab 处于未选中态
    const chatTab = page.getByRole("tab", { name: "创作" });
    await expect(chatTab).toHaveAttribute("aria-selected", "false");
    const settingTab = page.getByRole("tab", { name: "设置" });
    await expect(settingTab).toHaveAttribute("aria-selected", "false");
});
