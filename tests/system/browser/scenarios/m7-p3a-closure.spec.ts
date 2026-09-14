// case_id: m7-p3a-closure
// journey: smoke-baseline
// M7-04-04 P3A 聚合 closure（spec §52/M7-P3A，Chromium/WebKit 双跑，--repeat-each=2）。
// Work：Mini→Expanded→timeline→Play/Pause→seek→rate→SleepTimerUI→restart可达→查看正文→/library/[workId]；
// Draft：Mini→Expanded→查看正文→Transcript→返回controls→返回创作→/chat零发送；
// 全局：普通路由≠关、关→Mini、clear/idle自动关、390 Sheet/900 Panel、同Session连续；全程不经/player。
// Timer到期/speed去重/restart失败不重穷举（targeted已锁）。慢沙箱确定性轮询，无长sleep。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/** 探针快照（与 PlaybackSessionProbe 对齐子集，含 M7-02/03/04 透传）。 */
type ProbeSnapshot = {
    probe?: string;
    sessionId?: string | null;
    source?: { kind: string; workId?: number; messageId?: string } | null;
    status?: string;
    storyText?: string | null;
    speed?: number;
    sleepTimerMode?: string;
    nextParagraphIndex?: number;
    totalParagraphs?: number;
    transport?: {
        isPlaying?: boolean;
        hasAudioUrl?: boolean;
        audioUrl?: string | null;
        currentTime?: number;
        duration?: number;
        hasController?: boolean;
        playbackRate?: number;
        remainingMs?: number | null;
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
            return document.querySelectorAll('[data-testid="chat-message"]').length;
        })) as number;
    } catch {
        return -1;
    }
}

test("M7 P3A 聚合收官与生产切流", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    const visitedUrls: string[] = [];
    page.on("framenavigated", (frame) => {
        try {
            if (frame === page.mainFrame()) visitedUrls.push(page.url());
        } catch {}
    });

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

    const assertNoPlayer = (where: string): void => {
        expect(page.url(), `${where} 不得进 /player`).not.toContain("/player");
        for (const u of visitedUrls) {
            expect(u, `${where} 全程不经 /player`).not.toContain("/player");
        }
    };

    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `m7closure_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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
    visitedUrls.push(page.url());
    assertNoPlayer("基线");

    // Work 会话建立并暂停驻留。
    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string => `${label}森林里的小猫勇敢出发寻找魔法宝石，一路上遇到了善良的小兔和机智的小狐狸，大家决定结伴同行互相帮助共同面对未知的挑战。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `聚合收官${runKey}`,
        prompt: `聚合提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
    recorder.step("真实作品创建", { workId: work.id });

    const afterBegin = (await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { beginWork: (id: number, mode: string) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].beginWork(workId, "resume");
    }, work.id)) as ProbeSnapshot;
    let workSession = afterBegin.sessionId as string;
    expect(typeof workSession === "string" && workSession.length > 0).toBe(true);
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { playParagraph: (i: number) => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].playParagraph(0);
    });
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
    const workDuration = (await readProbe(page)).transport?.duration as number;
    expect(workDuration).toBeGreaterThan(0);
    recorder.step("Work 首段合成+驻留", { workSession, workDuration });

    // Work：Mini → Expanded（URL/session 不变），P3A 元素存在。
    const urlBeforeWork = page.url();
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBeforeWork);
    assertNoPlayer("Work 打开");
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(workSession);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    await expect(page.getByTestId("expanded-timeline")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-timeline-track")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-timeline-label")).toContainText("本段", { timeout: 15000 });
    await expect(page.getByTestId("expanded-paragraph-status")).toContainText("第", { timeout: 15000 });
    await expect(page.getByTestId("expanded-play-button")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-restart-button")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-rate-pill")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-pill")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-view-story-button")).toContainText("查看正文", { timeout: 15000 });
    expect(await page.getByTestId("expanded-view-transcript-button").count()).toBe(0);
    expect(await page.getByTestId("expanded-back-to-creation-button").count()).toBe(0);
    expect(await page.getByTestId("expanded-continue-creation-button").count()).toBe(0);
    expect(await page.getByText("上一段").count()).toBe(0);
    expect(await page.getByText("下一段").count()).toBe(0);
    recorder.step("Work 打开元素齐全", {});

    // Work：Play/Pause 各一次（session 不变；1s mock 音频播放中可能自然推进并预取下段，
    // TTS 计数不做零断言——同一性以 sessionId + 无新增 beginSession 为准，targeted 已锁 play 语义）。
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("expanded-play-button").click({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe("playing");
    expect((await readProbe(page)).sessionId).toBe(workSession);
    await page.getByTestId("expanded-play-button").click({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe("paused");
    expect((await readProbe(page)).sessionId).toBe(workSession);
    expect(beginSessionCount).toBe(0);
    recorder.step("Work Play/Pause 同一性", {});

    // Work：键盘 seek（End→Home，全 clamp，session 不变）。
    beginSessionCount = 0;
    ttsSynthCount = 0;
    const slider = page.getByTestId("expanded-timeline-track");
    await slider.focus({ timeout: 15000 });
    await page.keyboard.press("End");
    await expect
        .poll(async () => (await readProbe(page)).transport?.currentTime ?? -1, { timeout: 15000 })
        .toBeGreaterThanOrEqual(workDuration - 0.6);
    expect((await readProbe(page)).sessionId).toBe(workSession);
    await page.keyboard.press("Home");
    await expect
        .poll(async () => (await readProbe(page)).transport?.currentTime ?? 999, { timeout: 15000 })
        .toBeLessThan(0.6);
    expect((await readProbe(page)).sessionId).toBe(workSession);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("Work seek 同一性", {});

    // Work：倍速 1.5x（三同步，不写默认，不触发 TTS）。
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("expanded-rate-pill").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-rate-menu")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("expanded-rate-option-1.5").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-rate-pill")).toContainText("1.5x", { timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).speed, { timeout: 15000 }).toBe(1.5);
    await expect.poll(async () => (await readProbe(page)).transport?.playbackRate, { timeout: 15000 }).toBe(1.5);
    expect((await readProbe(page)).sessionId).toBe(workSession);
    expect(ttsSynthCount).toBe(0);
    expect(beginSessionCount).toBe(0);
    recorder.step("Work 倍速三同步", {});

    // Work：Sleep Timer UI 可达（pill+菜单齐全，Escape 只关菜单）。
    await expect(page.getByTestId("expanded-sleep-timer-pill")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("expanded-sleep-timer-pill").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-menu")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-option-off")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-option-10")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-sleep-timer-option-story_end")).toBeVisible({ timeout: 15000 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("expanded-sleep-timer-menu")).toBeHidden({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect((await readProbe(page)).sessionId).toBe(workSession);
    recorder.step("Work SleepTimer UI 可达", {});

    // Work：restart 可达（新 UUID，位置回 0）。
    await page.getByTestId("expanded-restart-button").click({ timeout: 15000 });
    await expect
        .poll(async () => (await readProbe(page)).sessionId, { timeout: 30000 })
        .not.toBe(workSession);
    workSession = (await readProbe(page)).sessionId as string;
    expect(typeof workSession === "string" && workSession.length > 0).toBe(true);
    await expect.poll(async () => (await readProbe(page)).nextParagraphIndex, { timeout: 30000 }).toBe(0);
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { pause: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].pause();
    });
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("paused");
    const audioAfterRestart = (await readProbe(page)).transport?.audioUrl as string;
    const countAfterRestart = (await readProbe(page)).audioCount as number;
    recorder.step("Work restart 新会话", { workSession });

    // Work：查看正文 → 精确 /library/[workId]，播放继续。
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("expanded-view-story-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => page.url(), { timeout: 30000 }).toContain(`/library/${work.id}`);
    assertNoPlayer("Work 查看正文");
    const afterWorkNav = await readProbe(page);
    expect(afterWorkNav.sessionId).toBe(workSession);
    expect(afterWorkNav.status).toBe("paused");
    expect(afterWorkNav.transport?.audioUrl).toBe(audioAfterRestart);
    expect(afterWorkNav.audioCount).toBe(countAfterRestart);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("Work 查看正文精确目标", { url: page.url() });

    // 全局：普通路由切换 ≠ 关闭（重开后经 TabBar 到 /chat 仍 open）。
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button[role="tab"]')).find((el) =>
            (el.textContent ?? "").includes("创作"),
        ) as unknown as { click?: () => void } | undefined;
        if (!btn || typeof btn.click !== "function") throw new Error("chat-tab-not-found");
        btn.click();
    });
    await page.waitForURL("**/chat", { timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(workSession);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    assertNoPlayer("普通路由保持");
    recorder.step("普通路由不关闭", { url: page.url() });

    // 全局：390 Sheet → 900 Panel → 回 390（resize 不重置）。
    const sheet390 = await page.getByTestId("expanded-sheet").boundingBox();
    expect(sheet390).not.toBeNull();
    if (sheet390) {
        expect(sheet390.width).toBeGreaterThan(300);
        expect(sheet390.y + sheet390.height).toBeGreaterThan(700);
    }
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(workSession);
    await expect
        .poll(
            async () => {
                const box = await page.getByTestId("expanded-sheet").boundingBox();
                if (!box) return 999;
                return Math.abs(box.x + box.width - 900);
            },
            { timeout: 15000 },
        )
        .toBeLessThan(8);
    const panel900 = await page.getByTestId("expanded-sheet").boundingBox();
    expect(panel900).not.toBeNull();
    if (panel900) {
        expect(Math.abs(panel900.width - 400)).toBeLessThan(60);
        expect(Math.abs(panel900.x + panel900.width - 900)).toBeLessThan(8);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(workSession);
    recorder.step("响应式 Sheet/Panel", { panel900 });
    assertNoPlayer("响应式");

    // 全局：关闭 → Mini 恢复（session/暂停态不变）。
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 15000 }).toBe(1);
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(workSession);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe("paused");
    assertNoPlayer("关闭回 Mini");
    recorder.step("关闭回 Mini", {});

    // Draft：本地 seed 并驻留。
    const draftStory = `${para("丙")}\n${para("丁")}`;
    const draftMessageId = `msg_closure_${runKey}`;
    const draftTitle = `草稿聚合${runKey}`;
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
    const draftSession = seeded.sessionId as string;
    expect(typeof draftSession === "string" && draftSession.length > 0).toBe(true);
    expect(draftSession).not.toBe(workSession);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("paused");
    const draftBaseline = await readProbe(page);
    expect(draftBaseline.source?.kind).toBe("draft");
    expect(draftBaseline.storyText).toBe(draftStory);
    const draftAudioCount = draftBaseline.audioCount as number;
    recorder.step("Draft 会话驻留", { draftSession });

    // Draft：Mini → Expanded → 查看正文（Transcript 口）+ 返回创作并存。
    const urlBeforeDraft = page.url();
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBeforeDraft);
    assertNoPlayer("Draft 打开");
    await expect.poll(async () => (await readProbe(page)).sessionId, { timeout: 15000 }).toBe(draftSession);
    await expect(page.getByTestId("expanded-view-transcript-button")).toContainText("查看正文", { timeout: 15000 });
    await expect(page.getByTestId("expanded-back-to-creation-button")).toContainText("返回创作", { timeout: 15000 });
    expect(await page.getByTestId("expanded-view-story-button").count()).toBe(0);
    expect(await page.getByTestId("expanded-continue-creation-button").count()).toBe(0);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("Draft 双口并存", {});

    // Draft：查看正文 → Transcript 只读（URL 不变，session 不变）。
    await page.getByTestId("expanded-view-transcript-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-transcript")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBeforeDraft);
    await expect(page.getByTestId("expanded-transcript-text")).toContainText("森林里的小猫", { timeout: 15000 });
    expect(await page.getByTestId("expanded-transcript-text").textContent()).toBe(draftStory);
    expect(await page.getByTestId("expanded-playback-controls").count()).toBe(0);
    const afterTranscript = await readProbe(page);
    expect(afterTranscript.sessionId).toBe(draftSession);
    expect(afterTranscript.status).toBe("paused");
    expect(afterTranscript.audioCount).toBe(draftAudioCount);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    assertNoPlayer("Transcript");
    recorder.step("Draft Transcript 只读", {});

    // Draft：返回 controls（零变化）。
    await page.getByTestId("expanded-transcript-back-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-transcript")).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-playback-controls")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBeforeDraft);
    expect((await readProbe(page)).sessionId).toBe(draftSession);
    recorder.step("Draft 返回控制", {});

    // Draft：返回创作 → /chat，零自动发送，播放继续。
    const chatCountBefore = await readChatCount(page);
    const probeBeforeBack = await readProbe(page);
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("expanded-back-to-creation-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => page.url(), { timeout: 30000 }).toContain("/chat");
    assertNoPlayer("返回创作");
    const afterBack = await readProbe(page);
    expect(afterBack.sessionId).toBe(draftSession);
    expect(JSON.stringify(afterBack.source)).toBe(JSON.stringify(probeBeforeBack.source));
    expect(afterBack.status).toBe("paused");
    expect(afterBack.transport?.isPlaying).toBe(false);
    expect(afterBack.audioCount).toBe(draftAudioCount);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    const chatCountAfter = await readChatCount(page);
    expect(chatCountAfter).toBe(chatCountBefore);
    const pendingAutoSend = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return (w["__pendingAutoSend"] as unknown) ?? null;
    });
    expect(pendingAutoSend).toBe(null);
    recorder.step("Draft 返回创作零发送", { url: page.url(), chatCountAfter });

    // 全局：clear/idle → auto-close（重开后 clear，面板自动关闭）。
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { clearForClosureTest: () => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].clearForClosureTest();
    });
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe("idle");
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => page.getByTestId("mini-now-playing").count(), { timeout: 15000 }).toBe(0);
    assertNoPlayer("clear 自动关");
    recorder.step("clear/idle 自动关", {});

    // 全程 /player 零导航终检。
    for (const u of visitedUrls) {
        expect(u).not.toContain("/player");
    }
    expect(page.url()).not.toContain("/player");
    recorder.step("全程不经 /player", { visited: visitedUrls.length });
});
