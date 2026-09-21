import { test, expect } from "../harness/fixtures";
import { enterGuestChat } from "./helpers/guest";
import {
    captureVisual,
    closeExpanded,
    expectExpandedTimelineAdvancing,
    openExpandedFromMini,
    readExpandedTitles,
    readMiniTitles,
    sendStory,
    setContinuousEnabled,
    waitStoryCardReady,
} from "./helpers/creation-journey";

/**
 * 旅程四：集合详情起播后的跨页播放之旅（Mini / Expanded / 刷新 / 跨页 / 安全区）。
 *
 * 同一集合标题在创作头、故事库卡片、详情页、Mini、Expanded 五处统一；
 * 详情起播后 Mini 跨页保持可播；刷新后会话显示恢复；刷新后仍可播；
 * Mini 存在时故事库末卡片不被底部 Chrome 遮挡；/player 退役进故事库。
 *
 * 全程只认可见 UI：可见文本、元素显隐与几何、URL。不读 Store、不调
 * API、不读隐藏 DOM、不设任何测试开关。
 */
test.describe("集合详情起播跨页播放", () => {
    test("集合详情起播跨页播放", async ({ page, harnessEnv }) => {
        test.setTimeout(240000);
        await enterGuestChat(page, harnessEnv.appUrl);
        const appUrl = harnessEnv.appUrl;
        const initialViewport = page.viewportSize() ?? { width: 1280, height: 720 };

        // ① 安静建两篇（关开关，避免系统续写干扰成员顺序）。
        await setContinuousEnabled(page, false);
        await sendStory(page, "写一个关于雾中山城的故事");
        await waitStoryCardReady(page, 0);
        await sendStory(page, "写一个关于星空营地的故事");
        await waitStoryCardReady(page, 1);
        const barTitle = page.getByTestId("continuous-collection-title");
        await expect
            .poll(async () => (await barTitle.innerText()).trim(), { timeout: 30000 })
            .not.toBe("新作品集");
        const collectionTitle = (await barTitle.innerText()).trim();
        expect(collectionTitle.length).toBeGreaterThan(0);

        // ② 进故事库打开同名集合：卡片标题与创作头一致。
        await page.goto(`${appUrl}/library`, { waitUntil: "networkidle", timeout: 60000 });
        const card = page.getByTestId(/^collection-card-/).filter({ hasText: collectionTitle }).first();
        await expect(card).toBeVisible({ timeout: 15000 });
        expect(((await card.getByTestId("collection-title").innerText()).trim())).toBe(collectionTitle);
        await card.getByTestId(/^collection-link-/).click();
        await page.waitForURL("**/library/collections/**", { timeout: 15000 });

        // ③ 详情页：标题一致，两名成员，动态记下首篇标题。
        await expect(page.getByTestId("collection-detail-page")).toBeVisible({ timeout: 15000 });
        expect(((await page.getByTestId("collection-title").innerText()).trim())).toBe(collectionTitle);
        const memberTitles = page.getByTestId(/^member-title-/);
        await expect(memberTitles).toHaveCount(2, { timeout: 15000 });
        const firstWorkTitle = ((await memberTitles.first().innerText()).trim());
        expect(firstWorkTitle.length).toBeGreaterThan(0);

        // ④ 起播首篇后快速切到第二篇、再切回首篇：任何时刻只允许最新目标
        // 显示准备中，旧请求不得清理新目标状态或迟到起播。
        const memberPlayButtons = page.getByTestId(/^member-play-/);
        const firstPlay = memberPlayButtons.first();
        const secondPlay = memberPlayButtons.nth(1);
        await firstPlay.click();
        await expect(firstPlay).toContainText("暂停", { timeout: 60000 });
        await secondPlay.click();
        await expect(secondPlay).toContainText("准备语音", { timeout: 15000 });
        await expect(firstPlay).not.toContainText("准备语音");
        await firstPlay.click();
        await expect(firstPlay).toContainText("准备语音", { timeout: 15000 });
        await expect(secondPlay).not.toContainText("准备语音");
        await expect(firstPlay).toContainText("暂停", { timeout: 60000 });

        // latest-wins 后 Mini 主标题为集合标题，副标题仍是最终首篇。
        await expect(page.getByTestId("mini-title")).toHaveText(collectionTitle, { timeout: 15000 });
        await expect(page.getByTestId("mini-secondary-label")).toContainText(firstWorkTitle, {
            timeout: 15000,
        });
        const mini = await readMiniTitles(page);
        expect(mini.title).toBe(collectionTitle);
        expect(mini.secondary).not.toBeNull();
        expect(mini.secondary as string).toContain(firstWorkTitle);

        // ⑤ 打开 Expanded：标题/副标题一致，时间线秒级可见。
        await openExpandedFromMini(page);
        const expanded = await readExpandedTitles(page);
        expect(expanded.title).toBe(collectionTitle);
        expect(expanded.subtitle).toBe(firstWorkTitle);
        await expect(page.getByTestId("expanded-timeline-current")).toContainText(":", {
            timeout: 10000,
        });
        await expect(page.getByTestId("expanded-timeline-duration")).toContainText(":", {
            timeout: 10000,
        });
        await page.setViewportSize({ width: 1440, height: 900 });
        await captureVisual(page, "1440-expanded");
        await page.setViewportSize(initialViewport);
        await closeExpanded(page);

        // ⑤-B 重命名集合（用户可见改名）：作品标题不变；reload 后 Mini 显示新
        // 集合标题，证明 Mini 一级标题取自集合（hydrate 活读）而非作品标题。
        const renamedTitle = "月光穿过很长很长的山谷，照亮归途上每一座安静的小屋与仍在等待故事的人";
        await page.getByTestId("collection-rename-btn").click();
        await page.getByTestId("collection-rename-input").fill(renamedTitle);
        await page.getByTestId("collection-rename-save").click();
        await expect(page.getByTestId("collection-title")).toHaveText(renamedTitle, {
            timeout: 15000,
        });
        expect(((await memberTitles.first().innerText()).trim())).toBe(firstWorkTitle);

        // 长标题详情在亮色、暗色与移动/桌面均保持完整层级，不出现原生控件或横向溢出。
        const detailUrl = page.url();
        await page.goto(`${appUrl}/setting`, { waitUntil: "networkidle", timeout: 60000 });
        const lightMode = page.getByRole("radio", { name: "亮色模式" });
        await lightMode.focus();
        await page.keyboard.press("Space");
        await expect(lightMode).toBeChecked();
        // 配置以 500ms 防抖持久化；用户完成选择后留出保存窗口，再做整页跨页验证。
        await page.waitForTimeout(1000);
        await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 60000 });
        await page.setViewportSize({ width: 375, height: 812 });
        await captureVisual(page, "375-collection-detail-light-long-title");
        await page.setViewportSize({ width: 1440, height: 900 });
        await captureVisual(page, "1440-collection-detail-light-long-title");
        await page.goto(`${appUrl}/setting`, { waitUntil: "networkidle", timeout: 60000 });
        const darkMode = page.getByRole("radio", { name: "暗色模式" });
        await darkMode.focus();
        await page.keyboard.press("Space");
        await expect(darkMode).toBeChecked();
        await page.waitForTimeout(1000);
        await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 60000 });
        await page.setViewportSize({ width: 375, height: 812 });
        await captureVisual(page, "375-collection-detail-dark-long-title");
        await page.setViewportSize(initialViewport);

        // ⑥ 刷新：Mini 显示恢复为新集合标题（与作品标题不同，证明取自集合），
        // 且仍可播（时间线推进证明）。
        await page.reload({ waitUntil: "networkidle", timeout: 60000 });
        const miniAfterReload = await readMiniTitles(page);
        expect(miniAfterReload.title).toBe(renamedTitle);
        await page.getByTestId("mini-playback-button").click();
        await openExpandedFromMini(page);
        await expectExpandedTimelineAdvancing(page);
        await closeExpanded(page);

        // ⑦ 跨 Tab 保持：经底部主导航切到创作页，内存 Session 不重水合，
        // Mini 和物理音频继续播放而不是声画分裂成“已暂停”。
        await expect(page.getByTestId("mini-now-playing")).toHaveAttribute("data-status", "playing");
        await page.getByRole("tab", { name: "创作" }).click();
        await page.waitForURL("**/chat", { timeout: 15000 });
        await expect(page.getByTestId("mini-now-playing")).toHaveAttribute("data-status", "playing");
        await expect(page.getByTestId("mini-secondary-label")).toContainText("正在播放");
        await expect(page.getByTestId("mini-playback-button")).toHaveAttribute("aria-label", "暂停播放");
        const miniOnChat = await readMiniTitles(page);
        expect(miniOnChat.title).toBe(renamedTitle);
        await captureVisual(page, "1280-chat-bar-on");
        await page.setViewportSize({ width: 375, height: 812 });
        await captureVisual(page, "375-chat-bar-on");
        await page.setViewportSize({ width: 430, height: 932 });
        await captureVisual(page, "430-chat-bar-on");
        await page.setViewportSize({ width: 1440, height: 900 });
        await captureVisual(page, "1440-chat-bar-on");
        await page.setViewportSize(initialViewport);

        // ⑧ 安全区：窄视口下故事库末卡片完全位于 Mini 之上（几何无遮挡），三视口截图。
        await page.setViewportSize({ width: 375, height: 812 });
        await page.goto(`${appUrl}/library`, { waitUntil: "networkidle", timeout: 60000 });
        await expect(page.getByTestId("mini-now-playing")).toBeVisible({ timeout: 15000 });
        const lastCard = page.getByTestId(/^collection-card-/).last();
        await lastCard.scrollIntoViewIfNeeded();
        const cardBox = await lastCard.boundingBox();
        const miniBox = await page.getByTestId("mini-now-playing").boundingBox();
        expect(cardBox).not.toBeNull();
        expect(miniBox).not.toBeNull();
        expect((cardBox as { y: number; height: number }).y + (cardBox as { height: number }).height).toBeLessThanOrEqual(
            (miniBox as { y: number }).y,
        );
        await captureVisual(page, "375-mini-library-bottom");
        await page.setViewportSize({ width: 430, height: 932 });
        await captureVisual(page, "430-mini-library-bottom");
        await page.setViewportSize({ width: 1440, height: 900 });
        await captureVisual(page, "1440-mini-library-bottom");
        await page.setViewportSize(initialViewport);

        // ⑨ /player 已退役：进故事库。
        await page.goto(`${appUrl}/player`, { waitUntil: "networkidle", timeout: 60000 });
        await page.waitForURL("**/library**", { timeout: 30000 });
        expect(page.url()).toContain(`${appUrl}/library`);
    });
});
