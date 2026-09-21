import { test, expect } from "../harness/fixtures";
import { enterGuestChat } from "./helpers/guest";
import {
    captureVisual,
    cardActionButton,
    continuousStatusText,
    readMiniTitles,
    sendStory,
    setContinuousEnabled,
    verifyCardPlayPauseResume,
    waitAutoplayedCardActive,
    waitCardEnded,
    waitStoryCardReady,
} from "./helpers/creation-journey";

/**
 * 旅程一：同一会话连创两篇，逐个验证播放/暂停/继续，再打开连续创作开关
 * 观察下一篇卡片与自动续播。
 *
 * 全程只认可见 UI：状态卡文案、预算文本、卡片按钮文案、Mini 标题、URL。
 * 不读 Store、不调 API、不读隐藏 DOM、不设任何测试开关。
 */
test.describe("同一会话两篇故事播放与连续开关交接", () => {
    test("同一会话两篇故事播放与连续开关交接", async ({ page, harnessEnv }) => {
        test.setTimeout(240000);
        await enterGuestChat(page, harnessEnv.appUrl);
        const appUrl = harnessEnv.appUrl;

        // ① 默认连续创作开启：状态卡文案 + 预算 + 开关三者同源可见。
        await expect(continuousStatusText(page)).toHaveText("连续创作已开启", { timeout: 15000 });
        await expect(page.getByTestId("continuous-remaining-budget")).toContainText("剩余", {
            timeout: 10000,
        });
        const initialViewport = page.viewportSize() ?? { width: 1280, height: 720 };
        await captureVisual(page, "1280-creation-bar-on");
        await page.setViewportSize({ width: 375, height: 812 });
        await captureVisual(page, "375-creation-bar-on");
        await page.setViewportSize({ width: 430, height: 932 });
        await captureVisual(page, "430-creation-bar-on");
        await page.setViewportSize({ width: 1440, height: 900 });
        await captureVisual(page, "1440-creation-bar-on");
        await page.setViewportSize(initialViewport);

        // ② 关开关，连续生成两篇（互不干扰，各自出现播放按钮）。
        await setContinuousEnabled(page, false);
        await sendStory(page, "写一个关于山间小屋的短故事");
        await waitStoryCardReady(page, 0);

        // 首作晋升后作品集标题落地创作头（晋升成功回写后收敛，无需 reload）：
        // 动态读取，后续跨表面一致性以此为准。
        const barTitle = page.getByTestId("continuous-collection-title");
        await expect
            .poll(async () => (await barTitle.innerText()).trim(), { timeout: 30000 })
            .not.toBe("新作品集");
        const collectionTitle = (await barTitle.innerText()).trim();
        expect(collectionTitle.length).toBeGreaterThan(0);

        // ③ 第一篇：草稿自动播会起播（Mini 现身即证明），卡片随晋升落定
        // 「播放」后做用户三态验证（重播入口，整轨在前，确定性）。
        await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 60000 });
        await verifyCardPlayPauseResume(page, 0);
        await waitCardEnded(page, 0);

        // 第二篇：后续草稿不再自动播，就绪即「播放」，直接验证。
        await sendStory(page, "再写一个关于海边灯塔的短故事");
        await waitStoryCardReady(page, 1);
        await verifyCardPlayPauseResume(page, 1);
        await waitCardEnded(page, 1);

        // ④ 打开开关（静默态开启，回到已开启；截图矩阵）。
        await setContinuousEnabled(page, true);
        await captureVisual(page, "1280-enabled-idle");
        await page.setViewportSize({ width: 375, height: 812 });
        await captureVisual(page, "375-enabled-idle");
        await page.setViewportSize({ width: 430, height: 932 });
        await captureVisual(page, "430-enabled-idle");
        await page.setViewportSize({ width: 1440, height: 900 });
        await captureVisual(page, "1440-enabled-idle");
        await page.setViewportSize(initialViewport);

        // ⑤ 等第二篇被自动续播播完（系统续写，无人点击），再重播它到尾段：
        // 调度触发，下一篇卡片出现。
        await waitCardEnded(page, 1, 150000);
        await cardActionButton(page, 1).click();
        const nextCard = page.getByTestId("continuous-next-card");
        await expect(nextCard).toBeVisible({ timeout: 30000 });
        await captureVisual(page, "1280-preparing");
        await page.setViewportSize({ width: 375, height: 812 });
        await captureVisual(page, "375-preparing");
        await page.setViewportSize({ width: 430, height: 932 });
        await captureVisual(page, "430-preparing");
        await page.setViewportSize({ width: 1440, height: 900 });
        await captureVisual(page, "1440-preparing");
        await page.setViewportSize(initialViewport);

        // ⑥ 第三篇（系统续写）自动续播：无人点击过它却进入播放态，
        // 即证明自动续播发生；Mini 复现同集合标题。
        // 偶发发送失败时用产品重试（有界），仍失败则如实失败。
        await waitAutoplayedCardActive(page, 2, 150000);
        const mini = await readMiniTitles(page);
        expect(mini.title).toBe(collectionTitle);
        expect(mini.secondary).not.toBeNull();

        // ⑦ 关开关收尾（同一集合标题保持）。
        await setContinuousEnabled(page, false);
        expect(page.url()).toContain(`${appUrl}/chat`);
        expect((await page.getByTestId("continuous-collection-title").innerText()).trim()).toBe(
            collectionTitle,
        );
    });
});
