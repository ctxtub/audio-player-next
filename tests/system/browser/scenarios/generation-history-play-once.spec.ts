// case_id: generation-history-play-once
// journey: history-reuse-playback
// legacy_aliases: [E2E-02-11-02, H-21]
// M4-07 relocation：History ownership 已回迁 Chat（Chat History Surface），/player 不再拥有 History 入口；
// 本用例自 M4-10 起改走聊天页「历史」按钮 + 面板内「生成历史」分段，oracle 不变
// （source/text 匹配、不触发 Agent/新历史/续写、oneShot 本页单次）。
import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { countTableRows, resolveIsolationDbPath } from "./helpers/db";

/**
 * 生成历史本页单次回放（旧 E2E-02-11-02/H-21，现 Chat-owned History Surface）。
 *
 * 断言绑定方案第6节：source/text 匹配；不触发 Agent/新历史/续写。
 * oneShot 播放源切换、不新增历史（隔离库计数不变）、不污染聊天、不触发续写。
 * 真媒体事件由浏览器自然产生，不用 dispatchEvent 合成。
 */
test("生成历史本页单次回放", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(120000);
    /** 证据记录器（fixtures 自动挂载，显式取用以记录外部时间线与库路径）。 */
    const recorder = evidence as unknown as {
        step: (name: string, detail?: unknown) => void;
    };
    /** 当次运行隔离库路径（evidence-recorder 同源直查）。 */
    const dbFile: string = resolveIsolationDbPath(harnessEnv.runId);
    recorder.step("隔离库直查路径", { dbFile });
    /** 本用例唯一提示词（串行共享库内唯一键）。 */
    const prompt: string = `L3回放${Date.now()}${Math.floor(Math.random() * 100000)}请讲一个动物朋友互相帮助的故事。`;
    /** Agent/续写相关请求计数（回放段只允许 TTS，不允许 Agent）。 */
    let agentCalls = 0;
    page.on("request", (request) => {
        const url: string = request.url();
        if (url.includes("agent.interact")) {
            agentCalls += 1;
        }
    });

    // 中文注释：经真实访客 API 进入创作页（双浏览器稳态，见 helpers/auth）。
    await ensureGuestByApi(page, harnessEnv.appUrl);

    // 中文注释：先完成一次真实创作，使生成历史落库（回放前置）。
    const composer = page.getByPlaceholder("请输入内容...");
    await composer.fill(prompt);
    await page.getByRole("button", { name: "发送" }).click({ timeout: 15000 });
    await expect(composer).toBeEnabled({ timeout: 90000 });
    /** 回放前访客生成历史行数（DB 断言基线）。 */
    const historyBefore: number = countTableRows(dbFile, "GuestGenerationHistory");
    expect(historyBefore).toBeGreaterThanOrEqual(1);
    recorder.step("回放前基线", { historyBefore });

    // 中文注释：开聊天历史切生成历史（M4-07 后入口为聊天页「历史」按钮），清空 Agent 计数后点回放（本页单次）。
    await dismissOnboarding(page);
    await page.getByRole("button", { name: "打开历史" }).click({ timeout: 15000 });
    await page.getByRole("tab", { name: "生成历史" }).click({ timeout: 15000 });
    await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 30000 });
    agentCalls = 0;
    await page.getByRole("button", { name: "回放此故事" }).first().click({ timeout: 15000 });

    // 中文注释：oneShot 播放源切换——产品隐藏 audio 经自然 loadedmetadata 起播，
    // 等待自然播放证据（playing/ended/currentTime 任一），不断言合成细节。
    const replayed = await page.evaluate(async () => {
        const audio = document.querySelector("audio") as HTMLAudioElement | null;
        if (!audio) {
            return { hasAudio: false, played: false, readyState: 0 };
        }
        const played = await new Promise<boolean>((resolve) => {
            let done = false;
            const finish = (value: boolean): void => {
                if (!done) {
                    done = true;
                    resolve(value);
                }
            };
            const timer = window.setTimeout(() => finish(!audio.paused || audio.currentTime > 0 || audio.ended), 30000);
            const onPlaying = (): void => {
                window.clearTimeout(timer);
                finish(true);
            };
            const onEnded = (): void => {
                window.clearTimeout(timer);
                finish(true);
            };
            audio.addEventListener("playing", onPlaying, { once: true });
            audio.addEventListener("ended", onEnded, { once: true });
            if (!audio.paused || audio.ended || audio.currentTime > 0) {
                window.clearTimeout(timer);
                finish(true);
            }
        });
        return { hasAudio: true, played, readyState: audio.readyState };
    });
    expect(replayed.hasAudio).toBe(true);
    expect(replayed.played).toBe(true);
    expect(replayed.readyState).toBeGreaterThanOrEqual(1);
    recorder.step("回放自然起播", replayed);

    // 中文注释：回放后静置一段，让可能的续写/误落库有机会发生（误行为会如实失败）。
    await page.waitForTimeout(5000);

    // 中文注释：DB 断言——回放不新增历史（隔离库计数不变）。
    /** 回放后访客生成历史行数。 */
    const historyAfter: number = countTableRows(dbFile, "GuestGenerationHistory");
    expect(historyAfter).toBe(historyBefore);
    // 中文注释：network 断言——回放不触发 Agent/续写。
    expect(agentCalls).toBe(0);
    // 中文注释：聊天断言——回放不污染聊天（本次创作仍在，无新增续写气泡改变主体）。
    await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 30000 });
    recorder.step("回放无副作用", { historyBefore, historyAfter, agentCalls });
});
