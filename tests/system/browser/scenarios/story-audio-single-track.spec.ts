// case_id: story-audio-single-track
// journey: story-library-assets
// M9-C1 T3 StoryAudio 单轨资产 targeted（Chromium+WebKit）。
// 任意正文只暴露一个授权 Asset/总时长/时间轴；任意段落索引共用同一 Asset URL；
// 卡片 / Mini / Expanded 共用同一 `<audio>` 时间轴；暂停→恢复不重复 TTS；
// 整轨 ended 才切下一 Work（无就绪 next 时按单轨语义整 Work 完播）。
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
    title?: string | null;
    storyText?: string | null;
    nextParagraphIndex?: number;
    totalParagraphs?: number;
    audioCount?: number;
    transport?: {
        isPlaying?: boolean;
        hasAudioUrl?: boolean;
        audioUrl?: string | null;
        currentTime?: number;
        duration?: number;
    };
};

type M9Snapshot = {
    probe?: string;
    status?: string;
    epoch?: number;
    hasPreparedNextWork?: boolean;
};

async function readProbe(page: Page): Promise<ProbeSnapshot> {
    return (await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M5PlaybackProbe"] as { snapshot?: () => ProbeSnapshot } | undefined;
        if (!probe || typeof probe.snapshot !== "function") throw new Error("probe-not-ready");
        return probe.snapshot();
    })) as ProbeSnapshot;
}

async function m9Call<T>(page: Page, method: string, args: unknown[] = []): Promise<T> {
    return page.evaluate(
        (input: { method: string; args: unknown[] }) => {
            const w = window as unknown as Record<string, unknown>;
            const probe = w["__M9ContinuousCreationProbe"] as
                | Record<string, (...a: unknown[]) => unknown>
                | undefined;
            if (!probe) throw new Error("m9-probe-not-ready");
            return probe[input.method](...input.args);
        },
        { method, args },
    ) as Promise<T>;
}

/** 与 components/NowPlaying/PlaybackTimeline 的 formatSegmentTime 同口径（m:ss）。 */
function formatSegmentTime(seconds: number): string {
    const safe = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const minutes = Math.floor(safe / 60);
    const secs = Math.floor(safe % 60);
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

type Counters = {
    legacyTts: number;
    ensureAsset: number;
    segmentBytes: number;
    assetBytes: number;
    saveProgress: number;
};

function attachCounters(page: Page): Counters {
    const counters: Counters = {
        legacyTts: 0,
        ensureAsset: 0,
        segmentBytes: 0,
        assetBytes: 0,
        saveProgress: 0,
    };
    page.on("request", (req) => {
        try {
            const url: string = req.url();
            if (url.includes("/api/trpc/") && url.includes("tts.synthesize")) counters.legacyTts += 1;
            if (
                url.includes("/api/trpc/") &&
                url.includes("storyAudio.ensure") &&
                !url.includes("ensureSegment")
            ) {
                counters.ensureAsset += 1;
            }
            if (url.includes("storyAudio.saveProgress")) counters.saveProgress += 1;
            if (url.includes("/api/audio/segments/")) counters.segmentBytes += 1;
            if (url.includes("/api/audio/assets/")) counters.assetBytes += 1;
        } catch {}
    });
    return counters;
}

async function waitForProbes(page: Page): Promise<void> {
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });
}

/**
 * 就绪下一个作品的 e2e 种子：reset → deferred schedule（fire-and-forget）→ resolve。
 * 必须与 continuous-creation-auto-next 同口径：等待 generating_next 后再 resolve，
 * 绝不 await 未决的 deferred schedule（会与 resolve 互锁）。
 */
async function seedPreparedNextWork(
    page: Page,
    epoch: number,
    next: { messageId: string; audioUrl: string; content: string },
): Promise<void> {
    await m9Call(page, "resetForNewCreation", [
        { budgetMs: 60000, collectionId: "e2e-t3-single", epoch },
    ]);
    await page.evaluate((e: number) => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M9ContinuousCreationProbe"] as
            | { scheduleNextWork: (input: { epoch: number; remainingTrackMs: number }) => Promise<unknown> }
            | undefined;
        if (!probe) throw new Error("m9-probe-not-ready");
        void probe.scheduleNextWork({ epoch: e, remainingTrackMs: 1000 });
    }, epoch);
    await expect
        .poll(async () => (await m9Call<M9Snapshot>(page, "snapshot")).status, { timeout: 15000 })
        .toBe("generating_next");
    await m9Call(page, "resolveNextWork", [next]);
    await expect
        .poll(async () => (await m9Call<M9Snapshot>(page, "snapshot")).hasPreparedNextWork === true, {
            timeout: 15000,
        })
        .toBe(true);
}

test("StoryAudio 单轨资产：一条时间轴 + 卡片/Mini/Expanded 同源 + 整轨 ended 完播", async ({
    page,
    harnessEnv,
    evidence,
}) => {
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

    const counters = attachCounters(page);

    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `t3_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        "SecurePass123!",
    );
    await dismissOnboarding(page);
    await waitForProbes(page);
    // 关闭连续创作，隔离「整轨 ended → 整 Work 完播」语义（无就绪 next 不应被自动续写顶替）。
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M9ContinuousCreationProbe"]),
        null,
        { timeout: 30000 },
    );
    await m9Call(page, "disable");

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
    expect(counters.legacyTts).toBe(0);
    expect(counters.segmentBytes).toBe(0);
    expect(counters.ensureAsset).toBeGreaterThanOrEqual(1);
    expect(counters.assetBytes).toBeGreaterThanOrEqual(1);
    // 整轨 ended 之前不得出现「整 Work 完播/切下一 Work」。
    expect(first.status).not.toBe("ended");
    expect(Number(first.nextParagraphIndex ?? 0)).toBeLessThan(Number(first.totalParagraphs ?? 0));
    recorder.step("首播单轨命中（未 ended）", { audioUrl: firstUrl.slice(0, 48), sessionId });

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
    expect(counters.legacyTts).toBe(0);
    expect(counters.segmentBytes).toBe(0);

    // 任意段落索引都指向同一 Asset URL（一个 Work 一条时间轴）。
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(1);
    });
    const second = await readProbe(page);
    expect(second.transport?.audioUrl).toBe(firstUrl);
    recorder.step("段落 1 复用同一 Asset", { audioUrl: second.transport?.audioUrl });

    // 列表表面（M9-C1 T4：/library 顶层恒为 Collection 卡片，不再有 Work 直链；
    // 本步 oracle 仍是 probe 会话快照——SPA 导航后全局唯一 `<audio>` 时间轴仍绑定同一 Asset。
    // 就绪门改为 library-page 本体 + 集合列表哨兵）。
    await page.getByRole("tab", { name: "故事库" }).click({ timeout: 15000 });
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 20000 });
    const onLibrarySnapshot = await readProbe(page);
    recorder.step("列表表面会话快照", {
        source: onLibrarySnapshot.source,
        status: onLibrarySnapshot.status,
        audioUrl: onLibrarySnapshot.transport?.audioUrl,
        audioCount: onLibrarySnapshot.audioCount,
    });
    expect(onLibrarySnapshot.source?.kind).toBe("work");
    expect(onLibrarySnapshot.source?.workId).toBe(work.id);
    expect(onLibrarySnapshot.transport?.audioUrl).toBe(firstUrl);
    expect(onLibrarySnapshot.audioCount).toBe(1);
    recorder.step("列表表面同源", { workId: work.id });

    // Mini → Expanded：同一 transport 时间轴，Expanded 时长 == 整轨时长。
    await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-timeline")).toBeVisible({ timeout: 15000 });
    const expandedSnapshot = await readProbe(page);
    expect(expandedSnapshot.source?.workId).toBe(work.id);
    expect(expandedSnapshot.transport?.audioUrl).toBe(firstUrl);
    const expectedDuration = formatSegmentTime(Number(expandedSnapshot.transport?.duration ?? 0));
    await expect(page.getByTestId("expanded-timeline-duration")).toHaveText(expectedDuration);
    recorder.step("Mini/Expanded 同源", { duration: expectedDuration });

    // 整轨自然播完（真实 ended）→ 无就绪 next 时按单轨语义整 Work 完播。
    await expect
        .poll(async () => (await readProbe(page)).status === "ended", { timeout: 60000 })
        .toBe(true);
    const ended = await readProbe(page);
    expect(ended.nextParagraphIndex).toBe(ended.totalParagraphs);
    expect(counters.legacyTts).toBe(0);
    expect(counters.segmentBytes).toBe(0);
    recorder.step("整轨 ended 完播", {
        nextParagraphIndex: ended.nextParagraphIndex,
        totalParagraphs: ended.totalParagraphs,
    });
});

test("StoryAudio 单轨：整轨 ended 才切下一 Work（有就绪 next 时切换）", async ({
    page,
    harnessEnv,
    evidence,
}) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };

    await page.addInitScript(() => {
        try {
            (window as unknown as Record<string, unknown>).__SINGLE_TRACK_AUDIO_ENABLED = "1";
        } catch {}
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    const counters = attachCounters(page);
    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `t3next_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        "SecurePass123!",
    );
    await dismissOnboarding(page);
    await waitForProbes(page);

    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string =>
        `${label}深夜的灯塔下老船长翻开泛黄的航海日志，巨浪与星光交织成未知的航线，勇气与智慧将指引每一次抉择。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `单轨切换${runKey}`,
        prompt: `单轨切换提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });

    await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { beginWork: (id: number, mode: string) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].beginWork(workId, "resume");
    }, work.id);
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(0);
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 60000 })
        .toBe(true);
    const assetUrl = (await readProbe(page)).transport?.audioUrl as string;
    expect(assetUrl.startsWith("/api/audio/assets/")).toBe(true);

    // 暂停后种子就绪下一作品（避免 near-end 调度竞态），再恢复整轨播放。
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { pause: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].pause();
    });
    const nextUrl = `blob:e2e-t3-next-${runKey}`;
    const nextEpoch = 900000 + (Date.now() % 100000);
    await seedPreparedNextWork(page, nextEpoch, {
        messageId: `e2e-t3-next-${runKey}`,
        audioUrl: nextUrl,
        content: "E2E 下一作品",
    });
    // 整轨尚未 ended：绝不提前切下一 Work。
    expect((await readProbe(page)).transport?.audioUrl).toBe(assetUrl);
    expect((await readProbe(page)).status).not.toBe("ended");
    recorder.step("就绪 next 但未切换", { assetUrl: assetUrl.slice(0, 48) });

    await page.evaluate(() => {
        const w = window as unknown as Record<string, { resume: () => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].resume();
    });

    // 整轨 ended 后：消费就绪 next 并切换播放。
    await expect
        .poll(async () => (await readProbe(page)).transport?.audioUrl === nextUrl, { timeout: 60000 })
        .toBe(true);
    await expect
        .poll(async () => (await m9Call<M9Snapshot>(page, "snapshot")).hasPreparedNextWork === false, {
            timeout: 15000,
        })
        .toBe(true);
    expect(counters.legacyTts).toBe(0);
    expect(counters.segmentBytes).toBe(0);
    recorder.step("整轨 ended 切换下一 Work", { nextUrl });
});

test("StoryAudio 单轨关闭：legacy 逐段推进（对照，不成立单轨完播）", async ({
    page,
    harnessEnv,
}) => {
    test.setTimeout(240000);

    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    const counters = attachCounters(page);
    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `t3off_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        "SecurePass123!",
    );
    await dismissOnboarding(page);
    await waitForProbes(page);

    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string =>
        `${label}深夜的灯塔下老船长翻开泛黄的航海日志，巨浪与星光交织成未知的航线，勇气与智慧将指引每一次抉择。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `单轨关闭${runKey}`,
        prompt: `单轨关闭提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });

    await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { beginWork: (id: number, mode: string) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].beginWork(workId, "resume");
    }, work.id);
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(0);
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 60000 })
        .toBe(true);
    const firstUrl = (await readProbe(page)).transport?.audioUrl as string;
    expect(firstUrl.startsWith("/api/audio/assets/")).toBe(false);
    expect(counters.legacyTts).toBeGreaterThanOrEqual(1);

    // legacy：首段 ended 只推进一段（nextIndex=1），不是整 Work 完播。
    await expect
        .poll(async () => Number((await readProbe(page)).nextParagraphIndex ?? -1) === 1, {
            timeout: 60000,
        })
        .toBe(true);
    const advanced = await readProbe(page);
    expect(advanced.status).not.toBe("ended");
    expect(advanced.nextParagraphIndex).toBeLessThan(advanced.totalParagraphs ?? 0);
});

test("StoryAudio 单轨：页面隐藏/离开强制落库 positionMs", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };

    await page.addInitScript(() => {
        try {
            (window as unknown as Record<string, unknown>).__SINGLE_TRACK_AUDIO_ENABLED = "1";
        } catch {}
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    const counters = attachCounters(page);
    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `t3hide_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        "SecurePass123!",
    );
    await dismissOnboarding(page);
    await waitForProbes(page);

    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string =>
        `${label}深夜的灯塔下老船长翻开泛黄的航海日志，巨浪与星光交织成未知的航线，勇气与智慧将指引每一次抉择。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `单轨隐藏${runKey}`,
        prompt: `单轨隐藏提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });

    await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { beginWork: (id: number, mode: string) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].beginWork(workId, "resume");
    }, work.id);
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(0);
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 60000 })
        .toBe(true);
    await expect
        .poll(async () => (await readProbe(page)).transport?.duration ?? 0, { timeout: 60000 })
        .toBeGreaterThan(0);

    // 暂停：排除 timeupdate 非强制落库干扰；随后清空计数。
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { pause: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].pause();
    });
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("paused");
    await page.waitForTimeout(800);
    counters.saveProgress = 0;

    // 页面隐藏 / 离开：真实 DOM 事件路径，必须触发 force 落库。
    await page.evaluate(() => {
        try {
            Object.defineProperty(document, "hidden", { value: true, configurable: true });
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(new Event("pagehide"));
        } catch {}
    });
    await expect
        .poll(() => counters.saveProgress, { timeout: 15000 })
        .toBeGreaterThanOrEqual(1);
    recorder.step("页面隐藏强制落库", { saveProgress: counters.saveProgress });
});
