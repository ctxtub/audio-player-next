// case_id: expanded-work-view-story
// journey: smoke-baseline
// M7-04-01 Work 查看正文导航 targeted（验收 1/2/3/4/6，Chromium/WebKit 双跑）。
// Work 打开 Expanded→查看正文→先关后导→精确 /library/[workId]→播放继续
// （session/transport/audio 同一性，Host 不重挂）；同 Detail 只关不推
// （pushState 计数 0）；它 Detail 照推当前 Work；全程无 fake-id 导航。
// Draft 隐藏面由 L1/L2 覆盖（本用例聚焦 Work 导航；Draft Transcript 归 M7-04-02）。
// 慢沙箱确定性轮询，无长 sleep。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/** 探针快照（与 PlaybackSessionProbe 对齐）。 */
type ProbeSnapshot = {
    probe?: string;
    sessionId?: string | null;
    source?: { kind: string; workId?: number; messageId?: string } | null;
    status?: string;
    transport?: {
        isPlaying?: boolean;
        hasAudioUrl?: boolean;
        audioUrl?: string | null;
        currentTime?: number;
        duration?: number;
        hasController?: boolean;
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

test("Expanded Work 查看正文导航", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    const seenLibraryUrls: string[] = [];

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
        `m7view_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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
    const workA = await createStoryWorkByPage(page, {
        title: `查看正文A${runKey}`,
        prompt: `查看正文提示A${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
    const workB = await createStoryWorkByPage(page, {
        title: `查看正文B${runKey}`,
        prompt: `查看正文提示B${runKey}`,
        storyText: `${para("丙")}\n${para("丁")}`,
    });
    recorder.step("真实作品A/B创建", { workA: workA.id, workB: workB.id });

    const afterBegin = (await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { beginWork: (id: number, mode: string) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].beginWork(workId, "resume");
    }, workA.id)) as ProbeSnapshot;
    const sessionA = afterBegin.sessionId as string;
    expect(typeof sessionA === "string" && sessionA.length > 0).toBe(true);
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(0);
    });
    // 立即暂停（防时序竞速：mock 音频固定 1s，若 pause 跑输段尾，
    // 段落会自然推进，后续 session 同一性断言偏移——沿用 P3A 历史 flaky 修法）。
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { pause: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].pause();
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 30000 })
        .toBe(true);
    await expect
        .poll(async () => (await readProbe(page)).transport?.duration ?? 0, { timeout: 30000 })
        .toBeGreaterThan(0);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("paused");
    const baseline = await readProbe(page);
    const audioUrlBefore = baseline.transport?.audioUrl as string;
    const audioCountBefore = baseline.audioCount as number;
    expect(audioCountBefore).toBeGreaterThan(0);
    recorder.step("首段合成+驻留", { sessionA, audioCountBefore });

    // 打开 Expanded（URL/session 不变），查看正文可见。
    const urlBefore = page.url();
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBefore);
    await expect(page.getByTestId("expanded-actions")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-view-story-button")).toContainText("查看正文", { timeout: 15000 });
    expect(await page.getByTestId("expanded-view-story-button").count()).toBe(1);
    recorder.step("Work 展示查看正文", {});

    // 点击：先关后导→精确 /library/[A]→播放继续（验收 1/2）。
    await page.getByTestId("expanded-view-story-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect
        .poll(async () => page.url(), { timeout: 30000 })
        .toContain(`/library/${workA.id}`);
    expect(page.url()).toContain(`/library/${workA.id}`);
    seenLibraryUrls.push(page.url());
    const afterNav = await readProbe(page);
    expect(afterNav.sessionId).toBe(sessionA);
    expect(JSON.stringify(afterNav.source)).toBe(JSON.stringify(afterBegin.source));
    expect(afterNav.status).toBe("paused");
    expect(afterNav.transport?.isPlaying).toBe(false);
    expect(afterNav.transport?.audioUrl).toBe(audioUrlBefore);
    expect(afterNav.audioCount).toBe(audioCountBefore);
    expect(afterNav.transport?.hasController).toBe(true);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("先关后导精确目标播放继续", { url: page.url() });

    // 同 Detail 只关不推（验收 3）：pushState 计数为 0。
    await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        w["__viewStoryPushCount"] = 0;
        if (!w["__viewStoryPushWrapped"]) {
            w["__viewStoryPushWrapped"] = true;
            const origPush = window.history.pushState.bind(window.history);
            window.history.pushState = (...args: Parameters<typeof window.history.pushState>) => {
                w["__viewStoryPushCount"] = ((w["__viewStoryPushCount"] as number) ?? 0) + 1;
                return origPush(...args);
            };
        }
    });
    await expect(page.getByTestId("mini-metadata-button")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-view-story-button")).toBeVisible({ timeout: 15000 });
    beginSessionCount = 0;
    await page.getByTestId("expanded-view-story-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    expect(page.url()).toContain(`/library/${workA.id}`);
    const samePushCount = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return (w["__viewStoryPushCount"] as number) ?? -1;
    });
    expect(samePushCount).toBe(0);
    expect((await readProbe(page)).sessionId).toBe(sessionA);
    expect(beginSessionCount).toBe(0);
    recorder.step("同 Detail 只关不推", { samePushCount });

    // 它 Detail 照推当前 Work（验收 4）：重载进 /library/[B]，会话经锚点水合回 A。
    await page.goto(`${harnessEnv.appUrl}/library/${workB.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect
        .poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 })
        .toBe(sessionA);
    expect(page.url()).toContain(`/library/${workB.id}`);
    await expect(page.getByTestId("mini-metadata-button")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("expanded-view-story-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect
        .poll(async () => page.url(), { timeout: 30000 })
        .toContain(`/library/${workA.id}`);
    seenLibraryUrls.push(page.url());
    expect((await readProbe(page)).sessionId).toBe(sessionA);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("它 Detail 照推当前 Work", { url: page.url() });

    // 无 fake-id 导航（验收 5 的浏览器侧）：全程 Library 目标皆为真实作品 id。
    for (const seen of seenLibraryUrls) {
        expect(seen).not.toContain("fake");
        expect(seen).not.toContain("undefined");
        expect(seen).not.toContain("null");
        expect(seen).not.toContain("NaN");
    }
    const detailId = page.url().match(/\/library\/(\d+)/)?.[1];
    expect(detailId).toBe(String(workA.id));
    recorder.step("无 fake-id 导航", { seenLibraryUrls });
});
