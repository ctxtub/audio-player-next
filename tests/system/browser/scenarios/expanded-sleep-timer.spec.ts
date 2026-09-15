// case_id: expanded-sleep-timer-p3c
// journey: smoke-baseline
// M7-03 P3C Expanded 睡眠定时 targeted（验收 2/3/5/7/8/9/10，Chromium/WebKit 双跑）。
// 默认 minutes→快捷 off/10/story_end→刷新持久→restart 回默认不继承→Escape 只关菜单。
// 慢沙箱确定性轮询，无长 sleep。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/** 探针快照（与 PlaybackSessionProbe 对齐，含 M7-03 sleepTimerMode/remainingMs）。 */
type ProbeSnapshot = {
    probe?: string;
    sessionId?: string | null;
    source?: { kind: string; workId?: number; messageId?: string } | null;
    status?: string;
    sleepTimerMode?: string;
    transport?: {
        isPlaying?: boolean;
        hasAudioUrl?: boolean;
        currentTime?: number;
        duration?: number;
        hasController?: boolean;
        sleepTimerMode?: string;
        remainingMs?: number | null;
        totalAllowedMs?: number | null;
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

test("Expanded 睡眠定时 P3C", async ({ page, harnessEnv, evidence }) => {
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
        `m7p3c_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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
        title: `P3C定时${runKey}`,
        prompt: `P3C提示词${runKey}`,
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
    // 立即暂停（防 mock 1s 音频播完推进段落，后续 pill/菜单断言偏移）。
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { pause: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].pause();
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 30000 })
        .toBe(true);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("paused");
    // 验收：新 Session 默认 Timer = minutes（默认配置 enabled=true/minutes=30）。
    await expect.poll(async () => (await readProbe(page)).sleepTimerMode, { timeout: 15000 }).toBe("minutes");
    const defaultRemaining = (await readProbe(page)).transport?.remainingMs as number;
    expect(defaultRemaining).toBe(30 * 60000);
    recorder.step("新 Session 默认 minutes", { sessionId, defaultRemaining });

    // 打开 Expanded。
    const urlBefore = page.url();
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBefore);

    // pill 展示 MM:SS 后暂停（§32）。
    await expect(page.getByTestId("expanded-sleep-timer-pill")).toContainText("后暂停", { timeout: 15000 });
    recorder.step("pill 默认展示", {});

    // 菜单选项齐全：关闭/10/20/30/60/自定义/故事结束（Work 显示 story_end）。
    await page.getByTestId("expanded-sleep-timer-pill").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-menu")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-option-off")).toBeVisible({ timeout: 15000 });
    for (const preset of ["10", "20", "30", "60"]) {
        await expect(page.getByTestId(`expanded-sleep-timer-option-${preset}`)).toBeVisible({ timeout: 15000 });
    }
    await expect(page.getByTestId("expanded-sleep-timer-custom-input")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-option-story_end")).toBeVisible({ timeout: 15000 });
    recorder.step("菜单选项齐全", {});

    // Escape 只关菜单不关 Expanded（约束 9 内联形态）。
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("expanded-sleep-timer-menu")).toBeHidden({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    recorder.step("Escape 只关菜单", {});

    // UI 选 10 分钟：mode=minutes/remaining=600000，session 不变、无新 begin/TTS。
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("expanded-sleep-timer-pill").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-menu")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("expanded-sleep-timer-option-10").click({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sleepTimerMode, { timeout: 15000 }).toBe("minutes");
    await expect
        .poll(async () => (await readProbe(page)).transport?.remainingMs, { timeout: 15000 })
        .toBe(10 * 60000);
    expect((await readProbe(page)).sessionId).toBe(sessionId);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    await expect(page.getByTestId("expanded-sleep-timer-pill")).toContainText("10:00 后暂停", { timeout: 15000 });
    recorder.step("UI 选 10 分钟", {});

    // UI 自定义 45 分钟。
    await page.getByTestId("expanded-sleep-timer-pill").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-menu")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("expanded-sleep-timer-custom-input").fill("45");
    await page.getByTestId("expanded-sleep-timer-custom-apply").click({ timeout: 15000 });
    await expect
        .poll(async () => (await readProbe(page)).transport?.remainingMs, { timeout: 15000 })
        .toBe(45 * 60000);
    expect((await readProbe(page)).sessionId).toBe(sessionId);
    recorder.step("UI 自定义 45 分钟", {});

    // UI 选本故事结束后：story_end/null，session 不变。
    await page.getByTestId("expanded-sleep-timer-pill").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-menu")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("expanded-sleep-timer-option-story_end").click({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sleepTimerMode, { timeout: 15000 }).toBe("story_end");
    await expect
        .poll(async () => (await readProbe(page)).transport?.remainingMs, { timeout: 15000 })
        .toBe(null);
    expect((await readProbe(page)).sessionId).toBe(sessionId);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    await expect(page.getByTestId("expanded-sleep-timer-pill")).toContainText("本故事结束后", { timeout: 15000 });
    recorder.step("UI 选 story_end", {});

    // UI 关闭：off/null；刷新后仍 off（持久化验收）。
    await page.getByTestId("expanded-sleep-timer-pill").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-menu")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("expanded-sleep-timer-option-off").click({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sleepTimerMode, { timeout: 15000 }).toBe("off");
    await expect(page.getByTestId("expanded-sleep-timer-pill")).toContainText("关闭", { timeout: 15000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 }).toBe(sessionId);
    await expect.poll(async () => (await readProbe(page)).sleepTimerMode, { timeout: 15000 }).toBe("off");
    await expect
        .poll(async () => (await readProbe(page)).transport?.remainingMs, { timeout: 15000 })
        .toBe(null);
    recorder.step("off 刷新持久", {});

    // restart 新 Session 不继承旧 Timer：回默认 minutes/30min（验收 7）。
    const afterRestart = (await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { beginWork: (id: number, mode: string) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].beginWork(workId, "restart");
    }, work.id)) as ProbeSnapshot;
    expect((afterRestart.sessionId as string) !== sessionId).toBe(true);
    await expect.poll(async () => (await readProbe(page)).sleepTimerMode, { timeout: 15000 }).toBe("minutes");
    await expect
        .poll(async () => (await readProbe(page)).transport?.remainingMs, { timeout: 15000 })
        .toBe(30 * 60000);
    recorder.step("restart 回默认不继承", { sessionId: afterRestart.sessionId });
});
