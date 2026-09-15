// case_id: continuous-creation-default-on / continuous-creation-budget-stop-matrix / new-creation-strong-reset
// journey: story-collection-continuous
// M9-C1 T2 targeted L3（闭合项 6）：在真实浏览器进程内驱动真实编排服务
// （continuousCreationFlow + continuousCreationStore），覆盖
//   默认开启 → 自动下一任务 → 预算耗尽停止；
//   新建创作静默（停声/idle）且旧在途响应不复活、不污染新会话。
// 并顺带以真实布局几何锁定「新建创作」按钮单行（闭合项 7）。
// 无 mock 状态机：探针只调用产品既有函数。
import { test, expect } from "../harness/fixtures";
import type { Page } from "@playwright/test";
import { ensureGuestByApi } from "./helpers/auth";
import { captureT2Visual } from "./helpers/visual";

type ProbeSnapshot = {
    probe?: string;
    status?: string;
    epoch?: number;
    enabled?: boolean;
    remainingMs?: number | null;
    hasNextJob?: boolean;
    hasPreparedNextWork?: boolean;
};

type ProbeMethod =
    | "snapshot"
    | "resetForNewCreation"
    | "setBudget"
    | "disable"
    | "enable"
    | "reset"
    | "resolveNextWork"
    | "reportAudioActive"
    | "handleTrackEnded"
    | "consumePreparedNextWork";

async function probeCall<T>(page: Page, method: ProbeMethod, args: unknown[] = []): Promise<T> {
    return page.evaluate(
        (input: { method: string; args: unknown[] }) => {
            const w = window as unknown as Record<string, unknown>;
            const probe = w["__M9ContinuousCreationProbe"] as
                | Record<string, (...a: unknown[]) => unknown>
                | undefined;
            if (!probe) throw new Error("m9-probe-not-ready");
            return probe[input.method](...input.args);
        },
        { method, args },
    ) as Promise<T>;
}

async function readProbe(page: Page): Promise<ProbeSnapshot> {
    return probeCall<ProbeSnapshot>(page, "snapshot");
}

async function startDeferredSchedule(page: Page, epoch: number): Promise<void> {
    await page.evaluate((e: number) => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M9ContinuousCreationProbe"] as
            | { scheduleNextWork: (input: { epoch: number; remainingTrackMs: number }) => Promise<unknown> }
            | undefined;
        if (!probe) throw new Error("m9-probe-not-ready");
        void probe.scheduleNextWork({ epoch: e, remainingTrackMs: 1000 });
    }, epoch);
}

test("默认开启→自动下一任务→预算耗尽停止；新建创作静默且旧响应不复活", async ({ page, harnessEnv }) => {
    test.setTimeout(180000);
    page.on("dialog", (dialog) => {
        void dialog.accept();
    });

    await ensureGuestByApi(page, harnessEnv.appUrl);

    const clearButton = page.getByRole("button", { name: "新建创作" });
    await expect(clearButton).toBeVisible({ timeout: 30000 });

    // 闭合项 7：真实布局几何——按钮文案必须单行（Range 只产生 1 个文本 rect）。
    const buttonGeometry = await clearButton.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        const box = (el as HTMLElement).getBoundingClientRect();
        return { rectCount: rects.length, width: box.width, height: box.height };
    });
    expect(buttonGeometry.rectCount, "「新建创作」按钮文案必须单行").toBe(1);
    expect(buttonGeometry.width).toBeGreaterThanOrEqual(52);
    expect(buttonGeometry.height).toBeLessThanOrEqual(40);
    await captureT2Visual(page, "new-creation-button-single-line");

    const switchEl = page.getByTestId("continuous-switch");
    await expect(switchEl).toHaveAttribute("aria-checked", "true", { timeout: 30000 });
    await page.waitForFunction(
        () => Boolean((window as unknown as Record<string, unknown>)["__M9ContinuousCreationProbe"]),
        null,
        { timeout: 30000 },
    );

    // —— 1. 默认开启 → 自动下一任务 ——
    const base = await readProbe(page);
    expect(base.enabled).toBe(true);
    expect(base.status).toBe("enabled_idle");

    await probeCall(page, "resetForNewCreation", [{ budgetMs: 60000, collectionId: "e2e-col", epoch: 101 }]);
    await startDeferredSchedule(page, 101);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe("generating_next");
    await probeCall(page, "resolveNextWork", [
        { messageId: "e2e-next-1", audioUrl: "blob:e2e-next-1", content: "E2E 下一段" },
    ]);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe("next_ready");
    const ready = await readProbe(page);
    expect(ready.hasNextJob).toBe(true);
    expect(ready.hasPreparedNextWork).toBe(true);
    const ended = await probeCall<{ work: { messageId: string } | null }>(page, "handleTrackEnded", [101]);
    expect(ended.work?.messageId).toBe("e2e-next-1");
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe("enabled_idle");
    expect((await readProbe(page)).hasPreparedNextWork).toBe(false);

    // —— 2. 预算耗尽停止：在途晚到不得写回/复活 ——
    await probeCall(page, "resetForNewCreation", [{ budgetMs: 60000, collectionId: "e2e-col", epoch: 102 }]);
    await probeCall(page, "setBudget", [60]);
    await startDeferredSchedule(page, 102);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe("generating_next");
    await probeCall(page, "reportAudioActive", [true]);
    await page.waitForTimeout(120);
    await probeCall(page, "reportAudioActive", [true]);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe("ended_budget");
    await probeCall(page, "resolveNextWork", [
        { messageId: "e2e-late-budget", audioUrl: "blob:e2e-late", content: "耗尽后晚到" },
    ]);
    await page.waitForTimeout(200);
    const afterBudget = await readProbe(page);
    expect(afterBudget.hasPreparedNextWork).toBe(false);
    expect(afterBudget.status).toBe("ended_budget");
    const endedBudget = await probeCall<{ work: unknown }>(page, "handleTrackEnded", [102]);
    expect(endedBudget.work).toBeNull();

    // —— 3. 新建创作：静默 + 旧在途响应不复活/不污染 ——
    await probeCall(page, "resetForNewCreation", [{ budgetMs: 60000, collectionId: "e2e-col", epoch: 103 }]);
    await startDeferredSchedule(page, 103);
    await expect.poll(async () => (await readProbe(page)).status, { timeout: 15000 }).toBe("generating_next");

    await clearButton.click();
    await expect(switchEl).toHaveAttribute("aria-checked", "true", { timeout: 30000 });
    await expect(page.getByTestId("continuous-status-card")).toContainText("连续创作已开启");
    await expect
        .poll(async () => (await readProbe(page)).epoch, { timeout: 15000 })
        .toBeGreaterThan(103);

    await probeCall(page, "resolveNextWork", [
        { messageId: "e2e-late-newcreation", audioUrl: "blob:e2e-late-nc", content: "新建创作后晚到" },
    ]);
    await page.waitForTimeout(200);
    const afterNewCreation = await readProbe(page);
    expect(afterNewCreation.hasPreparedNextWork).toBe(false);
    expect(afterNewCreation.status).not.toBe("next_ready");
    const staleEnd = await probeCall<{ work: unknown }>(page, "handleTrackEnded", [103]);
    expect(staleEnd.work).toBeNull();

    const transportPlaying = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const probe = w["__M5PlaybackProbe"] as
            | { snapshot?: () => { transport?: { isPlaying?: boolean } } }
            | undefined;
        return probe?.snapshot?.().transport?.isPlaying ?? false;
    });
    expect(transportPlaying).toBe(false);
});
