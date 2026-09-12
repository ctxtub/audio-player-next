// case_id: library-lifecycle-journey
// journey: story-library
// legacy_aliases: [E2E-07-15]
import { test, expect } from "../harness/fixtures";
import { ensureRegisteredByApi } from "./helpers/auth";
import { bulkCreateStoryWorksByPage, type CreateStoryWorkInput } from "./helpers/library";

/**
 * 故事库完整生命周期旅程（E2E-07-15，L3 真实浏览器端到端全链路）。
 *
 * 覆盖完整的 17 个有序步骤：
 * 1. 创建 >=21 条真实 StoryWorks（保证分页成立）
 * 2. /library active 首屏 = 20 条
 * 3. scroll 拉取下一页（21+ 条出现）
 * 4. 搜索（q 过滤）
 * 5. 打开某条的真实 detail（/library/{真实id}）
 * 6. Rename（改名后返回列表验证标题同步）
 * 7. Favorite（收藏）
 * 8. 返回列表 / 切 favorites 验证收藏出现
 * 9. Move to Trash（从 detail 移入回收站，应离开详情）
 * 10. Undo（Restore）恢复
 * 11. 再 Move（第二次移入回收站）
 * 12. 切到 trash 视图
 * 13. Trash 卡片无 Detail 入口（无法进入详情，直接访问呈现统一不可用）
 * 14. Restore（从 trash 恢复）
 * 15. 再 Trash（第三次移入回收站）
 * 16. Permanent Delete（二次确认流）
 * 17. 最终消失（全部/收藏/回收站列表均无此作品，直接访问不可用）
 */
test("故事库完整生命周期旅程", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(180000);

    const recorder = evidence as unknown as {
        step: (name: string, detail?: unknown) => void;
    };

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            const text = msg.text().slice(0, 300);
            if (
                text.includes("Failed to fetch RSC payload") ||
                text.includes("Falling back to browser navigation") ||
                text.includes("status of 404 (Not Found)")
            ) {
                return;
            }
            consoleErrors.push(text);
        }
    });
    page.on("pageerror", (err) => {
        pageErrors.push(String(err).slice(0, 300));
    });

    // 预置引导弹窗标记，防止新手引导遮挡后续交互
    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });

    // 注册全新独立用户（authedLimit = 60，满足批量创建 22 条作品限额与数据隔离）
    const username = `journey_user_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    await ensureRegisteredByApi(page, harnessEnv.appUrl, username, "SecurePass123!");
    recorder.step("注册独立用户完成", { username });

    // 1. 批量创建 22 条真实作品（>=21 条，保证分页成立）
    const storyInputs: CreateStoryWorkInput[] = [];
    for (let i = 1; i <= 21; i += 1) {
        const padded = String(i).padStart(2, "0");
        storyInputs.push({
            title: `星际探索第${padded}章`,
            prompt: `关于宇宙深处探险的第${padded}段提示词`,
            storyText: `这是星际探索故事正文的第${padded}部分，记录了深空飞船航行中的精彩记录...`,
        });
    }
    // 第 22 条为具备特定关键词的目标作品
    storyInputs.push({
        title: "小猫历险记",
        prompt: "勇敢小猫寻找魔法宝石的故事",
        storyText: "从前在一座充满奇迹的森林边，有一只勇敢的小猫咪，它踏上了寻找神秘魔法宝石的历险旅程...",
    });

    const createdWorks = await bulkCreateStoryWorksByPage(page, storyInputs);
    expect(createdWorks).toHaveLength(22);
    const targetWork = createdWorks[21]!;
    expect(targetWork.title).toBe("小猫历险记");
    expect(targetWork.id).toBeGreaterThan(0);
    recorder.step("真实作品批量创建完成", { total: 22, targetId: targetWork.id });

    // 2. /library active 首屏 = 20 条
    await page.goto(`${harnessEnv.appUrl}/library`, { waitUntil: "networkidle", timeout: 30000 });
    const retryBtn = page.getByRole("button", { name: "重试" });
    try {
        if (await retryBtn.isVisible({ timeout: 1500 })) {
            await retryBtn.click();
        }
    } catch {}
    await expect(page.getByTestId("library-page")).toBeVisible({ timeout: 15000 });
    const cards = page.locator('article[data-testid^="story-work-card-"]');
    await expect(cards).toHaveCount(20, { timeout: 15000 });
    recorder.step("首屏20条截断验证", { count: 20 });

    // 3. scroll 拉取下一页（21+ 条出现）
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const sentinel = page.getByTestId("infinite-scroll-sentinel");
    if (await sentinel.isVisible().catch(() => false)) {
        await sentinel.scrollIntoViewIfNeeded().catch(() => {});
    }

    // 若依然显示手动加载更多按钮，则尝试快速触发一次
    const manualLoadBtn = page.getByTestId("manual-load-more-btn");
    try {
        if (await manualLoadBtn.isVisible().catch(() => false)) {
            await manualLoadBtn.click({ timeout: 1500, force: true }).catch(() => {});
        }
    } catch {}

    await expect(cards).toHaveCount(22, { timeout: 20000 });
    await expect(page.getByTestId("terminal-no-more")).toBeVisible({ timeout: 15000 });
    recorder.step("滚动分页加载至22条全部加载完成", { totalCount: 22 });

    // 4. 搜索（q 过滤）
    const searchInput = page.getByTestId("library-search-input");
    await searchInput.fill("小猫");
    // 等待搜索防抖完成，列表应仅匹配出 1 条目标作品
    await expect(cards).toHaveCount(1, { timeout: 15000 });
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`story-card-link-${targetWork.id}`)).toHaveText("小猫历险记");

    // 清空搜索恢复全量 22 条
    await page.getByTestId("library-search-clear-btn").click();
    await expect(searchInput).toHaveValue("");
    await expect(cards).toHaveCount(22, { timeout: 15000 });
    recorder.step("搜索过滤与恢复验证", { searchTarget: "小猫", filtered: 1, restored: 22 });

    // 5. 打开某条的真实 detail（/library/{真实id}）
    await page.getByTestId(`story-card-link-${targetWork.id}`).click();
    await page.waitForURL(`**/library/${targetWork.id}`, { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe(`/library/${targetWork.id}`);
    await expect(page.getByTestId("story-detail-container")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("story-detail-title")).toHaveText("小猫历险记");
    recorder.step("进入真实详情页", { id: targetWork.id });

    // 6. Rename（改名后返回列表验证标题同步）
    await page.getByTestId("story-detail-rename-btn").click();
    const renameInput = page.getByTestId("story-detail-rename-input");
    await expect(renameInput).toBeVisible({ timeout: 15000 });
    await renameInput.fill("勇敢小猫大冒险");
    await page.getByTestId("story-detail-rename-save-btn").click();
    await expect(page.getByTestId("story-detail-title")).toHaveText("勇敢小猫大冒险", { timeout: 15000 });

    // 返回列表验证标题同步
    await page.getByTestId("back-to-library-link").click();
    await page.waitForURL("**/library", { timeout: 15000 });
    await expect(page.getByTestId(`story-card-link-${targetWork.id}`)).toHaveText("勇敢小猫大冒险", { timeout: 15000 });
    recorder.step("重命名跨缓存列表同步完成", { newTitle: "勇敢小猫大冒险" });

    // 7. Favorite（在详情中收藏）
    await page.getByTestId(`story-card-link-${targetWork.id}`).click();
    await page.waitForURL(`**/library/${targetWork.id}`, { timeout: 15000 });
    const favoriteBtn = page.getByTestId("story-detail-favorite-btn");
    await favoriteBtn.click();
    await expect(page.getByTestId("story-detail-favorite-badge")).toBeVisible({ timeout: 15000 });
    recorder.step("详情页收藏成功", { id: targetWork.id });

    // 8. 返回列表 / 切 favorites 验证收藏出现
    await page.getByTestId("back-to-library-link").click();
    await page.waitForURL("**/library", { timeout: 15000 });
    await page.getByTestId("view-tab-favorites").click();
    await expect(page.getByTestId("view-tab-favorites")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`story-card-link-${targetWork.id}`)).toHaveText("勇敢小猫大冒险");
    recorder.step("收藏视图验证卡片呈现", { id: targetWork.id });

    // 9. Move to Trash（从 detail 移入回收站，应离开详情）
    await page.getByTestId(`story-card-link-${targetWork.id}`).click();
    await page.waitForURL(`**/library/${targetWork.id}`, { timeout: 15000 });
    await page.getByTestId("story-detail-trash-btn").click();

    // 验证软删除后离开详情页，跳转至 /library 并展示撤销提示栏
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");
    await expect(page.getByTestId("library-undo-toast")).toBeVisible({ timeout: 15000 });
    recorder.step("详情页软删除并自动导航离开", { id: targetWork.id });

    // 10. Undo（Restore）恢复
    await page.getByTestId("library-undo-btn").click();
    await expect(page.getByTestId("library-undo-toast")).toBeHidden({ timeout: 15000 });
    await page.getByTestId("view-tab-active").click();
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`story-card-link-${targetWork.id}`)).toHaveText("勇敢小猫大冒险");
    recorder.step("Undo撤销恢复成功", { id: targetWork.id });

    // 11. 再 Move（第二次移入回收站）
    await page.getByTestId(`story-card-trash-btn-${targetWork.id}`).click();
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeHidden({ timeout: 15000 });
    await expect(page.getByTestId("library-undo-toast")).toBeVisible({ timeout: 15000 });
    // 关闭 Undo 浮条
    await page.getByTestId("library-undo-dismiss-btn").click();
    await expect(page.getByTestId("library-undo-toast")).toBeHidden({ timeout: 15000 });
    recorder.step("第二次移入回收站完成", { id: targetWork.id });

    // 12. 切到 trash 视图
    await page.getByTestId("view-tab-trash").click();
    await expect(page.getByTestId("view-tab-trash")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`story-card-trash-badge-${targetWork.id}`)).toHaveText("已移入回收站");
    recorder.step("切换至回收站视图确认作品在列", { id: targetWork.id });

    // 13. Trash 卡片无 Detail 入口（无法进入详情）
    await expect(page.getByTestId(`story-card-static-${targetWork.id}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`story-card-link-${targetWork.id}`)).toHaveCount(0);
    const trashCard = page.getByTestId(`story-work-card-${targetWork.id}`);
    await expect(trashCard.locator("a")).toHaveCount(0);

    // 直接在浏览器地址栏强制访问该 trashed 作品详情，必须触发统一不可用保护
    await page.goto(`${harnessEnv.appUrl}/library/${targetWork.id}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await expect(page.getByTestId("library-unavailable")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("story-detail-container")).toBeHidden();
    await page.getByTestId("back-to-library-link").click();
    await page.waitForURL("**/library", { timeout: 15000 });
    recorder.step("回收站卡片无详情入口且直接访问被统一不可用拦截", { id: targetWork.id });

    // 14. Restore（从 trash 恢复）
    await page.getByTestId("view-tab-trash").click();
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeVisible({ timeout: 15000 });
    await page.getByTestId(`story-card-restore-btn-${targetWork.id}`).click();
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeHidden({ timeout: 15000 });

    // 切换至全部视图验证作品恢复可见
    await page.getByTestId("view-tab-active").click();
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`story-card-link-${targetWork.id}`)).toBeVisible({ timeout: 15000 });
    recorder.step("从回收站恢复至全部列表完成", { id: targetWork.id });

    // 15. 再 Trash（第三次移入回收站）
    await page.getByTestId(`story-card-trash-btn-${targetWork.id}`).click();
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeHidden({ timeout: 15000 });
    if (await page.getByTestId("library-undo-dismiss-btn").isVisible()) {
        await page.getByTestId("library-undo-dismiss-btn").click();
    }
    await page.getByTestId("view-tab-trash").click();
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeVisible({ timeout: 15000 });
    recorder.step("第三次移入回收站准备永久删除", { id: targetWork.id });

    // 16. Permanent Delete（二次确认流）
    await page.getByTestId(`story-card-delete-permanently-btn-${targetWork.id}`).click();
    const deleteDialog = page.getByTestId(`permanent-delete-dialog-${targetWork.id}`);
    await expect(deleteDialog).toBeVisible({ timeout: 15000 });
    await page.getByTestId("permanent-delete-confirm-btn").click();
    await expect(deleteDialog).toBeHidden({ timeout: 15000 });
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeHidden({ timeout: 15000 });
    recorder.step("永久删除二次确认流执行完成", { id: targetWork.id });

    // 17. 最终消失（列表/trash 均无此作品，直接访问不可用）
    // 回收站中无
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeHidden();
    // 全部列表中无
    await page.getByTestId("view-tab-active").click();
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeHidden();
    // 收藏列表中无
    await page.getByTestId("view-tab-favorites").click();
    await expect(page.getByTestId(`story-work-card-${targetWork.id}`)).toBeHidden();
    // 直接访问详情无
    await page.goto(`${harnessEnv.appUrl}/library/${targetWork.id}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await expect(page.getByTestId("library-unavailable")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("story-detail-container")).toBeHidden();
    recorder.step("作品全维度彻底消失验证完毕", { id: targetWork.id });

    // 全程零控制台与页面未捕获错误
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    recorder.step("终态控制台与页面零报错", { consoleErrors: 0, pageErrors: 0 });
});
