import { test, expect } from "../harness/fixtures";
import { enterGuestChat } from "./helpers/guest";
import {
    cardActionButton,
    cardActionButtons,
    chatContent,
    composerInput,
    continuousStatusText,
    playCardWhenSettled,
    readMiniTitles,
    sendStory,
    setContinuousEnabled,
    waitStoryCardReady,
} from "./helpers/creation-journey";

/**
 * 旅程三：播放中 / 准备中新建创作强重置。
 *
 * - 播放中重置：起播后看到「暂停」（播放中）即点新建创作，确认后旧声立停、
 *   Mini 消失、回到空对话，且迟到结果不再复活。
 * - 已入库旧作不受影响（故事库仍可见旧集合）。
 * - 准备中重置：点播放后不等就绪即新建创作，迟到的音频准备不得复活 Mini。
 * - 生成中重置：发送后仍在流式时新建创作，旧流被真中断，不留下半截卡片。
 *
 * 全程只认可见 UI：按钮文案、Mini 显隐、空态文案、输入框状态、URL。
 * 不读 Store、不调 API、不读隐藏 DOM、不设任何测试开关。
 */
test.describe("播放与准备中新创作强重置", () => {
    test("播放与准备中新创作强重置", async ({ page, harnessEnv }) => {
        test.setTimeout(240000);
        await enterGuestChat(page, harnessEnv.appUrl);
        const appUrl = harnessEnv.appUrl;

        // 原生确认框：一律接受并记录（三次重置都有旧消息，都会弹框）。
        const dialogs: string[] = [];
        page.on("dialog", (dialog) => {
            dialogs.push(dialog.message());
            void dialog.accept();
        });

        // ① 先关开关（证明重置后默认回到开启）。
        await setContinuousEnabled(page, false);
        await sendStory(page, "写一个关于旧钟楼的故事");
        await waitStoryCardReady(page, 0);
        const barTitle = page.getByTestId("continuous-collection-title");
        await expect
            .poll(async () => (await barTitle.innerText()).trim(), { timeout: 30000 })
            .not.toBe("新作品集");
        const collectionTitle = (await barTitle.innerText()).trim();
        expect(collectionTitle.length).toBeGreaterThan(0);

        // ② 播放中重置：草稿自动播起播（Mini 现身）后重播作品（Mini 显示集合标题），
        // 看到暂停（播放中）即新建创作。
        await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 60000 });
        await playCardWhenSettled(page, 0);
        const miniBefore = await readMiniTitles(page);
        expect(miniBefore.title).toBe(collectionTitle);
        await page.getByRole("button", { name: "新建创作" }).click();
        expect(dialogs.length).toBeGreaterThanOrEqual(1);
        expect(dialogs[dialogs.length - 1]).toContain("新建创作");

        // ③ 立即回到空对话初始态：无 Mini、无卡片按钮、空态文案、输入框清空可用、
        // 开关回到默认开启、新作品集占位。
        await expect(page.getByTestId("mini-now-playing")).toBeHidden({ timeout: 10000 });
        await expect(page.getByText("暂未开始任何对话")).toBeVisible({ timeout: 10000 });
        await expect(composerInput(page)).toHaveValue("");
        await expect(composerInput(page)).toBeEnabled();
        await expect(page.getByRole("button", { name: "发送" })).toBeEnabled();
        await expect(continuousStatusText(page)).toHaveText("连续创作已开启", { timeout: 10000 });
        expect((await page.getByTestId("continuous-collection-title").innerText()).trim()).toBe(
            "新作品集",
        );

        // ④ 沉淀 8 秒：迟到的准备/生成结果不得复活旧卡片与 Mini。
        await page.waitForTimeout(8000);
        expect(await cardActionButtons(page).count()).toBe(0);
        await expect(page.getByTestId("mini-now-playing")).toBeHidden();
        await expect(page.getByText("暂未开始任何对话")).toBeVisible();

        // ⑤ 已入库旧作不受影响：故事库仍可见旧集合与原标题。
        await page.goto(`${appUrl}/library`, { waitUntil: "networkidle", timeout: 60000 });
        const libraryCard = page.getByTestId(/^collection-card-/).first();
        await expect(libraryCard).toBeVisible({ timeout: 15000 });
        expect(((await libraryCard.getByTestId("collection-title").innerText()).trim())).toBe(
            collectionTitle,
        );
        await page.goto(`${appUrl}/chat`, { waitUntil: "networkidle", timeout: 60000 });
        await expect(page.getByText("暂未开始任何对话")).toBeVisible({ timeout: 15000 });

        // ⑥ 准备中重置：新会话发一篇，就绪后点播放、不等出声即新建创作。
        await sendStory(page, "写一个关于青石巷的故事");
        await waitStoryCardReady(page, 0);
        await cardActionButton(page, 0).click();
        await page.getByRole("button", { name: "新建创作" }).click();
        await page.waitForTimeout(8000);
        await expect(page.getByTestId("mini-now-playing")).toBeHidden({ timeout: 10000 });
        expect(await cardActionButtons(page).count()).toBe(0);
        await expect(page.getByText("暂未开始任何对话")).toBeVisible();

        // ⑦ 生成中重置：发送后看到用户气泡（旧会话消息已落定，确认框必弹）
        // 即新建创作，旧流被中断，不留半截卡片。
        await sendStory(page, "写一个关于白塔湖的故事");
        await expect(
            chatContent(page).locator("span").filter({ hasText: "写一个关于白塔湖的故事" }).first(),
        ).toBeVisible({ timeout: 15000 });
        await page.getByRole("button", { name: "新建创作" }).click();
        await page.waitForTimeout(10000);
        expect(await cardActionButtons(page).count()).toBe(0);
        await expect(page.getByTestId("mini-now-playing")).toBeHidden();
        await expect(page.getByText("暂未开始任何对话")).toBeVisible();
        expect(page.url()).toContain(`${appUrl}/chat`);
    });
});
