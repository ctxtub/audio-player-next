// case_id: m8-production-closure
// journey: story-library-assets
// M8-05-04 Production Closure browser 3 例（spec §22–§25/§39；Chromium+WebKit）。
// ①Work canonical replay：首次 materialize→replay→同 asset 且 legacy TTS 不增加；
// ②Trash 当前播放 + Restore：当前 Session 可继续（同 sessionId）→Restore→no regeneration / same asset；
// ③Guest registration：Guest canonical Work→register→User 继续同一 canonical audio→no copy / no TTS（bytes 相等）。
// 口径：mock TTS 即时固定 MP3；legacy TTS 经 /api/trpc tts.synthesize 请求计数；
// canonical 侧以 ensureSegment 返回的同一 segmentId + 同一 playbackUrl + 字节相等为同一资产证据。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ensureGuestByApi, ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/** 探针快照（与 PlaybackSessionProbe 对齐子集）。 */
type ProbeSnapshot = {
    probe?: string;
    sessionId?: string | null;
    source?: { kind: string; workId?: number; messageId?: string } | null;
    status?: string;
    transport?: {
        isPlaying?: boolean;
        hasAudioUrl?: boolean;
        audioUrl?: string | null;
    };
};

/** ensureSegment 返回（ready 形态子集）。 */
type EnsureReady = {
    status: string;
    segment: { id: string; index: number; playbackUrl?: string };
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

/** 开 canonical 的独立 context（每用例隔离，生产默认仍关闭）。 */
async function enableCanonical(page: Page): Promise<void> {
    await page.addInitScript(() => {
        try {
            (window as unknown as Record<string, unknown>).__CANONICAL_AUDIO_ENABLED = "1";
        } catch {}
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });
}

/** legacy TTS 计数器（应恒 0）+ ensure 计数。 */
function installCounters(page: Page): { legacyTts: () => number; ensure: () => number } {
    let legacyTtsCount = 0;
    let ensureCount = 0;
    page.on("request", (req) => {
        try {
            const url: string = req.url();
            if (url.includes("/api/trpc/") && url.includes("tts.synthesize")) legacyTtsCount += 1;
            if (url.includes("/api/trpc/") && url.includes("storyAudio.ensureSegment")) ensureCount += 1;
        } catch {}
    });
    return { legacyTts: () => legacyTtsCount, ensure: () => ensureCount };
}

/** 页内直调 tRPC mutation（POST batch=1；query 一律走 trpcQuery）。 */
async function trpc<T>(page: Page, path: string, json: unknown): Promise<T> {
    return (await page.evaluate(
        async ({ path, json }: { path: string; json: unknown }) => {
            const res = await fetch(`/api/trpc/${path}?batch=1`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ "0": { json } }),
            });
            if (!res.ok) throw new Error(`trpc ${path} HTTP ${res.status}: ${await res.text()}`);
            const data = await res.json();
            const first = data[0];
            if (first.error) throw new Error(`trpc ${path} error: ${JSON.stringify(first.error)}`);
            return first.result.data.json;
        },
        { path, json },
    )) as T;
}

/** 页内直调 tRPC query（GET batch=1；本服务端禁 POST 到 query，405）。 */
async function trpcQuery<T>(page: Page, path: string, json: unknown): Promise<T> {
    return (await page.evaluate(
        async ({ path, json }: { path: string; json: unknown }) => {
            const input = encodeURIComponent(JSON.stringify({ "0": { json } }));
            const res = await fetch(`/api/trpc/${path}?batch=1&input=${input}`, {
                method: "GET",
                headers: { accept: "application/json" },
            });
            if (!res.ok) throw new Error(`trpc ${path} HTTP ${res.status}: ${await res.text()}`);
            const data = await res.json();
            const first = data[0];
            if (first.error) throw new Error(`trpc ${path} error: ${JSON.stringify(first.error)}`);
            return first.result.data.json;
        },
        { path, json },
    )) as T;
}

/** 轮询 ensureSegment 直到 ready（物化可能先 preparing）。 */
async function ensureReady(
    page: Page,
    workId: number,
    segmentIndex: number,
    sessionId: string,
): Promise<EnsureReady> {
    let last: EnsureReady | null = null;
    await expect
        .poll(
            async () => {
                const res = (await trpc<EnsureReady>(page, "storyAudio.ensureSegment", {
                    workId,
                    segmentIndex,
                    sessionId,
                })) as EnsureReady;
                last = res;
                return res.status;
            },
            { timeout: 60000 },
        )
        .toBe("ready");
    return last as unknown as EnsureReady;
}

/** 取 segment 二进制字节（比较同一资产用）。 */
async function fetchSegmentBytes(page: Page, playbackUrl: string): Promise<number[]> {
    return (await page.evaluate(async (url: string) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`segment HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        return Array.from(new Uint8Array(buf));
    }, playbackUrl)) as number[];
}

function storyPara(label: string): string {
    return `${label}深夜的灯塔下老船长翻开泛黄的航海日志，巨浪与星光交织成未知的航线，勇气与智慧将指引每一次抉择。${"内容".repeat(40)}${label}尾`;
}

async function waitProbe(page: Page): Promise<void> {
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });
}

test("M8 closure：Work canonical replay 不增 TTS", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    await enableCanonical(page);
    const counters = installCounters(page);
    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `m805r_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        "SecurePass123!",
    );
    await dismissOnboarding(page);
    await waitProbe(page);

    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const work = await createStoryWorkByPage(page, {
        title: `ClosureReplay${runKey}`,
        prompt: `ClosureReplay提示词${runKey}`,
        storyText: `${storyPara("甲")}\n${storyPara("乙")}`,
    });
    const sessionId = randomUUID();

    const first = await ensureReady(page, work.id, 0, sessionId);
    expect(first.segment.playbackUrl?.startsWith("/api/audio/segments/")).toBe(true);
    recorder.step("首次 materialize", { segmentId: first.segment.id });

    const second = await ensureReady(page, work.id, 0, sessionId);
    expect(second.segment.id).toBe(first.segment.id);
    expect(second.segment.playbackUrl).toBe(first.segment.playbackUrl);
    expect(counters.legacyTts()).toBe(0);
    recorder.step("replay 同资产无 TTS", { ensureCalls: counters.ensure() });
});

test("M8 closure：Trash 当前播放可继续 + Restore 同资产", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    await enableCanonical(page);
    const counters = installCounters(page);
    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `m805t_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        "SecurePass123!",
    );
    await dismissOnboarding(page);
    await waitProbe(page);

    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const work = await createStoryWorkByPage(page, {
        title: `ClosureTrash${runKey}`,
        prompt: `ClosureTrash提示词${runKey}`,
        storyText: `${storyPara("丙")}\n${storyPara("丁")}`,
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
    const beforeTrash = await readProbe(page);
    const beforeUrl = beforeTrash.transport?.audioUrl as string;
    expect(beforeUrl.startsWith("/api/audio/segments/")).toBe(true);

    await trpc(page, "library.moveToTrash", { id: work.id });
    const afterTrash = await readProbe(page);
    expect(afterTrash.sessionId).toBe(sessionId);
    recorder.step("Trash 后当前 Session 可继续", { sessionId });

    await trpc(page, "library.restore", { id: work.id });
    const afterRestore = await ensureReady(page, work.id, 0, sessionId);
    expect(afterRestore.segment.playbackUrl).toBe(beforeUrl);
    expect(counters.legacyTts()).toBe(0);
    recorder.step("Restore 后同资产无再生", {});
});

test("M8 closure：Guest 注册后继续同一 canonical audio", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    await enableCanonical(page);
    const counters = installCounters(page);
    await ensureGuestByApi(page, harnessEnv.appUrl);
    await waitProbe(page);

    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const title = `ClosureGuest${runKey}`;
    const work = await createStoryWorkByPage(page, {
        title,
        prompt: `ClosureGuest提示词${runKey}`,
        storyText: `${storyPara("戊")}\n${storyPara("己")}`,
    });
    const guestSession = randomUUID();
    const guestReady = await ensureReady(page, work.id, 0, guestSession);
    const guestBytes = await fetchSegmentBytes(page, guestReady.segment.playbackUrl as string);
    expect(guestBytes.length).toBeGreaterThan(0);
    recorder.step("Guest canonical 物化", { bytes: guestBytes.length });

    const username = `m805g_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    await trpc(page, "auth.register", { username, password: "SecurePass123!" });
    const list = (await trpcQuery<{
        items: Array<{ id: number; title: string }>;
    }>(page, "library.list", {})) as { items: Array<{ id: number; title: string }> };
    const migrated = list.items.find((w) => w.title === title);
    expect(migrated).toBeTruthy();

    const userSession = randomUUID();
    const userReady = await ensureReady(page, (migrated as { id: number }).id, 0, userSession);
    const userBytes = await fetchSegmentBytes(page, userReady.segment.playbackUrl as string);
    expect(userBytes).toEqual(guestBytes);
    expect(counters.legacyTts()).toBe(0);
    recorder.step("注册后同一资产无拷贝无 TTS", {});
});
