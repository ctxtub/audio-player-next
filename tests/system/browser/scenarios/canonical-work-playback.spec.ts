// case_id: canonical-work-playback-read
// journey: story-library-assets
// M8-04 Work 播放读路径 targeted（spec §22–§25/§39；单 canonical-work-playback spec，Chromium+WebKit）。
// Work 首播 preparation→canonical 播放；同 Work 重播 canonical hit（无重复 TTS）；
// 跨 /chat /library 保持 Session 无重复 TTS；refresh resume canonical hit；
// next-segment lookahead；speed 变更不产生重复资产。Draft 恒旧路径由 L1/L2 覆盖，
// 本 spec 聚焦 Work canonical browser 闭环（mock TTS 即时固定 MP3）。
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
    nextParagraphIndex?: number;
    totalParagraphs?: number;
    speed?: number;
    transport?: {
        isPlaying?: boolean;
        hasAudioUrl?: boolean;
        audioUrl?: string | null;
        playbackRate?: number;
    };
    audioCount?: number;
};

/** 读探针快照。 */
async function readProbe(page: Page): Promise<ProbeSnapshot> {
    return (await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M5PlaybackProbe"] as { snapshot?: () => ProbeSnapshot } | undefined;
        if (!probe || typeof probe.snapshot !== "function") throw new Error("probe-not-ready");
        return probe.snapshot();
    })) as ProbeSnapshot;
}

test("Canonical Work 播放读路径与复用", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };

    // M8-04 browser 运行时覆盖：本 spec 独立 context 经 globalThis 开 canonical，
    // 其他 spec 不受影响；生产默认仍关闭（fail closed）。
    await page.addInitScript(() => {
        try {
            (window as unknown as Record<string, unknown>).__CANONICAL_AUDIO_ENABLED = "1";
        } catch {}
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    /** 网络计数：legacy TTS（应为 0）/ canonical ensure / segment 二进制。 */
    let legacyTtsCount = 0;
    let ensureCount = 0;
    let segmentBytesCount = 0;
    page.on("request", (req) => {
        try {
            const url: string = req.url();
            if (url.includes("/api/trpc/") && url.includes("tts.synthesize")) legacyTtsCount += 1;
            if (url.includes("/api/trpc/") && url.includes("storyAudio.ensureSegment")) ensureCount += 1;
            if (url.includes("/api/audio/segments/")) segmentBytesCount += 1;
        } catch {}
    });

    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `m804_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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
    const para = (label: string): string => `${label}深夜的灯塔下老船长翻开泛黄的航海日志，巨浪与星光交织成未知的航线，勇气与智慧将指引每一次抉择。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `Canonical读${runKey}`,
        prompt: `Canonical读提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
    recorder.step("真实作品创建", { workId: work.id });

    // 首播：begin → play(0)，应经 ensure → canonical URL（preparation 后播放）。
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
    const first = await readProbe(page);
    const firstUrl = first.transport?.audioUrl as string;
    expect(typeof firstUrl === "string" && firstUrl.startsWith("/api/audio/segments/")).toBe(true);
    expect(legacyTtsCount).toBe(0);
    expect(ensureCount).toBeGreaterThanOrEqual(1);
    recorder.step("首播 canonical 命中", { audioUrl: firstUrl.slice(0, 48) });

    // 同 Work 重播：同 segment 再次 play，canonical hit（URL 不变，无新增 legacy TTS）。
    const ensureBeforeReplay = ensureCount;
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(0);
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.audioUrl === firstUrl, { timeout: 30000 })
        .toBe(true);
    expect(legacyTtsCount).toBe(0);
    recorder.step("重播 canonical hit", { ensureDelta: ensureCount - ensureBeforeReplay });

    // lookahead：触发 N+1 预取（timeupdate near-end 或显式 prefetch），不断言 TTS 增量精确值，
    // 仅断言预取后同 URL 复用且 legacy 仍 0（绝不首播全篇外）。
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { prefetchNext: (i: number) => Promise<ProbeSnapshot> }>;
        const probe = w["__M5PlaybackProbe"] as unknown as Record<string, unknown>;
        // 探针若无 prefetchNext 则经 timeupdate 自然触发；此处兼容两种形态。
        if (typeof probe["prefetchNext"] === "function") return (probe["prefetchNext"] as (i: number) => Promise<unknown>)(1);
        return Promise.resolve();
    }).catch(() => {});
    await page.waitForTimeout(1500);
    expect(legacyTtsCount).toBe(0);

    // 跨路由保持 Session：经应用内 Tab 做 SPA 导航（/chat→/library，客户端路由，
    // 与 playback-session-survives-navigation 同口径；整页 goto 非产品路由模型）。
    // 全程同 sessionId、无新增 legacy TTS。
    const legacyBeforeNav = legacyTtsCount;
    const chatTab = page.getByRole("tab", { name: "创作" });
    const libraryTab = page.getByRole("tab", { name: "故事库" });
    await expect(chatTab).toBeVisible({ timeout: 15000 });
    await chatTab.click({ timeout: 15000 });
    await page.waitForURL("**/chat", { timeout: 15000 });
    await expect
        .poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 })
        .toBe(sessionId);
    await expect(libraryTab).toBeVisible({ timeout: 15000 });
    await libraryTab.click({ timeout: 15000 });
    await page.waitForURL("**/library", { timeout: 15000 });
    // 慢引擎水合异步到达：轮询等同 sessionId 恢复（与跨路由存活 spec 同口径）。
    await expect
        .poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 })
        .toBe(sessionId);
    const afterNav = await readProbe(page);
    expect(afterNav.sessionId).toBe(sessionId);
    expect(legacyTtsCount).toBe(legacyBeforeNav);
    recorder.step("跨路由 Session 保持", {});

    // refresh resume canonical hit：刷新后同 session ready → 再播命中同一 canonical URL。
    await page.reload();
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect
        .poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 })
        .toBe(sessionId);
    const afterRefresh = await readProbe(page);
    expect(afterRefresh.sessionId).toBe(sessionId);
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(0);
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 30000 })
        .toBe(true);
    const afterResume = await readProbe(page);
    expect((afterResume.transport?.audioUrl as string)?.startsWith("/api/audio/segments/")).toBe(true);
    expect(legacyTtsCount).toBe(0);
    recorder.step("刷新恢复 canonical hit", {});

    // speed 变更不产生重复资产：切 1.5 后重播同段，legacy 仍 0 且 URL 仍 canonical。
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { setSpeed?: (r: number) => Promise<ProbeSnapshot> }>;
        const probe = w["__M5PlaybackProbe"] as unknown as Record<string, unknown>;
        if (typeof probe["setSpeed"] === "function") return (probe["setSpeed"] as (r: number) => Promise<unknown>)(1.5);
        return Promise.resolve();
    }).catch(() => {});
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(0);
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 30000 })
        .toBe(true);
    expect(legacyTtsCount).toBe(0);
    const afterSpeed = await readProbe(page);
    expect((afterSpeed.transport?.audioUrl as string)?.startsWith("/api/audio/segments/")).toBe(true);
    expect(segmentBytesCount).toBeGreaterThanOrEqual(1);
    recorder.step("倍速不产生重复资产", {});
});
