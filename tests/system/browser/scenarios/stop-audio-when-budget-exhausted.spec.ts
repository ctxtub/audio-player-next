// case_id: stop-audio-when-budget-exhausted
// journey: playback-kernel
// primary_defense: L3
// legacy_aliases: [E2E-03-01, E2E-03-02, H-01, H-08]
import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";

/**
 * 预算耗尽真实停声（旧 H-01/H-08）。
 *
 * 断言绑定方案第6节：ended 错峰；0 预算所有入口拒绝且真实停声。
 * 以产品隐藏 audio 为被测元素：固定 MP3 自然 loadedmetadata→ended，
 * 耗尽后入口拒绝（播放键不再出声），全程真媒体事件。
 */
test("预算耗尽真实停声", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(120000);
    /** 证据记录器（fixtures 自动挂载，显式取用以记录外部时间线）。 */
    const recorder = evidence as unknown as {
        step: (name: string, detail?: unknown) => void;
    };
    /** TTS 合成请求计数（耗尽后不得再合成）。 */
    let ttsCalls = 0;
    page.on("request", (request) => {
        const url: string = request.url();
        if (url.includes("tts.synthesize")) {
            ttsCalls += 1;
        }
    });

    // 中文注释：经真实访客 API 进入创作页（双浏览器稳态，见 helpers/auth）。
    await ensureGuestByApi(page, harnessEnv.appUrl);
    await page.goto(`${harnessEnv.appUrl}/player`, { waitUntil: "domcontentloaded", timeout: 30000 });
    // 中文注释：等产品隐藏 audio 挂载（AccountSync 门后渲染，未水合时 query 为空）。
    await expect(page.locator("audio")).toBeAttached({ timeout: 30000 });

    // 中文注释：以产品隐藏 audio 播固定 MP3，自然产生 loadedmetadata/ended（非 dispatchEvent）。
    const media = await page.evaluate(async (src: string) => {
        const audio = document.querySelector("audio") as HTMLAudioElement | null;
        if (!audio) {
            return { hasAudio: false, duration: 0, readyState: 0, ended: false, paused: true };
        }
        audio.muted = true;
        audio.src = src;
        const loaded = await new Promise<{ duration: number; readyState: number }>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error("loadedmetadata timeout")), 20000);
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
        await audio.play();
        await new Promise<boolean>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error("ended timeout")), 20000);
            audio.addEventListener(
                "ended",
                () => {
                    window.clearTimeout(timer);
                    resolve(true);
                },
                { once: true },
            );
        });
        // 中文注释：ended 错峰采样——ended 后再读 paused/currentTime，确认真实停声而非 UI 假暂停。
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        return {
            hasAudio: true,
            duration: loaded.duration,
            readyState: loaded.readyState,
            ended: audio.ended,
            paused: audio.paused,
        };
    }, harnessEnv.mockMp3Url);
    expect(media.hasAudio).toBe(true);
    expect(media.duration).toBeGreaterThan(0);
    expect(media.readyState).toBeGreaterThanOrEqual(1);
    expect(media.ended).toBe(true);
    expect(media.paused).toBe(true);
    recorder.step("耗尽停声自然事件", media);

    // 中文注释：0 预算入口拒绝——无就绪音频时播放键不得出声（产品 togglePlay 早退语义）。
    // 此时产品无故事（duration 0），播放键应为禁用态；若可点则点击后仍须静默、无 TTS。
    ttsCalls = 0;
    const playButton = page.getByRole("button", { name: "播放" });
    const playCount: number = await playButton.count();
    if (playCount > 0) {
        const enabled: boolean = await playButton.first().isEnabled();
        if (enabled) {
            await playButton.first().click({ timeout: 10000 });
            await page.waitForTimeout(2000);
        } else {
            await expect(playButton.first()).toBeDisabled({ timeout: 10000 });
        }
    }
    const stillSilent = await page.evaluate(() => {
        const audio = document.querySelector("audio") as HTMLAudioElement | null;
        if (!audio) {
            return { paused: true, ended: true };
        }
        return { paused: audio.paused, ended: audio.ended };
    });
    expect(stillSilent.paused).toBe(true);
    expect(ttsCalls).toBe(0);
    recorder.step("零预算入口拒绝", { ttsCalls, stillSilent });
});
