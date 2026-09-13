// case_id: client-route-nav-play-continuity
// journey: playback-kernel
// legacy_aliases: [E2E-03-09]
// M5-10 fixup Scenario A（评审 Blocking 1）：session survives navigation（真实 browser 聚合）。
// Work playback 建立 sessionId=S（含一次真实 TTS 合成 + pause 驻留），跨
// /chat→/library→/setting→back 全程断言：AudioControllerHost 唯一 owner（audio
// 单元素 + 同一元素 marker 存活）、sessionId 仍为 S、source 不变、不重复
// beginSession、不自动重播（无新增 tts.synthesize、同轨道 URL 不变）、不创建
// 第二 audio owner。慢沙箱一律确定性轮询（expect.poll），无长 sleep。
// 身份取注册用户：authed TTS 按 userId 隔离（45/分钟），repeat 多测同 run 同 IP 不共享桶；
// 访客 IP 桶 15/分钟在同 run 多测并发下必超（harness 限流面，非产品语义）。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/** 探针快照（与 PlaybackSessionProbe 对齐，序列化安全子集）。 */
type ProbeSnapshot = {
    probe?: string;
    sessionId?: string | null;
    source?: { kind: string; workId?: number; messageId?: string } | null;
    status?: string;
    continuationMode?: string;
    nextParagraphIndex?: number;
    totalParagraphs?: number;
    transport?: {
        isPlaying?: boolean;
        hasAudioUrl?: boolean;
        audioUrl?: string | null;
        currentTime?: number;
        hasController?: boolean;
    };
    audioCount?: number;
};

/** 读探针快照（未就绪抛错由 poll 重试）。 */
async function readProbe(page: Page): Promise<ProbeSnapshot> {
    return (await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M5PlaybackProbe"] as { snapshot?: () => ProbeSnapshot } | undefined;
        if (!probe || typeof probe.snapshot !== "function") throw new Error("probe-not-ready");
        return probe.snapshot();
    })) as ProbeSnapshot;
}

test("播放会话跨路由导航存活", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(180000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };

    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    /** 导航阶段 beginSession / TTS 计数（URL 子串口径，含 tRPC batch 形态）。 */
    let beginSessionCount = 0;
    let ttsSynthCount = 0;
    page.on("request", (req) => {
        try {
            const url: string = req.url();
            if (url.includes("beginSession")) beginSessionCount += 1;
            if (url.includes("tts.synthesize") || url.includes("synthesize")) {
                // 仅统计 tRPC TTS 合成（排除静态资源误含）。
                if (url.includes("/api/trpc/")) ttsSynthCount += 1;
            }
        } catch {}
    });

    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `m5nav_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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

    // 真实 StoryWork（两段式，每段 >80 字防前向合并，确保 total>=2）。
    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string => `${label}森林里的小猫勇敢出发寻找魔法宝石，一路上遇到了善良的小兔和机智的小狐狸，大家决定结伴同行互相帮助共同面对未知的挑战。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `导航存活${runKey}`,
        prompt: `导航存活提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
    recorder.step("真实作品创建", { workId: work.id });

    // 建立播放会话 S（真实 beginSession + 真实 TTS 合成首段），随即 pause 驻留以消除 1s 固定 MP3 自然 ended 竞态。
    const afterBegin = (await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { beginWork: (id: number, mode: string) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].beginWork(workId, "resume");
    }, work.id)) as ProbeSnapshot;
    expect(typeof afterBegin.sessionId === "string" && (afterBegin.sessionId as string).length > 0).toBe(true);
    const sessionId = afterBegin.sessionId as string;
    recorder.step("会话建立", { sessionId });

    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(0);
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 30000 })
        .toBe(true);
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { pause: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].pause();
    });
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("paused");
    const beforeNav = await readProbe(page);
    expect(beforeNav.sessionId).toBe(sessionId);
    expect(beforeNav.source?.kind).toBe("work");
    expect((beforeNav.source as { workId?: number })?.workId).toBe(work.id);
    expect(beforeNav.audioCount).toBe(1);
    expect(beforeNav.transport?.hasAudioUrl).toBe(true);
    const pausedAudioUrl = beforeNav.transport?.audioUrl as string;
    expect(typeof pausedAudioUrl === "string" && pausedAudioUrl.length > 0).toBe(true);
    recorder.step("首段合成+驻留", {
        status: beforeNav.status,
        next: beforeNav.nextParagraphIndex,
        total: beforeNav.totalParagraphs,
    });

    // AudioControllerHost 同一元素标记（main-navigation 同款 surrogate，跨路由存活即同一 Host）。
    await page.evaluate(() => {
        const audio = document.querySelector("audio");
        if (audio) {
            (audio as unknown as Record<string, unknown>)["__m5NavMarker"] = "m5-nav-survives-v1";
            audio.dataset.hostSurrogate = "active";
        }
    });

    // 导航阶段计数清零（只统计跨路由行为本身）。
    beginSessionCount = 0;
    ttsSynthCount = 0;

    const chatTab = page.getByRole("tab", { name: "创作" });
    const libraryTab = page.getByRole("tab", { name: "故事库" });
    const settingTab = page.getByRole("tab", { name: "设置" });

    // /chat → /library → /setting → back → /library，每步轮询同一 S。
    await expect(libraryTab).toBeVisible({ timeout: 15000 });
    await libraryTab.click({ timeout: 15000 });
    await page.waitForURL("**/library", { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 }).toBe(sessionId);

    await expect(settingTab).toBeVisible({ timeout: 15000 });
    await settingTab.click({ timeout: 15000 });
    await page.waitForURL("**/setting", { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 }).toBe(sessionId);

    await page.goBack();
    await page.waitForURL("**/library", { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 }).toBe(sessionId);

    await expect(chatTab).toBeVisible({ timeout: 15000 });
    await chatTab.click({ timeout: 15000 });
    await page.waitForURL("**/chat", { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 }).toBe(sessionId);

    // 终态聚合断言：唯一 owner + 同 S + 同源 + 同轨道 + 无重建。
    const afterNav = await readProbe(page);
    expect(afterNav.sessionId).toBe(sessionId);
    expect(afterNav.source?.kind).toBe("work");
    expect((afterNav.source as { workId?: number })?.workId).toBe(work.id);
    expect(afterNav.status).toBe("paused");
    expect(afterNav.audioCount).toBe(1);
    expect(afterNav.transport?.hasAudioUrl).toBe(true);
    expect(afterNav.transport?.audioUrl).toBe(pausedAudioUrl);
    expect(afterNav.transport?.hasController).toBe(true);
    const markerAlive = await page.evaluate(() => {
        const audio = document.querySelector("audio");
        if (!audio) return { alive: false, count: document.querySelectorAll("audio").length };
        return {
            alive:
                (audio as unknown as Record<string, unknown>)["__m5NavMarker"] === "m5-nav-survives-v1" &&
                audio.dataset.hostSurrogate === "active",
            count: document.querySelectorAll("audio").length,
        };
    });
    expect(markerAlive.count).toBe(1);
    expect(markerAlive.alive).toBe(true);
    // 不重复 beginSession、不自动重播（导航零合成）。
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("导航存活终态", {
        sessionId,
        audioCount: afterNav.audioCount,
        beginSessionCount,
        ttsSynthCount,
        markerAlive,
    });
});
