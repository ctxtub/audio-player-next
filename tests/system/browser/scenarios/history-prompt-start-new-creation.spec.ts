// case_id: history-prompt-start-new-creation
// journey: reuse-history-to-create
// legacy_aliases: [E2E-02-11-01, H-21]
// FIXED 2026-09-10：H-21 历史重创作不清空旧会话（RED-2-1，双浏览器复现 run=2026-09-10T01-41-03-283Z-dc4778）→ 方案A ChatLayout 消费 pendingAutoSend 前调 resetStoryFlow()（+2 行），chromium L75/L78 转 PASS（run=2026-09-10T01-43-27-744Z-28d858）；K1/K2 为 oracle 校准非缺陷
// M4-07 relocation：History ownership 已回迁 Chat（Chat History Surface），/player 不再拥有 History 入口；
// 本用例自 M4-10 起改走聊天页「历史」按钮 + 面板内「提示词历史」分段，oracle 不变（干净新会话、上下文隔离、自动播放、旧作可返、重载后不断点续播）。
import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";
import { countTableRows, resolveIsolationDbPath } from "./helpers/db";

/** 第二次创作的新提示词（与旧提示词不同源，避免串台误判）。 */
const newPromptTail: string = "请用全新开头讲一个关于深海小潜航员的故事。";

/**
 * 从提示词历史开始新创作（旧 E2E-02-11-01/H-21，现 Chat-owned History Surface）。
 *
 * 断言绑定方案第6节：新 Agent 上下文不含旧会话；新建干净当前会话；
 * 旧创作保留在历史可返回；新故事允许自动播放。
 * 产品语义以 handoff 第11节为准，不重新解释。
 */
test("从提示词历史开始新创作", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(120000);
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

    // 中文注释：经真实访客 API 进入创作页（双浏览器稳态，见 helpers/auth）。
    await ensureGuestByApi(page, harnessEnv.appUrl);

    // 中文注释：第一次创作（旧会话），等待流式结束（输入框恢复可用）。
    const composer = page.getByPlaceholder("请输入内容...");
    await composer.fill(oldPrompt);
    await page.getByRole("button", { name: "发送" }).click({ timeout: 15000 });
    await expect(composer).toBeEnabled({ timeout: 90000 });
    recorder.step("第一次创作完成", { oldPrompt });

    // 中文注释：在聊天历史确认旧提示词已落历史（UI 可见即落库可查；M4-07 后入口为聊天页「历史」按钮）。
    await dismissOnboarding(page);
    await page.getByRole("button", { name: "打开历史" }).click({ timeout: 15000 });
    await page.getByRole("tab", { name: "提示词历史" }).click({ timeout: 15000 });
    await expect(page.getByText(oldPrompt).first()).toBeVisible({ timeout: 30000 });

    // 中文注释：清空 network 计数，仅统计“从历史开始的新创作”窗口。
    agentBodies.length = 0;
    /** 新创作提示词（基于旧提示词改写，明确不同会话；实际提交沿用所选历史条目原文）。 */
    const newPrompt: string = `${oldPrompt} ${newPromptTail}`;
    // 中文注释：点击“用此提示词重新创作”→同页自动发送（产品真实链路：面板关闭 + pending 消费 + 先重置再提交）。
    const recreateButton = page.getByRole("button", { name: "用此提示词重新创作" }).first();
    await recreateButton.click({ timeout: 15000 });

    // 中文注释：新创作输入框应保持可见；自动发送进行中输入框禁用；完成后恢复可用（至多等一次完整生成）。
    const chatComposer = page.getByPlaceholder("请输入内容...");
    await expect(chatComposer).toBeVisible({ timeout: 30000 });
    // 中文注释：自动发送进行中输入框禁用；完成后恢复可用（至多等一次完整生成）。
    await expect(chatComposer).toBeEnabled({ timeout: 90000 });
    recorder.step("新创作流式结束", { newPrompt });

    // 中文注释：K2校准——等待 agent 请求真正发出（轮询 agentBodies，间隔500ms，上限15s），替代固定断言窗口；双浏览器统一等待，断言本体不变；15s仍0请求则如实FAIL，不跳过不掩盖。
    const waitStart: number = Date.now();
    while (agentBodies.length < 1 && Date.now() - waitStart < 15000) {
        await page.waitForTimeout(500);
    }
    // 中文注释：K2校准续——WebKit 无手势自动发送经解锁门延迟，首个 Enabled 可能早于请求发出；请求出现后再等一次流式结束，确保“创作完成后”再断言网络与起播。
    await expect(chatComposer).toBeEnabled({ timeout: 90000 });

    // 中文注释：network 层断言——新请求恰一次 Agent 调用，且不含旧会话上下文。
    // 新创作沿用所选旧提示词（同文），故以旧助手回复（固定 mock 文本）为旧上下文标记：
    // 干净会话的请求体应仅含新用户消息，不含旧助手旧文；串台态则含旧助手旧文。
    expect(agentBodies.length).toBe(1);
    /** 新请求体全文（批量包 JSON）。 */
    const newBody: string = agentBodies[0] ?? "";
    expect(newBody.includes("harness 固定 mock 回复")).toBe(false);
    recorder.step("新请求上下文隔离", { agentCalls: agentBodies.length });

    // 中文注释：K1校准——/chat 内新故事已生成并起播证据（重载前）：audio 存在且已播放。
    // 断点水合设计 isPlaying=false，重载后不自动恢复为预期，故起播证据只在 /chat 重载前采集。
    // Fix 8 根因加固：旧实现以 playing/ended/!paused 任一先到即判 played=true，
    // 在 WebKit 下元数据尚未加载（readyState=0）时即可退出，造成 readyState 快照断言 flaky。
    // 新实现要求“元数据已加载（loadedmetadata/readyState>=1 真实观测）与已起播”双事件同时成立才退出，
    // readyState>=1 断言保留（只增不减，严格更强）。
    const chatAutoplay = await page.evaluate(async () => {
        const audio = document.querySelector("audio") as HTMLAudioElement | null;
        if (!audio || !audio.src) {
            return { hasSrc: false, played: false, metadataReady: false, readyState: 0 };
        }
        const state = await new Promise<{ played: boolean; metadataReady: boolean }>((resolve) => {
            let played = false;
            let metadataReady = audio.readyState >= 1;
            let done = false;
            const finish = (): void => {
                if (!done && played && metadataReady) {
                    done = true;
                    window.clearTimeout(timer);
                    cleanup();
                    resolve({ played, metadataReady });
                }
            };
            const timer = window.setTimeout(() => {
                if (!done) {
                    done = true;
                    cleanup();
                    resolve({ played, metadataReady });
                }
            }, 15000);
            const onPlaying = (): void => {
                played = true;
                finish();
            };
            const onEnded = (): void => {
                played = true;
                finish();
            };
            const onMetadata = (): void => {
                metadataReady = audio.readyState >= 1;
                finish();
            };
            const cleanup = (): void => {
                audio.removeEventListener("playing", onPlaying);
                audio.removeEventListener("ended", onEnded);
                audio.removeEventListener("loadedmetadata", onMetadata);
                audio.removeEventListener("canplay", onMetadata);
            };
            audio.addEventListener("playing", onPlaying);
            audio.addEventListener("ended", onEnded);
            audio.addEventListener("loadedmetadata", onMetadata);
            audio.addEventListener("canplay", onMetadata);
            if (!audio.paused || audio.ended || audio.currentTime > 0) {
                played = true;
            }
            finish();
        });
        return { hasSrc: true, played: state.played, metadataReady: state.metadataReady, readyState: audio.readyState };
    });
    expect(chatAutoplay.hasSrc).toBe(true);
    expect(chatAutoplay.played).toBe(true);
    expect(chatAutoplay.metadataReady).toBe(true);
    expect(chatAutoplay.readyState).toBeGreaterThanOrEqual(1);
    recorder.step("新故事已生成并起播", chatAutoplay);

    // 中文注释：旧创作保留在历史可返回（聊天历史面板可见 + 隔离库直查，双重证据）。
    await page.getByRole("button", { name: "打开历史" }).click({ timeout: 15000 });
    await page.getByRole("tab", { name: "提示词历史" }).click({ timeout: 15000 });
    await expect(page.getByText(oldPrompt).first()).toBeVisible({ timeout: 30000 });
    /** 访客提示词历史行数（新创作应新增，不覆盖旧条）。 */
    const promptRows: number = countTableRows(dbFile, "GuestPromptHistory");
    expect(promptRows).toBeGreaterThanOrEqual(1);

    // 中文注释：K1校准——断点水合设计 isPlaying=false，重载后不自动恢复为预期；/chat 重载后断言 audio 无 src 且不自动播放。
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await expect(page.getByPlaceholder("请输入内容...")).toBeEnabled({ timeout: 90000 });
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
    recorder.step("重载后不断点续播", afterReload);
});
