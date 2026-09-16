// case_id: library-lifecycle-journey
// journey: story-library
// legacy_aliases: [E2E-07-15]
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";

/**
 * 故事库完整生命周期旅程（E2E-07-15，L3 真实浏览器端到端全链路，M9-C1 T4 集合级）。
 *
 * 顶层恒为 Collection 卡片；覆盖完整的 17 个有序步骤：
 * 1. 创建 22 个集合（各 1 作品，保证分页成立）
 * 2. /library active 首屏 = 20 张卡片
 * 3. scroll 拉取下一页（22 张出现）
 * 4. 搜索（命中集内作品时按集合去重）
 * 5. 打开某集合的真实详情（/library/collections/{真实id}）
 * 6. Rename（改名后返回列表验证标题同步）
 * 7. Favorite（收藏）
 * 8. 返回列表 / 切 favorites 验证收藏出现
 * 9. Move to Trash（从详情删除，应离开详情）
 * 10. Undo（Restore）恢复
 * 11. 再 Move（第二次移入回收站）
 * 12. 切到 trash 视图
 * 13. Trash 卡片无详情入口（直接访问呈现统一不可用）
 * 14. Restore（从 trash 恢复）
 * 15. 再 Trash（第三次移入回收站）
 * 16. Permanent Delete（二次确认流）
 * 17. 最终消失（全部/收藏/回收站列表均无此集合，直接访问不可用）
 */

type TrpcBatch = Array<{ result: { data: { json: unknown } } }>;

async function trpcMutate(page: Page, path: string, input: unknown): Promise<unknown> {
    return page.evaluate(
        async (args: { path: string; input: unknown }) => {
            const res = await fetch(`/api/trpc/${args.path}?batch=1`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ "0": { json: args.input } }),
            });
            if (!res.ok) throw new Error(`trpc-http-${res.status}`);
            const batch = (await res.json()) as TrpcBatch;
            const first = batch[0];
            if (!first || !("result" in first)) throw new Error("trpc-error-shape");
            return (first as { result: { data: { json: unknown } } }).result.data.json;
        },
        { path, input },
    );
}

async function trpcQuery(page: Page, path: string, input: unknown): Promise<unknown> {
    return page.evaluate(
        async (args: { path: string; input: unknown }) => {
            const encoded = encodeURIComponent(JSON.stringify({ "0": { json: args.input } }));
            const res = await fetch(`/api/trpc/${args.path}?batch=1&input=${encoded}`, {
                method: "GET",
                headers: { accept: "application/json" },
            });
            if (!res.ok) throw new Error(`trpc-http-${res.status}`);
            const batch = (await res.json()) as TrpcBatch;
            const first = batch[0];
            if (!first || !("result" in first)) throw new Error("trpc-error-shape");
            return (first as { result: { data: { json: unknown } } }).result.data.json;
        },
        { path, input },
    );
}

test("故事库完整生命周期旅程", async ({ page, harnessEnv, evidence }) => {
    test.setTimeout(300000);

    const recorder = evidence as unknown as {
        step: (name: string, detail?: unknown) => void;
    };

    // W36（T4R1）：404 默认拒绝——仅两处刻意 fail-closed 探测的时间窗内放行，
    // 且末端以 response URL 白名单复核（仅 /api/trpc/collection.get）。
    let allowExpected404 = false;
    let deleteForeverRequestCount = 0;
    page.on("request", (req) => {
        if (req.url().includes("collection.deleteForever")) {
            deleteForeverRequestCount += 1;
        }
    });

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    // fail-closed 读路径（直接访问已删除集合）在刻意探测窗内产生 collection.get 404；
    // 窗口外任何 404 计入 consoleErrors（默认拒绝），末端再以 response URL 白名单复核。
    const observed404Urls: string[] = [];
    page.on("response", (res) => {
        if (res.status() === 404) {
            observed404Urls.push(res.url());
        }
    });
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            const text = msg.text().slice(0, 300);
            if (
                text.includes("Failed to fetch RSC payload") ||
                text.includes("Falling back to browser navigation")
            ) {
                return;
            }
            if (text.includes("status of 404 (Not Found)")) {
                // 仅刻意探测窗内放行；窗口外一律计入（默认拒绝）。
                if (allowExpected404) return;
            }
            // 附来源 URL，便于区分预期导航 404 与真实资源 404。
            const loc = msg.location();
            consoleErrors.push(loc?.url ? `${text} @ ${loc.url.slice(0, 160)}` : text);
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

    // 注册全新独立用户（authedLimit = 60，满足批量建集限额与数据隔离）
    const username = `journey_user_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    await ensureRegisteredByApi(page, harnessEnv.appUrl, username, "SecurePass123!");
    recorder.step("注册独立用户完成", { username });

    // 1. 经真实 promotion 创建 22 个集合（各 1 作品，保证分页成立）
    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const collectionIds: string[] = [];
    for (let i = 1; i <= 22; i += 1) {
        const padded = String(i).padStart(2, "0");
        const isTarget = i === 22;
        const created = (await trpcMutate(page, "conversation.createNew", {})) as {
            id?: string;
        };
        if (!created.id) throw new Error("no-conversation-id");
        await trpcMutate(page, "collection.promoteArtifact", {
            conversationId: created.id,
            sourceMessageId: `t4-journey-${runKey}-${padded}`,
            prompt: isTarget ? "勇敢小猫寻找魔法宝石的故事" : `关于宇宙深处探险的第${padded}段提示词`,
            storyText: isTarget
                ? "从前在一座充满奇迹的森林边，有一只勇敢的小猫咪，它踏上了寻找神秘魔法宝石的历险旅程..."
                : `这是星际探索故事正文的第${padded}部分，记录了深空飞船航行中的精彩记录...${"星光与航线交织的夜晚。".repeat(4)}`,
        });
        const found = (await trpcQuery(page, "collection.list", {
            view: "active",
            query: isTarget ? "小猫" : `第${padded}段提示词`,
            limit: 5,
        })) as { items?: Array<{ id?: string }> };
        const cid = found.items?.[0]?.id;
        if (!cid) throw new Error(`no-collection-id-${padded}`);
        collectionIds.push(cid);
    }
    expect(collectionIds).toHaveLength(22);
    const targetId = collectionIds[21]!;
    recorder.step("真实集合批量创建完成", { total: 22, targetId });

    // 2. /library active 首屏 = 20 张
    await page.goto(`${harnessEnv.appUrl}/library`, { waitUntil: "networkidle", timeout: 30000 });
    const retryBtn = page.getByRole("button", { name: "重试" });
    const libraryPage = page.getByTestId("library-page");
    for (let attempt = 0; attempt < 5; attempt += 1) {
        if (await libraryPage.isVisible().catch(() => false)) {
            break;
        }
        if (await retryBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await retryBtn.click().catch(() => {});
        }
        await page.waitForTimeout(500);
    }
    await expect(libraryPage).toBeVisible({ timeout: 15000 });
    const cards = page.locator('article[data-testid^="collection-card-"]');
    await expect(cards).toHaveCount(20, { timeout: 15000 });
    recorder.step("首屏20张截断验证", { count: 20 });

    // 3. scroll 拉取下一页（22 张出现）
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
    recorder.step("滚动分页加载至22张全部加载完成", { totalCount: 22 });

    // 4. 搜索（命中集内作品时按集合去重）
    const searchInput = page.getByTestId("library-search-input");
    await searchInput.fill("小猫");
    // 等待搜索防抖完成，列表应仅匹配出 1 张目标集合卡片
    await expect(cards).toHaveCount(1, { timeout: 15000 });
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });

    // 清空搜索恢复全量 22 张
    await page.getByTestId("library-search-clear-btn").click();
    await expect(searchInput).toHaveValue("");
    await expect(cards).toHaveCount(22, { timeout: 15000 });
    recorder.step("搜索过滤与恢复验证", { searchTarget: "小猫", filtered: 1, restored: 22 });

    // 5. 打开目标集合的真实详情（/library/collections/{真实id}）
    await page.getByTestId(`collection-link-${targetId}`).click();
    await page.waitForURL(`**/library/collections/${targetId}`, { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe(`/library/collections/${targetId}`);
    await expect(page.getByTestId("collection-detail-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("collection-members")).toBeVisible({ timeout: 15000 });
    recorder.step("进入真实集合详情页", { id: targetId });

    // 6. Rename（改名后返回列表验证标题同步）
    await page.getByTestId("collection-rename-btn").click();
    const renameInput = page.getByTestId("collection-rename-input");
    await expect(renameInput).toBeVisible({ timeout: 15000 });
    await renameInput.fill("勇敢小猫大冒险");
    await page.getByTestId("collection-rename-save").click();
    await expect(page.getByTestId("collection-title")).toHaveText("勇敢小猫大冒险", { timeout: 15000 });

    // 返回列表验证标题同步
    await page.getByTestId("collection-back-btn").click();
    await page.waitForURL("**/library", { timeout: 15000 });
    await expect(
        page.getByTestId(`collection-card-${targetId}`).getByTestId("collection-title"),
    ).toHaveText("勇敢小猫大冒险", { timeout: 15000 });
    recorder.step("重命名跨缓存列表同步完成", { newTitle: "勇敢小猫大冒险" });

    // 7. Favorite（在详情中收藏）
    await page.getByTestId(`collection-link-${targetId}`).click();
    await page.waitForURL(`**/library/collections/${targetId}`, { timeout: 15000 });
    await page.getByTestId("collection-favorite-btn").click();
    await expect(page.getByTestId("collection-favorite-btn")).toHaveAttribute("data-favorited", "true", {
        timeout: 15000,
    });
    recorder.step("详情页收藏成功", { id: targetId });

    // 8. 返回列表 / 切 favorites 验证收藏出现
    await page.getByTestId("collection-back-btn").click();
    await page.waitForURL("**/library", { timeout: 15000 });
    await page.getByTestId("view-tab-favorites").click();
    await expect(page.getByTestId("view-tab-favorites")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });
    await expect(
        page.getByTestId(`collection-card-${targetId}`).getByTestId("collection-title"),
    ).toHaveText("勇敢小猫大冒险");
    recorder.step("收藏视图验证卡片呈现", { id: targetId });

    // 9. Move to Trash（从详情移入回收站，应离开详情）
    await page.getByTestId(`collection-link-${targetId}`).click();
    await page.waitForURL(`**/library/collections/${targetId}`, { timeout: 15000 });
    await page.getByTestId("collection-delete-btn").click();

    // 验证软删除后离开详情页，跳转至 /library 并展示撤销提示栏
    await page.waitForURL("**/library", { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/library");
    await expect(page.getByTestId("library-undo-toast")).toBeVisible({ timeout: 15000 });
    recorder.step("详情页软删除并自动导航离开", { id: targetId });

    // 10. Undo（Restore）恢复
    await page.getByTestId("library-undo-btn").click();
    await expect(page.getByTestId("library-undo-toast")).toBeHidden({ timeout: 15000 });
    await page.getByTestId("view-tab-active").click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });
    await expect(
        page.getByTestId(`collection-card-${targetId}`).getByTestId("collection-title"),
    ).toHaveText("勇敢小猫大冒险");
    recorder.step("Undo撤销恢复成功", { id: targetId });

    // 11. 再 Move（第二次移入回收站）
    await page.getByTestId(`collection-trash-btn-${targetId}`).click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeHidden({ timeout: 15000 });
    await expect(page.getByTestId("library-undo-toast")).toBeVisible({ timeout: 15000 });
    // 关闭 Undo 浮条
    await page.getByTestId("library-undo-dismiss-btn").click();
    await expect(page.getByTestId("library-undo-toast")).toBeHidden({ timeout: 15000 });
    recorder.step("第二次移入回收站完成", { id: targetId });

    // 12. 切到 trash 视图
    await page.getByTestId("view-tab-trash").click();
    await expect(page.getByTestId("view-tab-trash")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("collection-trash-badge")).toHaveText("已移入回收站");
    recorder.step("切换至回收站视图确认集合在列", { id: targetId });

    // 13. Trash 卡片无详情入口（无法进入详情）
    await expect(page.getByTestId("collection-title-static")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`collection-link-${targetId}`)).toHaveCount(0);
    const trashCard = page.getByTestId(`collection-card-${targetId}`);
    await expect(trashCard.locator("a")).toHaveCount(0);

    // 直接在浏览器地址栏强制访问该 trashed 集合详情，必须触发统一不可用保护
    // （fail-closed 读产生 collection.get 404，时间窗内放行 + 末端 URL 白名单复核）。
    allowExpected404 = true;
    try {
        await page.goto(`${harnessEnv.appUrl}/library/collections/${targetId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await expect(page.getByTestId("library-unavailable")).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("collection-detail-page")).toBeHidden();
        await page.getByTestId("back-to-library-link").click();
        await page.waitForURL("**/library", { timeout: 15000 });
    } finally {
        allowExpected404 = false;
    }
    recorder.step("回收站卡片无详情入口且直接访问被统一不可用拦截", { id: targetId });

    // 14. Restore（从 trash 恢复）
    await page.getByTestId("view-tab-trash").click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });
    await page.getByTestId("collection-restore-btn").click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeHidden({ timeout: 15000 });

    // 切换至全部视图验证集合恢复可见
    await page.getByTestId("view-tab-active").click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`collection-link-${targetId}`)).toBeVisible({ timeout: 15000 });
    recorder.step("从回收站恢复至全部列表完成", { id: targetId });

    // 15. 再 Trash（第三次移入回收站）
    await page.getByTestId(`collection-trash-btn-${targetId}`).click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeHidden({ timeout: 15000 });
    if (await page.getByTestId("library-undo-dismiss-btn").isVisible()) {
        await page.getByTestId("library-undo-dismiss-btn").click();
    }
    await page.getByTestId("view-tab-trash").click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });
    recorder.step("第三次移入回收站准备永久删除", { id: targetId });

    // 16. Permanent Delete（二次确认流与零 RPC 守卫）
    expect(deleteForeverRequestCount).toBe(0);
    await page.getByTestId("collection-permanent-delete-btn").click();
    const deleteDialog = page.getByTestId("collection-delete-confirm");
    await expect(deleteDialog).toBeVisible({ timeout: 15000 });
    // 未确认前严格零 RPC
    expect(deleteForeverRequestCount).toBe(0);
    recorder.step("永久删除未确认前零RPC", { rpcCount: 0 });

    await page.getByTestId("collection-delete-confirm-ok").click();
    await expect(deleteDialog).toBeHidden({ timeout: 15000 });
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeHidden({ timeout: 15000 });
    // 确认后恰好触发 1 次永久删除 RPC
    expect(deleteForeverRequestCount).toBe(1);
    recorder.step("永久删除二次确认流执行完成", { id: targetId, rpcCount: 1 });

    // 17. 最终消失（列表/trash 均无此集合，直接访问不可用）
    // 回收站中无
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeHidden();
    // 全部列表中无
    await page.getByTestId("view-tab-active").click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeHidden();
    // 收藏列表中无（先等 tab 切换触发的合法客户端导航落定，再断言与后续硬导航；
    // 否则 WebKit 下 page.goto 会被该尚未完成的客户端导航打断）
    await page.getByTestId("view-tab-favorites").click();
    await expect(page.getByTestId("view-tab-favorites")).toHaveAttribute("aria-selected", "true");
    await page.waitForURL(
        (url) => url.pathname === "/library" && url.searchParams.get("view") === "favorites",
        { timeout: 15000 },
    );
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeHidden();
    // 直接访问详情无（fail-closed 读产生 collection.get 404，时间窗内放行 + 末端 URL 白名单复核）。
    allowExpected404 = true;
    try {
        await page.goto(`${harnessEnv.appUrl}/library/collections/${targetId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await expect(page.getByTestId("library-unavailable")).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("collection-detail-page")).toBeHidden();
    } finally {
        allowExpected404 = false;
    }
    recorder.step("集合全维度彻底消失验证完毕", { id: targetId });

    // 全程零控制台与页面未捕获错误；404 响应只允许 fail-closed 的 collection.get。
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    const unexpected404 = observed404Urls.filter((u) => !u.includes("/api/trpc/collection.get"));
    expect(unexpected404).toEqual([]);
    recorder.step("终态控制台与页面零报错", { consoleErrors: 0, pageErrors: 0 });
});
