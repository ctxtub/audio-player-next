import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";

/**
 * 故事库完整生命周期旅程（真实浏览器端到端全链路，  集合级）。
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

test("故事库完整生命周期旅程", async ({ page, harnessEnv }) => {
    test.setTimeout(300000);

    // 404 默认拒绝——仅两处刻意 fail-closed 探测的时间窗内放行，
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
    // fail-closed 读路径（直接访问已删除集合 / 软删后重取）在刻意探测窗内产生
    // collection.get 404；窗口外任何 404 计入 consoleErrors（默认拒绝），末端再以
    // response URL 白名单复核（时间窗与 URL 白名单双条件）。
    const testStart = Date.now();
    const observed404s: Array<{ url: string; t: number }> = [];
    // 期望窗：step 绑定的真实触发点，open/close 为相对 testStart 的 ms。
    const windows: Array<{ step: string; open: number; close: number | null }> = [];
    // 全量 collection.* 时间线（取证，长期有效）：仅存诊断最小字段（过程名/ID 前缀/状态），
    // 逐行打印而非整串 JSON，避免长串被截断而丢掉后半段时间线。
    type ColEntry = {
        dt: number;
        dir: "→" | "←";
        method: string;
        proc: string;
        idPrefix: string;
        status: number | null;
    };
    const colTimeline: ColEntry[] = [];
    const parseCol = (u: string): { proc: string; idPrefix: string } => {
        const proc = /\/api\/trpc\/(collection\.[A-Za-z]+)/.exec(u)?.[1] ?? "collection.?";
        const id = /%22id%22%3A%22([0-9a-fA-F-]{0,8})/.exec(u)?.[1];
        return { proc, idPrefix: id ?? "-" };
    };
    page.on("request", (req) => {
        const u = req.url();
        if (!u.includes("/api/trpc/collection.")) return;
        const { proc, idPrefix } = parseCol(u);
        colTimeline.push({
            dt: Date.now() - testStart,
            dir: "→",
            method: req.method(),
            proc,
            idPrefix,
            status: null,
        });
    });
    page.on("response", (res) => {
        const u = res.url();
        if (u.includes("/api/trpc/collection.")) {
            const { proc, idPrefix } = parseCol(u);
            colTimeline.push({
                dt: Date.now() - testStart,
                dir: "←",
                method: res.request().method(),
                proc,
                idPrefix,
                status: res.status(),
            });
        }
        if (res.status() === 404) observed404s.push({ url: u, t: Date.now() });
    });
    const observed404Urls = (): string[] => observed404s.map((o) => o.url);
    /** 逐行完整打印时间线（不截断整串），仅在出现未预期错误时调用。 */
    const dumpDiagnostics = (label: string): void => {
        const rel = (t: number): number => t - testStart;
        console.log(
            `[${label}] windows=${JSON.stringify(
                windows.map((w) => ({
                    step: w.step,
                    open: rel(w.open),
                    close: w.close == null ? null : rel(w.close),
                })),
            )}`,
        );
        console.log(
            `[${label}] 404-resp=${
                observed404s
                    .map((o) => `${rel(o.t)}ms:${/collection\.[A-Za-z]+/.exec(o.url)?.[0] ?? o.url.slice(0, 40)}`)
                    .join(" | ") || "none"
            }`,
        );
        console.log(`[${label}] collection.* timeline (${colTimeline.length} entries, showing last 40):`);
        for (const e of colTimeline.slice(-40)) {
            console.log(
                `[${label}]   ${e.dt}ms ${e.dir}${e.method} ${e.proc} id=${e.idPrefix} status=${e.status ?? "-"}`,
            );
        }
    };
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

    // 期望窗原语（：open 于真实触发点之前/之内，close 于触发后的重试尾巴落定之后。
    const openExpected404Window = (step: string): void => {
        allowExpected404 = true;
        windows.push({ step, open: Date.now(), close: null });
    };
    const closeExpected404Window = (): void => {
        allowExpected404 = false;
        const seg = windows[windows.length - 1];
        if (seg && seg.close == null) seg.close = Date.now();
    };
    // 刻意 fail-closed 探测的关窗条件——React Query 默认重试尾巴（间隔 1s/2s/4s，
    // console 错误与 retry 一一对应）必须落定后才关窗，否则纯墙钟窗恒有竞态。
    // 关窗 = observed404s 连续 8s 无增长（覆盖最大 4s 重试间隔 + 抖动），60s 上限 fail-closed。
    async function settleExpected404sAndCloseWindow(): Promise<void> {
        const deadline = Date.now() + 60000;
        let last = observed404s.length;
        let quietSince = Date.now();
        for (;;) {
            if (Date.now() > deadline) throw new Error("expected-404-settle-timeout");
            await page.waitForTimeout(1000);
            if (observed404s.length !== last) {
                last = observed404s.length;
                quietSince = Date.now();
            } else if (Date.now() - quietSince >= 8000) {
                break;
            }
        }
        closeExpected404Window();
    }

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
            sourceMessageId: `library-journey-${runKey}-${padded}`,
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

    // 5. 打开目标集合的真实详情（/library/collections/{真实id}）
    await page.getByTestId(`collection-link-${targetId}`).click();
    await page.waitForURL(`**/library/collections/${targetId}`, { timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe(`/library/collections/${targetId}`);
    await expect(page.getByTestId("collection-detail-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("collection-members")).toBeVisible({ timeout: 15000 });

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

    // 7. Favorite（在详情中收藏）
    await page.getByTestId(`collection-link-${targetId}`).click();
    await page.waitForURL(`**/library/collections/${targetId}`, { timeout: 15000 });
    await page.getByTestId("collection-favorite-btn").click();
    await expect(page.getByTestId("collection-favorite-btn")).toHaveAttribute("data-favorited", "true", {
        timeout: 15000,
    });

    // 8. 返回列表 / 切 favorites 验证收藏出现
    await page.getByTestId("collection-back-btn").click();
    await page.waitForURL("**/library", { timeout: 15000 });
    await page.getByTestId("view-tab-favorites").click();
    await expect(page.getByTestId("view-tab-favorites")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });
    await expect(
        page.getByTestId(`collection-card-${targetId}`).getByTestId("collection-title"),
    ).toHaveText("勇敢小猫大冒险");

    // 9. Move to Trash（从详情移入回收站，应离开详情）
    await page.getByTestId(`collection-link-${targetId}`).click();
    await page.waitForURL(`**/library/collections/${targetId}`, { timeout: 15000 });
    // 软删除动作的真实触发点——详情页 `moveToTrash` 的 invalidateCollection 会
    // 对刚被软删的集合重取详情（fail-closed → collection.get 404）。期望窗必须以该
    // 真实触发点开窗（删除点击之前），而非守着"不会发生请求"的静默区间。
    // 该重取属产品面次生瑕疵（软删后不应再发详情读），本轮窄修不改为产品行为，
    // 作为已知缺口写入 CLOSEOUT §5/§9，窗口 + URL 白名单双条件保持不变。
    // 注：关窗的 8s settle 会越过 Undo 浮条 6s 自动消失窗口，故 Undo 恢复必须与
    // 软删除同处一个窗口块内先执行、再结算关窗（断言零削减，仅调整先后）。
    openExpected404Window("step9-detail-soft-delete");
    try {
        await page.getByTestId("collection-delete-btn").click();

        // 验证软删除后离开详情页，跳转至 /library 并展示撤销提示栏
        await page.waitForURL("**/library", { timeout: 15000 });
        expect(new URL(page.url()).pathname).toBe("/library");
        await expect(page.getByTestId("library-undo-toast")).toBeVisible({ timeout: 15000 });

        // 10. Undo（Restore）恢复（保持在 Undo 浮条 6s 生命周期内）
        await page.getByTestId("library-undo-btn").click();
        await expect(page.getByTestId("library-undo-toast")).toBeHidden({ timeout: 15000 });
        await page.getByTestId("view-tab-active").click();
        await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });
        await expect(
            page.getByTestId(`collection-card-${targetId}`).getByTestId("collection-title"),
        ).toHaveText("勇敢小猫大冒险");

        await settleExpected404sAndCloseWindow();
    } finally {
        if (allowExpected404) closeExpected404Window();
    }

    // 11. 再 Move（第二次移入回收站）
    await page.getByTestId(`collection-trash-btn-${targetId}`).click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeHidden({ timeout: 15000 });
    await expect(page.getByTestId("library-undo-toast")).toBeVisible({ timeout: 15000 });
    // 关闭 Undo 浮条
    await page.getByTestId("library-undo-dismiss-btn").click();
    await expect(page.getByTestId("library-undo-toast")).toBeHidden({ timeout: 15000 });

    // 12. 切到 trash 视图
    await page.getByTestId("view-tab-trash").click();
    await expect(page.getByTestId("view-tab-trash")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("collection-trash-badge")).toHaveText("已移入回收站");

    // 13. Trash 卡片无详情入口（无法进入详情）
    await expect(page.getByTestId("collection-title-static")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`collection-link-${targetId}`)).toHaveCount(0);
    const trashCard = page.getByTestId(`collection-card-${targetId}`);
    await expect(trashCard.locator("a")).toHaveCount(0);

    // 直接在浏览器地址栏强制访问该 trashed 集合详情，必须触发统一不可用保护
    //（fail-closed 读产生 collection.get 404，窗口 ∧ URL 白名单双条件）。
    openExpected404Window("step13-trash-direct-visit");
    try {
        await page.goto(`${harnessEnv.appUrl}/library/collections/${targetId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await expect(page.getByTestId("library-unavailable")).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("collection-detail-page")).toBeHidden();
        await page.getByTestId("back-to-library-link").click();
        await page.waitForURL("**/library", { timeout: 15000 });
        await settleExpected404sAndCloseWindow();
    } finally {
        if (allowExpected404) closeExpected404Window();
    }

    // 14. Restore（从 trash 恢复）
    await page.getByTestId("view-tab-trash").click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });
    await page.getByTestId("collection-restore-btn").click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeHidden({ timeout: 15000 });

    // 切换至全部视图验证集合恢复可见
    await page.getByTestId("view-tab-active").click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId(`collection-link-${targetId}`)).toBeVisible({ timeout: 15000 });

    // 15. 再 Trash（第三次移入回收站）
    await page.getByTestId(`collection-trash-btn-${targetId}`).click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeHidden({ timeout: 15000 });
    if (await page.getByTestId("library-undo-dismiss-btn").isVisible()) {
        await page.getByTestId("library-undo-dismiss-btn").click();
    }
    await page.getByTestId("view-tab-trash").click();
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeVisible({ timeout: 15000 });

    // 16. Permanent Delete（二次确认流与零 RPC 守卫）
    expect(deleteForeverRequestCount).toBe(0);
    await page.getByTestId("collection-permanent-delete-btn").click();
    const deleteDialog = page.getByTestId("collection-delete-confirm");
    await expect(deleteDialog).toBeVisible({ timeout: 15000 });
    // 未确认前严格零 RPC
    expect(deleteForeverRequestCount).toBe(0);

    await page.getByTestId("collection-delete-confirm-ok").click();
    await expect(deleteDialog).toBeHidden({ timeout: 15000 });
    await expect(page.getByTestId(`collection-card-${targetId}`)).toBeHidden({ timeout: 15000 });
    // 确认后恰好触发 1 次永久删除 RPC
    expect(deleteForeverRequestCount).toBe(1);

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
    // 直接访问详情无（fail-closed 读产生 collection.get 404，窗口 ∧ URL 白名单双条件）。
    // 诊断式轮询：不断言弱化，失败时输出当时画面状态（路由/两候选 testid/pageErrors）。
    openExpected404Window("step17-forever-deleted-direct-visit");
    try {
        await page.goto(`${harnessEnv.appUrl}/library/collections/${targetId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await expect
            .poll(async () => {
                if (await page.getByTestId("library-unavailable").isVisible().catch(() => false)) {
                    return "unavailable";
                }
                if (await page.getByTestId("collection-detail-page").isVisible().catch(() => false)) {
                    return "detail-still-mounted";
                }
                return `neither(path=${new URL(page.url()).pathname},pageErrors=[${pageErrors.join("|").slice(0, 200)}],resp404=${observed404s.length})`;
            }, { timeout: 30000 })
            .toBe("unavailable");
        await expect(page.getByTestId("collection-detail-page")).toBeHidden();
        await settleExpected404sAndCloseWindow();
    } finally {
        if (allowExpected404) closeExpected404Window();
    }

    // 全程零控制台与页面未捕获错误；404 响应只允许 fail-closed 的 collection.get。
    // 失败时逐行完整打印窗口与 collection.* 时间线（不截断整串）。
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
        dumpDiagnostics(`stray-404-diag target=${targetId.slice(0, 8)}`);
    }
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    const unexpected404 = observed404Urls().filter((u) => !u.includes("/api/trpc/collection.get"));
    expect(unexpected404).toEqual([]);
});
