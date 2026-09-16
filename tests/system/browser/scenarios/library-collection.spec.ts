// case_id: collection-library-ui
// journey: story-library
// T4 Collection 两层列表/详情/生命周期 + Mini 底部安全区（Chromium+WebKit）。
// 顶层恒为 Collection 卡片；详情成员按 position 升序；逐 Work 播放精确到成员；
// 集合级重命名/收藏/删除/Undo/恢复/永久删除；滚动容器消费 MainChrome 占位变量。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureRegisteredByApi } from "./helpers/auth";
import { dismissOnboarding } from "./helpers/guest";

type TrpcBatch = Array<{ result: { data: { json: unknown } } }>;

/** 页内直调 tRPC mutation（POST batch=1）。 */
async function trpcCall(page: Page, path: string, input: unknown): Promise<unknown> {
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

/** 页内直调 tRPC query（GET batch=1；服务端禁 POST 到 query）。 */
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

type ProbeSnapshot = {
    source?: { kind: string; workId?: number } | null;
    status?: string;
    transport?: { currentTime?: number; duration?: number; hasAudioUrl?: boolean; audioUrl?: string | null };
};

async function readProbe(page: Page): Promise<ProbeSnapshot> {
    return (await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M5PlaybackProbe"] as { snapshot?: () => ProbeSnapshot } | undefined;
        if (!probe || typeof probe.snapshot !== "function") throw new Error("probe-not-ready");
        return probe.snapshot();
    })) as ProbeSnapshot;
}

async function waitForProbes(page: Page): Promise<void> {
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M5PlaybackProbe"]),
        null,
        { timeout: 30000 },
    );
}

async function seedOneCollection(
    page: Page,
    runKey: string,
): Promise<{ conversationId: string; collectionId: string; workIds: number[]; titles: string[] }> {
    const created = (await trpcCall(page, "conversation.createNew", {})) as {
        id?: string;
    };
    const conversationId = created.id;
    if (!conversationId) throw new Error("no-conversation-id");
    const titles = [`壹号作品${runKey}`, `贰号作品${runKey}`, `叁号作品${runKey}`];
    const workIds: number[] = [];
    for (let i = 0; i < 3; i += 1) {
        const work = (await trpcCall(page, "collection.promoteArtifact", {
            conversationId,
            sourceMessageId: `t4-seed-${runKey}-${i}`,
            prompt: `集合种子提示词${runKey}-${i}`,
            storyText: `集合种子正文${runKey}第${i}章。${"星光与航线交织的夜晚，老船长翻开泛黄的航海日志。".repeat(6)}`,
        })) as { id?: number };
        if (!work.id) throw new Error("no-work-id");
        workIds.push(work.id);
    }
    const list = (await trpcQuery(page, "collection.list", { view: "active", limit: 20 })) as {
        items?: Array<{ id?: string }>;
    };
    const collectionId = list.items?.[0]?.id;
    if (!collectionId) throw new Error("no-collection-id");
    return { conversationId, collectionId, workIds, titles };
}

async function registerAndDismiss(page: Page, appUrl: string, tag: string): Promise<void> {
    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("chat_onboarding_seen_v1", "true");
        } catch {}
    });
    await ensureRegisteredByApi(
        page,
        appUrl,
        `t4col_${tag}_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        "SecurePass123!",
    );
    await dismissOnboarding(page);
    await waitForProbes(page);
}

test("Collection 两层列表/详情/逐Work播放 + Mini 安全区", async ({
    page,
    harnessEnv,
    evidence,
}) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    // Mini 安全区走 docked 路径（visible + layoutMode 非 wide-floating）；窄视口锁定该路径。
    await page.setViewportSize({ width: 767, height: 844 });
    await registerAndDismiss(page, harnessEnv.appUrl, "a");
    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const seed = await seedOneCollection(page, runKey);
    recorder.step("集合种子就绪", { works: seed.workIds.length });

    // 顶层恒为 Collection 卡片（含成员计数）。
    await page.goto(`${harnessEnv.appUrl}/library`, { waitUntil: "networkidle", timeout: 30000 });
    const card = page.getByTestId(`collection-card-${seed.collectionId}`);
    await expect(card).toBeVisible({ timeout: 30000 });
    await expect(card.getByTestId("collection-work-count")).toContainText("3");
    recorder.step("顶层集合卡片可见", { collectionId: seed.collectionId });

    // 详情成员按 position 升序。
    await page.getByTestId(`collection-link-${seed.collectionId}`).click();
    await expect(page.getByTestId("collection-detail-page")).toBeVisible({ timeout: 15000 });
    const positions: number[] = [];
    for (const workId of seed.workIds) {
        const row = page.getByTestId(`member-work-${workId}`);
        await expect(row).toBeVisible({ timeout: 15000 });
        positions.push(Number(await row.getAttribute("data-position")));
    }
    expect(positions).toEqual([0, 1, 2]);
    recorder.step("成员顺序断言通过", { positions });

    // 逐 Work 播放精确到成员，并产出可播音频（W38：只断言 source 即覆盖缺口）。
    await page.getByTestId(`member-play-${seed.workIds[1]}`).click();
    await expect
        .poll(async () => (await readProbe(page)).source?.workId, { timeout: 60000 })
        .toBe(seed.workIds[1]);
    // 可播性（W38，与单轨 spec 同口径）：transport 拿到非空 Asset URL，会话未进 error。
    // 注：本 spec 未开单轨 flag，音源为 ephemeral（非 /api/audio/assets/ canonical），故不断言前缀。
    await expect
        .poll(async () => (await readProbe(page)).transport?.hasAudioUrl, { timeout: 60000 })
        .toBe(true);
    const playSnap = await readProbe(page);
    expect(playSnap.status).not.toBe("error");
    const playedUrl = playSnap.transport?.audioUrl ?? "";
    expect(typeof playSnap.transport?.audioUrl === "string" && playedUrl.length > 0).toBe(true);
    recorder.step("逐Work播放精确且可播", {
        workId: seed.workIds[1],
        audioUrlLen: playedUrl.length,
        isCanonicalAssetUrl: playedUrl.startsWith("/api/audio/assets/"),
    });

    // Mini 安全区（docked 路径）：末成员可滚到 Mini 之上，且三占位变量数值组合成立。
    await expect(page.getByTestId("mini-slot")).toHaveAttribute("data-visible", "true", {
        timeout: 30000,
    });
    await expect(page.getByTestId("main-chrome")).toHaveAttribute("data-has-docked-mini", "true", {
        timeout: 15000,
    });
    const miniTop = await page.getByTestId("mini-now-playing").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top;
    });
    const lastCardBottom = await page
        .getByTestId(`member-work-${seed.workIds[2]}`)
        .evaluate((el) => {
            el.scrollIntoView({ block: "end" });
            const r = el.getBoundingClientRect();
            return r.bottom;
        });
    expect(lastCardBottom).toBeLessThanOrEqual(miniTop);
    // MainChrome 单源输出三变量（Mini 占用非零即 docked 预留生效）。
    const miniVar = await page.evaluate(() => {
        const host = document.querySelector('[data-testid="main-chrome"]');
        if (!host) return "";
        return getComputedStyle(host).getPropertyValue("--mini-player-occupied-height");
    });
    expect(miniVar.trim().length).toBeGreaterThan(0);
    expect(miniVar.trim()).not.toBe("0px");
    // 数值组合行为断言（全部取已求值长度，避开 var()/calc() 原串解析）：
    // .content padding-bottom ≈ TabBar 高 + Mini 高 + gap(8px token)。
    const reservation = await page.evaluate(() => {
        const content = document.querySelector('[data-testid="main-chrome-content"]');
        const miniEl = document.querySelector('[data-testid="mini-now-playing"]');
        const tabEl = document.querySelector('[role="tablist"]') ?? document.querySelector("nav");
        if (!content || !miniEl || !tabEl) return null;
        return {
            pad: Number.parseFloat(getComputedStyle(content as Element).paddingBottom) || 0,
            miniH: miniEl.getBoundingClientRect().height,
            tabH: (tabEl as HTMLElement).getBoundingClientRect().height,
        };
    });
    expect(reservation).not.toBeNull();
    // WebKit 亚像素舍入可达 ±3（总量 ~140），容差 4 仍能捕获任何缺项（缺 Mini 差 68，缺 TabBar 差 64）。
    expect(
        Math.abs(reservation!.pad - (reservation!.tabH + reservation!.miniH + 8)),
    ).toBeLessThanOrEqual(4);
    recorder.step("Mini安全区断言通过", { lastCardBottom, miniTop, reservation });
});

test("Collection 集合级生命周期：重命名/收藏/删除/Undo/恢复/永久删除", async ({
    page,
    harnessEnv,
    evidence,
}) => {
    test.setTimeout(240000);
    const recorder = evidence as unknown as { step: (name: string, detail?: unknown) => void };
    await registerAndDismiss(page, harnessEnv.appUrl, "b");
    const runKey = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const seed = await seedOneCollection(page, runKey);

    await page.goto(`${harnessEnv.appUrl}/library`, { waitUntil: "networkidle", timeout: 30000 });
    await expect(page.getByTestId(`collection-card-${seed.collectionId}`)).toBeVisible({
        timeout: 30000,
    });

    // 重命名→列表同步。
    await page.getByTestId(`collection-link-${seed.collectionId}`).click();
    await expect(page.getByTestId("collection-detail-page")).toBeVisible({ timeout: 15000 });
    const newTitle = `重命名集合${runKey}`;
    await page.getByTestId("collection-rename-btn").click();
    await page.getByTestId("collection-rename-input").fill(newTitle);
    await page.getByTestId("collection-rename-save").click();
    await expect(page.getByTestId("collection-title")).toContainText(newTitle);
    await page.getByTestId("collection-back-btn").click();
    await expect(
        page.getByTestId(`collection-card-${seed.collectionId}`).getByTestId("collection-title"),
    ).toContainText(newTitle);
    recorder.step("重命名同步通过", { newTitle });

    // 收藏→收藏视图出现→取消。
    await page.getByTestId(`collection-link-${seed.collectionId}`).click();
    await page.getByTestId("collection-favorite-btn").click();
    await expect(page.getByTestId("collection-favorite-btn")).toHaveAttribute(
        "data-favorited",
        "true",
        { timeout: 15000 },
    );
    await page.getByTestId("collection-back-btn").click();
    await page.getByTestId("view-tab-favorites").click();
    await expect(page.getByTestId(`collection-card-${seed.collectionId}`)).toBeVisible({
        timeout: 15000,
    });
    recorder.step("收藏视图通过", {});

    // 软删除→Undo 恢复。
    await page.getByTestId("view-tab-active").click();
    await page.getByTestId(`collection-link-${seed.collectionId}`).click();
    await page.getByTestId("collection-delete-btn").click();
    await expect(page.getByTestId("collection-detail-page")).toBeHidden({ timeout: 15000 });
    await expect(page.getByTestId("library-undo-toast")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("library-undo-btn").click();
    await expect(page.getByTestId("library-undo-toast")).toBeHidden({ timeout: 15000 });
    await expect(page.getByTestId(`collection-card-${seed.collectionId}`)).toBeVisible({
        timeout: 15000,
    });
    recorder.step("删除Undo恢复通过", {});

    // 再次删除→回收站（无详情入口）→恢复。
    await page.getByTestId(`collection-link-${seed.collectionId}`).click();
    await page.getByTestId("collection-delete-btn").click();
    await expect(page.getByTestId("library-undo-toast")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("library-undo-dismiss-btn").click();
    await page.getByTestId("view-tab-trash").click();
    const trashCard = page.getByTestId(`collection-card-${seed.collectionId}`);
    await expect(trashCard).toBeVisible({ timeout: 15000 });
    expect(await trashCard.locator("a").count()).toBe(0);
    await page.getByTestId("collection-restore-btn").click();
    await page.getByTestId("view-tab-active").click();
    await expect(page.getByTestId(`collection-card-${seed.collectionId}`)).toBeVisible({
        timeout: 15000,
    });
    recorder.step("回收站恢复通过", {});

    // 第三次删除→永久删除二次确认→彻底消失。
    await page.getByTestId(`collection-link-${seed.collectionId}`).click();
    await page.getByTestId("collection-delete-btn").click();
    await expect(page.getByTestId("library-undo-toast")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("library-undo-dismiss-btn").click();
    await page.getByTestId("view-tab-trash").click();
    await expect(page.getByTestId(`collection-card-${seed.collectionId}`)).toBeVisible({
        timeout: 15000,
    });
    await page.getByTestId("collection-permanent-delete-btn").click();
    await expect(page.getByTestId("collection-delete-confirm")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("collection-delete-confirm-ok").click();
    await expect(page.getByTestId(`collection-card-${seed.collectionId}`)).toBeHidden({
        timeout: 30000,
    });
    await page.getByTestId("view-tab-active").click();
    await expect(page.getByTestId(`collection-card-${seed.collectionId}`)).toBeHidden({
        timeout: 15000,
    });
    recorder.step("永久删除消失通过", {});
});