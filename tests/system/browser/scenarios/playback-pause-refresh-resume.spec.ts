// case_id: history-restore-card-resynth
// journey: playback-kernel
// legacy_aliases: [E2E-03-10, H-11]
// M5-10 fixup Scenario B（评审 Blocking 1）：pause/refresh/resume（真实 browser 聚合）。
// Work 播放并 checkpoint→pause→browser refresh→rehydrate 同一 sessionId→status=ready
// + transport 空闲（url null/currentTime 0/isPlaying false）+ 无 autoplay→用户再播放后
// 从 canonical paragraph（刷新前后同一 next）resume。慢沙箱一律确定性轮询，无长 sleep。
// 身份取注册用户（同 Scenario A：避开访客 IP 桶 15/分钟在 repeat 多测下的 harness 限流误伤）。
// Scenario C（stale async TTS）保留 L1 确定性覆盖（exec-playback-runtime-orchestration §50）：
// browser mock TTS 为即时固定 MP3，无可编程延迟面，为其加延迟钩需改运行时本体，违背边界。
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
    continuationMode?: string;
    nextParagraphIndex?: number;
    totalParagraphs?: number;
    lastCompletedParagraphIndex?: number;
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

/** 读探针快照。 */
async function readProbe(page: Page): Promise<ProbeSnapshot> {
    return (await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M5PlaybackProbe"] as { snapshot?: () => ProbeSnapshot } | undefined;
        if (!probe || typeof probe.snapshot !== "function") throw new Error("probe-not-ready");
        return probe.snapshot();
    })) as ProbeSnapshot;
}

test("暂停刷新后同会话就绪恢复", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(180000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };

    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    /** TTS 合成计数（resume 后必须新增 exactly ≥1，刷新静置期必须零新增）。 */
    let ttsSynthCount = 0;
    page.on("request", (req) => {
        try {
            const url: string = req.url();
            if (url.includes("/api/trpc/") && (url.includes("tts.synthesize") || url.includes("synthesize"))) {
                ttsSynthCount += 1;
            }
        } catch {}
    });

    await ensureRegisteredByApi(
        page,
        harnessEnv.appUrl,
        `m5rsm_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        "SecurePass123!",
    );
    await dismissOnboarding(page);
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect(page.getByTestId("m5-playback-probe")).toBeAttached({ timeout: 15000 });

    // 真实 StoryWork（两段式，canonical 段落可观测）。
    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const para = (label: string): string => `${label}深夜的灯塔下老船长翻开泛黄的航海日志，巨浪与星光交织成未知的航线，勇气与智慧将指引每一次抉择。${"内容".repeat(40)}${label}尾`;
    const work = await createStoryWorkByPage(page, {
        title: `刷新恢复${runKey}`,
        prompt: `刷新恢复提示词${runKey}`,
        storyText: `${para("甲")}\n${para("乙")}`,
    });
    recorder.step("真实作品创建", { workId: work.id });

    // 播放并 checkpoint→pause（真实 TTS + 真实 saveCheckpointImmediate 落库）。
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
    const beforeRefresh = await readProbe(page);
    expect(beforeRefresh.sessionId).toBe(sessionId);
    const canonicalNext = beforeRefresh.nextParagraphIndex as number;
    expect(typeof canonicalNext === "number").toBe(true);
    recorder.step("播放+落点+暂停", {
        sessionId,
        canonicalNext,
        total: beforeRefresh.totalParagraphs,
    });

    // Browser refresh → rehydrate 同一 S（确定性轮询 ready）。
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
    const afterRehydrate = await readProbe(page);
    expect(afterRehydrate.sessionId).toBe(sessionId);
    expect(afterRehydrate.source?.kind).toBe("work");
    expect((afterRehydrate.source as { workId?: number })?.workId).toBe(work.id);
    expect(afterRehydrate.status).toBe("ready");
    expect(afterRehydrate.nextParagraphIndex).toBe(canonicalNext);
    // Transport 空闲三元组：url null / currentTime 0 / isPlaying false + 单 audio owner。
    expect(afterRehydrate.transport?.hasAudioUrl).toBe(false);
    expect(afterRehydrate.transport?.audioUrl).toBe(null);
    expect(afterRehydrate.transport?.currentTime).toBe(0);
    expect(afterRehydrate.transport?.isPlaying).toBe(false);
    expect(afterRehydrate.audioCount).toBe(1);
    expect(afterRehydrate.transport?.hasController).toBe(true);
    recorder.step("刷新水合同一会话", {
        sessionId,
        canonicalNext,
        transport: afterRehydrate.transport,
    });

    // 无 autoplay（短窗静置 3s 仍 ready + 无轨 + 无新增合成；唯一允许的短 sleep，否定性必要）。
    ttsSynthCount = 0;
    const idleBefore = await readProbe(page);
    await page.waitForTimeout(3000);
    const idleAfter = await readProbe(page);
    expect(idleAfter.sessionId).toBe(sessionId);
    expect(idleAfter.status).toBe("ready");
    expect(idleAfter.transport?.hasAudioUrl).toBe(false);
    expect(idleAfter.transport?.isPlaying).toBe(false);
    expect(idleAfter.nextParagraphIndex).toBe(canonicalNext);
    expect(ttsSynthCount).toBe(0);
    recorder.step("刷新后无自动播放", { idleBefore: idleBefore.status, idleAfter: idleAfter.status, ttsSynthCount });

    // 用户再播放 → 从 canonical paragraph resume（同 S + 新合成 + 同 next 出发）。
    await page.evaluate(() => {
        const w = window as unknown as Record<string, { resume: () => Promise<ProbeSnapshot> }>;
        return w["__M5PlaybackProbe"].resume();
    });
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl === true, { timeout: 30000 })
        .toBe(true);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 30000 }).toBe("playing");
    const afterResume = await readProbe(page);
    expect(afterResume.sessionId).toBe(sessionId);
    expect(afterResume.source?.kind).toBe("work");
    expect((afterResume.source as { workId?: number })?.workId).toBe(work.id);
    // resume 不建新会话：next 仍从 canonical 出发（playParagraph(next) 不前跳）。
    expect(afterResume.nextParagraphIndex).toBe(canonicalNext);
    expect(afterResume.audioCount).toBe(1);
    expect(ttsSynthCount).toBeGreaterThanOrEqual(1);
    recorder.step("用户恢复播放", {
        sessionId,
        canonicalNext,
        ttsSynthCount,
        status: afterResume.status,
    });
});
