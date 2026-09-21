import { test, expect } from "../harness/fixtures";
import { enterGuestChat } from "./helpers/guest";
import {
    captureVisual,
    cardActionButtons,
    composerInput,
    continuousStatusText,
    readMiniTitles,
    sendStory,
    setContinuousEnabled,
    waitAutoplayedCardActive,
    waitStoryCardReady,
} from "./helpers/creation-journey";

/**
 * 连续创作下一作品交接（准备 → 条件等待 → 自动续播 → 预算）。
 *
 * 编排确定性说明（只描述用户可见因果，不触内部）：
 * - 播放尾段会自动准备下一篇；当前播完而下一篇未就绪时，下一篇卡片
 *   明确进入「当前故事已结束，正在等待下一篇」（等待期间不消耗预算），
 *   就绪后自动续播，无需用户再点一次播放。
 * - 下一篇可能提前准备完成，也可能在当前篇结束后仍未就绪；只有后一种情况
 *   才出现等待态。旅程不通过人为减速制造分支，等待真实出现时再验证预算暂停。
 *
 * 全程只认可见 UI：状态卡文案、预算文本、卡片按钮文案、Mini 标题。不读
 * Store、不调 API、不读隐藏 DOM、不设任何测试开关。
 */
test.describe("连续创作下一篇准备与自动续播", () => {
    test("连续创作下一篇准备与自动续播", async ({ page, harnessEnv }) => {
        test.setTimeout(240000);
        await enterGuestChat(page, harnessEnv.appUrl);
        const appUrl = harnessEnv.appUrl;

        // ① 连续创作默认开启；预算默认不限（秒级预算断言需先经设置页设为有限）。
        await expect(continuousStatusText(page)).toHaveText("连续创作已开启", { timeout: 15000 });
        const budget = page.getByTestId("continuous-remaining-budget");
        await expect(budget).toHaveText("剩余 不限", { timeout: 10000 });

        // ② 设置页把默认睡眠定时设为 10 分钟（可见滑块 Home 键直达最小值），
        // 回创作页新建会话使预算快照为有限值。
        await page.goto(`${appUrl}/setting`, { waitUntil: "networkidle", timeout: 60000 });
        const timerSlider = page.getByRole("slider").first();
        await expect(timerSlider).toBeVisible({ timeout: 15000 });
        await timerSlider.focus();
        await page.keyboard.press("Home");
        await page.waitForTimeout(1500);
        await page.goto(`${appUrl}/chat`, { waitUntil: "networkidle", timeout: 60000 });
        await page.getByRole("button", { name: "新建创作" }).click();
        await expect(budget).toHaveText("剩余 10:00", { timeout: 15000 });
        await expect(composerInput(page)).toBeEnabled({ timeout: 15000 });
        await page.waitForTimeout(500);

        // ③ 发起第一篇并等其就绪，记下集合标题（晋升成功后收敛）。
        await sendStory(page, "讲一个关于森林邮递员的故事");
        await waitStoryCardReady(page, 0);
        const barTitle = page.getByTestId("continuous-collection-title");
        await expect
            .poll(async () => (await barTitle.innerText()).trim(), { timeout: 30000 })
            .not.toBe("新作品集");
        const collectionTitle = (await barTitle.innerText()).trim();
        expect(collectionTitle.length).toBeGreaterThan(0);

        // ④ 第一轮交接：首篇草稿自动起播后保持无人干预；第二篇（系统续写）
        // 无人点击却进入播放态 = 当前作品自然结束后的自动续播真实发生。
        // 此处不可等待首篇落定后再重播，否则可能在接力已开始时把播放抢回首篇。
        await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 60000 });
        await waitAutoplayedCardActive(page, 1, 150000);

        // ⑤ 观察下一轮交接。若真实进入等待态，验证等待期间预算不推进；
        // 若提前准备完成，则直接验证下一篇无人点击自动进入播放。
        const waitingStatus = page
            .getByTestId("continuous-next-card")
            .getByRole("status")
            .filter({ hasText: "当前故事已结束，正在等待下一篇" });
        const nextCardScope = page.getByTestId("continuous-next-card");
        let waitingBudget: string | null = null;
        let sendRetries = 0;
        const nextCardIndex = await cardActionButtons(page).count();
        const deadline = Date.now() + 150000;
        for (;;) {
            if ((await nextCardScope.getByText("发送失败").count()) > 0) {
                sendRetries += 1;
                if (sendRetries > 2) {
                    throw new Error("next-work send failed persistently after 2 product retries");
                }
                await nextCardScope.getByRole("button", { name: "重试" }).click();
                await page.waitForTimeout(2000);
                continue;
            }
            if ((await waitingStatus.count()) > 0) {
                const currentBudget = (await budget.innerText()).trim();
                if (waitingBudget === null) {
                    waitingBudget = currentBudget;
                    await captureVisual(page, "waiting-for-next-story");
                } else {
                    expect(currentBudget).toBe(waitingBudget);
                }
            }
            const buttons = cardActionButtons(page);
            if ((await buttons.count()) > nextCardIndex) {
                const label = (await buttons.nth(nextCardIndex).innerText()).trim();
                if (label === "暂停" || label === "重新播放") {
                    break;
                }
            }
            if (Date.now() >= deadline) {
                throw new Error("next story did not autoplay within the visible journey budget");
            }
            await page.waitForTimeout(100);
        }

        // ⑥ 自动续播后 Mini 复现同集合标题。
        const mini = await readMiniTitles(page);
        expect(mini.title).toBe(collectionTitle);
        await expect(budget).toContainText("剩余", { timeout: 10000 });

        // ⑦ 关开关收尾（在途续写被真取消，只认关闭文案）。
        await setContinuousEnabled(page, false);
    });
});
