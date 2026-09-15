// case_id: history-prompt-start-new-creation
// journey: reuse-history-to-create
// legacy_aliases: [E2E-02-11-01, H-21]
// FIXED 2026-09-10：H-21 历史重创作不清空旧会话（RED-2-1，双浏览器复现 run=2026-09-10T01-41-03-283Z-dc4778）→ 方案A ChatLayout 消费 pendingAutoSend 前调 resetStoryFlow()（+2 行），chromium L75/L78 转 PASS（run=2026-09-10T01-43-27-744Z-28d858）；K1/K2 为 oracle 校准非缺陷
// M4-07 relocation：History ownership 已回迁 Chat（Chat History Surface），/player 不再拥有 History 入口；
// 本用例自 M4-10 起改走聊天页「历史」按钮 + 面板内「提示词历史」分段，oracle 不变（干净新会话、上下文隔离、自动播放、旧作可返、重载后不断点续播）。
// M10-03（已冻结 M9-F01 Draft Session 语义）：旧 oracle 只看底层 <audio> media state，已退役（STALE_ORACLE）；
// 本 spec 迁移到正式 Draft autoplay 语义：`pendingAutoSend → resetStoryFlow → beginChatStream → autoplayDraftStory(draft)`，
// 断言正式 Playback Session（source.kind='draft'，finite）+ 真实起播 + Mini + Anchor hydrate ready + reload 不 autoplay；
// 真实 audio 起播证据保留（只增不减）。完成判定一律状态型 predicate（expect.poll / waitForFunction），无固定 sleep。
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

/** 同帧 Draft 起播证据：一次 waitForFunction 原子读取真实播放态 + Mini + Session（证明 Transport 播放时 Session 已非 idle）。 */
interface SameFrameDraftPlayback {
    /** 实际音频地址（provider 合成产物：blob:/data:audio*）。 */
    src: string;
    /** 当前播放时间（秒）。 */
    currentTime: number;
    /** 是否暂停。 */
    paused: boolean;
    /** readyState（元数据已加载证据）。 */
    readyState: number;
    /** 元数据就绪（loadedmetadata/readyState>=1 真实观测）。 */
    metadataReady: boolean;
    /** 已起播（playing/ended/currentTime 任一真实推进）。 */
    played: boolean;
    /** MiniNowPlaying 是否同帧可见。 */
    miniVisible: boolean;
    /** Mini 的 data-status（应派生自 Session，起播时为 playing）。 */
    miniStatus: string | null;
    /** Mini 可见文本（诊断用）。 */
    miniText: string;
    /** 同帧 Session 状态（必须非 idle，证明先有 Session 后有 Transport 播放）。 */
    sessionStatus: string | null;
    /** 同帧 Session source kind（必须为 draft）。 */
    sessionSourceKind: string | null;
    /** 同帧 Session id（必须与 begin 后的 Draft Session 同一）。 */
    sessionId: string | null;
}

/**
 * 等“Draft Session 非 idle + 真实起播 + 元数据就绪 + Mini 同帧可见”，并原子返回同一帧快照。
 * @param page Playwright 页面
 * @param timeout 超时毫秒
 * @returns 同帧快照
 */
async function waitForDraftPlaybackWithMiniAndSession(
    page: Page,
    timeout = 90000,
): Promise<SameFrameDraftPlayback> {
    const handle = await page.waitForFunction(
        () => {
            const w = window as unknown as Record<string, unknown>;
            const probe = w["__M5PlaybackProbe"] as
                | { snapshot?: () => Record<string, unknown> }
                | undefined;
            const audio = document.querySelector("audio") as HTMLAudioElement | null;
            const mini = document.querySelector('[data-testid="mini-now-playing"]') as HTMLElement | null;
            if (!audio || !mini) {
                return null;
            }
            if (mini.getClientRects().length === 0) {
                return null;
            }
            if (!audio.src && !audio.currentSrc) {
                return null;
            }
            const metadataReady: boolean = audio.readyState >= 1;
            if (!metadataReady) {
                return null;
            }
            const started: boolean = !audio.paused || audio.currentTime > 0 || audio.ended;
            if (!started) {
                return null;
            }
            let sessionStatus: string | null = null;
            let sessionSourceKind: string | null = null;
            let sessionId: string | null = null;
            try {
                const snap = (probe?.snapshot?.() ?? {}) as Record<string, unknown>;
                const source = snap["source"] as { kind?: unknown } | null | undefined;
                sessionStatus = typeof snap["status"] === "string" ? (snap["status"] as string) : null;
                sessionSourceKind =
                    source && typeof source.kind === "string" ? (source.kind as string) : null;
                sessionId = typeof snap["sessionId"] === "string" ? (snap["sessionId"] as string) : null;
            } catch {
                return null;
            }
            if (sessionSourceKind !== "draft" || sessionStatus === null || sessionStatus === "idle") {
                return null;
            }
            return {
                src: audio.currentSrc || audio.src,
                currentTime: audio.currentTime,
                paused: audio.paused,
                readyState: audio.readyState,
                metadataReady,
                played: started,
                miniVisible: true,
                miniStatus: mini.getAttribute("data-status"),
                miniText: (mini.textContent || "").slice(0, 80),
                sessionStatus,
                sessionSourceKind,
                sessionId,
            };
        },
        null,
        { timeout },
    );
    return (await handle.jsonValue()) as SameFrameDraftPlayback;
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

/** 读该提示词的生成行数（容错：瞬时锁返回 -1 由 poll 重试）。 */
function safeGenerationCount(dbFile: string, prompt: string): number {
    try {
        return findGuestGenerationsByPrompt(dbFile, prompt).length;
    } catch {
        return -1;
    }
}

/**
 * 从提示词历史开始新创作（旧 E2E-02-11-01/H-21，现 Chat-owned History Surface）。
 *
 * M9-F01 冻结语义：`pendingAutoSend → resetStoryFlow → beginChatStream → autoplayDraftStory(draft)`，
 * 新故事经正式 Draft Session（source.kind='draft'，finite）由 M5/M8 provider 真实起播；
 * 旧 Transport-only / 整篇 blob 当段播放语义已退役。本 spec 只断言 History 重创作特有的价值，
 * 不复制 M9-F01 已有的全套测试（全局同帧可达见 story-playback-global-controls-reachable）。
 * 真媒体事件由浏览器自然产生，不用 dispatchEvent 合成；完成判定一律状态型 predicate。
 */
test("从提示词历史开始新创作", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(240000);
    /** 证据记录器（fixtures 自动挂载，显式取用以记录外部时间线与库路径）。 */
    const recorder = evidence as unknown as {
        step: (name: string, detail?: unknown) => void;
    };
    /** 当次运行隔离库路径（evidence-recorder 同源直查）。 */
    const dbFile: string = resolveIsolationDbPath(harnessEnv.runId);
    recorder.step("隔离库直查路径", { dbFile });
    /** 本用例唯一旧提示词（隔离库多 spec 串行共享，唯一键防串扰）。 */
    const oldPrompt: string = `L3旧创作${Date.now()}${Math.floor(Math.random() * 100000)}请讲一个温柔的星际冒险睡前故事。`;
    /** Agent 交互请求体快照（network 层，判定单次调用与上下文隔离）。 */
    const agentBodies: string[] = [];
    page.on("request", (request) => {
        const url: string = request.url();
        if (url.includes("agent.interact") && request.method() === "POST") {
            agentBodies.push(request.postData() ?? "");
        }
    });

    // 中文注释：经真实访客 API 进入创作页（双浏览器稳态，见 helpers/auth），等探针就绪。
    await ensureGuestByApi(page, harnessEnv.appUrl);
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );

    // 中文注释：第一次创作（旧会话），等待流式结束（输入框恢复可用，状态型）。
    const composer = page.getByPlaceholder("请输入内容...");
    await composer.fill(oldPrompt);
    await page.getByRole("button", { name: "发送" }).click({ timeout: 15000 });
    await expect(composer).toBeEnabled({ timeout: 90000 });
    // 中文注释：等首次落库定型（生成行出现，状态型 poll；确保清空计数前旧链已静止，否则旧 trailing 会污染新窗口计数）。
    await expect.poll(() => safeGenerationCount(dbFile, oldPrompt), { timeout: 30000 }).toBeGreaterThanOrEqual(1);
    // 中文注释：等首次 Draft Session 建立（状态型 poll；为重创作的“新 Session”提供旧身份基线，避免旧 Session 满足条件造成新 Session 误判）。
    await expect
        .poll(
            async () => {
                try {
                    const snap = await readProbe(page);
                    if (snap.source?.kind !== "draft") return null;
                    return snap.sessionId ?? null;
                } catch {
                    return null;
                }
            },
            { timeout: 30000 },
        )
        .not.toBe(null);
    recorder.step("第一次创作完成", { oldPrompt });

    // 中文注释：在聊天历史确认旧提示词已落历史（UI 可见即落库可查；M4-07 后入口为聊天页「历史」按钮）。
    await dismissOnboarding(page);
    await page.getByRole("button", { name: "打开历史" }).click({ timeout: 15000 });
    await page.getByRole("tab", { name: "提示词历史" }).click({ timeout: 15000 });
    await expect(page.getByText(oldPrompt).first()).toBeVisible({ timeout: 30000 });
    /** 重创作前的旧 Session 身份（用于证明新 Draft 为新 Session，不复用旧身份；reset 后旧 id 短暂驻留，必须等新 id 才算新 Session）。 */
    const oldProbeBaseline = await readProbe(page);
    const oldSessionId: string | null = (oldProbeBaseline.sessionId as string | null) ?? null;
    const oldDraftMessageId: string | null =
        typeof oldProbeBaseline.source?.messageId === "string"
            ? (oldProbeBaseline.source.messageId as string)
            : null;

    // 中文注释：清空 network 计数，仅统计“从历史开始的新创作”窗口。
    agentBodies.length = 0;
    // 中文注释：点击“用此提示词重新创作”→同页自动发送（产品真实链路：面板关闭 + pending 消费 + 先重置再提交）。
    // 新创作沿用所选旧提示词原文（同文），故上下文隔离以旧助手回复（固定 mock 文本）为旧上下文标记。
    const recreateButton = page.getByRole("button", { name: "用此提示词重新创作" }).first();
    await recreateButton.click({ timeout: 15000 });

    // 中文注释：新创作输入框应保持可见；oracle 9——完成判定一律状态型 predicate，不用固定 sleep。
    const chatComposer = page.getByPlaceholder("请输入内容...");
    await expect(chatComposer).toBeVisible({ timeout: 30000 });
    // 中文注释：WebKit 无手势自动发送经解锁门延迟，首个 Enabled 可能早于请求发出；先等请求出现（poll），再等流式结束（Enabled）。
    await expect.poll(() => agentBodies.length, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
    await expect(chatComposer).toBeEnabled({ timeout: 90000 });
    // 中文注释：等新 Draft Session 建立（必须等到与旧 id 不同的新 Session；reset 后旧 Session 以 paused 短暂驻留，
    // 若只等 draft+非 idle 会立刻命中旧 Session 造成“新 Session”误判。状态型 poll，不用固定 sleep）。
    await expect
        .poll(
            async () => {
                try {
                    const snap = await readProbe(page);
                    if (snap.source?.kind !== "draft") return null;
                    const sid: string | null =
                        typeof snap.sessionId === "string" ? (snap.sessionId as string) : null;
                    if (sid === null || sid.length === 0) return null;
                    if (oldSessionId !== null && oldSessionId.length > 0 && sid === oldSessionId) {
                        return null;
                    }
                    return sid;
                } catch {
                    return null;
                }
            },
            { timeout: 60000 },
        )
        .not.toBe(null);
    recorder.step("新创作流式结束", { oldPrompt });

    // 中文注释：oracle 1——network 层断言新请求恰一次 Agent 调用（严格相等；此时流已结束 + Session 已建立，若有续写第二请求必已出现）。
    expect(agentBodies.length).toBe(1);
    /** 新请求体全文（批量包 JSON）。 */
    const newBody: string = agentBodies[0] ?? "";
    // 中文注释：oracle 2——干净会话的请求体应仅含新用户消息，不含旧助手旧文；串台态则含旧助手旧文。
    expect(newBody.includes("harness 固定 mock 回复")).toBe(false);
    recorder.step("新请求上下文隔离", { agentCalls: agentBodies.length });

    // 中文注释：oracle 3——新生成 Draft 有正式 Playback Session（source draft + 新 messageId + 新 sessionId + 非 idle + finite）。
    const draftSnap = await readProbe(page);
    expect(draftSnap.source?.kind).toBe("draft");
    const draftMessageId: unknown = draftSnap.source?.messageId;
    expect(typeof draftMessageId === "string" && (draftMessageId as string).length > 0).toBe(true);
    expect((draftMessageId as string).startsWith("replay-text-")).toBe(false);
    if (oldDraftMessageId !== null && oldDraftMessageId.length > 0) {
        expect(draftMessageId as string).not.toBe(oldDraftMessageId);
    }
    expect(typeof draftSnap.sessionId === "string" && (draftSnap.sessionId as string).length > 0).toBe(true);
    if (oldSessionId !== null && oldSessionId.length > 0) {
        expect(draftSnap.sessionId).not.toBe(oldSessionId);
    }
    expect(draftSnap.status).not.toBe("idle");
    expect(draftSnap.status).not.toBe("error");
    expect(draftSnap.continuationMode).toBe("finite");
    // 中文注释：真 server Anchor 身份 = draft/该新消息（证明建立了正式 Session，而非 Transport-only）。
    await expect.poll(() => safeAnchorKind(dbFile, oldPrompt), { timeout: 30000 }).toBe("draft");
    const anchorBeforeReload = safeAnchor(dbFile, oldPrompt);
    expect(anchorBeforeReload?.sourceKind).toBe("draft");
    expect(anchorBeforeReload?.sourceId).toBe(draftMessageId as string);
    expect(anchorBeforeReload?.sessionId).toBe(draftSnap.sessionId as string);
    recorder.step("新 Draft Session 身份", {
        source: draftSnap.source,
        continuationMode: draftSnap.continuationMode,
        sessionId: draftSnap.sessionId,
        anchor: anchorBeforeReload,
    });

    // 中文注释：oracle 4+5+6——同帧原子证据：Session 已非 idle（先有 Session 后有 Transport 播放）+
    // audio 自然起播（真实播放证据：自然 playing/ended/currentTime + loadedmetadata/readyState>=1，只增不减）+
    // Mini 同帧可见（data-status playing，只派生自 Session）；音源须为 provider 合成产物（blob:/data:audio*）。
    const frame = await waitForDraftPlaybackWithMiniAndSession(page);
    expect(frame.sessionSourceKind).toBe("draft");
    expect(frame.sessionStatus).not.toBe("idle");
    expect(frame.sessionId).toBe(draftSnap.sessionId as string);
    expect(frame.played).toBe(true);
    expect(frame.metadataReady).toBe(true);
    expect(frame.readyState).toBeGreaterThanOrEqual(1);
    expect(frame.miniVisible).toBe(true);
    expect(frame.miniStatus).toBe("playing");
    expect(frame.paused).toBe(false);
    expect(/^(blob:|data:audio\/)/.test(frame.src), `frame=${JSON.stringify(frame)}`).toBe(true);
    recorder.step("新故事 Draft 起播同帧快照", { ...frame });

    // 中文注释：oracle 7——旧创作保留在历史可返回（聊天历史面板可见 + 隔离库直查，双重证据）。
    // 新创作沿用同文提示词：PromptHistory 为 upsert（同键 useCount+1，行数仍>=1），GenerationHistory 为新增（同提示词行数>=2，不覆盖旧条）。
    await page.getByRole("button", { name: "打开历史" }).click({ timeout: 15000 });
    await page.getByRole("tab", { name: "提示词历史" }).click({ timeout: 15000 });
    await expect(page.getByText(oldPrompt).first()).toBeVisible({ timeout: 30000 });
    await expect.poll(() => safeGenerationCount(dbFile, oldPrompt), { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    /** 访客提示词历史行数（同文 upsert，不覆盖旧条）。 */
    const promptRows: number = countTableRows(dbFile, "GuestPromptHistory");
    expect(promptRows).toBeGreaterThanOrEqual(1);
    recorder.step("旧作仍在历史", {
        promptRows,
        generationRows: safeGenerationCount(dbFile, oldPrompt),
    });
    // 中文注释：按真实用户路径关闭历史面板（覆盖式 dialog 会遮挡 Mini；同帧快照已证明面板关闭前 Mini 即与音频同时可见，此处只为回到干净态）。
    await page.getByRole("button", { name: "关闭历史" }).click({ timeout: 15000 });
    await expect(page.getByRole("dialog", { name: "历史" })).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 15000 });

    // 中文注释：oracle 8——reload 后 Anchor 可 hydrate 为 ready（同一 sessionId/source），不 autoplay，
    // Transport 无旧 src（hasAudioUrl=false/audioUrl=null）且 DOM audio 无 src 且 paused。
    const sessionIdBeforeReload: string = draftSnap.sessionId as string;
    const messageIdBeforeReload: string = draftMessageId as string;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await expect(page.getByPlaceholder("请输入内容...")).toBeEnabled({ timeout: 90000 });
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
    await expect
        .poll(
            async () => {
                try {
                    return (await readProbe(page)).status ?? null;
                } catch {
                    return null;
                }
            },
            { timeout: 60000 },
        )
        .toBe("ready");
    const afterRehydrate = await readProbe(page);
    expect(afterRehydrate.sessionId).toBe(sessionIdBeforeReload);
    expect(afterRehydrate.source?.kind).toBe("draft");
    expect(afterRehydrate.source?.messageId).toBe(messageIdBeforeReload);
    expect(afterRehydrate.status).toBe("ready");
    expect(afterRehydrate.transport?.hasAudioUrl).toBe(false);
    expect(afterRehydrate.transport?.audioUrl).toBe(null);
    expect(afterRehydrate.transport?.isPlaying).toBe(false);
    const afterReload = await page.evaluate(() => {
        const audio = document.querySelector("audio") as HTMLAudioElement | null;
        if (!audio) {
            return { hasAudio: false, hasSrc: false, paused: true };
        }
        const src: string = audio.currentSrc || audio.src || "";
        return { hasAudio: true, hasSrc: src.length > 0, paused: audio.paused };
    });
    expect(afterReload.hasSrc).toBe(false);
    expect(afterReload.paused).toBe(true);
    // 中文注释：不 autoplay 否定性必要短窗（唯一允许的短 sleep）：静置 3s 仍 ready + 无轨 + 无新增合成倾向。
    await page.waitForTimeout(3000);
    const idleAfter = await readProbe(page);
    expect(idleAfter.sessionId).toBe(sessionIdBeforeReload);
    expect(idleAfter.status).toBe("ready");
    expect(idleAfter.transport?.hasAudioUrl).toBe(false);
    expect(idleAfter.transport?.isPlaying).toBe(false);
    const anchorAfter = safeAnchor(dbFile, oldPrompt);
    expect(anchorAfter?.sourceKind).toBe("draft");
    expect(anchorAfter?.sessionId).toBe(sessionIdBeforeReload);
    recorder.step("重载后不断点续播", { afterReload, anchor: anchorAfter });
});
