// case_id: expanded-playback-capabilities-p3a
// journey: smoke-baseline
// M7-02 P3A Playback Capabilities targeted（验收 1-10，Chromium/WebKit 双跑）。
// play→open Expanded→seek/speed/paragraph→Mini 同步：本段 timeline、click/keyboard
// 全 clamp、ARIA slider、七档倍速三同步且不写 Config 不触发 TTS、Work restart 新 UUID、
// 无 Prev/Next、无整篇 timeline。慢沙箱确定性轮询，无长 sleep。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/** 探针快照（与 PlaybackSessionProbe 对齐，含 M7-02 speed/playbackRate）。 */
type ProbeSnapshot = {
    probe?: string;
    sessionId?: string | null;
    source?: { kind: string; workId?: number; messageId?: string } | null;
    status?: string;
    speed?: number;
    continuationMode?: string;
    nextParagraphIndex?: number;
    totalParagraphs?: number;
    transport?: {
        isPlaying?: boolean;
        hasAudioUrl?: boolean;
        audioUrl?: string | null;
        currentTime?: number;
        duration?: number;
        hasController?: boolean;
        playbackRate?: number;
    };
    audioCount?: number;
};

async function readProbe(page: Page): Promise<ProbeSnapshot> {
    return (await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M5PlaybackProbe"] as { snapshot?: () => ProbeSnapshot } | undefined;
        if (!probe || typeof probe.snapshot !== "function") throw new Error("probe-not-ready");
        return probe.snapshot();
    })) as ProbeSnapshot;
}

test("Expanded 播放能力 P3A", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };

    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    let beginSessionCount = 0;
    let ttsSynthCount = 0;
    page.on("request", (req) => {
        try {
            const url: string = req.url();
            if (url.includes("beginSession")) beginSessionCount += 1;
            if (url.includes("tts.synthesize") || url.includes("synthesize")) {
                if (url.includes("/api/trpc/")) ttsSynthCount += 1;
            }
        } catch {}
    });

    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `m7p3a_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        "SecurePass123!",
    );
    await dismissOnboarding(page);
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });
    recorder.step("探针就绪", {});

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${harnessEnv.appUrl}/chat`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("main-chrome")).toBeAttached({ timeout: 15000 });

    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string => `${label}森林里的小猫勇敢出发寻找魔法宝石，一路上遇到了善良的小兔和机智的小狐狸，大家决定结伴同行互相帮助共同面对未知的挑战。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `P3A能力${runKey}`,
        prompt: `P3A提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
    recorder.step("真实作品创建", { workId: work.id });

    const afterBegin = (await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { beginWork: (id: number, mode: string) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].beginWork(workId, "resume");
    }, work.id)) as ProbeSnapshot;
    const sessionId = afterBegin.sessionId as string;
    expect(typeof sessionId === "string" && sessionId.length > 0).toBe(true);
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(0);
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 30000 })
        .toBe(true);
    // 等待真实 duration（固定 1s MP3，headless 下 loadedmetadata 后 >0）。
    await expect
        .poll(async () => (await readProbe(page)).transport?.duration ?? 0, { timeout: 30000 })
        .toBeGreaterThan(0);
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { pause: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].pause();
    });
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("paused");
    const pausedAudioUrl = (await readProbe(page)).transport?.audioUrl as string;
    const pausedDuration = (await readProbe(page)).transport?.duration as number;
    expect(pausedDuration).toBeGreaterThan(0);
    recorder.step("首段合成+驻留", { sessionId, pausedDuration });

    // 打开 Expanded（URL/session 不变）。
    const urlBefore = page.url();
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBefore);
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(sessionId);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("打开 Expanded 不变", {});

    // P3A 元素存在性 + 本段标签 + 无 Prev/Next + 无整篇。
    await expect(page.getByTestId("expanded-timeline")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-timeline-track")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-paragraph-status")).toContainText("第", { timeout: 15000 });
    await expect(page.getByTestId("expanded-timeline-label")).toContainText("本段", { timeout: 15000 });
    await expect(page.getByTestId("expanded-rate-pill")).toContainText("1", { timeout: 15000 });
    await expect(page.getByTestId("expanded-play-button")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-restart-button")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-seek-back")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-seek-forward")).toBeVisible({ timeout: 15000 });
    // 无上一段/下一段（spec §40 拒绝）。
    await expect(page.getByText("上一段")).toHaveCount(0);
    await expect(page.getByText("下一段")).toHaveCount(0);
    // ARIA slider 完整。
    const slider = page.getByTestId("expanded-timeline-track");
    await expect(slider).toHaveAttribute("role", "slider");
    await expect(slider).toHaveAttribute("aria-label", "本段播放进度");
    expect(await slider.getAttribute("aria-valuemin")).toBe("0");
    const maxAttr = await slider.getAttribute("aria-valuemax");
    expect(Number(maxAttr)).toBeGreaterThan(0);
    expect(await slider.getAttribute("aria-valuetext")).toContain("/");
    recorder.step("P3A 元素与无 Prev/Next", { maxAttr });

    // Click seek：75% 处点击，session 不变、无新会话/TTS、时间跳变。
    const trackBox = await slider.boundingBox();
    expect(trackBox).not.toBeNull();
    if (trackBox) {
        beginSessionCount = 0;
        ttsSynthCount = 0;
        const clickX = trackBox.x + trackBox.width * 0.75;
        const clickY = trackBox.y + trackBox.height / 2;
        await page.mouse.click(clickX, clickY);
        await expect
            .poll(async () => (await readProbe(page)).transport?.currentTime ?? -1, { timeout: 15000 })
            .toBeGreaterThan(0);
        const afterClick = await readProbe(page);
        expect(afterClick.sessionId).toBe(sessionId);
        expect(JSON.stringify(afterClick.source)).toBe(JSON.stringify(afterBegin.source));
        expect(beginSessionCount).toBe(0);
        expect(ttsSynthCount).toBe(0);
        // 75% 容差 ±0.6s（1s 音频下 headless seeking 粒度）。
        const expected = (pausedDuration * 0.75);
        expect(Math.abs((afterClick.transport?.currentTime ?? 0) - expected)).toBeLessThan(0.6);
        recorder.step("点击 seek 钳制且 session 不变", { currentTime: afterClick.transport?.currentTime });
    }

    // Keyboard：End→duration、Home→0、ArrowRight clamp、ArrowLeft clamp。
    await slider.focus({ timeout: 15000 });
    await page.keyboard.press("End");
    await expect
        .poll(async () => (await readProbe(page)).transport?.currentTime ?? -1, { timeout: 15000 })
        .toBeGreaterThanOrEqual(Math.floor(pausedDuration) > 0 ? pausedDuration - 0.6 : 0);
    expect((await readProbe(page)).sessionId).toBe(sessionId);
    await page.keyboard.press("Home");
    await expect
        .poll(async () => (await readProbe(page)).transport?.currentTime ?? 999, { timeout: 15000 })
        .toBeLessThan(0.6);
    expect((await readProbe(page)).sessionId).toBe(sessionId);
    // +5s 在 1s 音频下钳制到 duration（验收 2）。
    await page.keyboard.press("ArrowRight");
    await expect
        .poll(async () => (await readProbe(page)).transport?.currentTime ?? -1, { timeout: 15000 })
        .toBeGreaterThanOrEqual(pausedDuration - 0.6);
    expect((await readProbe(page)).sessionId).toBe(sessionId);
    await page.keyboard.press("ArrowLeft");
    await expect
        .poll(async () => (await readProbe(page)).transport?.currentTime ?? 999, { timeout: 15000 })
        .toBeLessThan(0.6);
    expect((await readProbe(page)).sessionId).toBe(sessionId);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("键盘 seek 全 clamp", {});

    // 倍速：1.5x 即时同步 Session+Transport，不写 Config，不触发 TTS。
    ttsSynthCount = 0;
    await page.getByTestId("expanded-rate-pill").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-rate-menu")).toBeVisible({ timeout: 15000 });
    // 七档齐全。
    for (const v of ["0.8", "0.9", "0.95", "1", "1.05", "1.1", "1.5"]) {
        await expect(page.getByTestId(`expanded-rate-option-${v}`)).toBeVisible({ timeout: 15000 });
    }
    await page.getByTestId("expanded-rate-option-1.5").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-rate-pill")).toContainText("1.5x", { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).speed, { timeout: 15000 }).toBe(1.5);
    await expect.poll(async () => (await readProbe(page)).transport?.playbackRate, { timeout: 15000 }).toBe(1.5);
    // <audio> 即时生效。
    await expect
        .poll(
            async () =>
                page.evaluate(() => {
                    const el = document.querySelector("audio") as unknown as { playbackRate?: number } | null;
                    return el?.playbackRate ?? -1;
                }),
            { timeout: 15000 },
        )
        .toBe(1.5);
    expect(ttsSynthCount).toBe(0);
    expect(beginSessionCount).toBe(0);
    expect((await readProbe(page)).sessionId).toBe(sessionId);
    recorder.step("倍速三同步无 TTS", {});

    // 段落 badge：仍为第 1/2 段（seek/speed 不污染 paragraph identity）。
    await expect(page.getByTestId("expanded-paragraph-status")).toContainText("第 1 / 2 段", { timeout: 15000 });
    const probeAfterSpeed = await readProbe(page);
    expect(probeAfterSpeed.nextParagraphIndex).toBe(0);
    expect(probeAfterSpeed.totalParagraphs).toBe(2);
    recorder.step("段落 badge 未污染", {});

    // 从头播放（Work）：新 UUID + position 0，Mini 同步。
    const expandedTitle = await page.getByTestId("expanded-title").innerText();
    ttsSynthCount = 0;
    await page.getByTestId("expanded-restart-button").click({ timeout: 15000 });
    await expect
        .poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 })
        .not.toBe(sessionId);
    const restartedId = (await readProbe(page)).sessionId as string;
    expect(typeof restartedId === "string" && restartedId.length > 0).toBe(true);
    await expect.poll(async () => (await readProbe(page)).nextParagraphIndex, { timeout: 30000 }).toBe(0);
    recorder.step("Work restart 新 UUID", { restartedId });

    // 关闭后 Mini 同步同一 Session。
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 15000 }).toBe(1);
    await expect(page.getByTestId("mini-title")).toContainText(expandedTitle.slice(0, 6), { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(restartedId);
    recorder.step("Mini 同步", {});

    // 【M7-02 fixup 回归 B】焦点掉出 overlay（busy 控件 disabled 后的浏览器行为）：
    // document fallback 必须接管关闭（Blocking 3 收窄后的定向验证）。
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el && typeof el.blur === "function") el.blur();
        (document.body as HTMLElement).focus?.();
    });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    recorder.step("焦点掉 body → Escape 关闭（fallback）", {});

    // 【M7-02 fixup 回归 C】焦点在 nested menu（overlay 内）：fallback 让行，
    // Escape 仍由 RAC 语义关闭面板（不抢先、不重复关闭）。
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("expanded-rate-pill").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-rate-menu")).toBeVisible({ timeout: 15000 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    recorder.step("menu 内 Escape → 关闭（RAC 语义，fallback 让行）", {});
});
