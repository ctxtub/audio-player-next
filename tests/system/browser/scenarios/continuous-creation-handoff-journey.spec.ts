import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";
import {
    captureVisual,
    cardActionButtons,
    continuousStatusText,
    playCardWhenSettled,
    readMiniTitles,
    sendStory,
    setContinuousEnabled,
    waitAutoplayedCardActive,
    waitStoryCardReady,
} from "./helpers/creation-journey";

/**
 * 旅程二：连续创作下一作品交接（等待 → 自动续播 → 预算）。
 *
 * 编排确定性说明（只描述用户可见因果，不触内部）：
 * - 播放尾段会自动准备下一篇；当前播完而下一篇未就绪时，下一篇卡片
 *   明确进入「当前故事已结束，正在等待下一篇」（等待期间不消耗预算），
 *   就绪后自动续播，无需用户再点一次播放。
 * - 第一轮交接（用户起播 A → 系统 B）只断言自动续播发生（B 无人点击却播完）；
 *   第二轮及之后的交接必经过等待态（调度发生在尾段上一秒内，准备需数秒），
 *   等待与预算断言锚定在这些轮次，最多顺延三轮。
 *
 * 全程只认可见 UI：状态卡文案、预算文本、卡片按钮文案、Mini 标题。不读
 * Store、不调 API、不读隐藏 DOM、不设任何测试开关。
 */
test.describe("连续创作下一篇等待与自动续播", () => {
    test("连续创作下一篇等待与自动续播", async ({ page, harnessEnv }) => {
        test.setTimeout(240000);
        await ensureGuestByApi(page, harnessEnv.appUrl);
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

        // ③ 发起第一篇并等其就绪，记下集合标题（晋升成功后收敛）。
        await sendStory(page, "讲一个关于森林邮递员的故事");
        await waitStoryCardReady(page, 0);
        const barTitle = page.getByTestId("continuous-collection-title");
        await expect
            .poll(async () => (await barTitle.innerText()).trim(), { timeout: 30000 })
            .not.toBe("新作品集");
        const collectionTitle = (await barTitle.innerText()).trim();
        expect(collectionTitle.length).toBeGreaterThan(0);

        // ④ 第一轮交接：草稿自动播起播（Mini 现身）后重播首篇触发尾段调度；
        // 第二篇（系统续写）无人点击却进入播放态 = 自动续播发生。
        await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 60000 });
        await playCardWhenSettled(page, 0);
        await waitAutoplayedCardActive(page, 1, 150000);

        // ⑤ 在后续交接中捕获等待态：顺延多轮，每轮都是真实等待。
        // 若下一篇发送失败，用产品重试（有界两轮）后继续等。
        const waitingStatus = page
            .getByTestId("continuous-next-card")
            .getByRole("status")
            .filter({ hasText: "当前故事已结束，正在等待下一篇" });
        const nextCardScope = page.getByTestId("continuous-next-card");
        const initialViewport = page.viewportSize() ?? { width: 1280, height: 720 };
        let waitingProven = false;
        let sendRetries = 0;
        for (let round = 0; round < 6 && !waitingProven; round += 1) {
            if ((await nextCardScope.getByText("发送失败").count()) > 0) {
                sendRetries += 1;
                if (sendRetries > 2) {
                    throw new Error("next-work send failed persistently after 2 product retries");
                }
                await nextCardScope.getByRole("button", { name: "重试" }).click();
                await page.waitForTimeout(2000);
                continue;
            }
            await expect(waitingStatus).toBeVisible({ timeout: 60000 });
            const first = ((await budget.innerText()).trim());
            await captureVisual(page, "1280-waiting");
            await page.setViewportSize({ width: 375, height: 812 });
            await captureVisual(page, "375-waiting");
            await page.setViewportSize({ width: 430, height: 932 });
            await captureVisual(page, "430-waiting");
            await page.setViewportSize({ width: 1440, height: 900 });
            await captureVisual(page, "1440-waiting");
            await page.setViewportSize(initialViewport);
            // 等待期间预算不得推进：秒级文本 3 秒后仍完全相同
            //（若音频在走，秒数必掉；仍在等待才比较，滑入续播则顺延下一轮）。
            await page.waitForTimeout(3000);
            if ((await waitingStatus.count()) === 0) {
                continue;
            }
            const second = ((await budget.innerText()).trim());
            expect(second).toBe(first);
            waitingProven = true;
        }
        expect(waitingProven).toBe(true);

        // ⑥ 等待结束 = 自动续播：新增卡片自动进入播放（偶发发送失败时产品重试），
        // 且 Mini 复现同集合标题。
        const cardCountBefore = await cardActionButtons(page).count();
        await waitAutoplayedCardActive(page, cardCountBefore, 150000);
        const mini = await readMiniTitles(page);
        expect(mini.title).toBe(collectionTitle);
        await expect(budget).toContainText("剩余", { timeout: 10000 });

        // ⑦ 关开关收尾（在途续写被真取消，只认关闭文案）。
        await setContinuousEnabled(page, false);
    });
});
