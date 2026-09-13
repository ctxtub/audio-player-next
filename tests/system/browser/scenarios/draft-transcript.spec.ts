// case_id: expanded-draft-transcript
// journey: smoke-baseline
// M7-04-02 Draft Transcript targeted（验收 1/2/3/4/5/6，Chromium/WebKit 双跑）。
// Draft 打开 Expanded→查看正文→Expanded 内只读 TranscriptView（route 不变，
// 内容 = Session.storyText）→返回控制（Session/Transport/Audio 零变化）→
// promotion 模拟后 transcript 保持打开 + 打开作品详情复用同一出口精确
// /library/[workId]；全程无 fake-id 导航，开合不写 global UI Store
//（面板保持打开即局部 view 的可观察证明）。
// 慢沙箱确定性轮询，无长 sleep。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { createStoryWorkByPage } from "./helpers/library";

/** 探针快照（与 PlaybackSessionProbe 对齐，含 M7-04-02 storyText 透传）。 */
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

test("Expanded Draft Transcript 只读面", async ({ page, harnessEnv, evidence }) => {
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
        `m7draft_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
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

    // promotion 目标作品（真实 library.create，打开作品详情精确目标用）。
    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string => `${label}森林里的小猫勇敢出发寻找魔法宝石，一路上遇到了善良的小兔和机智的小狐狸，大家决定结伴同行互相帮助共同面对未知的挑战。${"内容".repeat(40)}${label}尾`;
    const targetWork = await createStoryWorkByPage(page, {
        title: `草稿转正目标${runKey}`,
        prompt: `草稿转正提示${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
    recorder.step("promotion 目标作品创建", { workId: targetWork.id });

    // Draft 会话本地 seed（E2E-only 入口，不建 server Anchor、不触网络）。
    const draftMessageId = `msg_draft_transcript_${runKey}`;
    const draftTitle = `草稿故事${runKey}`;
    const draftStory = `${para("丙")}\n${para("丁")}`;
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
    recorder.step("Draft 会话驻留", { draftSessionId, audioCountBefore });

    // 打开 Expanded（URL 不变），Draft 查看正文入口可见（同文案独立口）。
    const urlBefore = page.url();
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBefore);
    await expect(page.getByTestId("expanded-actions")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-view-transcript-button")).toContainText("查看正文", { timeout: 15000 });
    expect(await page.getByTestId("expanded-view-transcript-button").count()).toBe(1);
    expect(await page.getByTestId("expanded-view-story-button").count()).toBe(0);
    expect(await page.getByTestId("expanded-transcript").count()).toBe(0);
    recorder.step("Draft 展示查看正文", {});

    // 点击：Expanded 内打开只读 Transcript（验收 1/2：面板保持打开、route 不变、
    // 内容 = Session.storyText、无编辑面）。
    await page.getByTestId("expanded-view-transcript-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-transcript")).toBeVisible({ timeout: 15000 });
    // 面板保持打开 = 局部 view 的可观察证明（开合不走 global 关闭）。
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBefore);
    await expect(page.getByTestId("expanded-transcript-text")).toContainText("森林里的小猫", { timeout: 15000 });
    const transcriptText = await page.getByTestId("expanded-transcript-text").textContent();
    expect(transcriptText).toBe(draftStory);
    expect(await page.getByTestId("expanded-transcript-empty").count()).toBe(0);
    // 只读：无可编辑元素。
    expect(await page.locator('[data-testid="expanded-transcript"] textarea').count()).toBe(0);
    expect(await page.locator('[data-testid="expanded-transcript"] input').count()).toBe(0);
    expect(await page.locator('[data-testid="expanded-transcript"] [contenteditable="true"]').count()).toBe(0);
    const afterOpen = await readProbe(page);
    expect(afterOpen.sessionId).toBe(draftSessionId);
    expect(JSON.stringify(afterOpen.source)).toBe(JSON.stringify(baseline.source));
    expect(afterOpen.status).toBe("paused");
    expect(afterOpen.transport?.isPlaying).toBe(false);
    expect(afterOpen.audioCount).toBe(audioCountBefore);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    // promotion 前无打开作品详情入口（不越界进 M4 流程）。
    expect(await page.getByTestId("expanded-open-work-detail-button").count()).toBe(0);
    recorder.step("Transcript 只读打开", {});

    // 返回控制：Session/Transport/Audio 零变化（验收 3），URL 不变。
    await page.getByTestId("expanded-transcript-back-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-transcript")).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBefore);
    const afterBack = await readProbe(page);
    expect(afterBack.sessionId).toBe(draftSessionId);
    expect(JSON.stringify(afterBack.source)).toBe(JSON.stringify(baseline.source));
    expect(afterBack.status).toBe("paused");
    expect(afterBack.transport?.isPlaying).toBe(false);
    expect(afterBack.transport?.audioUrl).toBe(afterOpen.transport?.audioUrl ?? null);
    expect(afterBack.audioCount).toBe(audioCountBefore);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("返回控制零变化", {});

    // promotion：transcript 保持打开（§35.1），出现打开作品详情入口。
    await page.getByTestId("expanded-view-transcript-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-transcript")).toBeVisible({ timeout: 15000 });
    await page.evaluate((workId: number) => {
        const w = window as unknown as Record<string, { simulateDraftPromotedToWork: (id: number) => ProbeSnapshot }>;
        return w["__M5PlaybackProbe"].simulateDraftPromotedToWork(workId);
    }, targetWork.id);
    await expect
        .poll(async () => (await readProbe(page)).source?.kind, { timeout: 15000 })
        .toBe("work");
    // transcript 不强制关闭 + 同一 storyText 继续展示。
    await expect(page.getByTestId("expanded-transcript")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect((await page.getByTestId("expanded-transcript-text").textContent())).toBe(draftStory);
    expect((await readProbe(page)).sessionId).toBe(draftSessionId);
    await expect(page.getByTestId("expanded-open-work-detail-button")).toContainText("打开作品详情", { timeout: 15000 });
    recorder.step("promotion 保持打开", {});

    // 打开作品详情：复用同一路由出口 → 精确 /library/[workId]，会话同一。
    beginSessionCount = 0;
    ttsSynthCount = 0;
    await page.getByTestId("expanded-open-work-detail-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toHaveCount(0, { timeout: 15000 });
    await expect
        .poll(async () => page.url(), { timeout: 30000 })
        .toContain(`/library/${targetWork.id}`);
    expect(page.url()).toContain(`/library/${targetWork.id}`);
    seenLibraryUrls.push(page.url());
    const afterNav = await readProbe(page);
    expect(afterNav.sessionId).toBe(draftSessionId);
    expect(afterNav.audioCount).toBe(audioCountBefore);
    expect(beginSessionCount).toBe(0);
    expect(ttsSynthCount).toBe(0);
    recorder.step("打开作品详情精确目标", { url: page.url() });

    // 无 fake-id 导航（验收 4 的浏览器侧）。
    for (const seen of seenLibraryUrls) {
        expect(seen).not.toContain("fake");
        expect(seen).not.toContain("undefined");
        expect(seen).not.toContain("null");
        expect(seen).not.toContain("NaN");
    }
    const detailId = page.url().match(/\/library\/(\d+)/)?.[1];
    expect(detailId).toBe(String(targetWork.id));
    recorder.step("无 fake-id 导航", { seenLibraryUrls });
});
