// case_id: m9-player-retirement-closure
// journey: smoke-baseline
// M9-04 Dead-code / Allowlist Closure & M9 Final Gate（targeted browser closure，4 条，不扩全场景重写）。
// A. cold bookmark：/player → /library → 无旧 Player DOM → library 可用；
// B. restored Work Anchor：直开 /player → /library → Session hydrate → Mini 出现 → open Expanded → sessionId/progress 对齐；
// C. active playback：正在播 → harness 侧真实 App Router client transition /player → redirect /library → sessionId 不变 → transport 不被 route 主动清理 → Expanded 仍可操作；
// D. canonical Work：/library 播放 canonical segment → route nav/reload → canonical asset/session identity 无回归。
// Draft 回归由 integration/unit 层覆盖（Draft ephemeral 不切 canonical），本 spec 不另起 Draft 用例。
// 全程确定性轮询（expect.poll），无长 sleep（否定性短窗除外），retries=0，双 project 串行。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureGuestByApi, ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";
import { transitionToPlayerCompatViaClientRouter } from "../harness/player-compat-transition";

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

test("M9-04/A cold bookmark 经兼容入口落库可用且无旧 UI", async ({ page, harnessEnv, evidence }) => {
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

    await page.goto(`${harnessEnv.appUrl}/player?legacy=1#frag`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");
    expect(page.url()).not.toContain("/player");
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "故事库", level: 1 })).toBeVisible({ timeout: 15000 });
    await expectNoLegacyPlayerUI(page);
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(null);
    await expect(page.getByTestId("mini-now-playing")).toHaveCount(0, { timeout: 15000 });
    recorder.step("cold bookmark 无旧 UI 且 library 可用", { url: page.url() });
});

test("M9-04/B restored Work Anchor 经兼容入口水合对齐可展开", async ({ page, harnessEnv, evidence }) => {
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
        `m9closeB_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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
        title: `终局冷启${runKey}`,
        prompt: `终局冷启提示词${runKey}`,
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
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    await expectNoLegacyPlayerUI(page);
    // Mini 出现 → open Expanded → sessionId/progress 对齐，URL 不变。
    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 30000 }).toBe(1);
    const urlBeforeExpand = page.url();
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBeforeExpand);
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(sessionId);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    recorder.step(" restored 水合对齐可展开", { sessionId, canonicalNext });
});

test("M9-04/C active playback 经兼容入口会话连续可操作", async ({ page, harnessEnv, evidence }) => {
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
        `m9closeC_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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
        title: `终局活跃${runKey}`,
        prompt: `终局活跃提示词${runKey}`,
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
    const beforeAudioUrl = beforeCompat.transport?.audioUrl as string;
    const canonicalNext = beforeCompat.nextParagraphIndex as number;
    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 15000 }).toBe(1);
    const docToken = (await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const token = `m9-close-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        w["__m9CloseDocToken"] = token;
        const audio = document.querySelector("audio");
        if (audio) {
            (audio as unknown as Record<string, unknown>)["__m9CloseMarker"] = "m9-close-owner-v1";
            audio.dataset.compatSurrogate = "active";
        }
        return token;
    })) as string;
    recorder.step("活跃会话建立", { sessionId, canonicalNext });

    beginSessionCount = 0;
    ttsSynthCount = 0;
    await transitionToPlayerCompatViaClientRouter(page, "/player?from=active#keep");
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");
    expect(page.url()).not.toContain("/player");
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    await expectNoLegacyPlayerUI(page);

    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 60000 }).toBe(sessionId);
    await expect
        .poll(
            async () =>
                await page.evaluate(
                    () => (window as unknown as Record<string, unknown>)["__m9CloseDocToken"],
                ),
            { timeout: 15000 },
        )
        .toBe(docToken);
    const afterCompat = await readProbe(page);
    expect(afterCompat.source?.kind).toBe("work");
    expect((afterCompat.source as { workId?: number })?.workId).toBe(work.id);
    expect(afterCompat.nextParagraphIndex).toBe(canonicalNext);
    expect(afterCompat.status).toBe("paused");
    expect(afterCompat.transport?.hasAudioUrl).toBe(true);
    expect(afterCompat.transport?.audioUrl).toBe(beforeAudioUrl);
    expect(afterCompat.audioCount).toBe(1);
    expect(afterCompat.transport?.hasController).toBe(true);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);

    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 30000 }).toBe(1);
    const urlBeforeExpand = page.url();
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBeforeExpand);
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(sessionId);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    recorder.step("活跃会话兼容连续可操作", { sessionId, canonicalNext });
});

test("M9-04/D canonical Work 经路由往返无回归", async ({ page, harnessEnv, evidence }) => {
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
        `m9closeD_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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
    const para = (label: string): string => `${label}山谷中的小溪静静流淌，微风带来远方的花香，小鸟在枝头欢唱，宁静的午后让人心旷神怡。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `终局canonical${runKey}`,
        prompt: `终局canonical提示词${runKey}`,
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
    const firstAudioUrl = (await readProbe(page)).transport?.audioUrl as string;
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
    beginSessionCount = 0;
    ttsSynthCount = 0;
    recorder.step("canonical 首播落点", { sessionId, canonicalNext, firstAudioUrl });

    // route nav 往返：/library → /chat → /library（同一 Session 连续，不重建）。
    await page.goto(`${harnessEnv.appUrl}/chat`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 }).toBe(sessionId);
    await page.goto(`${harnessEnv.appUrl}/library`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 }).toBe(sessionId);
    const afterNav = await readProbe(page);
    expect((afterNav.source as { workId?: number })?.workId).toBe(work.id);
    expect(afterNav.nextParagraphIndex).toBe(canonicalNext);
    // MPA 整页 navigation 重建 document：blob audioUrl 不跨 document 存活为预期（硬刷新丢失播放已知语义）；
    // 此处只锁 canonical 身份连续（sessionId/workId/next 同一，无新增 beginSession/synthesize），不锁 audioUrl 同值。
    // C 已用 client transition 锁 active transport 连续，此处互补覆盖 MPA 路径。
    await expectNoLegacyPlayerUI(page);

    // reload：hydrate 后 canonical 身份对齐，transport 空闲但 session 同一。
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissOnboarding(page);
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 60000 }).toBe(sessionId);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 60000 }).toBe("ready");
    const afterReload = await readProbe(page);
    expect((afterReload.source as { workId?: number })?.workId).toBe(work.id);
    expect(afterReload.nextParagraphIndex).toBe(canonicalNext);
    expect(afterReload.transport?.hasAudioUrl).toBe(false);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    recorder.step("canonical 路由往返无回归", { sessionId, canonicalNext });
});
