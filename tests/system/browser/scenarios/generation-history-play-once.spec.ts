// case_id: generation-history-play-once
// journey: history-reuse-playback
// legacy_aliases: [E2E-02-11-02, H-21]
// M4-07 relocation：History ownership 已回迁 Chat（Chat History Surface），/player 不再拥有 History 入口；
// 本用例自 M4-10 起改走聊天页「历史」按钮 + 面板内「生成历史」分段。
// M9-F01（已冻结）：回放不再是旧 oneShot / Transport 播放源切换语义，而是正式 Work Session：
// `GenerationHistory.record.id → source={kind:'work', workId} → finite Work Session → M5/M8 provider`。
// 旧 oneShot 文案与 oracle 已退役（STALE_ORACLE）；本 spec 只断言 History case 特有的价值，
// 不复制 M9-F01 已有的全套测试（全局同帧可达见 story-playback-global-controls-reachable）。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureGuestByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import {
    countTableRows,
    findGuestGenerationsByPrompt,
    readGuestPlaybackAnchorByPrompt,
    resolveIsolationDbPath,
} from "./helpers/db";

/**
 * 生成历史 Work Session 有限回放（旧 E2E-02-11-02/H-21，现 Chat-owned History Surface）。
 *
 * M9-F01 冻结语义：点击「回放此故事」必须建立正式 Work Session
 *（`source={kind:'work', workId: record.id}`，finite，不触发 AI continuation），
 * 经 M5/M8 provider 真实起播，Mini 可见、Expanded 可达；不新增历史、不污染聊天，
 * 完播后仍是同一 Work identity。真媒体事件由浏览器自然产生，不用 dispatchEvent 合成。
 */

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

/** 同帧起播证据：一次 waitForFunction 原子读取 <audio> 真实播放态 + Mini 可见性/状态。 */
interface SameFramePlayback {
    /** 实际音频地址（provider 合成产物：blob:/data:audio*）。 */
    src: string;
    /** 当前播放时间（秒）。 */
    currentTime: number;
    /** 是否暂停。 */
    paused: boolean;
    /** MiniNowPlaying 是否同帧可见。 */
    miniVisible: boolean;
    /** Mini 的 data-status（应派生自 Session）。 */
    miniStatus: string | null;
    /** Mini 可见文本（诊断用）。 */
    miniText: string;
}

/**
 * 等“真实起播 + Mini 同帧可见”，并原子返回同一帧快照。
 * @param page Playwright 页面
 * @param timeout 超时毫秒
 * @returns 同帧快照
 */
async function waitForPlaybackWithMini(page: Page, timeout = 90000): Promise<SameFramePlayback> {
    const handle = await page.waitForFunction(
        () => {
            const audio = document.querySelector("audio") as HTMLAudioElement | null;
            const mini = document.querySelector('[data-testid="mini-now-playing"]') as HTMLElement | null;
            if (!audio || !mini) {
                return null;
            }
            if (mini.getClientRects().length === 0) {
                return null;
            }
            const started: boolean = !audio.paused || audio.currentTime > 0 || audio.ended;
            if (!started) {
                return null;
            }
            return {
                src: audio.currentSrc || audio.src,
                currentTime: audio.currentTime,
                paused: audio.paused,
                miniVisible: true,
                miniStatus: mini.getAttribute("data-status"),
                miniText: (mini.textContent || "").slice(0, 80),
            };
        },
        null,
        { timeout },
    );
    return (await handle.jsonValue()) as SameFramePlayback;
}

/** 读 Anchor 身份（容错：App 正在写 checkpoint 时轮询读不抛，返回 null）。 */
function safeAnchor(
    dbFile: string,
    prompt: string,
): { sourceKind: string; sourceId: string; anchorState: string; sessionId: string } | null {
    try {
        return readGuestPlaybackAnchorByPrompt(dbFile, prompt);
    } catch {
        return null;
    }
}

/** 读 Anchor sourceKind（容错版；无 Anchor/瞬时锁返回 ""）。 */
function safeAnchorKind(dbFile: string, prompt: string): string {
    return safeAnchor(dbFile, prompt)?.sourceKind ?? "";
}

/** 导航到空白页并静置，确保客户端完全停止后再做回放点击（杜绝 autoplay 晚到覆盖显式回放）。 */
async function detachClient(page: Page): Promise<void> {
    await page.goto("about:blank", { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(2000);
}

test("生成历史本页单次回放", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    /** 证据记录器（fixtures 自动挂载，显式取用以记录外部时间线与库路径）。 */
    const recorder = evidence as unknown as {
        step: (name: string, detail?: unknown) => void;
    };
    /** 当次运行隔离库路径（evidence-recorder 同源直查）。 */
    const dbFile: string = resolveIsolationDbPath(harnessEnv.runId);
    recorder.step("隔离库直查路径", { dbFile });
    /** 本用例唯一提示词（串行共享库内唯一键）。 */
    const prompt: string = `L3回放${Date.now()}${Math.floor(Math.random() * 100000)}请讲一个动物朋友互相帮助的故事。`;
    /** Agent/续写相关请求计数（回放段只允许 TTS/provider，不允许 Agent）。 */
    let agentCalls = 0;
    page.on("request", (request) => {
        const url: string = request.url();
        if (url.includes("agent.interact")) {
            agentCalls += 1;
        }
    });

    // 中文注释：经真实访客 API 进入创作页（双浏览器稳态，见 helpers/auth）。
    await ensureGuestByApi(page, harnessEnv.appUrl);
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );

    // 中文注释：先完成一次真实创作，使生成历史落库（回放前置）。
    const composer = page.getByPlaceholder("请输入内容...");
    await composer.fill(prompt);
    await page.getByRole("button", { name: "发送" }).click({ timeout: 15000 });
    await expect(composer).toBeEnabled({ timeout: 90000 });
    // 中文注释：创作 quiescence 等待——自动续写是流完成后的合法产品行为，
    // 其 trailing 落库可能晚于输入框恢复到达；必须等行数稳定后再取基线，否则基线读到
    // 半程值造成误判（M6-04 hardening：只把基线取在静止点，oracle 本身不变）。
    // 按提示词取该次生成的全部 Work 行（自动续写会以同一提示词再落一条 Work）。
    let workRows = findGuestGenerationsByPrompt(dbFile, prompt);
    const quiesceDeadline = Date.now() + 60000;
    for (;;) {
        await page.waitForTimeout(3000);
        const recount = findGuestGenerationsByPrompt(dbFile, prompt);
        if (recount.length === workRows.length && workRows.length >= 1) {
            workRows = recount;
            break;
        }
        workRows = recount;
        if (Date.now() >= quiesceDeadline) {
            break;
        }
    }
    expect(workRows.length).toBeGreaterThanOrEqual(1);
    recorder.step("回放前置创作完成", { workIds: workRows.map((row) => row.id) });

    // 中文注释：生成完成后的 autoplay 链可能仍在途；先分离客户端再重载，杜绝
    // 后台 Draft autoplay 晚到覆盖用户显式回放的 Work Session（真实产品里用户
    // 不会在 autoplay 进行中立刻点历史回放，这里让前置确定化，oracle 不放宽）。
    await detachClient(page);
    await page.goto(`${harnessEnv.appUrl}/chat`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2000);
    await dismissOnboarding(page);

    // 中文注释：开聊天历史切生成历史（M4-07 后入口为聊天页「历史」按钮）。
    // UI 顺序为 createdAt desc,id desc，故列表首条 = 最大 id；点首条并断言 Session 绑定到该 Work。
    await page.getByRole("button", { name: "打开历史" }).click({ timeout: 15000 });
    await page.getByRole("tab", { name: "生成历史" }).click({ timeout: 15000 });
    await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 30000 });
    const clickedWorkId: number = workRows[workRows.length - 1]?.id ?? -1;
    expect(Number.isInteger(clickedWorkId) && clickedWorkId > 0).toBe(true);
    /** 回放前基线：生成历史行数（回放不得新增）与聊天行数（回放不得建 Draft/污染聊天）。 */
    const historyBefore: number = countTableRows(dbFile, "GuestGenerationHistory");
    const chatBefore: number = countTableRows(dbFile, "GuestChatMessage");
    expect(historyBefore).toBeGreaterThanOrEqual(1);
    recorder.step("回放前基线", { historyBefore, chatBefore, clickedWorkId });
    agentCalls = 0;
    const historyItem = page.locator('[class*="historyItem"]').filter({ hasText: prompt }).first();
    await expect(historyItem).toBeVisible({ timeout: 30000 });
    await historyItem.getByRole("button", { name: "回放此故事" }).click({ timeout: 15000 });

    // 中文注释：oracle 1+2+3+4——回放必须建立正式 Work Session：source.kind='work'、
    // source.workId=实际点击的 record.id、continuationMode='finite'（非 Draft、无 replay-text 身份）。
    await expect
        .poll(
            async () => {
                try {
                    const snap = await readProbe(page);
                    return snap.source?.kind === "work" ? (snap.source?.workId ?? null) : null;
                } catch {
                    return null;
                }
            },
            { timeout: 30000 },
        )
        .toBe(clickedWorkId);
    const replaySnap = await readProbe(page);
    expect(replaySnap.source?.kind).toBe("work");
    expect(replaySnap.source?.workId).toBe(clickedWorkId);
    expect(replaySnap.continuationMode).toBe("finite");
    expect(replaySnap.source?.messageId ?? null).toBe(null);
    recorder.step("回放 Session 身份", {
        source: replaySnap.source,
        continuationMode: replaySnap.continuationMode,
        sessionId: replaySnap.sessionId,
    });

    // 中文注释：真 server Anchor 身份 = work/该 Work id（证明点击建立了正式 Session，而非 Transport-only）。
    await expect.poll(() => safeAnchorKind(dbFile, prompt), { timeout: 30000 }).toBe("work");
    const anchor = safeAnchor(dbFile, prompt);
    expect(workRows.map((row) => String(row.id))).toContain(anchor?.sourceId);
    expect(anchor?.sourceId).toBe(String(clickedWorkId));
    expect(anchor?.sourceId.startsWith("replay-text-")).toBe(false);
    recorder.step("回放 Anchor 身份", { anchor, clickedWorkId });

    // 中文注释：oracle 5+6——实际 audio 自然起播（真实播放证据：自然 playing/ended/currentTime 任一，
    // 不只看 media state 或只看 store）且同帧 Mini 可见、状态 playing；音源须为 M5/M8 provider
    // 合成产物（blob:/data:audio*），不断言合成细节。
    const frame = await waitForPlaybackWithMini(page);
    expect(frame.miniVisible).toBe(true);
    expect(frame.miniStatus).toBe("playing");
    expect(frame.paused).toBe(false);
    expect(/^(blob:|data:audio\/)/.test(frame.src), `frame=${JSON.stringify(frame)}`).toBe(true);
    recorder.step("回放自然起播同帧快照", { ...frame });

    // 中文注释：按真实用户路径关闭历史面板（面板是覆盖式 dialog，会遮挡 Mini 点击；
    // 同帧快照已证明面板打开时 Mini 即与音频同时可见，此处只为到达 Mini 做面板关闭）。
    await page.getByRole("button", { name: "关闭历史" }).click({ timeout: 15000 });
    await expect(page.getByRole("dialog", { name: "历史" })).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 15000 });

    // 中文注释：oracle 6（续）——Expanded 可打开：点 Mini 元数据区开 Expanded（URL 不变、会话不变），
    // 关闭后 Mini 恢复。
    const urlBeforeExpand = page.url();
    const sessionBeforeExpand = (await readProbe(page)).sessionId;
    await page.getByTestId("mini-metadata-button").click({ timeout: 15000 });
    await expect(page.getByTestId("expanded-now-playing")).toBeVisible({ timeout: 15000 });
    expect(page.url()).toBe(urlBeforeExpand);
    await expect.poll(
        async () => {
            try {
                return (await readProbe(page)).sessionId;
            } catch {
                return null;
            }
        },
        { timeout: 15000 },
    ).toBe(sessionBeforeExpand);
    await page.getByTestId("expanded-close-button").click({ timeout: 15000 });
    await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 15000 });
    recorder.step("Expanded 可打开", { sessionBeforeExpand });

    // 中文注释：oracle 7+8+9——回放不触发 Agent/续写、不新增历史、不污染聊天、不建 Draft。
    // 静置一段，让可能的续写/误落库有机会发生（误行为会如实失败）。
    await page.waitForTimeout(5000);
    /** 回放后访客生成历史行数（不得新增）。 */
    const historyAfter: number = countTableRows(dbFile, "GuestGenerationHistory");
    expect(historyAfter).toBe(historyBefore);
    /** 回放后访客聊天行数（不得建 Draft、不得污染聊天）。 */
    const chatAfter: number = countTableRows(dbFile, "GuestChatMessage");
    expect(chatAfter).toBe(chatBefore);
    // 中文注释：network 断言——回放不触发 Agent/续写。
    expect(agentCalls).toBe(0);
    // 中文注释：聊天断言——回放不污染聊天（本次创作仍在，无新增续写气泡改变主体）。
    await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 30000 });
    recorder.step("回放无副作用", { historyBefore, historyAfter, chatBefore, chatAfter, agentCalls });

    // 中文注释：oracle 10——回放结束后仍是同一 Work identity：等自然完播（status=ended，
    // source 不被清空），再断言 Session 与 Anchor 仍绑定最初点击的 Work，且无副作用行数变化。
    await expect.poll(
        async () => {
            try {
                return (await readProbe(page)).status ?? null;
            } catch {
                return null;
            }
        },
        { timeout: 90000 },
    ).toBe("ended");
    const endedSnap = await readProbe(page);
    expect(endedSnap.source?.kind).toBe("work");
    expect(endedSnap.source?.workId).toBe(clickedWorkId);
    const anchorAfterEnd = safeAnchor(dbFile, prompt);
    expect(anchorAfterEnd?.sourceKind).toBe("work");
    expect(anchorAfterEnd?.sourceId).toBe(String(clickedWorkId));
    expect(countTableRows(dbFile, "GuestGenerationHistory")).toBe(historyBefore);
    expect(countTableRows(dbFile, "GuestChatMessage")).toBe(chatBefore);
    expect(agentCalls).toBe(0);
    recorder.step("完播后同一 Work 身份", {
        source: endedSnap.source,
        sessionId: endedSnap.sessionId,
        anchor: anchorAfterEnd,
    });
});
