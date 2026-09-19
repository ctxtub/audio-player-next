import { test, expect } from "../harness/fixtures";
import { ensureGuestByApi } from "./helpers/auth";
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
        await ensureGuestByApi(page, harnessEnv.appUrl);
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

        // ④ 起播首篇：Mini 主标题为集合标题，副标题含作品短标题。
        await page.getByTestId(/^member-play-/).first().click();
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
        const renamedTitle = "旅程改名集合";
        await page.getByTestId("collection-rename-btn").click();
        await page.getByTestId("collection-rename-input").fill(renamedTitle);
        await page.getByTestId("collection-rename-save").click();
        await expect(page.getByTestId("collection-title")).toHaveText(renamedTitle, {
            timeout: 15000,
        });
        expect(((await memberTitles.first().innerText()).trim())).toBe(firstWorkTitle);

        // ⑥ 刷新：Mini 显示恢复为新集合标题（与作品标题不同，证明取自集合），
        // 且仍可播（时间线推进证明）。
        await page.reload({ waitUntil: "networkidle", timeout: 60000 });
        const miniAfterReload = await readMiniTitles(page);
        expect(miniAfterReload.title).toBe(renamedTitle);
        await page.getByTestId("mini-playback-button").click();
        await openExpandedFromMini(page);
        await expectExpandedTimelineAdvancing(page);
        await closeExpanded(page);

        // ⑦ 跨页保持：回创作页 Mini 仍在且为新集合标题（截图矩阵）。
        await page.goto(`${appUrl}/chat`, { waitUntil: "networkidle", timeout: 60000 });
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
        await page.goto(`${appUrl}/player`, { timeout: 60000 });
        await page.waitForURL("**/library**", { timeout: 15000 });
        expect(page.url()).toContain(`${appUrl}/library`);
    });
});
