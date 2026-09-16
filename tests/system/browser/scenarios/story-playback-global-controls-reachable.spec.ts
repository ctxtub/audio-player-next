//：任何用户可感知的故事播放都必须先有正式 PlaybackSession；
// 唯一真实 UI 入口 StoryCard（Legacy 卡片，含 persisted audioUrl）：
// 起播时 <audio> 真实出声，且同帧 MiniNowPlaying 可见
//（Mini 显隐只派生自 Session：source !== null && status !== 'idle'）。
// 不预置 Session（先清 Anchor 冷态），由真实点击驱动；retries=0，不合成媒体事件。
//：Chat History Surface（打开历史 / 生成历史 / 回放此故事）已退役，
// 原「生成历史回放」用例随该入口一并移除；Work Session 覆盖仍由
// canonical-work-playback 与 storycard-session-flow 承担。
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

test("故事卡播放后全局控制立即可用", async ({ page, harnessEnv }) => {
    test.setTimeout(180000);
    const dbFile: string = resolveIsolationDbPath(harnessEnv.runId);

    await ensureGuestByApi(page, harnessEnv.appUrl);
    const { prompt } = await generateStory(page, "卡片", dbFile);

    // 中文注释：先离开页面让客户端静止，再植入“旧历史卡”（服务端 guard 禁止新增
    // legacy storyCard 写入，故只经隔离库直写模拟旧数据）并清 Anchor（冷态无 Session）。
    for (const audioUrl of ["https://legacy.example.com/whole.mp3", ""]) {
        await detachClient(page);
        const storyText: string = seedLegacyStoryCardPartsByPrompt(dbFile, prompt, audioUrl);
        deleteGuestPlaybackAnchorByPrompt(dbFile, prompt);

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

        // 中文注释：真 server Anchor 身份 = draft/该消息（证明点击建立了正式 Session）。
        await expect.poll(() => safeAnchorKind(dbFile, prompt), { timeout: 15000 }).toBe("draft");
        const anchor = safeAnchor(dbFile, prompt);
        expect(anchor?.sourceId.length).toBeGreaterThan(0);
        expect(anchor?.sourceId).not.toContain("legacy.example.com");
    }
    // 中文注释：播放结束前不断言方向键行为；本用例只负责全局控制入口可达。
    await page.waitForTimeout(1000);
});
