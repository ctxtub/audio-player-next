// case_id: story-playback-global-controls-reachable
// journey: playback-kernel
// legacy_aliases: [E2E-03-13, M9-F01]
// M9-F01：任何用户可感知的故事播放都必须先有正式 PlaybackSession；
// StoryCard（Legacy 卡片，含 persisted audioUrl）与 Generation History 回放
// 两类真实 UI 入口都必须：起播时 <audio> 真实出声，且同帧 MiniNowPlaying 可见
// （Mini 显隐只派生自 Session：source !== null && status !== 'idle'）。
// 不预置 Session（先清 Anchor 冷态），由真实点击驱动；retries=0，不合成媒体事件。
import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import {
    deleteGuestPlaybackAnchorByPrompt,
    findGuestGenerationsByPrompt,
    readGuestPlaybackAnchorByPrompt,
    resolveIsolationDbPath,
    seedLegacyStoryCardPartsByPrompt,
} from "./helpers/db";

/** 同帧起播证据：一次 evaluate 原子读取 <audio> 真实播放态 + Mini 可见性/状态。 */
interface SameFramePlayback {
    /** 实际音频地址（blob: 表示 provider 合成，legacy URL 被忽略）。 */
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
async function waitForPlaybackWithMini(
    page: import("@playwright/test").Page,
    timeout = 90000,
): Promise<SameFramePlayback> {
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

/**
 * 真实创作一段故事（mock 上游），返回唯一提示词与本次提示词名下的全部 Work id（升序）。
 * 等待生成历史行数静止（自动续写也会落一条 Work，必须等它定型再取基线）。
 * @param page Playwright 页面
 * @param scenario 场景短名（保证提示词唯一）
 * @param dbFile 隔离库路径
 * @returns 提示词与该提示词名下的 Work id（升序）
 */
async function generateStory(
    page: import("@playwright/test").Page,
    scenario: string,
    dbFile: string,
): Promise<{ prompt: string; workIds: number[] }> {
    const prompt: string = `M9F01L3${scenario}${Date.now()}${Math.floor(Math.random() * 100000)}请讲一个动物朋友互相帮助的故事。`;
    const composer = page.getByPlaceholder("请输入内容...");
    await composer.fill(prompt);
    await page.getByRole("button", { name: "发送" }).click({ timeout: 15000 });
    await expect(composer).toBeEnabled({ timeout: 90000 });
    // 中文注释：等自动续写/落库静止（3s 内行数不变），确保全部 Work 行与 Anchor 已定型。
    let rows = findGuestGenerationsByPrompt(dbFile, prompt);
    const deadline = Date.now() + 60000;
    for (;;) {
        await page.waitForTimeout(3000);
        const recount = findGuestGenerationsByPrompt(dbFile, prompt);
        if (recount.length === rows.length && rows.length >= 1) {
            rows = recount;
            break;
        }
        rows = recount;
        if (Date.now() >= deadline) {
            break;
        }
    }
    expect(rows.length).toBeGreaterThanOrEqual(1);
    return { prompt, workIds: rows.map((row) => row.id) };
}

/** 导航到空白页并静置，确保客户端完全停止（不再写 checkpoint/anchor/parts）后再做库夹具。 */
async function detachClient(page: import("@playwright/test").Page): Promise<void> {
    await page.goto("about:blank", { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(2000);
}

/**
 * 从 tRPC 请求体解析指定 procedure 的 input（身份绑定的判据）。
 *
 * wire 依据（tRPC v11 + superjson；客户端见 `lib/trpc/client.ts` 的
 * `httpBatchLink`，服务端按同一 shape 反序列化）：
 * - URL pathname 末段为逗号分隔的 procedure 名（batch），形如
 *   `/api/trpc/playback.beginSession,playback.getAnchor`；
 * - POST body 为 `{"<index>":{"json":<input>,"meta":{...}},...}`，`index` 与
 *   URL 中 procedure 的先后顺序一致；单发（非 batch）时为
 *   `{"json":<input>,"meta":{...}}`。
 * 故先按 procedure 在 URL 中的下标取对应 body 项，再解 superjson 的 `json`
 * 包装。任何一步解析失败都返回 null，由调用方 fail-closed——绝不退化为
 * 「只看 URL」的弱匹配。
 * @param response Playwright 抓到的响应
 * @param procedure 目标 procedure 名（如 `playback.beginSession`）
 * @returns 该 procedure 的 input 对象，或 null
 */
function parseTrpcInput(
    response: import("@playwright/test").Response,
    procedure: string,
): Record<string, unknown> | null {
    let path: string;
    try {
        path = new URL(response.url()).pathname.split("/").pop() ?? "";
    } catch {
        return null;
    }
    const index: number = path.split(",").indexOf(procedure);
    if (index < 0) {
        return null;
    }
    const rawBody: string | null = response.request().postData();
    if (!rawBody) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawBody);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") {
        return null;
    }
    const batchEntry = (parsed as Record<string, unknown>)[String(index)];
    for (const candidate of [batchEntry, parsed]) {
        if (!candidate || typeof candidate !== "object") {
            continue;
        }
        const record = candidate as Record<string, unknown>;
        if (record.json && typeof record.json === "object") {
            return record.json as Record<string, unknown>;
        }
        if (!("json" in record) && !("meta" in record)) {
            return record;
        }
    }
    return null;
}

test("M9-F01 故事卡播放（Legacy audioUrl 两种形态）全局控制同帧可达", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(180000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    const dbFile: string = resolveIsolationDbPath(harnessEnv.runId);

    await ensureGuestByApi(page, harnessEnv.appUrl);
    const { prompt } = await generateStory(page, "卡片", dbFile);
    recorder.step("真实创作完成", { prompt });

    // 中文注释：先离开页面让客户端静止，再植入“旧历史卡”（服务端 guard 禁止新增
    // legacy storyCard 写入，故只经隔离库直写模拟旧数据）并清 Anchor（冷态无 Session）。
    for (const audioUrl of ["https://legacy.example.com/whole.mp3", ""]) {
        await detachClient(page);
        const storyText: string = seedLegacyStoryCardPartsByPrompt(dbFile, prompt, audioUrl);
        deleteGuestPlaybackAnchorByPrompt(dbFile, prompt);
        recorder.step("植入 Legacy 卡片并清 Anchor", { audioUrl, storyLength: storyText.length });

        await page.goto(`${harnessEnv.appUrl}/chat`, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForTimeout(2000);
        await dismissOnboarding(page);

        // 中文注释：冷态断言——点击前无 Session（无 Mini、无预置 Anchor）。
        const mini = page.locator('[data-testid="mini-now-playing"]');
        await expect(mini).toHaveCount(0, { timeout: 15000 });
        await page.waitForTimeout(500);
        await expect(mini).toHaveCount(0, { timeout: 5000 });

        const playButton = page.getByRole("button", { name: "播放故事" }).first();
        await expect(playButton).toBeVisible({ timeout: 30000 });
        await playButton.click({ timeout: 15000 });

        const frame = await waitForPlaybackWithMini(page);
        expect(frame.miniVisible).toBe(true);
        expect(frame.miniStatus).toBe("playing");
        expect(frame.paused).toBe(false);
        // 中文注释：Legacy persisted audioUrl 绝不被当作 paragraph 0 播放——
        // 实际音源必须是 provider 合成产物（chromium=blob:，webkit=blob:/data:audio），
        // 绝不能是那个 legacy URL。
        expect(frame.src).not.toContain("legacy.example.com");
        expect(/^(blob:|data:audio\/)/.test(frame.src), `frame=${JSON.stringify(frame)}`).toBe(true);
        recorder.step("卡片起播同帧快照", { audioUrl, ...frame });

        // 中文注释：真 server Anchor 身份 = draft/该消息（证明点击建立了正式 Session）。
        await expect.poll(() => safeAnchorKind(dbFile, prompt), { timeout: 15000 }).toBe("draft");
        const anchor = safeAnchor(dbFile, prompt);
        expect(anchor?.sourceId.length).toBeGreaterThan(0);
        expect(anchor?.sourceId).not.toContain("legacy.example.com");
        recorder.step("Anchor 身份", { audioUrl, anchor });
    }
    // 中文注释：播放结束前不断言方向键行为；本用例只负责全局控制入口可达。
    await page.waitForTimeout(1000);
});

test("M9-F01 生成历史回放走正式 Work Session 且全局控制同帧可达", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(180000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    const dbFile: string = resolveIsolationDbPath(harnessEnv.runId);

    await ensureGuestByApi(page, harnessEnv.appUrl);
    const { prompt, workIds } = await generateStory(page, "历史", dbFile);
    recorder.step("真实创作完成", { prompt, workIds });

    // 中文注释：生成完成后的 autoplay 链可能仍在途；先分离客户端再重载，杜绝
    // 后台 Draft autoplay 晚到覆盖用户显式回放的 Work Session（真实产品里用户
    // 不会在 autoplay 进行中立刻点历史回放，这里让前置确定化，oracle 不放宽）。
    await detachClient(page);
    await page.goto(`${harnessEnv.appUrl}/chat`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2000);
    await dismissOnboarding(page);
    await page.getByRole("button", { name: "打开历史" }).click({ timeout: 15000 });
    await page.getByRole("tab", { name: "生成历史" }).click({ timeout: 15000 });
    await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 30000 });
    // 中文注释：自动续写会以同一提示词再落一条 Work；UI 顺序为 createdAt desc,id desc，
    // 故列表首条 = 最大 id。点首条（最新）并断言 Session 绑定到该 Work。
    const newestWorkId = String(workIds[workIds.length - 1]);
    const historyItem = page.locator('[class*="historyItem"]').filter({ hasText: prompt }).first();
    await expect(historyItem).toBeVisible({ timeout: 30000 });

    // M10-05-H1-F1-F2：先武装本次 Work 回放的 beginSession 响应等待，再点击回放；
    // 待该次 beginSession settle（产品 anchor upsert 已提交）后，才开始下方
    // safeAnchorKind 直连只读轮询，避免 test 侧直读与产品写窗口对撞触发
    // SQLITE_BUSY → 500 → Anchor 停在 draft。只等 settle，不新增「必须 200」
    // 之类新 oracle：若产品自身仍 500，settle 后 Anchor 仍 draft，原断言照常失败。
    //
    // 身份绑定（F2 收口）：只按 URL 匹配 procedure 名不足以放行——一次无关的
    // draft beginSession 晚到并 resolve 会提前放行 barrier，使用户 work click 的
    // beginSession 仍在写 Anchor 时 safeAnchorKind 就开始直读，observer-effect
    // 窗口重现。故必须同时满足：
    //   1) procedure 名 = playback.beginSession（URL pathname 末段）；
    //   2) 该请求 input.source.kind === "work"；
    //   3) String(input.source.workId) === newestWorkId（本用例已解析的最新 Work id）。
    const isNewestWorkBeginSession = (
        response: import("@playwright/test").Response,
    ): boolean => {
        const input = parseTrpcInput(response, "playback.beginSession");
        if (!input) {
            return false;
        }
        const source = input.source as Record<string, unknown> | undefined;
        if (!source || source.kind !== "work") {
            return false;
        }
        return String(source.workId) === newestWorkId;
    };
    const beginSessionSettled = page.waitForResponse(isNewestWorkBeginSession, {
        timeout: 30000,
    });
    await historyItem.getByRole("button", { name: "回放此故事" }).click({ timeout: 15000 });
    await beginSessionSettled;

    // 中文注释：回放必须建立 work Session（真 server Anchor sourceType=work/sourceId=该 Work）。
    await expect.poll(() => safeAnchorKind(dbFile, prompt), { timeout: 30000 }).toBe("work");
    const anchor = safeAnchor(dbFile, prompt);
    expect(workIds.map((id) => String(id))).toContain(anchor?.sourceId);
    expect(anchor?.sourceId).toBe(newestWorkId);
    recorder.step("回放 Anchor 身份", { anchor, newestWorkId });

    const frame = await waitForPlaybackWithMini(page);
    expect(frame.miniVisible).toBe(true);
    expect(frame.miniStatus).toBe("playing");
    expect(frame.paused).toBe(false);
    recorder.step("历史回放同帧快照", { ...frame });
    await page.waitForTimeout(1000);
});
