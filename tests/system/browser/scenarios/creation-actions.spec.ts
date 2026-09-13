// case_id: expanded-creation-actions
// journey: smoke-baseline
// M7-04-03 Creation Actions Boundary targeted（spec §36.2/§37/§75/M7-P07，Chromium/WebKit 双跑）。
// Draft 打开 Expanded→返回创作与查看正文并存→点击先关后导 /chat→播放继续
// （session/transport/audio 同一性，零自动发送）；Work 面继续创作/返回创作
// 均隐藏且动作区仅查看正文。慢沙箱确定性轮询，无长 sleep。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/** 探针快照（与 PlaybackSessionProbe 对齐，含 storyText 透传）。 */
type ProbeSnapshot = {
    probe?: string;
    sessionId?: string | null;
    source?: { kind: string; workId?: number; messageId?: string } | null;
    status?: string;
    storyText?: string | null;
    title?: string | null;
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

async function readChatCount(page: Page): Promise<number> {
    try {
        return (await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            const chat = (w["__chatMessageCount"] as number | undefined) ?? null;
            if (typeof chat === "number") return chat;
            // 回退：统计聊天流 DOM 气泡数（只读计数，不断言内容）。
            return document.querySelectorAll('[data-testid="chat-message"]').length;
        })) as number;
    } catch {
        return -1;
    }
}

test("Expanded 创作动作边界", async ({ page, harnessEnv, evidence }) => {
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
        `m7creation_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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

    // Draft 会话本地 seed（E2E-only，不建 server Anchor、不触网络）。
    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string => `${label}森林里的小猫勇敢出发寻找魔法宝石，一路上遇到了善良的小兔和机智的小狐狸，大家决定结伴同行互相帮助共同面对未知的挑战。${"内容".repeat(40)}${label}尾`;
    const draftStory = `${para("丙")}\n${para("丁")}`;
    const draftMessageId = `msg_creation_actions_${runKey}`;
    const draftTitle = `草稿故事${runKey}`;
    const seeded = await page.evaluate(
        (input: { messageId: string; title: string; storyText: string }) => {
            const w = window as unknown as Record<
                string,
                {
                    seedDraftTranscript: (i: { messageId: string; title: string; storyText: string }) => ProbeSnapshot;
                }
            >;
            return w["__M5PlaybackProbe"].seedDraftTranscript(input);
        },
        { messageId: draftMessageId, title: draftTitle, storyText: draftStory },
    );
    const draftSessionId = seeded.sessionId as string;
    expect(typeof draftSessionId === "string" && draftSessionId.length > 0).toBe(true);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("paused");
    const baseline = await readProbe(page);
    expect(baseline.source?.kind).toBe("draft");
    expect(baseline.storyText).toBe(draftStory);
    const audioCountBefore = baseline.audioCount as number;
    const chatCountBefore = await readChatCount(page);
    recorder.step("Draft 会话驻留", { draftSessionId, audioCountBefore, chatCountBefore });

    // 打开 Expanded：返回创作与查看正文并存（§37），继续创作隐藏（§36.2）。
    const urlBefore = page.url();
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBefore);
    await expect(page.getByTestId("expanded-actions")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-back-to-creation-button")).toContainText("返回创作", { timeout: 15000 });
    expect(await page.getByTestId("expanded-back-to-creation-button").count()).toBe(1);
    // 与查看正文并存（同容器双按钮，各自独立）。
    await expect(page.getByTestId("expanded-view-transcript-button")).toContainText("查看正文", { timeout: 15000 });
    expect(await page.getByTestId("expanded-view-story-button").count()).toBe(0);
    expect(await page.getByTestId("expanded-continue-creation-button").count()).toBe(0);
    recorder.step("Draft 返回创作与查看正文并存", {});

    // 点击返回创作：先关后导 /chat + 播放继续 + 零自动发送。
    await page.getByTestId("expanded-back-to-creation-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => page.url(), { timeout: 30000 }).toContain("/chat");
    expect(page.url()).toContain("/chat");
    const afterNav = await readProbe(page);
    expect(afterNav.sessionId).toBe(draftSessionId);
    expect(JSON.stringify(afterNav.source)).toBe(JSON.stringify(baseline.source));
    expect(afterNav.status).toBe("paused");
    expect(afterNav.transport?.isPlaying).toBe(false);
    expect(afterNav.transport?.audioUrl).toBe(baseline.transport?.audioUrl ?? null);
    expect(afterNav.audioCount).toBe(audioCountBefore);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    // 零自动发送：聊天流未新增（计数不变；发送面无预填即发）。
    expect(await readChatCount(page)).toBe(chatCountBefore);
    recorder.step("返回创作先关后导播放继续零发送", { url: page.url() });

    // Work 面：继续创作/返回创作均隐藏，动作区仅查看正文（§36.2 fail-closed 回归）。
    const work = await createStoryWorkByPage(page, {
        title: `创作边界Work${runKey}`,
        prompt: `创作边界提示${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
    const afterBegin = (await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { beginWork: (id: number, mode: string) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].beginWork(workId, "resume");
    }, work.id)) as ProbeSnapshot;
    const workSessionId = afterBegin.sessionId as string;
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
    await expect(page.getByTestId("mini-metadata-button")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-actions")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-view-story-button")).toContainText("查看正文", { timeout: 15000 });
    expect(await page.getByTestId("expanded-view-story-button").count()).toBe(1);
    expect(await page.getByTestId("expanded-continue-creation-button").count()).toBe(0);
    expect(await page.getByTestId("expanded-back-to-creation-button").count()).toBe(0);
    expect(await page.getByTestId("expanded-view-transcript-button").count()).toBe(0);
    const workZone = page.getByTestId("expanded-actions");
    expect(await workZone.locator("button").count()).toBe(1);
    expect((await readProbe(page)).sessionId).toBe(workSessionId);
    recorder.step("Work 继续创作隐藏单查看正文", { workId: work.id });
});
