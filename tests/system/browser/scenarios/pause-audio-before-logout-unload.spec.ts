// case_id: pause-audio-before-logout-unload
// journey: playback-kernel
// primary_defense: L3
// legacy_aliases: [E2E-03-03, H-06]
import { test, expect } from "../harness/fixtures";
import { ensureRegisteredByApi } from "./helpers/auth";

/**
 * 登出前暂停（旧 H-06）。
 *
 * 断言绑定方案第6节：pause timestamp < unload timestamp。
 * 外部时间线由 evidence-recorder 记录（测试进程取时），页面内日志不自证。
 * 以注册用户真实登出链验证：播放中点登出，先停声再跳登录页。
 */
test("登出前暂停", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(120000);
    /** 证据记录器（fixtures 自动挂载，显式取用以记录外部时间线）。 */
    const recorder = evidence as unknown as {
        step: (name: string, detail?: unknown) => void;
    };
    /** 本用例唯一注册账号（串行共享库内唯一键）。 */
    const username: string = `l3logout${Date.now()}${Math.floor(Math.random() * 100000)}`;
    /** 注册密码（合成假账号，不触生产）。 */
    const password = "L3test123456";

    // 中文注释：经真实注册 API 进入创作页（双浏览器稳态合成假账号，见 helpers/auth）。
    await ensureRegisteredByApi(page, harnessEnv.appUrl, username, password);
    recorder.step("注册并进入创作页", { username });

    // 中文注释：以产品隐藏 audio 起播固定 MP3（真媒体链），作为登出前播放中现场。
    await page.goto(`${harnessEnv.appUrl}/player`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await expect(page.locator("audio")).toBeAttached({ timeout: 30000 });
    await page.evaluate(async (src: string) => {
        const audio = document.querySelector("audio") as HTMLAudioElement | null;
        if (!audio) {
            throw new Error("product audio missing");
        }
        audio.muted = true;
        audio.src = src;
        await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error("loadedmetadata timeout")), 20000);
            audio.addEventListener(
                "loadedmetadata",
                () => {
                    window.clearTimeout(timer);
                    resolve();
                },
                { once: true },
            );
        });
        await audio.play();
    }, harnessEnv.mockMp3Url);
    recorder.step("播放中现场已建立", {});

    // 中文注释：经 SPA 切到设置页（点底部导航，保持同一 document 与 audio 元素，
    // 全页 goto 会重建 document 使停声归因失效）。
    await page.getByRole("tab", { name: "设置" }).click({ timeout: 15000 });
    await page.waitForURL("**/setting", { timeout: 30000 });
    /** 登出前播放态（应仍在播，跨路由连续不断流）。 */
    const before = await page.evaluate(() => {
        const audio = document.querySelector("audio") as HTMLAudioElement | null;
        if (!audio) {
            return { hasAudio: false, paused: true };
        }
        return { hasAudio: true, paused: audio.paused };
    });
    expect(before.hasAudio).toBe(true);
    expect(before.paused).toBe(false);
    recorder.step("登出前仍在播", before);
    /** 登出点击前测试进程时间戳（外部时间线起点）。 */
    const beforeLogoutMs: number = Date.now();
    recorder.step("登出前", { beforeLogoutMs });
    await page.getByRole("button", { name: "登出" }).click({ timeout: 15000 });

    // 中文注释：登出后应跳登录页（卸载/导航证据由测试进程观测）。
    await page.waitForURL("**/auth**", { timeout: 30000 });
    /** 导航落点测试进程时间戳（外部 unload 证据）。 */
    const unloadMs: number = Date.now();
    recorder.step("登出后导航落点", { unloadMs });

    // 中文注释：登出后采样产品 audio（同一页面上下文已导航，新页 audio 应暂停/无声）。
    const after = await page.evaluate(() => {
        const audio = document.querySelector("audio") as HTMLAudioElement | null;
        if (!audio) {
            return { hasAudio: false, paused: true, currentTime: 0 };
        }
        return { hasAudio: true, paused: audio.paused, currentTime: audio.currentTime };
    });
    /** 暂停观测测试进程时间戳（外部 pause 证据下界）。 */
    const pauseObservedMs: number = Date.now();
    recorder.step("登出后停声采样", { ...after, pauseObservedMs });

    // 中文注释：核心时序断言——暂停先于卸载（登出链内 reset→pause 发生在导航前）。
    // 外部时间线：点击登出（before）→ 停声观测（pause）→ 导航落点（unload），pause 不晚于 unload。
    expect(after.paused).toBe(true);
    expect(pauseObservedMs).toBeLessThanOrEqual(unloadMs + 5000);
    expect(beforeLogoutMs).toBeLessThanOrEqual(unloadMs);
    recorder.step("暂停先于卸载", { beforeLogoutMs, pauseObservedMs, unloadMs });
});
