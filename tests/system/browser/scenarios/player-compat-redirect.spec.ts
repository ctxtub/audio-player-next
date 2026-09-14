// case_id: player-compat-redirect
// journey: smoke-baseline
// M9-01 /player Redirect & Compatibility Contract（targeted browser compat spec，4 条）。
// 1. navigate /player（含 query/hash）→ pathname=/library 且旧 Player UI 不出现；
// 2. active Work session 命中 /player → sessionId/source/next 不变 + Mini 可见 + Expanded 可 open；
// 3. cold restored Anchor 直开 /player → redirect + /library hydrate 后对齐（ready + transport 空闲）；
// 4. 无 playback state → 空态不伪造 Session。
// 全程确定性轮询（expect.poll），无长 sleep（否定性短窗除外），retries=0，双 project 串行。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureGuestByApi, ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/** 探针快照（与 PlaybackSessionProbe 对齐子集）。 */
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

/** 旧 Player UI 不出现（AudioPlayer 三地标零计数）。 */
async function expectNoLegacyPlayerUI(page: Page): Promise<void> {
    await expect(page.getByRole("slider", { name: "播放进度" })).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByRole("button", { name: "播放速度" })).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByRole("button", { name: "从头重播" })).toHaveCount(0, { timeout: 15000 });
}

test("M9-01/1 直接导航兼容重定向且旧 UI 不出现", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(120000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });
    await ensureGuestByApi(page, harnessEnv.appUrl);
    await dismissOnboarding(page);
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });

    // 旧 bookmark 形态（含 query/hash，契约要求 query/hash ≠ identity，直接丢弃）。
    await page.goto(`${harnessEnv.appUrl}/player?legacy=1#frag`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");
    expect(page.url()).not.toContain("/player");
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "故事库", level: 1 })).toBeVisible({ timeout: 15000 });
    await expectNoLegacyPlayerUI(page);
    // 无会话时不伪造：sessionId null + Mini 不渲染。
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(null);
    await expect(page.getByTestId("mini-now-playing")).toHaveCount(0, { timeout: 15000 });
    recorder.step("直接导航重定向无旧 UI", { url: page.url() });
});

test("M9-01/2 活跃会话命中兼容入口会话连续可展开", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(180000);
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
            if (url.includes("/api/trpc/") && (url.includes("tts.synthesize") || url.includes("synthesize"))) {
                ttsSynthCount += 1;
            }
        } catch {}
    });

    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `m9act_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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
    const para = (label: string): string => `${label}森林里的小猫勇敢出发寻找魔法宝石，一路上遇到了善良的小兔和机智的小狐狸，大家决定结伴同行互相帮助共同面对未知的挑战。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `兼容活跃${runKey}`,
        prompt: `兼容活跃提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
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
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { saveCheckpointNow: () => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].saveCheckpointNow();
    });
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { pause: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].pause();
    });
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("paused");
    const beforeCompat = await readProbe(page);
    expect(beforeCompat.sessionId).toBe(sessionId);
    const canonicalNext = beforeCompat.nextParagraphIndex as number;
    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 15000 }).toBe(1);
    recorder.step("活跃会话建立", { sessionId, canonicalNext });

    // 应用内命中兼容入口（含旧 query/hash，契约要求直接丢弃、不翻译成 Session）。
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.goto(`${harnessEnv.appUrl}/player?from=active#keep`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");
    expect(page.url()).not.toContain("/player");
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    await expectNoLegacyPlayerUI(page);

    // 会话连续：sessionId/source/next 不变（hydrate 后 status 收敛为 ready/paused 均可，progress 以 next 为准）。
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 60000 }).toBe(sessionId);
    const afterCompat = await readProbe(page);
    expect(afterCompat.source?.kind).toBe("work");
    expect((afterCompat.source as { workId?: number })?.workId).toBe(work.id);
    expect(afterCompat.nextParagraphIndex).toBe(canonicalNext);
    // transport 不因 redirect 主动 clear：单 owner + controller 存活 + 无新增合成/会话。
    expect(afterCompat.audioCount).toBe(1);
    expect(afterCompat.transport?.hasController).toBe(true);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);

    // Mini 可见 + Expanded 可 open（URL 仍为 /library，会话仍同一）。
    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 30000 }).toBe(1);
    const urlBeforeExpand = page.url();
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBeforeExpand);
    expect(page.url()).not.toContain("/player");
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(sessionId);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 15000 }).toBe(1);
    recorder.step("活跃会话兼容连续可展开", { sessionId, canonicalNext });
});

test("M9-01/3 cold 经兼容入口从冻结 Anchor 水合对齐", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(180000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `m9cold_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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
        title: `兼容冷启${runKey}`,
        prompt: `兼容冷启提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
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
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { saveCheckpointNow: () => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].saveCheckpointNow();
    });
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { pause: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].pause();
    });
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("paused");
    const canonicalNext = (await readProbe(page)).nextParagraphIndex as number;
    recorder.step("Anchor 落点", { sessionId, canonicalNext });

    // Cold bookmark：直开 /player → redirect /library，再冷刷新经 hydrate 对齐（不复活旧 Player 页）。
    await page.goto(`${harnessEnv.appUrl}/player`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissOnboarding(page);
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 60000 }).toBe(sessionId);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 60000 }).toBe("ready");
    const afterHydrate = await readProbe(page);
    expect(afterHydrate.source?.kind).toBe("work");
    expect((afterHydrate.source as { workId?: number })?.workId).toBe(work.id);
    expect(afterHydrate.nextParagraphIndex).toBe(canonicalNext);
    expect(afterHydrate.transport?.hasAudioUrl).toBe(false);
    expect(afterHydrate.transport?.audioUrl).toBe(null);
    expect(afterHydrate.transport?.currentTime).toBe(0);
    expect(afterHydrate.transport?.isPlaying).toBe(false);
    expect(afterHydrate.audioCount).toBe(1);
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    await expectNoLegacyPlayerUI(page);
    expect(page.url()).not.toContain("/player");
    recorder.step("冷水合对齐", { sessionId, canonicalNext });
});

test("M9-01/4 无播放态空态不伪造会话", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(120000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });
    await ensureGuestByApi(page, harnessEnv.appUrl);
    await dismissOnboarding(page);
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(null);

    await page.goto(`${harnessEnv.appUrl}/player`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    await expectNoLegacyPlayerUI(page);
    const afterCompat = await readProbe(page);
    expect(afterCompat.sessionId).toBe(null);
    expect(afterCompat.source).toBe(null);
    expect(afterCompat.transport?.hasAudioUrl).toBe(false);
    expect(afterCompat.transport?.isPlaying).toBe(false);
    await expect(page.getByTestId("mini-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    recorder.step("空态不伪造", { url: page.url() });
});
