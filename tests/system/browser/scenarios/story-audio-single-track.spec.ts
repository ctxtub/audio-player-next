// case_id: story-audio-single-track
// journey: story-library-assets
// M9-C1 T3 StoryAudio 单轨资产 targeted（Chromium+WebKit）。
// 任意正文只暴露一个授权 Asset/总时长/时间轴；任意段落索引共用同一 Asset URL；
// 暂停→恢复不重复 TTS；legacy /api/audio/segments 与 tts.synthesize 为 0。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

type ProbeSnapshot = {
    probe?: string;
    sessionId?: string | null;
    source?: { kind: string; workId?: number; messageId?: string } | null;
    status?: string;
    nextParagraphIndex?: number;
    totalParagraphs?: number;
    transport?: {
        isPlaying?: boolean;
        hasAudioUrl?: boolean;
        audioUrl?: string | null;
        currentTime?: number;
        duration?: number;
    };
};

async function readProbe(page: Page): Promise<ProbeSnapshot> {
    return (await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M5PlaybackProbe"] as { snapshot?: () => ProbeSnapshot } | undefined;
        if (!probe || typeof probe.snapshot !== "function") throw new Error("probe-not-ready");
        return probe.snapshot();
    })) as ProbeSnapshot;
}

test("StoryAudio 单轨资产：一条时间轴 + 复用不重复 TTS", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };

    // 本 spec 独立 context 经 globalThis 开单轨（生产默认仍关闭，fail closed）。
    await page.addInitScript(() => {
        try {
            (window as unknown as Record<string, unknown>).__SINGLE_TRACK_AUDIO_ENABLED = "1";
        } catch {}
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    let legacyTtsCount = 0;
    let ensureAssetCount = 0;
    let segmentBytesCount = 0;
    let assetBytesCount = 0;
    page.on("request", (req) => {
        try {
            const url: string = req.url();
            if (url.includes("/api/trpc/") && url.includes("tts.synthesize")) legacyTtsCount += 1;
            if (
                url.includes("/api/trpc/") &&
                url.includes("storyAudio.ensure") &&
                !url.includes("ensureSegment")
            ) {
                ensureAssetCount += 1;
            }
            if (url.includes("/api/audio/segments/")) segmentBytesCount += 1;
            if (url.includes("/api/audio/assets/")) assetBytesCount += 1;
        } catch {}
    });

    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `t3_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        "SecurePass123!",
    );
    await dismissOnboarding(page);
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });

    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string =>
        `${label}深夜的灯塔下老船长翻开泛黄的航海日志，巨浪与星光交织成未知的航线，勇气与智慧将指引每一次抉择。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `单轨${runKey}`,
        prompt: `单轨提示词${runKey}`,
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
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 60000 })
        .toBe(true);
    const first = await readProbe(page);
    const firstUrl = first.transport?.audioUrl as string;
    expect(typeof firstUrl === "string" && firstUrl.startsWith("/api/audio/assets/")).toBe(true);
    expect(legacyTtsCount).toBe(0);
    expect(segmentBytesCount).toBe(0);
    expect(ensureAssetCount).toBeGreaterThanOrEqual(1);
    expect(assetBytesCount).toBeGreaterThanOrEqual(1);
    recorder.step("首播单轨命中", { audioUrl: firstUrl.slice(0, 48), sessionId });

    // 任意段落索引都指向同一 Asset URL（一个 Work 一条时间轴）。
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(1);
    });
    const second = await readProbe(page);
    expect(second.transport?.audioUrl).toBe(firstUrl);
    recorder.step("段落 1 复用同一 Asset", { audioUrl: second.transport?.audioUrl });

    // 暂停 → 恢复：仍是同一 Asset URL，且不产生 legacy TTS。
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { pause: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].pause();
    });
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { resume: () => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].resume();
    });
    const resumed = await readProbe(page);
    expect(resumed.transport?.audioUrl).toBe(firstUrl);
    expect(legacyTtsCount).toBe(0);
    expect(segmentBytesCount).toBe(0);
    recorder.step("暂停恢复复用同一 Asset", { audioUrl: resumed.transport?.audioUrl });
});
